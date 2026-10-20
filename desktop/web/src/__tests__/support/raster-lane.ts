/**
 * Raster display lanes for tests: the real lane handler (`createRasterLane`)
 * run in this process, with the pinned `cog-tiler-wasm` WebAssembly started in
 * Node, display COGs served by byte range as the asset protocol does, and one
 * stand-in for the browser-only canvas cog-tiler encodes tiles with.
 *
 * `hold` and `release` order replies: a held request runs on arrival, in order
 * as in a worker, and only its reply waits. A held reply never hangs a test,
 * since terminating the lane (the pool does it when its last client leaves)
 * drops it and the pool rejects what it was waiting for.
 * A lane deadline (`hang`) lands with 2d's MAP-17 work (2.1-M172).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { createRasterLane } from '../../maplibre/raster-display/lane'
import type { RasterWorkerLike } from '../../maplibre/raster-display/pool'
import type { RasterWorkerReply, RasterWorkerRequest } from '../../maplibre/raster-display/protocol'

type RasterOp = RasterWorkerRequest['op']

/** Display COG bytes by asset URL, or a resolver for many URLs. */
type RasterFixtures = Readonly<Record<string, Uint8Array>> | ((url: string) => Uint8Array | undefined)

export interface InProcessLane extends RasterWorkerLike {
  /** Every request the pool posted, in order. */
  readonly requests: readonly RasterWorkerRequest[]
  /** Every reply the lane sent, in order. */
  readonly replies: readonly RasterWorkerReply[]
  readonly terminated: boolean
  /** Hold the replies to later requests of these ops (every op when omitted) until released. */
  hold(ops?: readonly RasterOp[]): void
  /** Deliver one held request's reply, or every held reply and stop holding. */
  release(request?: RasterWorkerRequest): void
  /** The render requests posted so far. */
  renders(): Extract<RasterWorkerRequest, { op: 'render' }>[]
}

/** One lane running the real handler in this process. */
export function inProcessLane(): InProcessLane {
  const requests: RasterWorkerRequest[] = []
  const replies: RasterWorkerReply[] = []
  let holding: ReadonlySet<RasterOp> | 'all' | null = null
  /** Held requests by id: their reply once it came, or null while it runs. */
  let held = new Map<number, RasterWorkerReply | null>()
  /** Held requests released before their reply came. */
  const released = new Set<number>()
  let terminated = false
  const deliver = (reply: RasterWorkerReply) => {
    if (terminated) return
    replies.push(reply)
    lane.onmessage?.({ data: reply } as MessageEvent<RasterWorkerReply>)
  }
  const handler = createRasterLane((reply) => {
    if (terminated) return
    if (released.delete(reply.id) || !held.has(reply.id)) {
      held.delete(reply.id)
      deliver(reply)
    } else {
      held.set(reply.id, reply)
    }
  })
  const releaseOne = (id: number) => {
    const reply = held.get(id)
    held.delete(id)
    if (reply) deliver(reply)
    else released.add(id)
  }
  const lane: InProcessLane = {
    onmessage: null,
    onerror: null,
    requests,
    replies,
    get terminated() {
      return terminated
    },
    postMessage(message) {
      if (terminated) return
      requests.push(message)
      if (holding === 'all' || holding?.has(message.op)) held.set(message.id, null)
      handler.receive(message)
    },
    terminate() {
      terminated = true
      held = new Map()
      released.clear()
    },
    hold(ops) {
      holding = ops ? new Set(ops) : 'all'
    },
    release(request) {
      if (request) {
        if (!held.has(request.id)) throw new Error(`request ${request.id} (${request.op}) is not held`)
        releaseOne(request.id)
        return
      }
      holding = null
      for (const id of [...held.keys()]) releaseOne(id)
    },
    renders: () => requests.filter((request): request is Extract<RasterWorkerRequest, { op: 'render' }> => request.op === 'render'),
  }
  return lane
}

/**
 * Stubs `fetch` to serve the wasm binaries from disk and `fixtures` by byte
 * range, and the canvas cog-tiler encodes with by a raw-RGBA stand-in. Undo
 * with `vi.unstubAllGlobals()`.
 */
export function serveRasterFixtures(fixtures: RasterFixtures): void {
  const bytesOf = typeof fixtures === 'function' ? fixtures : (url: string) => fixtures[url]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
    if (url.startsWith('file:')) {
      return new Response(new Uint8Array(readFileSync(fileURLToPath(String(url)))), { headers: { 'Content-Type': 'application/wasm' } })
    }
    const tif = bytesOf(url)
    if (!tif) return new Response(null, { status: 404 })
    const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init?.headers).get('Range') ?? '')
    if (!range) return new Response(new Uint8Array(tif))
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]) + 1, tif.length) : tif.length
    return new Response(tif.slice(start, end), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end - 1}/${tif.length}` } })
  }))
  vi.stubGlobal('ImageData', RawImageData)
  vi.stubGlobal('OffscreenCanvas', RawOffscreenCanvas)
}

/** Opaque pixels of a tile encoded through the stand-in canvas (raw RGBA). */
export function opaquePixels(tile: Uint8Array | Uint8ClampedArray): number {
  let count = 0
  for (let index = 3; index < tile.length; index += 4) if (tile[index] !== 0) count += 1
  return count
}

/**
 * cog-tiler's `rgbaToPng` is browser-only (OffscreenCanvas). The stand-in's
 * "PNG" is the raw RGBA, so a tile's opaque pixels can be counted.
 */
class RawImageData {
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
}

class RawOffscreenCanvas {
  private image: RawImageData | null = null
  constructor(readonly width: number, readonly height: number) {}
  getContext() {
    return { putImageData: (image: RawImageData) => { this.image = image } }
  }
  async convertToBlob() {
    return new Blob([new Uint8Array(this.image?.data ?? new Uint8ClampedArray(this.width * this.height * 4))])
  }
}
