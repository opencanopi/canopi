// ---------------------------------------------------------------------------
// Pure leaf module (projection-imports-nothing): parameterised WGS84 ellipsoid
// radius formulas and scale-threshold tolerance. Web Mercator formulas live in
// `geo/web-mercator.ts`; WGS84 constants and the session plane live in
// `geo/session-plane.ts`.
// ---------------------------------------------------------------------------

const DEGREES_TO_RADIANS = Math.PI / 180
/** MapLibre's world is 512 CSS pixels wide at zoom 0. */
export const MAPLIBRE_WORLD_TILE_SIZE = 512

/** WGS84 prime-vertical (N, east-west) and meridional (M, north-south) radii of curvature at a latitude. */
export function wgs84Radii(
  lat: number,
  semiMajorAxisM: number,
  flattening: number,
): { readonly n: number; readonly m: number } {
  const e2 = flattening * (2 - flattening)
  const sin = Math.sin(lat * DEGREES_TO_RADIANS)
  const w = 1 - e2 * sin * sin
  const sqrtW = Math.sqrt(w)
  return {
    n: semiMajorAxisM / sqrtW,
    m: (semiMajorAxisM * (1 - e2)) / (w * sqrtW),
  }
}

/** WGS84 ground metres per Web Mercator unit along east-west (x) and north-south (y) at a latitude. */
export function wgs84MetresPerMercatorAtLat(
  lat: number,
  semiMajorAxisM: number,
  flattening: number,
): { readonly x: number; readonly y: number } {
  const { n, m } = wgs84Radii(lat, semiMajorAxisM, flattening)
  const phi = lat * DEGREES_TO_RADIANS
  const twoPiCos = 2 * Math.PI * Math.cos(phi)
  return { x: twoPiCos * n, y: twoPiCos * m }
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
