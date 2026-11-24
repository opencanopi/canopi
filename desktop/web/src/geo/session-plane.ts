// ---------------------------------------------------------------------------
// Session plane: the runtime's local metre frame for the open Design.
//
// Files store WGS84 lon/lat; tools, snapping, measurements, hit testing and
// PDF layout work in metres. The plane is a local Mercator frame (x east,
// y south) scaled at its origin latitude, so it stays an exact affine image of
// the MapLibre Mercator surface. It is rebuilt at the view centre when the view
// moves more than 10 km away; stored lon/lat stays authoritative throughout.
// ---------------------------------------------------------------------------

import {
  geoToMercator,
  mercatorToGeo,
  mercatorUnitsPerMeterAtLat,
} from './projection'

import type { GeoPoint } from '../generated/contracts'

export interface PlanePoint {
  readonly x: number
  readonly y: number
}

export const SESSION_PLANE_REORIGIN_DISTANCE_METERS = 10_000
export const DEFAULT_NEW_DESIGN_VIEW = Object.freeze({ lon: 13.0, lat: 23.0, zoom: 4 })

export interface SessionPlane {
  readonly origin: GeoPoint
  toPlane(point: GeoPoint): PlanePoint
  toGeo(point: PlanePoint): GeoPoint
  needsReorigin(viewCentre: PlanePoint): boolean
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

export function createSessionPlane(origin: GeoPoint): SessionPlane {
  const frozenOrigin = Object.freeze({ lon: origin.lon, lat: origin.lat })
  const mercatorOrigin = Object.freeze(geoToMercator(origin.lon, origin.lat))
  const unitsPerMeter = mercatorUnitsPerMeterAtLat(origin.lat)
  return Object.freeze({
    origin: frozenOrigin,
    toPlane(point: GeoPoint): PlanePoint {
      const mercator = geoToMercator(point.lon, point.lat)
      return {
        x: (mercator.x - mercatorOrigin.x) / unitsPerMeter,
        y: (mercator.y - mercatorOrigin.y) / unitsPerMeter,
      }
    },
    toGeo(point: PlanePoint): GeoPoint {
      const geo = mercatorToGeo(
        mercatorOrigin.x + point.x * unitsPerMeter,
        mercatorOrigin.y + point.y * unitsPerMeter,
      )
      return { lon: geo.lng, lat: geo.lat }
    },
    needsReorigin(viewCentre: PlanePoint): boolean {
      return Math.hypot(viewCentre.x, viewCentre.y) > SESSION_PLANE_REORIGIN_DISTANCE_METERS
    },
  })
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
