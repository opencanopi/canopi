/**
 * Raster tile seams (canopi-f47t.49): adjacent derivatives of one item, and
 * an item drawn under them, read through the real `cog-tiler-wasm` and
 * composited as the display lane draws them, meet with no gap, no value step
 * and no under-line.
 *
 * The derivatives are what the Rust engine writes
 * (`display_cog::library_tests::the_web_seam_fixtures_are_what_the_engine_writes`):
 * a Lambert-93 plane split into two adjacent NoData-free sources (west on
 * top), and the whole plane as another item under them. Each XYZ tile over
 * them is rendered at the item's zoom and two overview zooms with the
 * layer-wide stretch, the two top assets composited with maplibre-gl-raster's
 * `paintUnder` (copied below: the mosaic engine does not export it), and
 * the under item behind them, as MapLibre stacks the two layers.
 *
 * Measured (2026-10-15, cog-tiler-wasm 0.4.0): at the item's zoom and its
 * two overview zooms, 622, 151 and 76 under-line pixels, 1, 1 and 0 gaps,
 * no steps. The cause is upstream: `CogSource._renderExtent`
 * (`cog-tiler.js`, `fx = (px / outW) * NG`) samples each output pixel at its
 * top-left corner, not its centre. On a lattice aligned with the XYZ tiles,
 * every corner lies exactly on a source pixel edge, so
 * `floor((sx - origin) / pixel)` takes either pixel by floating-point
 * rounding of each file's own origin: two files on one lattice are drawn up
 * to a pixel apart, and the item under them shows along an edge. Read at
 * pixel centres (`point`), the same derivatives meet exactly (the second
 * case), so Canopi's lattice, footprints and overviews are not the cause.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CogSource } from 'cog-tiler-wasm'

interface SeamFixture {
  zoom: number
  nodata: number
  range: [number, number]
  top: { asset: string; bounds: [number, number, number, number] }[]
  under: { asset: string; bounds: [number, number, number, number] }
}

const fixtures = new URL('./fixtures/', import.meta.url)
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('rust-display-seam.json', fixtures)), 'utf8')) as SeamFixture

interface SeamCounts {
  /** Pixels inside the item's footprint that the top item leaves transparent. */
  gaps: number
  /** Pixel pairs across the join of two derivatives whose grey step differs from the plane's by more than 2. */
  steps: number
  /** Pixels where the item underneath shows because the top item left them transparent. */
  underLines: number
}

const TILE = 256

/**
 * maplibre-gl-raster 0.x `paintUnder` (dist/RasterControl-*.js), verbatim:
 * fills only fully transparent destination pixels, so the first asset
 * listed keeps a pixel two assets cover.
 */
function paintUnder(dst: Uint8ClampedArray, src: Uint8Array | Uint8ClampedArray): boolean {
  let complete = true
  for (let i = 3; i < dst.length; i += 4) {
    if (dst[i] !== 0) continue
    if (src[i] === 0) {
      complete = false
      continue
    }
    dst[i - 3] = src[i - 3]!
    dst[i - 2] = src[i - 2]!
    dst[i - 1] = src[i - 1]!
    dst[i] = src[i]!
  }
  return complete
}

const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z)
const tileY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
}

async function open(asset: string): Promise<CogSource> {
  const { openCog } = await import('cog-tiler-wasm')
  return openCog(new Uint8Array(readFileSync(fileURLToPath(new URL(asset, fixtures)))))
}

/** Gaps, steps and under-lines over every tile of the fixture at `z`. */
async function countAt(z: number, top: CogSource[], under: CogSource): Promise<SeamCounts> {
  const render = { colormap: 'gray', rescale: [fixture.range] as [number, number][], nodata: fixture.nodata }
  const [west, south, east, north] = fixture.under.bounds
  const counts: SeamCounts = { gaps: 0, steps: 0, underLines: 0 }
  for (let x = tileX(west, z); x <= tileX(east, z); x += 1) {
    for (let y = tileY(north, z); y <= tileY(south, z); y += 1) {
      const drawn = new Uint8ClampedArray(TILE * TILE * 4)
      // Which top asset drew each pixel, -1 for none.
      const owner = new Int8Array(TILE * TILE).fill(-1)
      for (const [index, asset] of top.entries()) {
        const rgba = await asset.renderTileRGBA(z, x, y, render)
        if (!rgba?.length) continue
        const before = drawn.filter((_, i) => i % 4 === 3)
        paintUnder(drawn, rgba)
        for (let pixel = 0; pixel < owner.length; pixel += 1) {
          if (before[pixel] === 0 && drawn[pixel * 4 + 3] !== 0) owner[pixel] = index
        }
      }
      const below = (await under.renderTileRGBA(z, x, y, render)) ?? new Uint8Array(TILE * TILE * 4)
      const opaque = (image: ArrayLike<number>, column: number, row: number) =>
        column >= 0 && row >= 0 && column < TILE && row < TILE && image[(row * TILE + column) * 4 + 3] !== 0
      const deltas: number[] = []
      const joins: number[] = []
      for (let row = 0; row < TILE; row += 1) {
        for (let column = 0; column < TILE; column += 1) {
          const pixel = row * TILE + column
          if (!opaque(drawn, column, row) && opaque(below, column, row)) {
            counts.underLines += 1
            const inside = [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => opaque(below, column + dx, row + dy)))
            if (inside) counts.gaps += 1
          }
          if (column + 1 < TILE && opaque(drawn, column, row) && opaque(drawn, column + 1, row)) {
            const delta = drawn[(pixel + 1) * 4]! - drawn[pixel * 4]!
            if (owner[pixel] === owner[pixel + 1]) deltas.push(delta)
            else joins.push(delta)
          }
        }
      }
      if (!joins.length) continue
      deltas.sort((a, b) => a - b)
      const median = deltas[Math.floor(deltas.length / 2)] ?? 0
      counts.steps += joins.filter((delta) => Math.abs(delta - median) > 2).length
    }
  }
  return counts
}

/** Counts at the item's zoom (full resolution) and its first two overview zooms. */
async function seamCounts(): Promise<SeamCounts[]> {
  const { init } = await import('cog-tiler-wasm')
  await init()
  const top = await Promise.all(fixture.top.map((entry) => open(entry.asset)))
  const under = await open(fixture.under.asset)
  return Promise.all([0, 1, 2].map((level) => countAt(fixture.zoom - level, top, under)))
}

/** Serves the wasm binaries from disk, as the asset protocol does. */
async function serve(input: RequestInfo | URL): Promise<Response> {
  const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
  if (url.startsWith('file:')) {
    return new Response(new Uint8Array(readFileSync(fileURLToPath(url))), { headers: { 'Content-Type': 'application/wasm' } })
  }
  return new Response(null, { status: 404 })
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(serve))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

/** Web Mercator metres of a longitude and latitude. */
const HALF_WORLD = 20_037_508.342_789_244
const mercator = (lon: number, lat: number): [number, number] => [
  (lon / 180) * HALF_WORLD,
  (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) * HALF_WORLD,
]
const geographic = (x: number, y: number): [number, number] => [
  (x / HALF_WORLD) * 180,
  (Math.atan(Math.exp((y / HALF_WORLD) * Math.PI)) * 360) / Math.PI - 90,
]

describe('raster tile seams', () => {
  // upstream: W9
  it.fails('[expected-fail upstream cog-tiler-wasm corner sampling, canopi-xgvh] adjacent derivatives and an item under them meet with no gap, step or under-line', async () => {
    const counts = await seamCounts()
    expect(counts).toEqual([0, 1, 2].map(() => ({ gaps: 0, steps: 0, underLines: 0 })))
  }, 60_000)

  it('reads the derivatives at pixel centres as one plane: every pixel of the item under them is shown by exactly one top asset, with its value', async () => {
    const { init } = await import('cog-tiler-wasm')
    await init()
    const top = await Promise.all(fixture.top.map((entry) => open(entry.asset)))
    const under = await open(fixture.under.asset)
    const pixel = (2 * HALF_WORLD) / 256 / 2 ** fixture.zoom
    const [west, south, east, north] = fixture.under.bounds
    const [minX, minY] = mercator(west, south)
    const [maxX, maxY] = mercator(east, north)
    const read = async (source: CogSource, lon: number, lat: number) => {
      const value = (await source.point(lon, lat)).values[0]
      return value === undefined || Number.isNaN(value) || value === fixture.nodata ? null : value
    }
    let shown = 0
    const faults: string[] = []
    // Every fourth lattice row, every pixel across: the outer edges and the join.
    for (let row = Math.floor((HALF_WORLD - maxY) / pixel); row * pixel < HALF_WORLD - minY; row += 4) {
      for (let column = Math.floor((minX + HALF_WORLD) / pixel); column * pixel < maxX + HALF_WORLD; column += 1) {
        const [lon, lat] = geographic(-HALF_WORLD + (column + 0.5) * pixel, HALF_WORLD - (row + 0.5) * pixel)
        const below = await read(under, lon, lat)
        const above = await Promise.all(top.map((source) => read(source, lon, lat)))
        const drawn = above.filter((value) => value !== null)
        if (below === null && drawn.length === 0) continue
        shown += 1
        if (below === null || drawn.length !== 1 || drawn[0] !== below) faults.push(`${column},${row}: ${below} under ${above}`)
      }
    }
    expect(shown).toBeGreaterThan(5000)
    expect(faults).toEqual([])
  }, 60_000)
})
