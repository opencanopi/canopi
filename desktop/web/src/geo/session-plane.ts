// ---------------------------------------------------------------------------
// Owner of the session plane and scale-only-through-plane (ADR 0001, ADR 0016,
// contracts §20): the runtime's local WGS84 ground-metre frame for the open Design.
//
// Invariants: files store WGS84 lon/lat; tools, snapping, measurements, hit
// testing and PDF layout work in WGS84 ground metres. All zoom/latitude scale
// conversions go through this module (`pixelsPerMetre`, `zoomForPixelsPerMetre`,
// `groundScaleAt`, `groundLength`, `groundArea`).
// The plane is Web Mercator scaled per-axis at its anchor by the WGS84 radii
// (east-west by 2π·N0·cosφ0, north-south by 2π·M0·cosφ0), so a plane metre is
// a true ground metre at the anchor in every direction and the plane stays an
// exact affine image of the MapLibre Mercator surface. It is rebuilt at the
// view centre when the view moves more than 10 km away; stored lon/lat stays
// authoritative throughout.
// ---------------------------------------------------------------------------

import { WGS84_FLATTENING, WGS84_SEMI_MAJOR_AXIS_M } from '../generated/canopi-design-format'
import type { GeoPoint } from '../types/design'
import {
  MAPLIBRE_WORLD_TILE_SIZE,
  wgs84MetresPerMercatorAtLat,
  wgs84Radii,
} from './projection'
import { geoToMercator, mercatorToGeo } from './web-mercator'

declare const planePointBrand: unique symbol
declare const conformalPointBrand: unique symbol
declare const metresBrand: unique symbol
declare const squareMetresBrand: unique symbol

/** Ground length in true WGS84 metres (`SessionPlane.groundLength`, contracts §20). */
export type Metres = number & { readonly [metresBrand]: true }

/** Ground area in true WGS84 square metres (`SessionPlane.groundArea`, contracts §20). */
export type SquareMetres = number & { readonly [squareMetresBrand]: true }

/** Ground metres in the session plane (x east, y south). Distinct from `ConformalPoint` at compile time. */
export interface PlanePoint {
  readonly x: number
  readonly y: number
  readonly [planePointBrand]?: 'PlanePoint'
  readonly [conformalPointBrand]?: never
}

/** Point in the camera's conformal (screen-similar) Web Mercator metre frame. */
export interface ConformalPoint {
  readonly x: number
  readonly y: number
  readonly [conformalPointBrand]: 'ConformalPoint'
  readonly [planePointBrand]?: never
}

/** Brand a raw `{ x, y }` pair as a `ConformalPoint` (used by `geo/view/` placement maths). */
export function conformalPoint(x: number, y: number): ConformalPoint {
  return { x, y } as ConformalPoint
}

export const SESSION_PLANE_REORIGIN_DISTANCE_METERS = 10_000
export const DEFAULT_NEW_DESIGN_VIEW = Object.freeze({ lon: 13.0, lat: 23.0, zoom: 4 })

export interface SessionPlane {
  /** Anchor WGS84 position (the objects' bounds centre, or the view centre). */
  readonly origin: GeoPoint
  /** Alias for `origin` (contracts §20). */
  readonly anchor: GeoPoint
  /** Fixed per-axis factor (plane metres per conformal metre) at the anchor: `ax = sqrt(N0/M0)`, `ay = 1/ax` (`1, 1` for conformal fixtures). */
  readonly axisScale: { readonly ax: number; readonly ay: number }
  toPlane(point: GeoPoint): PlanePoint
  toGeo(point: PlanePoint): GeoPoint
  /** Alias for `toGeo` (contracts §20). */
  toGeoPoint(point: PlanePoint): GeoPoint
  /** Plane metres -> the camera's conformal (screen-similar) frame. */
  toView(point: PlanePoint): ConformalPoint
  /** Conformal frame -> plane metres. */
  fromView(point: ConformalPoint): PlanePoint
  /** CSS pixels per plane metre along x, y, and their geometric mean at a MapLibre zoom. */
  pixelsPerMetre(zoom: number): { readonly x: number; readonly y: number; readonly mean: number }
  /** Exact inverse of `pixelsPerMetre(zoom).mean`. */
  zoomForPixelsPerMetre(meanPixelsPerMetre: number): number
  /** True WGS84 ground length in metres between two plane points (< 1 ppm vs Vincenty over a 10 km site). */
  groundLength(a: PlanePoint, b: PlanePoint): Metres
  /** True WGS84 ground area in square metres of a simple polygon ring in plane metres (< 1 ppm over a 10 km site). */
  groundArea(ring: readonly PlanePoint[]): SquareMetres
  /** Local ground metres per plane metre at `point`, per axis (`{ x: 1, y: 1 }` at the anchor). */
  groundScaleAt(point: PlanePoint): { readonly x: number; readonly y: number }
  needsReorigin(viewCentre: PlanePoint): boolean
}

/** Ground-metre measurement subset of `SessionPlane` (contracts §20), passed to runtime, tools, summary and PDF. */
export type GroundMeasure = Pick<SessionPlane, 'groundLength' | 'groundArea' | 'groundScaleAt'>

/** True WGS84 ground length of an open or closed polyline through `measure.groundLength`. */
export function groundPolylineLength(
  measure: Pick<GroundMeasure, 'groundLength'>,
  points: readonly PlanePoint[],
  closed: boolean,
): Metres {
  let total = 0
  const segments = closed ? points.length : points.length - 1
  for (let index = 0; index < segments; index += 1) {
    total += measure.groundLength(points[index]!, points[(index + 1) % points.length]!)
  }
  return total as Metres
}

/** A geographic camera: the view centre, its MapLibre zoom and its bearing (degrees clockwise from north). */
export interface GeographicView {
  readonly lon: number
  readonly lat: number
  readonly zoom: number
  readonly bearing: number
}

/**
 * A camera's centre, zoom and bearing as a geographic view (ViewReadSurface.captureView). Every camera comes from a driver frame,
 * and both drivers refuse a camera that is not finite. The bearing is the camera's: the stores it feeds fold it with storedBearing
 * (composeSavedView, the settings' last view).
 */
export function geographicViewOfCamera(
  camera: { readonly center: GeoPoint; readonly zoom: number; readonly bearingDeg: number },
): GeographicView {
  return { lon: camera.center.lon, lat: camera.center.lat, zoom: camera.zoom, bearing: camera.bearingDeg }
}

/**
 * A bearing as stored data writes it (the last view, saved views): rounded to 1e-6 degrees and folded into [0, 360), so 360
 * is 0; a missing or non-finite bearing is north up. App code cannot import the view's normaliseBearing (P10).
 */
export function storedBearing(deg: number | null | undefined): number {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return 0
  const folded = Math.round((((deg % 360) + 360) % 360) * 1e6) / 1e6
  return folded >= 360 ? 0 : folded
}

function buildSessionPlane(origin: GeoPoint, conformal: boolean): SessionPlane {
  const frozenOrigin = Object.freeze({ lon: origin.lon, lat: origin.lat })
  const mercatorOrigin = Object.freeze(geoToMercator(origin.lon, origin.lat))
  const anchorMetresPerMerc = wgs84MetresPerMercatorAtLat(origin.lat, WGS84_SEMI_MAJOR_AXIS_M, WGS84_FLATTENING)
  const { n: n0, m: m0 } = wgs84Radii(origin.lat, WGS84_SEMI_MAJOR_AXIS_M, WGS84_FLATTENING)
  const conformalMetresPerMerc = Math.sqrt(anchorMetresPerMerc.x * anchorMetresPerMerc.y)
  const ax = conformal ? 1 : Math.sqrt(n0 / m0)
  const ay = conformal ? 1 : 1 / ax
  const axisScale = Object.freeze({ ax, ay })
  const mercToPlaneX = conformal ? conformalMetresPerMerc : anchorMetresPerMerc.x
  const mercToPlaneY = conformal ? conformalMetresPerMerc : anchorMetresPerMerc.y

  const toPlane = (point: GeoPoint): PlanePoint => {
    const mercator = geoToMercator(point.lon, point.lat)
    return {
      x: (mercator.x - mercatorOrigin.x) * mercToPlaneX,
      y: (mercator.y - mercatorOrigin.y) * mercToPlaneY,
    }
  }

  const toGeo = (point: PlanePoint): GeoPoint => {
    const geo = mercatorToGeo(
      mercatorOrigin.x + point.x / mercToPlaneX,
      mercatorOrigin.y + point.y / mercToPlaneY,
    )
    return { lon: geo.lng, lat: geo.lat }
  }

  const toView = (point: PlanePoint): ConformalPoint => (
    conformal
      ? (point as unknown as ConformalPoint)
      : ({ x: point.x / ax, y: point.y / ay } as ConformalPoint)
  )

  const fromView = (point: ConformalPoint): PlanePoint => (
    conformal
      ? { x: point.x, y: point.y }
      : { x: point.x * ax, y: point.y * ay }
  )

  const groundScaleAt = (point: PlanePoint): { readonly x: number; readonly y: number } => {
    const lat = toGeo(point).lat
    const local = wgs84MetresPerMercatorAtLat(lat, WGS84_SEMI_MAJOR_AXIS_M, WGS84_FLATTENING)
    if (conformal) {
      const ratio = Math.sqrt(local.x * local.y) / conformalMetresPerMerc
      return { x: ratio, y: ratio }
    }
    return { x: local.x / mercToPlaneX, y: local.y / mercToPlaneY }
  }

  const groundLength = (a: PlanePoint, b: PlanePoint): Metres => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (dx === 0 && dy === 0) return 0 as Metres
    const mid: PlanePoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const s0 = groundScaleAt(a)
    const s1 = groundScaleAt(mid)
    const s2 = groundScaleAt(b)
    const d0 = Math.hypot(dx * s0.x, dy * s0.y)
    const d1 = Math.hypot(dx * s1.x, dy * s1.y)
    const d2 = Math.hypot(dx * s2.x, dy * s2.y)
    return ((d0 + 4 * d1 + d2) / 6) as Metres
  }

  const groundArea = (ring: readonly PlanePoint[]): SquareMetres => {
    const count = ring.length
    if (count < 3) return 0 as SquareMetres
    let cx = 0
    let cy = 0
    for (let i = 0; i < count; i++) {
      cx += ring[i]!.x
      cy += ring[i]!.y
    }
    cx /= count
    cy /= count
    let signedArea = 0
    for (let i = 0; i < count; i++) {
      const p0 = ring[i]!
      const p1 = ring[(i + 1) % count]!
      const planeTri = 0.5 * ((p0.x - cx) * (p1.y - cy) - (p1.x - cx) * (p0.y - cy))
      if (planeTri === 0) continue
      const m01 = groundScaleAt({ x: (cx + p0.x) / 2, y: (cy + p0.y) / 2 })
      const m12 = groundScaleAt({ x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 })
      const m20 = groundScaleAt({ x: (p1.x + cx) / 2, y: (p1.y + cy) / 2 })
      const jacobian = (m01.x * m01.y + m12.x * m12.y + m20.x * m20.y) / 3
      signedArea += planeTri * jacobian
    }
    return Math.abs(signedArea) as SquareMetres
  }

  return Object.freeze({
    origin: frozenOrigin,
    anchor: frozenOrigin,
    axisScale,
    toPlane,
    toGeo,
    toGeoPoint: toGeo,
    toView,
    fromView,
    pixelsPerMetre(zoom: number): { readonly x: number; readonly y: number; readonly mean: number } {
      const worldSize = MAPLIBRE_WORLD_TILE_SIZE * 2 ** zoom
      return {
        x: worldSize / mercToPlaneX,
        y: worldSize / mercToPlaneY,
        mean: worldSize / conformalMetresPerMerc,
      }
    },
    zoomForPixelsPerMetre(meanPixelsPerMetre: number): number {
      return Math.log2((meanPixelsPerMetre * conformalMetresPerMerc) / MAPLIBRE_WORLD_TILE_SIZE)
    },
    groundLength,
    groundArea,
    groundScaleAt,
    needsReorigin(viewCentre: PlanePoint): boolean {
      return Math.hypot(viewCentre.x, viewCentre.y) > SESSION_PLANE_REORIGIN_DISTANCE_METERS
    },
  })
}

/** Creates the WGS84 per-axis ground-metre session plane anchored at `origin` (ADR 0001, contracts §20). */
export function createSessionPlane(origin: GeoPoint): SessionPlane {
  return buildSessionPlane(origin, false)
}

/**
 * @testonly Explicit conformal similarity fixture plane (`axisScale = { ax: 1, ay: 1 }`) for tests that
 * intentionally construct a conformal similarity rather than the true per-axis ellipsoid plane (contracts §20).
 */
export function conformalFixturePlaneForTests(origin: GeoPoint): SessionPlane {
  return buildSessionPlane(origin, true)
}

// Canonical 1e-9 degree (about 0.1 mm) rounding for changed positions.
// Dividing the rounded integer by 1e9 yields the double nearest the decimal,
// so it prints without float noise; -0 is normalised to 0.
export function roundGeoDegrees(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9
  return rounded === 0 ? 0 : rounded
}

export function sessionPlaneOriginForPoints(
  points: Iterable<GeoPoint>,
  fallback: GeoPoint,
): GeoPoint {
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const point of points) {
    if (point.lon < minLon) minLon = point.lon
    if (point.lon > maxLon) maxLon = point.lon
    if (point.lat < minLat) minLat = point.lat
    if (point.lat > maxLat) maxLat = point.lat
  }
  if (minLon === Infinity) return { lon: fallback.lon, lat: fallback.lat }
  return { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 }
}
