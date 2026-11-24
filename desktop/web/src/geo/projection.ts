// ---------------------------------------------------------------------------
// Canonical canvas↔map projection seam.
//
// Canvas world coordinates are metres in the session plane (x east, y south),
// a Mercator-anchored local frame so the canvas and map share one affine
// surface. The origin is the session plane origin; see `session-plane.ts`.
// ---------------------------------------------------------------------------

const EARTH_RADIUS_METERS = 6371008.8
const EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * EARTH_RADIUS_METERS
const DEGREES_TO_RADIANS = Math.PI / 180
/** MapLibre's world is 512 CSS pixels wide at zoom 0. */
export const MAPLIBRE_WORLD_TILE_SIZE = 512

export interface MapMercatorCoordinate {
  x: number
  y: number
}

function mercatorXfromLng(lng: number): number {
  return (180 + lng) / 360
}

function mercatorYfromLat(lat: number): number {
  return (180 - (180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * DEGREES_TO_RADIANS / 2)))) / 360
}

function lngFromMercatorX(x: number): number {
  return x * 360 - 180
}

function latFromMercatorY(y: number): number {
  const y2 = 180 - y * 360
  return 360 / Math.PI * Math.atan(Math.exp(y2 * Math.PI / 180)) - 90
}

export function mercatorUnitsPerMeterAtLat(lat: number): number {
  return 1 / EARTH_CIRCUMFERENCE_METERS / Math.cos(lat * DEGREES_TO_RADIANS)
}

export function geoToMercator(lng: number, lat: number): MapMercatorCoordinate {
  return {
    x: mercatorXfromLng(lng),
    y: mercatorYfromLat(lat),
  }
}

export function mercatorToGeo(x: number, y: number): { lng: number; lat: number } {
  return {
    lng: lngFromMercatorX(x),
    lat: latFromMercatorY(y),
  }
}

/**
 * Convert canvas viewport scale to a MapLibre zoom level using the same
 * Mercator world-size convention as MapLibre's transform (512px world at z=0).
 */
export function stageScaleToMapZoom(stageScale: number, lat: number): number {
  const mercatorUnitsPerMeter = mercatorUnitsPerMeterAtLat(lat)
  const pixelsPerMercatorUnit = stageScale / mercatorUnitsPerMeter
  return Math.log2(pixelsPerMercatorUnit / MAPLIBRE_WORLD_TILE_SIZE)
}

/** Exact inverse of stageScaleToMapZoom for a fixed anchor latitude. */
export function mapZoomToStageScale(mapZoom: number, lat: number): number {
  return MAPLIBRE_WORLD_TILE_SIZE * 2 ** mapZoom * mercatorUnitsPerMeterAtLat(lat)
}

/** Relative margin for scale thresholds: far below anything visible, far above a zoom round trip's error. */
const SCALE_READBACK_TOLERANCE = 1e-9

/**
 * Whether a scale-derived value (px/m, or a screen gap in px) reaches a threshold. A camera holds a map zoom, so a scale placed at
 * a round value reads back a few ulps off it, often under (10 px/m at lat 47.2 reads 9.999999999999993). Every scale threshold
 * (the grid gap, the overview line) compares through this so such a placement lands on the side it was placed on.
 */
export function scaleReaches(value: number, threshold: number): boolean {
  return value >= threshold * (1 - SCALE_READBACK_TOLERANCE)
}
