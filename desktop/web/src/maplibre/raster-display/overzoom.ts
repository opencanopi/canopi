/**
 * Display tiles past a COG's native zoom, drawn from its native ancestor tile.
 *
 * `cog-tiler-wasm@0.4.0` reads each tile's source window with no halo and
 * samples output pixels at their corners. Past the native zoom one source
 * pixel spans many output pixels, so each tile holds its last source pixel
 * flat and the image shifts with zoom: adjacent tiles meet on a step. Here the
 * lane renders the native ancestor through the public `bbox` with a one-pixel
 * halo (at the native zoom upstream copies source pixels exactly), then
 * upsamples it bilinearly at output pixel centres, nearest where a corner is
 * transparent, as upstream does at NoData.
 *
 * At and below the native zoom, and for a source whose native zoom is not a
 * whole zoom (or that cog-tiler warps itself), tiles are upstream's unchanged.
 * Ancestors are cached in the caller's cache, which the lane charges to its
 * decoded-block budget; tiles of one screen share one or two ancestors.
 */
import type { CogSource, RenderOptions } from 'cog-tiler-wasm'

const TILE = 256
/** Ancestor window side: the native tile and one source pixel of halo each side. */
const WINDOW = TILE + 2
const HALF_WORLD = 20_037_508.342_789_244
/** How far from a whole zoom a native zoom may read, from float bounds, and still be one. */
const WHOLE_ZOOM_TOLERANCE = 1e-6

/** The part of an opened `CogSource` this module reads. */
interface OverzoomSource {
  readonly mode: CogSource['mode']
  readonly boundsLonLat: readonly number[]
  readonly levels: readonly { readonly width: number }[]
  renderTileRGBA(z: number, x: number, y: number, opts?: RenderOptions): Promise<Uint8Array | Uint8ClampedArray | null>
  bbox: CogSource['bbox']
}

/** A `Map`-like cache of ancestor windows; the lane's charges them to its budget. */
interface AncestorCache {
  get(key: string): Promise<unknown> | undefined
  set(key: string, value: Promise<unknown>): unknown
  delete(key: string): boolean
}

const mercatorX = (lon: number) => (lon / 180) * HALF_WORLD
const longitude = (x: number) => (x / HALF_WORLD) * 180
const latitude = (y: number) => (Math.atan(Math.exp((y / HALF_WORLD) * Math.PI)) * 360) / Math.PI - 90

/**
 * The XYZ zoom whose tile pixel is the source's full-resolution pixel, or null
 * when that is not a whole zoom or cog-tiler warps the source itself.
 */
function nativeZoomOf(source: Pick<OverzoomSource, 'mode' | 'boundsLonLat' | 'levels'>): number | null {
  if (source.mode !== '3857') return null
  const [west, , east] = source.boundsLonLat
  const width = source.levels[0]?.width
  if (west === undefined || east === undefined || !width) return null
  const pixel = (mercatorX(east) - mercatorX(west)) / width
  const zoom = Math.log2((2 * HALF_WORLD) / (TILE * pixel))
  const whole = Math.round(zoom)
  return Number.isFinite(zoom) && Math.abs(zoom - whole) < WHOLE_ZOOM_TOLERANCE ? whole : null
}

/** Tile (z, x, y) as `renderTileRGBA` returns it, drawn from the native ancestor past the native zoom. */
// upstream: W9
export async function renderTile(
  source: OverzoomSource,
  z: number,
  x: number,
  y: number,
  render: RenderOptions,
  cache: AncestorCache,
): Promise<Uint8Array | Uint8ClampedArray | null> {
  const native = nativeZoomOf(source)
  if (native === null || z <= native) return source.renderTileRGBA(z, x, y, render)
  const factor = 2 ** (z - native)
  const ax = Math.floor(x / factor)
  const ay = Math.floor(y / factor)
  // The halo would cross the antimeridian or the pole at the world's edge tiles.
  const last = 2 ** native - 1
  if (ax <= 0 || ay <= 0 || ax >= last || ay >= last) return source.renderTileRGBA(z, x, y, render)
  const window = await ancestorWindow(source, native, ax, ay, render, cache)
  if (!window) return null
  return upsample(window, x - ax * factor, y - ay * factor, factor)
}

/** The native tile (ax, ay) with one source pixel of halo, as RGBA `WINDOW`², or null when fully transparent. */
function ancestorWindow(
  source: OverzoomSource,
  native: number,
  ax: number,
  ay: number,
  render: RenderOptions,
  cache: AncestorCache,
): Promise<Uint8ClampedArray | null> {
  const key = `overzoom/${native}/${ax}/${ay}/${JSON.stringify(render)}`
  const cached = cache.get(key) as Promise<Uint8ClampedArray | null> | undefined
  if (cached) return cached
  const span = (2 * HALF_WORLD) / 2 ** native
  const pixel = span / TILE
  const bbox: [number, number, number, number] = [
    longitude(-HALF_WORLD + ax * span - pixel),
    latitude(HALF_WORLD - (ay + 1) * span - pixel),
    longitude(-HALF_WORLD + (ax + 1) * span + pixel),
    latitude(HALF_WORLD - ay * span + pixel),
  ]
  const pending = source.bbox(bbox, { ...render, width: WINDOW, height: WINDOW }).then(({ rgba }) => {
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return new Uint8ClampedArray(rgba)
    return null
  })
  cache.set(key, pending)
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key)
  })
  return pending
}

/**
 * Output tile (offsetX, offsetY) of the `factor`² tiles under an ancestor
 * window, sampled at output pixel centres. Window pixel i holds the value at
 * its centre i + 0.5 in window pixels; the halo shifts native pixels by one.
 * Null when every output pixel is transparent.
 */
function upsample(window: Uint8ClampedArray, offsetX: number, offsetY: number, factor: number): Uint8ClampedArray | null {
  const out = new Uint8ClampedArray(TILE * TILE * 4)
  const at = (column: number, row: number) => (row * WINDOW + column) * 4
  let any = false
  for (let py = 0; py < TILE; py += 1) {
    const v = (offsetY * TILE + py + 0.5) / factor + 0.5
    const r0 = Math.floor(v)
    const ty = v - r0
    for (let px = 0; px < TILE; px += 1) {
      const u = (offsetX * TILE + px + 0.5) / factor + 0.5
      const c0 = Math.floor(u)
      const tx = u - c0
      const o = (py * TILE + px) * 4
      const i00 = at(c0, r0)
      const i10 = at(c0 + 1, r0)
      const i01 = at(c0, r0 + 1)
      const i11 = at(c0 + 1, r0 + 1)
      if (window[i00 + 3] === 0 || window[i10 + 3] === 0 || window[i01 + 3] === 0 || window[i11 + 3] === 0) {
        const nearest = at(Math.min(Math.round(u), WINDOW - 1), Math.min(Math.round(v), WINDOW - 1))
        if (window[nearest + 3] === 0) continue
        for (let channel = 0; channel < 4; channel += 1) out[o + channel] = window[nearest + channel]!
        any = true
        continue
      }
      for (let channel = 0; channel < 4; channel += 1) {
        const top = window[i00 + channel]! + (window[i10 + channel]! - window[i00 + channel]!) * tx
        const bottom = window[i01 + channel]! + (window[i11 + channel]! - window[i01 + channel]!) * tx
        out[o + channel] = top + (bottom - top) * ty
      }
      any = true
    }
  }
  return any ? out : null
}
