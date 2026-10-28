// __tests__/support/geo-to-screen.ts  (test support)
//
// geoToScreen: where a MapLibre map at a ViewCamera draws a lon/lat point, in CSS px (Web Mercator at 512 px tiles, turned by the
// bearing about the screen centre). Production never projects a geographic point onto the screen (P3 keeps world-to-screen in
// view-transform.ts); the fake maps do, through this copy.

import { geoToMercator, MAPLIBRE_WORLD_TILE_SIZE } from '../../canvas/projection'
import { bearingCosSin } from '../../canvas/runtime/view/navigation-policy'
import type { GeoPoint } from '../../generated/contracts'
import type { ScreenPoint, ViewCamera, ViewScreen } from '../../canvas/runtime/view/types'

export function geoToScreen(camera: ViewCamera, screen: ViewScreen, g: GeoPoint): ScreenPoint {
  const point = geoToMercator(g.lon, g.lat)
  const centre = geoToMercator(camera.center.lon, camera.center.lat)
  const worldSize = MAPLIBRE_WORLD_TILE_SIZE * 2 ** camera.zoom
  const x = (point.x - centre.x) * worldSize
  const y = (point.y - centre.y) * worldSize
  const [cos, sin] = bearingCosSin(camera.bearingDeg)
  return { x: cos * x + sin * y + screen.width / 2, y: cos * y - sin * x + screen.height / 2 }
}
