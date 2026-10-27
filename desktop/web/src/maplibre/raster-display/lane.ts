/**
 * Raster display lane: the request handler one worker runs.
 *
 * Hosts the pinned `cog-tiler-wasm` module off the UI thread: COG header
 * reads, block decode and colorizing all happen here. Display COGs are written
 * in EPSG:3857 by the Rust warp, so cog-tiler takes its affine path; a source it
 * would warp itself (proj4js on the GeoTIFF keys, no datum shift) is refused at
 * open rather than drawn metres to kilometres off. `worker.ts` wires one lane to
 * its worker scope; the main thread only forwards requests through `pool.ts`,
 * which presents the lanes to the upstream `LayerManager` as its public
 * `loadCogTiler` module. Tests run the same handler in process
 * (`__tests__/support/raster-lane.ts`), each lane with its own state.
 *
 * Decoded blocks are cached by the upstream `CogSource` in a per-source
 * `tileCache` map capped by entry count only. The lane replaces that map with
 * one that charges every decoded block to a single lane-wide byte budget, so
 * many open sources cannot multiply the cache. The replacement relies on the
 * `tileCache` field of `cog-tiler-wasm@0.4.0`; `open` fails loudly if the
 * pinned module stops exposing it rather than silently losing the bound.
 * Tiles past a source's native zoom are drawn from its native ancestor
 * (`overzoom.ts`); those ancestor windows are charged to the same budget.
 */
import { init, openCog, rgbaToPng } from 'cog-tiler-wasm'
import type { CogSource, RenderOptions } from 'cog-tiler-wasm'
import type { RasterBandStatistics, RasterWorkerReply, RasterWorkerRequest, RasterSourceMetadata } from './protocol'
import { renderTile } from './overzoom'

/** One lane: requests in, one reply each out through the lane's `reply`. */
interface RasterLane {
  receive(request: RasterWorkerRequest): void
}

interface CacheEntry {
  readonly cache: BudgetedTileCache
  readonly key: string
  bytes: number
}

/** The lane-wide byte budget and least-recently-used order across every open source. */
class LaneBudget {
  /** Set by the pool on start. */
  limitBytes = 64 * 1024 * 1024
  usedBytes = 0
  readonly lru = new Map<string, CacheEntry>()
  private cacheSequence = 0

  nextPrefix(): string {
    return `c${++this.cacheSequence}:`
  }

  forget(lruKey: string): void {
    const entry = this.lru.get(lruKey)
    if (!entry) return
    this.lru.delete(lruKey)
    this.usedBytes -= entry.bytes
  }

  enforce(): void {
    for (const [lruKey, entry] of this.lru) {
      if (this.usedBytes <= this.limitBytes) return
      this.lru.delete(lruKey)
      this.usedBytes -= entry.bytes
      entry.cache.evict(entry.key)
    }
  }
}

/**
 * A `Map` compatible with the upstream tile cache that charges resolved
 * decoded blocks to the lane budget and evicts least-recently-used blocks
 * across sources once the budget is exceeded.
 */
class BudgetedTileCache extends Map<string, Promise<unknown>> {
  private readonly budget: LaneBudget
  private readonly prefix: string

  constructor(budget: LaneBudget) {
    super()
    this.budget = budget
    this.prefix = budget.nextPrefix()
  }

  override get(key: string): Promise<unknown> | undefined {
    const value = super.get(key)
    const entry = this.budget.lru.get(this.prefix + key)
    if (value && entry) {
      this.budget.lru.delete(this.prefix + key)
      this.budget.lru.set(this.prefix + key, entry)
    }
    return value
  }

  override set(key: string, value: Promise<unknown>): this {
    super.set(key, value)
    const budget = this.budget
    const lruKey = this.prefix + key
    const entry: CacheEntry = { cache: this, key, bytes: 0 }
    budget.forget(lruKey)
    budget.lru.set(lruKey, entry)
    value.then((decoded) => {
      if (budget.lru.get(lruKey) !== entry) return
      entry.bytes = decodedBytes(decoded)
      budget.usedBytes += entry.bytes
      budget.enforce()
    }, () => {})
    return this
  }

  override delete(key: string): boolean {
    this.budget.forget(this.prefix + key)
    return super.delete(key)
  }

  override clear(): void {
    for (const key of super.keys()) this.budget.forget(this.prefix + key)
    super.clear()
  }

  evict(key: string): void {
    super.delete(key)
  }
}

function decodedBytes(decoded: unknown): number {
  if (ArrayBuffer.isView(decoded)) return decoded.byteLength
  return 0
}

/** A lane with its own sources, caches and budget; `reply` carries each answer out. */
export function createRasterLane(reply: (message: RasterWorkerReply, transfer: Transferable[]) => void): RasterLane {
  const budget = new LaneBudget()
  /** Opened sources by pool handle. A pending open is awaited by later calls. */
  const sources = new Map<number, Promise<CogSource>>()
  /** Native ancestor windows of overzoomed tiles, by pool handle. */
  const ancestors = new Map<number, BudgetedTileCache>()

  function ancestorsFor(handle: number): BudgetedTileCache {
    let cache = ancestors.get(handle)
    if (!cache) {
      cache = new BudgetedTileCache(budget)
      ancestors.set(handle, cache)
    }
    return cache
  }

  function sourceFor(handle: number): Promise<CogSource> {
    const source = sources.get(handle)
    if (!source) throw new Error(`raster source ${handle} is not open in this lane`)
    return source
  }

  async function handle(request: RasterWorkerRequest): Promise<{ value: unknown; transfer: Transferable[] }> {
    switch (request.op) {
      case 'init':
        budget.limitBytes = request.budgetBytes
        await init()
        budget.enforce()
        return { value: true, transfer: [] }
      case 'open': {
        const opening = (async () => {
          await init()
          const source = await openCog(request.url)
          // upstream: W8
          const upstream = source as unknown as { tileCache?: unknown }
          if (!(upstream.tileCache instanceof Map)) {
            throw new Error('cog-tiler-wasm no longer exposes its decoded tile cache; the lane budget cannot be enforced')
          }
          upstream.tileCache = new BudgetedTileCache(budget)
          return source
        })()
        sources.set(request.handle, opening)
        opening.catch(() => {
          if (sources.get(request.handle) === opening) sources.delete(request.handle)
        })
        return { value: metadataOf(await opening), transfer: [] }
      }
      case 'render': {
        const source = await sourceFor(request.handle)
        const rgba = await renderTile(source, request.z, request.x, request.y, request.render as RenderOptions, ancestorsFor(request.handle))
        if (!rgba) return { value: null, transfer: [] }
        if (request.encoding === 'rgba') {
          const copy = new Uint8ClampedArray(rgba)
          return { value: copy, transfer: [copy.buffer] }
        }
        const png = await rgbaToPng(rgba, 256, 256)
        return { value: png, transfer: [png.buffer] }
      }
      case 'bbox': {
        const source = await sourceFor(request.handle)
        const image = await source.bbox(request.bbox, {
          ...(request.render as RenderOptions),
          width: request.width,
          height: request.height,
        })
        const copy = new Uint8ClampedArray(image.rgba)
        return { value: copy, transfer: [copy.buffer] }
      }
      case 'statistics': {
        const source = await sourceFor(request.handle)
        const level = statisticsLevel(source.levels)
        const statistics = await source.statistics({ maxSize: level.width })
        return { value: bandStatistics(statistics, level.width * level.height), transfer: [] }
      }
      case 'encode': {
        const png = await rgbaToPng(request.rgba, request.width, request.height)
        return { value: png, transfer: [png.buffer] }
      }
      case 'close': {
        const source = sources.get(request.handle)
        sources.delete(request.handle)
        ancestors.get(request.handle)?.clear()
        ancestors.delete(request.handle)
        if (source) {
          const opened = await source.catch(() => null)
          const cache = (opened as unknown as { tileCache?: unknown } | null)?.tileCache
          if (cache instanceof BudgetedTileCache) cache.clear()
        }
        return { value: true, transfer: [] }
      }
    }
  }

  return {
    receive(request) {
      handle(request).then(
        ({ value, transfer }) => reply({ id: request.id, ok: true, value }, transfer),
        (error: unknown) => reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }, []),
      )
    },
  }
}

function metadataOf(source: CogSource): RasterSourceMetadata {
  return { boundsLonLat: [...source.boundsLonLat] }
}

/** Samples one statistics read may hold: it decodes a whole level and sorts its values in this lane. */
const STATISTICS_SAMPLES = 512 * 512

/**
 * The finest level of at most `STATISTICS_SAMPLES` pixels, whose width as
 * `maxSize` makes cog-tiler's `statistics` read it. cog-tiler picks the first
 * level no wider than `maxSize` and ignores height, so a tall narrow raster
 * would otherwise be read whole; levels are finest first, so widths fall.
 */
function statisticsLevel<Level extends { readonly width: number; readonly height: number }>(levels: readonly Level[]): Level {
  return levels.find(({ width, height }) => width * height <= STATISTICS_SAMPLES) ?? levels.at(-1)!
}

/** Band 1 of cog-tiler's TiTiler-style statistics over `pixels` read; null when it has no valid pixel. */
function bandStatistics(statistics: Record<string, Record<string, unknown>>, pixels: number): RasterBandStatistics | null {
  const band = statistics.b1 as {
    count?: number
    min?: number
    max?: number
    percentile_2?: number
    percentile_98?: number
    histogram?: [number[], number[]]
  } | undefined
  if (!band?.count) return null
  return {
    min: band.min!,
    max: band.max!,
    percentile2: band.percentile_2!,
    percentile98: band.percentile_98!,
    histogram: band.histogram![0],
    pixels,
  }
}
