import type { GeoPoint, CanopiFile } from '../../types/design'
import { createSessionPlane, roundGeoDegrees } from '../../geo/session-plane'
import { hydrateSceneFromDesign } from '../../canvas/runtime/scene'

/** Test-only authoring origin; production never converts metre fixtures. */
export const TEST_GEO_ORIGIN: GeoPoint = Object.freeze({ lon: 13, lat: 23 })

/**
 * Authors a lon/lat position from local metres (x east, y south) around `origin`.
 * Use it to write fixtures that read like the old metre ones.
 */
export function geoAt(x: number, y: number, origin: GeoPoint = TEST_GEO_ORIGIN): { lon: number; lat: number } {
  const geo = createSessionPlane(origin).toGeo({ x, y })
  return { lon: geo.lon, lat: geo.lat }
}

/** geoAt on the 1e-9 degree grid Canopi writes, for fixtures a save must write back unchanged. */
export function storedGeoAt(x: number, y: number, origin: GeoPoint = TEST_GEO_ORIGIN): { lon: number; lat: number } {
  const geo = geoAt(x, y, origin)
  return { lon: roundGeoDegrees(geo.lon), lat: roundGeoDegrees(geo.lat) }
}

/**
 * The plane metres the runtime hydrates for a Design. The runtime centres its
 * session plane on the objects' bounds, so compare against this instead of the
 * metres a fixture was authored in.
 */
export function hydratedScene(file: CanopiFile) {
  return hydrateSceneFromDesign(file).persisted
}
