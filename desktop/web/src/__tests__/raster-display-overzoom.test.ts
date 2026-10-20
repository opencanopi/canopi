/**
 * Overzoomed display tiles through the real `cog-tiler-wasm` on a relief
 * derivative the Rust engine wrote (`fixtures/rust-display-relief.tif`,
 * native z17). Past the native zoom, cog-tiler 0.4.0 holds the last source
 * pixel of each tile flat and samples at pixel corners, so adjacent tiles meet
 * on a step; the lane draws those tiles from the native ancestor instead. At
 * and below the native zoom the lane's tiles are upstream's, byte for byte.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CogSource, RenderOptions } from 'cog-tiler-wasm'
import type { RasterWorkerReply, RasterWorkerRequest } from '../maplibre/raster-display/protocol'
import { renderTile } from '../maplibre/raster-display/overzoom'

const fixtures = new URL('../maplibre/raster-display/fixtures/', import.meta.url)
const relief = JSON.parse(readFileSync(fileURLToPath(new URL('rust-display-relief.json', fixtures)), 'utf8')) as {
  zoom: number
  nodata: number
  bounds: [number, number, number, number]
}
const render: RenderOptions = { colormap: 'gray', rescale: [[0, 255]], nodata: relief.nodata } as RenderOptions
const TILE = 256
const tif = new Uint8Array(readFileSync(fileURLToPath(new URL('rust-display-relief.tif', fixtures))))
const ASSET = 'asset://localhost/display-cog/rust-display-relief.tif'

/** Serves the wasm binaries from disk and the derivative by byte range, as the asset protocol does. */
async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
  if (url.startsWith('file:')) {
    return new Response(new Uint8Array(readFileSync(fileURLToPath(url))), { headers: { 'Content-Type': 'application/wasm' } })
  }
  if (url !== ASSET) return new Response(null, { status: 404 })
  const range = /bytes=(\d+)-(\d*)/.exec(new Headers(init?.headers).get('Range') ?? '')
  if (!range) return new Response(tif)
  const start = Number(range[1])
  const end = range[2] ? Math.min(Number(range[2]) + 1, tif.length) : tif.length
  return new Response(tif.slice(start, end), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end - 1}/${tif.length}` } })
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(serve))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

async function openRelief(): Promise<CogSource> {
  const { init, openCog } = await import('cog-tiler-wasm')
  await init()
  return openCog(tif)
}

const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z)
const tileY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
}

type Rgba = ArrayLike<number> | null
const grey = (image: Rgba, column: number, row: number) => image?.[(row * TILE + column) * 4] ?? 0
const opaque = (image: Rgba, column: number, row: number) => (image?.[(row * TILE + column) * 4 + 3] ?? 0) !== 0

/**
 * Mean grey step across the edges a tile shares with its east and south
 * neighbours, and mean step across its own middle, over opaque pixel pairs.
 */
async function steps(draw: (z: number, x: number, y: number) => Promise<Rgba>, z: number) {
  const [west, south, east, north] = relief.bounds
  let seam = 0
  let seamPairs = 0
  let inner = 0
  let innerPairs = 0
  for (let i = 0; i < 6; i += 1) {
    const x = tileX(west + (east - west) * (0.2 + 0.1 * i), z)
    const y = tileY(south + (north - south) * (0.3 + 0.07 * i), z)
    const [here, right, below] = await Promise.all([draw(z, x, y), draw(z, x + 1, y), draw(z, x, y + 1)])
    for (let k = 0; k < TILE; k += 1) {
      const pairs: [Rgba, number, number, Rgba, number, number, boolean][] = [
        [here, TILE - 1, k, right, 0, k, true],
        [here, k, TILE - 1, below, k, 0, true],
        [here, TILE / 2 - 1, k, here, TILE / 2, k, false],
        [here, k, TILE / 2 - 1, here, k, TILE / 2, false],
      ]
      for (const [a, ac, ar, b, bc, br, across] of pairs) {
        if (!opaque(a, ac, ar) || !opaque(b, bc, br)) continue
        const step = Math.abs(grey(a, ac, ar) - grey(b, bc, br))
        if (across) {
          seam += step
          seamPairs += 1
        } else {
          inner += step
          innerPairs += 1
        }
      }
    }
  }
  expect(seamPairs).toBeGreaterThan(1000)
  expect(innerPairs).toBeGreaterThan(1000)
  return { seam: seam / seamPairs, inner: inner / innerPairs }
}

describe('overzoomed display tiles', () => {
  it('draws upstream\'s tiles byte for byte at and below the native zoom', async () => {
    const source = await openRelief()
    const [west, south, east, north] = relief.bounds
    for (const z of [relief.zoom, relief.zoom - 1, relief.zoom - 2]) {
      const x = tileX((west + east) / 2, z)
      const y = tileY((south + north) / 2, z)
      const upstream = await source.renderTileRGBA(z, x, y, render)
      const drawn = await renderTile(source, z, x, y, render, new Map())
      expect(upstream).not.toBeNull()
      expect(drawn).toEqual(upstream)
    }
  }, 60_000)

  it.each([2, 4])('meets its neighbour without a step at the native zoom + %i', async (above) => {
    const source = await openRelief()
    const cache = new Map()
    const { seam, inner } = await steps((z, x, y) => renderTile(source, z, x, y, render, cache), relief.zoom + above)
    expect(inner).toBeGreaterThan(0)
    expect(seam).toBeLessThanOrEqual(1.5 * inner)
  }, 60_000)

  it('draws each output pixel at its centre: the native tile\'s bilinear value at that ground point', async () => {
    const source = await openRelief()
    const z = relief.zoom + 2
    const factor = 4
    const [west, south, east, north] = relief.bounds
    const x = tileX(west + (east - west) * 0.4, z)
    const y = tileY(south + (north - south) * 0.5, z)
    const nativeTile = await source.renderTileRGBA(relief.zoom, Math.floor(x / factor), Math.floor(y / factor), render)
    const drawn = await renderTile(source, z, x, y, render, new Map())
    let compared = 0
    const faults: string[] = []
    for (let py = 0; py < TILE; py += 5) {
      for (let px = 0; px < TILE; px += 5) {
        // Native tile pixel i holds the value at its centre, i + 0.5.
        const u = ((x % factor) * TILE + px + 0.5) / factor - 0.5
        const v = ((y % factor) * TILE + py + 0.5) / factor - 0.5
        const c = Math.floor(u)
        const r = Math.floor(v)
        if (c < 0 || r < 0 || c + 1 >= TILE || r + 1 >= TILE) continue
        if (![[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]].every(([cc, rr]) => opaque(nativeTile, cc!, rr!))) continue
        const tx = u - c
        const ty = v - r
        const top = grey(nativeTile, c, r) * (1 - tx) + grey(nativeTile, c + 1, r) * tx
        const bottom = grey(nativeTile, c, r + 1) * (1 - tx) + grey(nativeTile, c + 1, r + 1) * tx
        const expected = top * (1 - ty) + bottom * ty
        compared += 1
        if (Math.abs(grey(drawn, px, py) - expected) > 1) faults.push(`${px},${py}: ${grey(drawn, px, py)} for ${expected.toFixed(2)}`)
      }
    }
    expect(compared).toBeGreaterThan(1000)
    expect(faults).toEqual([])
  }, 60_000)

  it('renders each native ancestor once for the tiles under it', async () => {
    const source = await openRelief()
    const bbox = vi.spyOn(source, 'bbox')
    const z = relief.zoom + 2
    const [west, south, east, north] = relief.bounds
    const x = tileX((west + east) / 2, z) & ~3
    const y = tileY((south + north) / 2, z) & ~3
    const cache = new Map()
    await Promise.all([renderTile(source, z, x, y, render, cache), renderTile(source, z, x + 1, y, render, cache)])
    await renderTile(source, z, x, y + 1, render, cache)
    expect(bbox).toHaveBeenCalledTimes(1)
    await renderTile(source, z, x, y, { ...render, colormap: 'viridis' } as RenderOptions, cache)
    expect(bbox).toHaveBeenCalledTimes(2)
  }, 60_000)

  it('leaves a source whose native zoom is not a whole zoom to upstream', async () => {
    const upstream = new Uint8Array(TILE * TILE * 4)
    const source = {
      mode: '3857' as const,
      boundsLonLat: [4.36, 52.01, 4.37, 52.012],
      levels: [{ width: 1000 }],
      renderTileRGBA: vi.fn(async () => upstream),
      bbox: vi.fn(),
    }
    expect(await renderTile(source, 22, 1, 2, render, new Map())).toBe(upstream)
    expect(source.renderTileRGBA).toHaveBeenCalledWith(22, 1, 2, render)
    expect(source.bbox).not.toHaveBeenCalled()
  })

  it('leaves a source cog-tiler warps itself to upstream', async () => {
    const upstream = new Uint8Array(TILE * TILE * 4)
    const source = {
      mode: 'warp' as const,
      boundsLonLat: [0, 0, 1, 1],
      levels: [{ width: 256 }],
      renderTileRGBA: vi.fn(async () => upstream),
      bbox: vi.fn(),
    }
    expect(await renderTile(source, 22, 1, 2, render, new Map())).toBe(upstream)
    expect(source.bbox).not.toHaveBeenCalled()
  })

  it('is how the worker lane draws a tile, past the native zoom and at it', async () => {
    const replies: RasterWorkerReply[] = []
    const { createRasterLane } = await import('../maplibre/raster-display/lane')
    const lane = createRasterLane((reply) => replies.push(reply))
    const send = (request: RasterWorkerRequest) => lane.receive(request)
    const [west, south, east, north] = relief.bounds
    const tiles = [relief.zoom + 4, relief.zoom].map((z) => ({ z, x: tileX((west + east) / 2, z), y: tileY((south + north) / 2, z) }))
    send({ op: 'open', id: 1, handle: 1, url: ASSET })
    tiles.forEach((tile, index) => send({ op: 'render', id: 2 + index, handle: 1, ...tile, render, encoding: 'rgba' } as RasterWorkerRequest))
    await vi.waitFor(() => expect(replies).toHaveLength(3), { timeout: 10_000 })
    const source = await openRelief()
    for (const [index, { z, x, y }] of tiles.entries()) {
      const reply = replies.find((candidate) => candidate.id === 2 + index)!
      if (!reply.ok) throw new Error(reply.error)
      expect(new Uint8ClampedArray(reply.value as Uint8ClampedArray)).toEqual(new Uint8ClampedArray((await renderTile(source, z, x, y, render, new Map()))!))
    }
    send({ op: 'close', id: 9, handle: 1 })
    await vi.waitFor(() => expect(replies).toHaveLength(4))
  }, 60_000)
})
