// @vitest-environment jsdom
/**
 * canopi-ana9 through the real implementations: the real `maplibre-gl-raster`
 * `LayerManager` (cog-tiler-wasm engine) on the real MapLibre `Style`, the real
 * `RasterWorkerPool`, and one in-process lane running the real lane handler
 * (`__tests__/support/raster-lane.ts`). The Rust-written seam derivatives
 * (`fixtures/rust-display-seam-{a,b}.tif`) are served by byte range, as the
 * asset protocol does.
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
import { RasterWorkerPool } from './pool'
import { createRasterDisplay, type RasterDisplayLayer } from './adapter'
import type { RasterWorkerRequest } from './protocol'
import { inProcessLane, opaquePixels, serveRasterFixtures } from '../../__tests__/support/raster-lane'

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
const files = Object.fromEntries(
  [...fixture.top.map((entry) => entry.asset), fixture.under.asset].map((name) => [
    `${ASSET_PREFIX}${name}`,
    new Uint8Array(readFileSync(join(fixtures, name))),
  ]),
)

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
  const lane = inProcessLane()
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
  return { display, tile, empty, engines, requests: lane.requests }
}

/** URLs of the worker sources the lane holds open (opened, not yet closed), one entry per handle. */
function liveSources(requests: readonly RasterWorkerRequest[]): string[] {
  const open = new Map<number, string>()
  for (const request of requests) {
    if (request.op === 'open') open.set(request.handle, request.url)
    else if (request.op === 'close') open.delete(request.handle)
  }
  return [...open.values()]
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

beforeEach(() => {
  serveRasterFixtures(files)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('canopi-ana9: a Site data mosaic drawn again after it left the map', () => {
  it('canopi-ana9: a two-asset item hidden and shown again still draws its tile ([A] -> [] -> [A])', async () => {
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

  it('canopi-ana9: a ramp change to another variant and back still draws the mosaic ([A] -> [B] -> [A])', async () => {
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

  /**
   * Pins maplibre-gl-raster 0.14.15's `CogTilerEngine._assetSources`: mosaic
   * asset proxies cached by URL until `destroy()` and reused when a mosaic is
   * added again (RasterControl chunk, `_openAsset`). If upstream starts
   * evicting it, this fails, and the display's URL-bound proxies
   * (`displaySources`) can hold one handle each again.
   */
  it('pin: the engine reuses a mosaic\'s cached asset proxy after the layer left, and that proxy still draws', async () => {
    const { display, tile, engines } = await setup()
    const mosaic = item('lidar-heights-gen1', fixture.top)
    display.sync([mosaic], undefined)
    await tile(mosaic.id, Z, X, Y)
    const url = mosaic.assets[0]!.url
    const before = engines[0]!._assetSources.get(url)
    expect(before).toBeDefined()
    display.sync([], undefined)
    expect(engines[0]!._assetSources.get(url), 'upstream keeps the proxy after the layer left').toBe(before)
    display.sync([mosaic], undefined)
    await tile(mosaic.id, Z, X, Y)
    expect(engines[0]!._assetSources.get(url), 'the re-added mosaic reads the same cached proxy').toBe(before)
    const proxy = (await before) as { renderTileRGBA(z: number, x: number, y: number, render: unknown): Promise<Uint8ClampedArray | null> }
    expect(opaquePixels((await proxy.renderTileRGBA(Z, X, Y, {}))!)).toBeGreaterThan(0)
    display.dispose()
  }, 60_000)

  it('canopi-ana9: dispose closes every source the display opened, the kept mosaic assets included', async () => {
    const { display, tile, requests } = await setup()
    const mosaic = item('lidar-heights-gen1', fixture.top)
    const single = item('lidar-under-gen1', [fixture.under])
    display.sync([mosaic, single], undefined)
    await tile(mosaic.id, Z, X, Y)
    await tile(single.id, Z, X, Y)
    display.sync([], undefined)
    display.dispose()
    const handles = (op: 'open' | 'close') => new Set(requests.flatMap((request) => (request.op === op ? [request.handle] : [])))
    const opened = requests.flatMap((request) => (request.op === 'open' ? [request.url] : []))
    expect(opened, 'a mosaic asset and the single asset were opened').toEqual(expect.arrayContaining([mosaic.assets[0]!.url, single.assets[0]!.url]))
    expect([...handles('close')].sort()).toEqual([...handles('open')].sort())
  }, 60_000)

  it('canopi-ana9: a single layer on a shown mosaic\'s asset, hidden and shown again, opens one worker source per URL, all closed once nothing reads them', async () => {
    const { display, tile, requests } = await setup()
    const mosaic = item('lidar-heights-gen1', fixture.top)
    const single = item('lidar-tile-gen1', [fixture.top[0]!])
    display.sync([mosaic], undefined)
    await tile(mosaic.id, Z, X, Y)
    for (let round = 0; round < 3; round += 1) {
      display.sync([mosaic, single], undefined)
      await vi.waitFor(async () => expect(opaquePixels(await tile(single.id, Z, X, Y))).toBeGreaterThan(0), { timeout: 10_000 })
      display.sync([mosaic], undefined)
    }
    const urls = liveSources(requests)
    expect(urls, 'one live worker source per URL on the map').toEqual([...new Set(urls)])
    display.sync([], undefined)
    expect(liveSources(requests), 'nothing on the map, nothing open').toEqual([])
    display.dispose()
  }, 60_000)

  it('canopi-ana9: a mosaic replaced by a newer generation closes the asset sources only the old one read', async () => {
    const { display, tile, requests } = await setup()
    const [a, b] = fixture.top as [SeamFixture['under'], SeamFixture['under']]
    const gen1 = item('lidar-heights-gen1', [a, b])
    const gen2 = item('lidar-heights-gen2', [fixture.under, b])
    display.sync([gen1], undefined)
    await tile(gen1.id, Z, X, Y)
    expect(liveSources(requests)).toContain(gen1.assets[0]!.url)
    display.sync([gen2], undefined)
    await tile(gen2.id, Z, X, Y)
    expect(liveSources(requests), 'the superseded generation\'s own asset is closed').not.toContain(gen1.assets[0]!.url)
    display.sync([], undefined)
    expect(liveSources(requests)).toEqual([])
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
