/**
 * The display seam through its real implementations: a derivative the Rust
 * engine wrote (`fixtures/rust-display-cog.tif`, an RD New tile near Delft,
 * kept current by `display_cog::library_tests::the_web_display_fixture_is_what_the_engine_writes`)
 * opened by the pinned `cog-tiler-wasm`, its WebAssembly started in Node.
 * The lane opens it on cog-tiler's affine EPSG:3857 path, and at each probed
 * pixel centre cog-tiler reads the value native hover read there (A4). Cut
 * outliers' 2–98 % range comes from the lane's `statistics` op and lies within
 * 2 % of the span of the exact percentiles of every pixel.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RasterBandStatistics, RasterWorkerReply } from './protocol'

interface Fixture {
  bounds: [number, number, number, number]
  nodata: number | null
  width: number
  height: number
  probes: { longitude: number; latitude: number; value: number | null }[]
}

const fixtureUrl = new URL('./fixtures/rust-display-cog.tif', import.meta.url)
const tif = new Uint8Array(readFileSync(fileURLToPath(fixtureUrl)))
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/rust-display-cog.json', import.meta.url)), 'utf8')) as Fixture
const ASSET = 'asset://localhost/display-cog/rust-display-cog.tif'

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
  return new Response(tif.slice(start, end), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end - 1}/${tif.length}` },
  })
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(serve))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('a display derivative the Rust engine wrote', () => {
  it('opens in the worker lane on the EPSG:3857 path with the bounds Rust registered', async () => {
    const replies: RasterWorkerReply[] = []
    const { createRasterLane } = await import('./lane')
    const lane = createRasterLane((reply) => replies.push(reply))
    lane.receive({ op: 'open', id: 1, handle: 1, url: ASSET })
    await vi.waitFor(() => expect(replies).toHaveLength(1), { timeout: 10_000 })
    const reply = replies[0]!
    if (!reply.ok) throw new Error(reply.error)
    const metadata = reply.value as { boundsLonLat: number[] }
    metadata.boundsLonLat.forEach((value, index) => expect(value).toBeCloseTo(fixture.bounds[index]!, 9))
  })

  it('reads at each pixel centre the value native hover read there', async () => {
    const { init, openCog } = await import('cog-tiler-wasm')
    await init()
    const source = await openCog(tif)
    expect(source.mode).toBe('3857')
    expect(source.levels[0]).toMatchObject({ width: fixture.width, height: fixture.height })
    const valued = fixture.probes.filter((probe) => probe.value !== null)
    expect(valued.length).toBeGreaterThan(5)
    expect(fixture.probes.length - valued.length).toBeGreaterThan(0)
    for (const probe of fixture.probes) {
      const read = await source.point(probe.longitude, probe.latitude)
      expect(read.outside, `${probe.longitude}, ${probe.latitude}`).toBeUndefined()
      const value = read.values[0]!
      const empty = Number.isNaN(value) || value === fixture.nodata
      expect(empty ? null : value, `${probe.longitude}, ${probe.latitude}`).toBe(probe.value)
    }
  })

  it('gives Cut outliers a 2–98 % range within 2 % of the exact percentiles of every pixel', async () => {
    const { init, openCog } = await import('cog-tiler-wasm')
    await init()
    const source = await openCog(tif)
    // Every pixel centre on the 3857 grid the COG is written in.
    const toMercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
    const fromMercY = (y: number) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90
    const [west, south, east, north] = fixture.bounds
    const [top, bottom] = [toMercY(north), toMercY(south)]
    const values: number[] = []
    for (let row = 0; row < fixture.height; row += 1) {
      for (let column = 0; column < fixture.width; column += 1) {
        const lon = west + ((column + 0.5) / fixture.width) * (east - west)
        const lat = fromMercY(top + ((row + 0.5) / fixture.height) * (bottom - top))
        const value = (await source.point(lon, lat)).values[0]!
        if (!Number.isNaN(value) && value !== fixture.nodata) values.push(value)
      }
    }
    values.sort((a, b) => a - b)
    const exact = (percent: number) => values[Math.min(values.length - 1, Math.floor((percent / 100) * values.length))]!
    const span = values.at(-1)! - values[0]!

    const replies: RasterWorkerReply[] = []
    const { createRasterLane } = await import('./lane')
    const lane = createRasterLane((reply) => replies.push(reply))
    lane.receive({ op: 'open', id: 1, handle: 7, url: ASSET })
    lane.receive({ op: 'statistics', id: 2, handle: 7 })
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 10_000 })
    const reply = replies.find((candidate) => candidate.id === 2)!
    if (!reply.ok) throw new Error(reply.error)
    const statistics = reply.value as RasterBandStatistics
    expect(Math.abs(statistics.percentile2 - exact(2))).toBeLessThanOrEqual(0.02 * span)
    expect(Math.abs(statistics.percentile98 - exact(98))).toBeLessThanOrEqual(0.02 * span)
    expect(statistics.min).toBe(values[0])
    expect(statistics.max).toBe(values.at(-1))
    expect(statistics.histogram).toHaveLength(128)
    expect(statistics.histogram.reduce((sum, count) => sum + count, 0)).toBe(values.length)
    // The fixture is under 512² pixels: its full-resolution level is read, every pixel, valid or not.
    expect(fixture.width * fixture.height).toBeLessThanOrEqual(512 * 512)
    expect(statistics.pixels).toBe(fixture.width * fixture.height)
  })
})

interface ReliefFixture {
  zoom: number
  nodata: number
  bounds: [number, number, number, number]
  levels: number
}

const relief = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/rust-display-relief.json', import.meta.url)), 'utf8')) as ReliefFixture
const reliefTif = readFileSync(fileURLToPath(new URL('./fixtures/rust-display-relief.tif', import.meta.url)))

describe('a relief derivative the Rust engine wrote', () => {
  /**
   * Each tile pixel samples a level at its top-left corner (cog-tiler's
   * `_renderExtent`), bilinearly, which on the lattice is the stored pixel
   * whose corner it is. Where that pixel and its neighbours hold greys, the
   * drawn grey is the stored one within 1; where the 2×2 stored pixels around
   * the corner hold NoData the pixel is transparent. cog-tiler picks a tile's
   * level by comparing float resolutions (`_chooseLevel`), so a tile at an
   * overview's zoom may read another level (measured with cog-tiler-wasm
   * 0.4.0 near Delft: zooms 17 and 16 read level 0, 15 level 1 and 14
   * level 2): each tile at the item's zoom and three below draws one level's
   * greys exactly so, and each of the three levels is drawn.
   */
  it('draws the stored grey within 1 at its three finest levels, NoData transparent', async () => {
    const { init, openCog } = await import('cog-tiler-wasm')
    const { fromArrayBuffer } = await import('geotiff')
    await init()
    const bytes = new Uint8Array(reliefTif)
    const source = await openCog(bytes)
    expect(source.mode).toBe('3857')
    expect(source.levels).toHaveLength(relief.levels)
    const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const base = await tiff.getImage(0)
    const [ox, oy] = base.getOrigin() as [number, number]
    const [res0] = base.getResolution() as [number, number]
    const levels = await Promise.all(
      [0, 1, 2].map(async (index) => {
        const image = await tiff.getImage(index)
        const values = (await image.readRasters({ samples: [0], interleave: true })) as unknown as Float32Array
        return { width: image.getWidth(), height: image.getHeight(), values, pixel: res0 * 2 ** index }
      }),
    )
    const valid = (value: number | null) => value !== null && !Number.isNaN(value) && value !== relief.nodata
    const HALF_WORLD = 20_037_508.342_789_244
    const tileOf = (lon: number, lat: number, z: number) => {
      const rad = (lat * Math.PI) / 180
      return [
        Math.floor(((lon + 180) / 360) * 2 ** z),
        Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z),
      ] as const
    }
    /** Faults of `rgba`, tile (z, x, y), against `level`, and how many pixels were compared. */
    const check = (rgba: ArrayLike<number> | null, z: number, x: number, y: number, level: (typeof levels)[number]) => {
      const at = (column: number, row: number) =>
        column < 0 || row < 0 || column >= level.width || row >= level.height ? null : level.values[row * level.width + column]!
      const span = (2 * HALF_WORLD) / 2 ** z
      const result = { greys: 0, empty: 0, faults: [] as string[] }
      for (let py = 0; py < 256; py += 1) {
        for (let px = 0; px < 256; px += 1) {
          const column = Math.round((-HALF_WORLD + x * span + (px / 256) * span - ox) / level.pixel)
          const row = Math.round((oy - (HALF_WORLD - y * span - (py / 256) * span)) / level.pixel)
          const block = [at(column - 1, row - 1), at(column, row - 1), at(column - 1, row), at(column, row)]
          // The bilinear read's own neighbours, beyond the corner's block.
          const around = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => at(column + dx, row + dy)))
          const o = (py * 256 + px) * 4
          const [grey, alpha] = [rgba?.[o] ?? -1, rgba?.[o + 3] ?? 0]
          if (around.every(valid)) {
            result.greys += 1
            if (alpha !== 255 || Math.abs(grey - at(column, row)!) > 1) result.faults.push(`${column},${row}: ${grey}/${alpha} for ${at(column, row)}`)
          } else if (block.every((value) => !valid(value)) && block.some((value) => value !== null)) {
            result.empty += 1
            if (alpha !== 0) result.faults.push(`${column},${row}: NoData drawn with alpha ${alpha}`)
          }
        }
      }
      return result
    }
    const [west, south, east, north] = relief.bounds
    const drawnLevels = new Set<number>()
    const unmatched: string[] = []
    let empty = 0
    for (let k = 0; k < 4; k += 1) {
      const z = relief.zoom - k
      const [x0, y0] = tileOf(west, north, z)
      const [x1, y1] = tileOf(east, south, z)
      for (let x = x0; x <= x1; x += 1) {
        for (let y = y0; y <= y1; y += 1) {
          const rgba = await source.renderTileRGBA(z, x, y, { colormap: 'gray', rescale: [[0, 255]], nodata: relief.nodata })
          const checks = levels.map((level) => check(rgba, z, x, y, level))
          const read = checks.findIndex((result) => result.faults.length === 0 && result.greys > 0)
          if (read < 0) {
            unmatched.push(`z${z} ${x},${y}: ${checks.map((result) => result.faults[0]).join(' | ')}`)
            continue
          }
          drawnLevels.add(read)
          empty += checks[read]!.empty
        }
      }
    }
    expect(unmatched).toEqual([])
    expect([...drawnLevels].sort()).toEqual([0, 1, 2])
    expect(empty).toBeGreaterThan(0)
  }, 60_000)
})

describe('the lane\'s statistics read', () => {
  afterAll(() => {
    vi.doUnmock('cog-tiler-wasm')
    vi.resetModules()
  })

  it('picks the overview by its pixel count, so a tall narrow raster is never read whole', async () => {
    const statistics = vi.fn(async (_options: { maxSize: number }) => ({ b1: { count: 0 } }))
    const levels = (sizes: [number, number][]) => sizes.map(([width, height]) => ({ width, height }))
    const opened = [
      // A corridor DTM: every level is under 1024 px wide; only the fifth holds at most 512² samples.
      levels([[900, 20000], [450, 10000], [225, 5000], [113, 2500], [57, 1250]]),
      levels([[2048, 2048], [1024, 1024], [512, 512], [256, 256]]),
    ]
    vi.doMock('cog-tiler-wasm', () => ({
      init: async () => {},
      rgbaToPng: async () => new Uint8Array(0),
      openCog: async () => ({ boundsLonLat: [0, 0, 1, 1], tileCache: new Map(), levels: opened.shift(), statistics }),
    }))
    const replies: RasterWorkerReply[] = []
    vi.resetModules()
    const { createRasterLane } = await import('./lane')
    const lane = createRasterLane((reply) => replies.push(reply))
    lane.receive({ op: 'open', id: 1, handle: 1, url: 'asset://localhost/corridor.tif' })
    lane.receive({ op: 'statistics', id: 2, handle: 1 })
    lane.receive({ op: 'open', id: 3, handle: 2, url: 'asset://localhost/square.tif' })
    lane.receive({ op: 'statistics', id: 4, handle: 2 })
    await vi.waitFor(() => expect(replies).toHaveLength(4))
    expect(replies.every((reply) => reply.ok)).toBe(true)
    expect(statistics.mock.calls).toEqual([[{ maxSize: 57 }], [{ maxSize: 512 }]])
  })

  it('reports the pixels of the overview it read, so a mosaic weighs each sample by the ground it covers', async () => {
    const band = { count: 3, min: 1, max: 9, percentile_2: 1, percentile_98: 9, histogram: [[1, 1, 1], [1, 4, 7, 9]] }
    vi.doMock('cog-tiler-wasm', () => ({
      init: async () => {},
      rgbaToPng: async () => new Uint8Array(0),
      openCog: async () => ({
        boundsLonLat: [0, 0, 1, 1],
        tileCache: new Map(),
        levels: [{ width: 4096, height: 1024 }, { width: 2048, height: 512 }, { width: 1024, height: 256 }],
        statistics: async () => ({ b1: band }),
      }),
    }))
    const replies: RasterWorkerReply[] = []
    vi.resetModules()
    const { createRasterLane } = await import('./lane')
    const lane = createRasterLane((reply) => replies.push(reply))
    lane.receive({ op: 'open', id: 1, handle: 1, url: 'asset://localhost/strip.tif' })
    lane.receive({ op: 'statistics', id: 2, handle: 1 })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    const reply = replies.find((candidate) => candidate.id === 2)!
    if (!reply.ok) throw new Error(reply.error)
    expect((reply.value as RasterBandStatistics).pixels).toBe(1024 * 256)
  })
})
