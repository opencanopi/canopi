// @vitest-environment jsdom
/**
 * canopi-ana9 through the real implementations: the real `maplibre-gl-raster`
 * `LayerManager` (cog-tiler-wasm engine) on the real MapLibre `Style`, the real
 * `RasterWorkerPool`, and one in-process lane running `worker.ts` with the
 * pinned `cog-tiler-wasm` WebAssembly started in Node. The Rust-written seam
 * derivatives (`fixtures/rust-display-seam-{a,b}.tif`) are served by byte
 * range, as the asset protocol does.
 *
 * A two-asset item is a mosaic. Its tile is rendered through the engine's own
 * protocol handler (`CogTilerEngine._handleTile`, the function MapLibre's
 * `addProtocol` calls), drawn, removed (hide, or a ramp change that switches
 * the variant), and drawn again; the same tile must still be drawn.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RasterWorkerReply, RasterWorkerRequest } from './protocol'
import { RasterWorkerPool, type RasterWorkerLike } from './pool'
import { createRasterDisplay, type RasterDisplayLayer } from './adapter'

interface SeamFixture {
  zoom: number
  nodata: number
  range: [number, number]
  top: { asset: string; bounds: [number, number, number, number] }[]
  under: { asset: string; bounds: [number, number, number, number] }
}

// jsdom's URL is not Node's, so fixture paths are built as strings.
const fixtures = join(dirname(fileURLToPath(String(import.meta.url))), 'fixtures')
const fixture = JSON.parse(readFileSync(join(fixtures, 'rust-display-seam.json'), 'utf8')) as SeamFixture
const ASSET_PREFIX = 'asset://localhost/display-cog/'
const files = new Map<string, Uint8Array>(
  [...fixture.top.map((entry) => entry.asset), fixture.under.asset].map((name) => [
    `${ASSET_PREFIX}${name}`,
    new Uint8Array(readFileSync(join(fixtures, name))),
  ]),
)

/** Serves the wasm binaries from disk and the derivatives by byte range. */
async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
  if (url.startsWith('file:')) {
    return new Response(new Uint8Array(readFileSync(fileURLToPath(String(url)))), { headers: { 'Content-Type': 'application/wasm' } })
  }
  const tif = files.get(url)
  if (!tif) return new Response(null, { status: 404 })
  const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init?.headers).get('Range') ?? '')
  if (!range) return new Response(new Uint8Array(tif))
  const start = Number(range[1])
  const end = range[2] ? Math.min(Number(range[2]) + 1, tif.length) : tif.length
  return new Response(tif.slice(start, end), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end - 1}/${tif.length}` } })
}

/** One lane running the real `worker.ts` in this process. */
async function inProcessLane(): Promise<RasterWorkerLike> {
  const scope: {
    onmessage: ((event: MessageEvent<RasterWorkerRequest>) => void) | null
    postMessage(message: RasterWorkerReply): void
  } = { onmessage: null, postMessage: () => {} }
  // worker.ts binds `self` at import; put the page's back afterwards, since
  // maplibre-gl-raster's setImmediate shim reads `self` when it loads.
  const page = globalThis.self
  ;(globalThis as { self: unknown }).self = scope
  vi.resetModules()
  try {
    await import('./worker')
  } finally {
    ;(globalThis as { self: unknown }).self = page
  }
  const lane: RasterWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      scope.onmessage?.({ data: message } as MessageEvent<RasterWorkerRequest>)
    },
    terminate() {
      scope.onmessage = null
    },
  }
  scope.postMessage = (reply) => lane.onmessage?.({ data: reply } as MessageEvent<RasterWorkerReply>)
  return lane
}

interface Engine {
  _protocol: string
  _handleTile(url: string): Promise<Uint8Array>
  _assetSources: Map<string, unknown>
}

async function realMap() {
  // MapLibre's style needs workers only for messages this test never reads.
  vi.stubGlobal('Worker', class { postMessage() {} addEventListener() {} removeEventListener() {} terminate() {} })
  const { Map: MapLibreMap, Style } = await import('maplibre-gl')
  const map = Object.create(MapLibreMap.prototype) as InstanceType<typeof MapLibreMap> & Record<string, unknown>
  Object.assign(map, {
    _getMapId: () => 1,
    _requestManager: { transformRequest: (url: string) => ({ url }) },
    _update: () => map,
    migrateProjection() {},
    getTerrain: () => null,
    triggerRepaint() {},
    isStyleLoaded: () => true,
    // The camera over the seam fixture at the item's zoom, for the pool's tile relevance.
    getZoom: () => fixture.zoom,
    getBounds: () => {
      const [west, south, east, north] = fixture.under.bounds
      return { getWest: () => west, getSouth: () => south, getEast: () => east, getNorth: () => north }
    },
  })
  const style = new Style(map, {}) as unknown as { _loaded: boolean; stylesheet: unknown; _order: string[] }
  style._loaded = true
  style.stylesheet = { version: 8, sources: {}, layers: [] }
  map.style = style as never
  return { map, style }
}

async function setup() {
  const lane = await inProcessLane()
  const { map, style } = await realMap()
  const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 64 * 1024 * 1024, maxInFlightPerLane: 4, createWorker: () => lane })
  const engines: Engine[] = []
  const display = createRasterDisplay(map as never, {
    pool,
    loadRasterModule: async () => {
      const module = await import('maplibre-gl-raster')
      class Spy extends module.LayerManager {
        constructor(...args: ConstructorParameters<typeof module.LayerManager>) {
          super(...args)
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          const manager = this as unknown as { _cogEngine: Engine | null }
          engines.push(new Proxy({} as Engine, { get: (_, key) => (manager._cogEngine as unknown as Record<string | symbol, unknown>)[key] }))
        }
      }
      return { ...module, LayerManager: Spy } as never
    },
  })
  /** Waits until the layer is on the style, then renders tile z/x/y of it through the engine's protocol handler. */
  const tile = async (id: string, z: number, x: number, y: number) => {
    await vi.waitFor(() => {
      expect(style._order.some((layerId) => layerId.includes(id))).toBe(true)
      expect(engines[0]?._protocol).toBeTruthy()
    }, { timeout: 10_000 })
    const engine = engines[0]!
    return engine._handleTile(`${engine._protocol}://${id}/${z}/${x}/${y}`)
  }
  const empty = async () => {
    const engine = engines[0]!
    return engine._handleTile(`${engine._protocol}://no-such-layer/0/0/0`)
  }
  return { display, tile, empty, engines, style }
}

const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z)
const tileY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
}

function item(id: string, assets: readonly { asset: string; bounds: [number, number, number, number] }[], colormap = 'gray'): RasterDisplayLayer {
  const west = Math.min(...assets.map((entry) => entry.bounds[0]))
  const south = Math.min(...assets.map((entry) => entry.bounds[1]))
  const east = Math.max(...assets.map((entry) => entry.bounds[2]))
  const north = Math.max(...assets.map((entry) => entry.bounds[3]))
  return {
    id,
    name: id,
    assets: assets.map((entry) => ({ url: `${ASSET_PREFIX}${entry.asset}`, bbox: entry.bounds })),
    bounds: [west, south, east, north],
    opacity: 1,
    rescale: fixture.range,
    colormap,
    reversed: false,
  }
}

/** A tile inside the first top asset, at the item's zoom. */
const [aWest, aSouth, aEast, aNorth] = fixture.top[0]!.bounds
const Z = fixture.zoom
const X = tileX((aWest + aEast) / 2, Z)
const Y = tileY((aSouth + aNorth) / 2, Z)

/** Opaque pixels of a tile the engine returned (raw RGBA here, see RawOffscreenCanvas). */
function opaquePixels(tile: Uint8Array): number {
  let count = 0
  for (let index = 3; index < tile.length; index += 4) if (tile[index] !== 0) count += 1
  return count
}

/**
 * cog-tiler's `rgbaToPng` is browser-only (OffscreenCanvas). The one stand-in
 * in this test: its "PNG" is the raw RGBA, so a tile's opaque pixels can be
 * counted. Everything else is the real code.
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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(serve))
  vi.stubGlobal('ImageData', RawImageData)
  vi.stubGlobal('OffscreenCanvas', RawOffscreenCanvas)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('canopi-ana9: a Site data mosaic drawn again after it left the map', () => {
  it.fails('canopi-ana9: a two-asset item hidden and shown again still draws its tile ([A] -> [] -> [A])', async () => {
    const { display, tile, empty } = await setup()
    const mosaic = item('lidar-heights-gen1', fixture.top)
    display.sync([mosaic], undefined)
    const first = await tile(mosaic.id, Z, X, Y)
    const blank = await empty()
    expect(first.byteLength, 'first draw is a real tile').toBeGreaterThan(blank.byteLength)
    expect(opaquePixels(first)).toBeGreaterThan(0)

    display.sync([], undefined)
    display.sync([mosaic], undefined)
    const again = await tile(mosaic.id, Z, X, Y)
    expect(again, 'the same tile after hide/show is not the engine\'s EMPTY_TILE').not.toEqual(blank)
    expect(again.byteLength).toBe(first.byteLength)
    display.dispose()
  }, 60_000)

  it.fails('canopi-ana9: a ramp change to another variant and back still draws the mosaic ([A] -> [B] -> [A])', async () => {
    const { display, tile, empty } = await setup()
    // The bead's path: Terrain on heights, then Relief (another derivative under
    // another layer id, drawn in another ramp), then back.
    const heights = item('lidar-heights-gen1', fixture.top, 'terrain')
    const relief = item('lidar-heights-relief-gen1', [fixture.under], 'gray')
    display.sync([heights], undefined)
    const first = await tile(heights.id, Z, X, Y)
    const blank = await empty()
    expect(first.byteLength).toBeGreaterThan(blank.byteLength)

    display.sync([relief], undefined)
    const reliefTile = await tile(relief.id, Z, X, Y)
    expect(reliefTile.byteLength).toBeGreaterThan(blank.byteLength)

    display.sync([heights], undefined)
    const again = await tile(heights.id, Z, X, Y)
    expect(again, 'the mosaic tile after Relief and back is not EMPTY_TILE').not.toEqual(blank)
    display.dispose()
  }, 60_000)

  it('mechanism: the engine keeps the mosaic asset proxy by URL, and the pool refuses it once the layer left', async () => {
    const { display, tile, engines } = await setup()
    const mosaic = item('lidar-heights-gen1', fixture.top)
    display.sync([mosaic], undefined)
    await tile(mosaic.id, Z, X, Y)
    const url = mosaic.assets[0]!.url
    const before = engines[0]!._assetSources.get(url)
    expect(before).toBeDefined()
    display.sync([], undefined)
    // Upstream drops the layer but keeps `_assetSources` until destroy().
    expect(engines[0]!._assetSources.get(url)).toBe(before)
    display.sync([mosaic], undefined)
    await tile(mosaic.id, Z, X, Y)
    expect(engines[0]!._assetSources.get(url), 'the re-added mosaic reads the same cached proxy').toBe(before)
    const proxy = (await before) as { renderTileRGBA(z: number, x: number, y: number, render: unknown): Promise<unknown> }
    await expect(proxy.renderTileRGBA(Z, X, Y, {})).rejects.toThrow('Raster source is released')
    display.dispose()
  }, 60_000)

  it('control: a single-asset item hidden and shown again draws its tile (the engine reopens per layer)', async () => {
    const { display, tile, empty } = await setup()
    const single = item('lidar-under-gen1', [fixture.under])
    display.sync([single], undefined)
    const first = await tile(single.id, Z, X, Y)
    const blank = await empty()
    expect(first.byteLength).toBeGreaterThan(blank.byteLength)
    display.sync([], undefined)
    display.sync([single], undefined)
    // The engine opens a fresh source for the re-added layer; wait for it.
    await vi.waitFor(async () => {
      expect((await tile(single.id, Z, X, Y)).byteLength).toBe(first.byteLength)
    }, { timeout: 10_000 })
    display.dispose()
  }, 60_000)
})
