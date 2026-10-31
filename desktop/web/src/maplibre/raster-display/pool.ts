// maplibre/raster-display/pool.ts
// Owner of the raster decode workers (worker-only-in-owner, ADR 0028; §18 F16). Invariant:
// raster decode workers are started and terminated only by this pool.

/**
 * Shared raster display worker lanes.
 *
 * The pool owns every raster decode worker in the workspace. Callers acquire a
 * client; the pool starts its lanes on the first acquisition and terminates
 * them when the last client is disposed, so a map teardown with no other
 * raster consumer returns to zero workers and zero cache.
 *
 * A client is shaped like the `cog-tiler-wasm` module the upstream
 * `LayerManager` loads through its public `loadCogTiler` dependency. Its
 * sources are proxies: header reads, decode, reprojection and colorizing run in
 * a lane, and only encoded tiles cross back to the UI thread.
 *
 * Scheduling is owned here because the upstream engine never forwards
 * MapLibre's abort signal. Tile work is dispatched newest first, a bounded
 * number per lane, and a queued tile the client reports as no longer relevant
 * (outside the current viewport) is rejected before it starts. Statistics
 * (an overview decode and a sort that block their worker) are background work:
 * they start only when no tile waits, at most one per lane and one fewer than
 * the lanes in all, and tiles go first to a lane running none, so a mosaic's
 * range reads never hold back the map. Disposing a client rejects its queued
 * work and closes its sources in every lane.
 */
import type {
  RasterBandStatistics,
  RasterRenderOptions,
  RasterSourceMetadata,
  RasterWorkerReply,
  RasterWorkerRequest,
} from './protocol'
import { recordRaster } from './diagnostics'

/** Minimal worker surface; tests run the real lane in process (`__tests__/support/raster-lane.ts`). */
export interface RasterWorkerLike {
  postMessage(message: RasterWorkerRequest, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<RasterWorkerReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  terminate(): void
}

export interface RasterPoolOptions {
  /** Worker lanes shared by every client (two). */
  readonly lanes: number
  /** Aggregate decoded-block budget, split evenly across lanes. */
  readonly budgetBytes: number
  /** Requests a lane may hold in flight while it awaits range reads. */
  readonly maxInFlightPerLane: number
  readonly createWorker: () => RasterWorkerLike
}

/** Tile coordinates a relevance check can reject before work starts. */
export interface RasterTileRequest {
  readonly z: number
  readonly x: number
  readonly y: number
}

type RasterTileRelevance = (tile: RasterTileRequest) => boolean

/** One opened COG as the upstream engine sees it. */
export interface RasterProxySource extends RasterSourceMetadata {
  renderTilePNG(z: number, x: number, y: number, render?: RasterRenderOptions): Promise<Uint8Array>
  renderTileRGBA(z: number, x: number, y: number, render?: RasterRenderOptions): Promise<Uint8ClampedArray | null>
}

/** The client the upstream `LayerManager` treats as the cog-tiler module. */
export interface RasterPoolClient {
  init(): Promise<void>
  openCog(url: string): Promise<RasterProxySource>
  /**
   * Close every source this client opened for these URLs, in every lane. The
   * upstream engine only forgets a dropped layer's proxy, so the owner of the
   * layers calls this once no remaining layer reads the URL.
   */
  releaseSources(urls: readonly string[]): void
  rgbaToPng(rgba: Uint8Array | Uint8ClampedArray, width?: number, height?: number): Promise<Uint8Array>
  /** Render several COGs over one WGS84 box, first listed on top, as PNG bytes. */
  renderPreview(
    urls: readonly string[],
    bbox: [number, number, number, number],
    size: { width: number; height: number },
    render: RasterRenderOptions,
  ): Promise<Uint8Array>
  /** Band 1's statistics of one COG, read in a lane through a handle closed afterwards. */
  statistics(url: string): Promise<RasterBandStatistics | null>
  /** Report whether a queued tile still matters; checked just before dispatch. */
  setRelevance(relevance: RasterTileRelevance | null): void
  dispose(): void
}

type TaskKind = 'control' | 'tile' | 'background'

interface Task {
  readonly client: ClientState
  readonly kind: TaskKind
  readonly tile?: RasterTileRequest
  /** Lane that must run this task, when it is bound to one lane's state. */
  readonly lane?: number
  run(lane: Lane): Promise<unknown>
  resolve(value: unknown): void
  reject(error: unknown): void
}

interface Lane {
  readonly index: number
  readonly worker: RasterWorkerLike
  readonly pending: Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>
  inFlight: number
  /** Statistics running here; at most one, and never in every lane at once. */
  background: number
  broken: Error | null
}

interface ClientState {
  disposed: boolean
  relevance: RasterTileRelevance | null
  readonly handles: Set<number>
  /** Handles opened through `openCog`, by URL, for `releaseSources`. */
  readonly sources: Map<string, Set<number>>
}

function abortError(message = 'Raster request aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export class RasterWorkerPool {
  private lanes: Lane[] = []
  private queue: Task[] = []
  private clients = 0
  private requestSequence = 0
  private handleSequence = 0
  /** Lanes each handle is opened in, keyed by handle. */
  private readonly openedIn = new Map<number, Map<number, Promise<unknown>>>()
  private readonly urls = new Map<number, string>()

  constructor(private readonly options: RasterPoolOptions) {}

  /** Live lanes; zero when no client holds the pool. */
  get laneCount(): number {
    return this.lanes.length
  }

  acquire(): RasterPoolClient {
    if (this.clients === 0) this.start()
    this.clients += 1
    const state: ClientState = { disposed: false, relevance: null, handles: new Set(), sources: new Map() }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const pool = this
    const client: RasterPoolClient = {
      async init() {
        if (state.disposed) throw abortError('Raster client is disposed')
      },
      openCog: (url) => pool.openSource(state, url),
      releaseSources: (urls) => pool.releaseSources(state, urls),
      rgbaToPng: (rgba, width = 256, height = 256) => {
        const copy = new Uint8ClampedArray(rgba)
        return pool.schedule<Uint8Array>(state, 'control', undefined, undefined, (lane) =>
          pool.post(lane, { id: 0, op: 'encode', rgba: copy, width, height }, [copy.buffer]))
      },
      renderPreview: (urls, bbox, size, render) => pool.renderPreview(state, urls, bbox, size, render),
      statistics: (url) => pool.statistics(state, url),
      setRelevance(relevance) {
        state.relevance = relevance
      },
      dispose: () => pool.release(state),
    }
    return client
  }

  private start(): void {
    recordRaster({ kind: 'lanes-start', detail: String(this.options.lanes) })
    this.lanes = Array.from({ length: this.options.lanes }, (_, index) => this.createLane(index))
  }

  private createLane(index: number): Lane {
    const worker = this.options.createWorker()
    const lane: Lane = { index, worker, pending: new Map(), inFlight: 0, background: 0, broken: null }
    worker.onmessage = (event) => {
      const reply = event.data
      const waiter = lane.pending.get(reply.id)
      if (!waiter) return
      lane.pending.delete(reply.id)
      if (reply.ok) waiter.resolve(reply.value)
      else waiter.reject(new Error(reply.error))
    }
    worker.onerror = (event) => {
      // A lane that crashed cannot answer; fail its work instead of hanging it,
      // then replace it so later tiles do not keep landing on a dead worker.
      lane.broken = new Error(event.message || 'Raster worker lane failed')
      for (const waiter of lane.pending.values()) waiter.reject(lane.broken)
      lane.pending.clear()
      this.replaceLane(lane)
    }
    const budget = Math.max(1, Math.floor(this.options.budgetBytes / this.options.lanes))
    void this.post(lane, { id: 0, op: 'init', budgetBytes: budget }).catch(() => {})
    return lane
  }

  /** A fresh worker in the crashed lane's slot; its sources reopen on demand. */
  private replaceLane(lane: Lane): void {
    if (this.lanes[lane.index] !== lane) return
    lane.worker.onmessage = null
    lane.worker.onerror = null
    lane.worker.terminate()
    for (const lanes of this.openedIn.values()) lanes.delete(lane.index)
    recordRaster({ kind: 'lane-restart', detail: `lane ${lane.index} ${lane.broken?.message ?? ''}`.trim() })
    this.lanes[lane.index] = this.createLane(lane.index)
    this.dispatch()
  }

  private post<T>(lane: Lane, request: RasterWorkerRequest, transfer: Transferable[] = []): Promise<T> {
    if (lane.broken) return Promise.reject(lane.broken)
    const id = ++this.requestSequence
    return new Promise<T>((resolve, reject) => {
      lane.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      lane.worker.postMessage({ ...request, id } as RasterWorkerRequest, transfer)
    })
  }

  private schedule<T>(
    client: ClientState,
    kind: TaskKind,
    tile: RasterTileRequest | undefined,
    lane: number | undefined,
    run: (lane: Lane) => Promise<unknown>,
  ): Promise<T> {
    if (client.disposed) return Promise.reject(abortError('Raster client is disposed'))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ client, kind, tile, lane, run, resolve: resolve as (value: unknown) => void, reject })
      this.dispatch()
    })
  }

  /** Start queued work while lanes have capacity: control first, then newest tiles. */
  // upstream: W3
  private dispatch(): void {
    this.dropObsoleteTiles()
    for (;;) {
      const task = this.nextTask()
      if (!task) return
      const lane = task.lane !== undefined
        ? this.lanes[task.lane]!
        : this.leastLoadedLane(task.kind === 'background')!
      lane.inFlight += 1
      if (task.kind === 'background') lane.background += 1
      const started = performance.now()
      const label = task.tile ? `${task.tile.z}/${task.tile.x}/${task.tile.y}` : undefined
      task.run(lane).then((value) => {
        if (label) recordRaster({ kind: 'tile', detail: `lane ${lane.index} ${label}`, ms: performance.now() - started })
        task.resolve(value)
      }, (error: unknown) => {
        recordRaster({ kind: task.tile ? 'tile-error' : 'control-error', detail: `${label ?? ''} ${error instanceof Error ? error.message : String(error)}`.trim(), ms: performance.now() - started })
        task.reject(error)
      }).finally(() => {
        lane.inFlight -= 1
        if (task.kind === 'background') lane.background -= 1
        this.dispatch()
      })
    }
  }

  /** Reject queued tiles their client no longer wants, so obsolete work never waits for a lane. */
  private dropObsoleteTiles(): void {
    if (!this.queue.some((task) => task.tile && task.client.relevance)) return
    this.queue = this.queue.filter((task) => {
      if (!task.tile || !task.client.relevance || task.client.relevance(task.tile)) return true
      recordRaster({ kind: 'tile-dropped', detail: `${task.tile.z}/${task.tile.x}/${task.tile.y}` })
      task.reject(abortError('Raster tile left the viewport'))
      return false
    })
  }

  private nextTask(): Task | null {
    const capacity = (lane: Lane) => lane.inFlight < this.options.maxInFlightPerLane
    if (!this.lanes.some(capacity)) return null
    // Controls (open, close, encode) are cheap and unblock tiles: oldest first.
    for (let index = 0; index < this.queue.length; index += 1) {
      const task = this.queue[index]!
      if (task.kind !== 'control') continue
      if (task.lane !== undefined && !capacity(this.lanes[task.lane]!)) continue
      this.queue.splice(index, 1)
      return task
    }
    // Tiles: the newest request belongs to the current viewport.
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const task = this.queue[index]!
      if (task.kind !== 'tile') continue
      if (task.lane !== undefined && !capacity(this.lanes[task.lane]!)) continue
      this.queue.splice(index, 1)
      if (task.client.disposed) {
        task.reject(abortError('Raster client is disposed'))
        continue
      }
      if (task.tile && task.client.relevance && !task.client.relevance(task.tile)) {
        recordRaster({ kind: 'tile-dropped', detail: `${task.tile.z}/${task.tile.x}/${task.tile.y}` })
        task.reject(abortError('Raster tile left the viewport'))
        continue
      }
      return task
    }
    // Background work, oldest first, once no tile waits: one per lane, and
    // one lane (when there are two or more) always left free for tiles.
    const running = this.lanes.reduce((sum, lane) => sum + lane.background, 0)
    if (running >= Math.max(1, this.lanes.length - 1) || !this.leastLoadedLane(true)) return null
    const index = this.queue.findIndex((task) => task.kind === 'background')
    if (index < 0) return null
    return this.queue.splice(index, 1)[0]!
  }

  /**
   * The lane with most room. Background work takes only a lane running none;
   * other work prefers such a lane, since a running read blocks its worker.
   */
  private leastLoadedLane(background = false): Lane | null {
    let best: Lane | null = null
    for (const lane of this.lanes) {
      if (lane.inFlight >= this.options.maxInFlightPerLane) continue
      if (background && lane.background > 0) continue
      if (!best) best = lane
      else if ((lane.background === 0) !== (best.background === 0)) {
        if (lane.background === 0) best = lane
      } else if (lane.inFlight < best.inFlight) best = lane
    }
    return best
  }

  /** Open one handle in one lane, once; later renders there await it. */
  private ensureOpen(lane: Lane, handle: number): Promise<unknown> {
    let lanes = this.openedIn.get(handle)
    if (!lanes) {
      lanes = new Map()
      this.openedIn.set(handle, lanes)
    }
    let opening = lanes.get(lane.index)
    if (!opening) {
      opening = this.post<RasterSourceMetadata>(lane, { id: 0, op: 'open', handle, url: this.urls.get(handle)! })
      opening.catch(() => lanes!.delete(lane.index))
      lanes.set(lane.index, opening)
    }
    return opening
  }

  private async openSource(client: ClientState, url: string): Promise<RasterProxySource> {
    const handle = ++this.handleSequence
    this.urls.set(handle, url)
    client.handles.add(handle)
    let opened = client.sources.get(url)
    if (!opened) {
      opened = new Set()
      client.sources.set(url, opened)
    }
    opened.add(handle)
    let metadata: RasterSourceMetadata
    try {
      metadata = await this.schedule<RasterSourceMetadata>(client, 'control', undefined, undefined, (lane) =>
        this.ensureOpen(lane, handle))
    } catch (error) {
      this.forgetSource(client, url, handle)
      throw error
    }
    if (client.disposed) {
      this.closeHandle(handle)
      throw abortError('Raster client is disposed')
    }
    if (!client.handles.has(handle)) {
      // Released while it was opening: the layer that asked for it is gone.
      this.closeHandle(handle)
      throw abortError('Raster source is released')
    }
    const render = (encoding: 'png' | 'rgba', z: number, x: number, y: number, options: RasterRenderOptions = {}) =>
      this.schedule<Uint8Array | Uint8ClampedArray | null>(client, 'tile', { z, x, y }, undefined, async (lane) => {
        // upstream: W1
        // A released source is closed in every lane; never reopen it.
        if (!client.handles.has(handle)) throw abortError('Raster source is released')
        await this.ensureOpen(lane, handle)
        return this.post(lane, { id: 0, op: 'render', handle, z, x, y, render: options, encoding })
      })
    return {
      ...metadata,
      async renderTilePNG(z, x, y, options) {
        return ((await render('png', z, x, y, options)) as Uint8Array | null) ?? new Uint8Array(0)
      },
      renderTileRGBA: (z, x, y, options) => render('rgba', z, x, y, options) as Promise<Uint8ClampedArray | null>,
    }
  }

  private async renderPreview(
    client: ClientState,
    urls: readonly string[],
    bbox: [number, number, number, number],
    size: { width: number; height: number },
    render: RasterRenderOptions,
  ): Promise<Uint8Array> {
    const composite = new Uint8ClampedArray(size.width * size.height * 4)
    const handles: number[] = []
    try {
      for (const url of urls) {
        const handle = ++this.handleSequence
        this.urls.set(handle, url)
        client.handles.add(handle)
        handles.push(handle)
        const rgba = await this.schedule<Uint8ClampedArray>(client, 'tile', undefined, undefined, async (lane) => {
          await this.ensureOpen(lane, handle)
          return this.post(lane, { id: 0, op: 'bbox', handle, bbox, width: size.width, height: size.height, render })
        })
        // First listed source stays on top: fill only still-transparent pixels.
        let complete = true
        for (let index = 3; index < composite.length; index += 4) {
          if (composite[index] !== 0) continue
          if (rgba[index] === 0) {
            complete = false
            continue
          }
          composite[index - 3] = rgba[index - 3]!
          composite[index - 2] = rgba[index - 2]!
          composite[index - 1] = rgba[index - 1]!
          composite[index] = rgba[index]!
        }
        if (complete) break
      }
      return await this.schedule<Uint8Array>(client, 'control', undefined, undefined, (lane) =>
        this.post(lane, { id: 0, op: 'encode', rgba: composite, width: size.width, height: size.height }, [composite.buffer]))
    } finally {
      for (const handle of handles) {
        client.handles.delete(handle)
        this.closeHandle(handle)
      }
    }
  }

  private async statistics(client: ClientState, url: string): Promise<RasterBandStatistics | null> {
    const handle = ++this.handleSequence
    this.urls.set(handle, url)
    client.handles.add(handle)
    try {
      return await this.schedule<RasterBandStatistics | null>(client, 'background', undefined, undefined, async (lane) => {
        await this.ensureOpen(lane, handle)
        return this.post(lane, { id: 0, op: 'statistics', handle })
      })
    } finally {
      client.handles.delete(handle)
      this.closeHandle(handle)
    }
  }

  private releaseSources(client: ClientState, urls: readonly string[]): void {
    for (const url of urls) {
      for (const handle of client.sources.get(url) ?? []) this.forgetSource(client, url, handle)
    }
  }

  private forgetSource(client: ClientState, url: string, handle: number): void {
    const opened = client.sources.get(url)
    opened?.delete(handle)
    if (opened?.size === 0) client.sources.delete(url)
    client.handles.delete(handle)
    this.closeHandle(handle)
  }

  private closeHandle(handle: number): void {
    const lanes = this.openedIn.get(handle)
    this.openedIn.delete(handle)
    this.urls.delete(handle)
    if (!lanes) return
    for (const laneIndex of lanes.keys()) {
      const lane = this.lanes[laneIndex]
      if (lane) void this.post(lane, { id: 0, op: 'close', handle }).catch(() => {})
    }
  }

  private release(client: ClientState): void {
    if (client.disposed) return
    client.disposed = true
    recordRaster({ kind: 'client-dispose', detail: `${this.queue.filter((task) => task.client === client).length} queued, ${client.handles.size} sources` })
    const kept: Task[] = []
    for (const task of this.queue) {
      if (task.client === client) task.reject(abortError('Raster client is disposed'))
      else kept.push(task)
    }
    this.queue = kept
    for (const handle of client.handles) this.closeHandle(handle)
    client.handles.clear()
    this.clients -= 1
    if (this.clients === 0) this.stop()
  }

  /** Stops every lane; only the HMR owner of the module singleton calls it. */
  stopForHotReload(): void {
    this.stop()
  }

  private stop(): void {
    recordRaster({ kind: 'lanes-stop', detail: `${this.lanes.reduce((sum, lane) => sum + lane.pending.size, 0)} in flight` })
    for (const lane of this.lanes) {
      const error = abortError('Raster workers stopped')
      for (const waiter of lane.pending.values()) waiter.reject(error)
      lane.pending.clear()
      lane.worker.onmessage = null
      lane.worker.onerror = null
      lane.worker.terminate()
    }
    this.lanes = []
    this.queue = []
    this.openedIn.clear()
    this.urls.clear()
  }
}

/** Decoded-block cache shared by all display sources (128 MiB). */
const RASTER_DECODED_CACHE_BYTES = 128 * 1024 * 1024

let workspacePool: RasterWorkerPool | null = null

/** The workspace's shared pool, created on first use. */
export function rasterWorkerPool(): RasterWorkerPool {
  workspacePool ??= new RasterWorkerPool({
    lanes: 2,
    budgetBytes: RASTER_DECODED_CACHE_BYTES,
    maxInFlightPerLane: 4,
    createWorker: () =>
      new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'canopi-raster-display' }) as unknown as RasterWorkerLike,
  })
  return workspacePool
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    workspacePool?.stopForHotReload()
    workspacePool = null
  })
}
