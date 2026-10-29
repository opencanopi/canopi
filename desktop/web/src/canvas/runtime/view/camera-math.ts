// canvas/runtime/view/camera-math.ts  (pure; the only place camera targets are computed)
//
// Owns camera targets: geographic ViewCameras (Web Mercator plus bearing, what both drivers hold), and the one conversion of a plane
// placement (a PlanarCamera: a fit's result, a test's viewport) into a ViewCamera through the session plane. Nothing here
// constrains: the drivers pass every target through constrainCamera (navigation-policy.ts).

import { geoToMercator, MAPLIBRE_WORLD_TILE_SIZE, mercatorToGeo, stageScaleToMapZoom } from '../../projection'
import type { SessionPlane } from '../../session-plane'
import { bearingCosSin, normaliseBearing } from './navigation-policy'
import type { GeoPoint } from '../../../generated/contracts'
import type { PlanarCamera, ScreenPoint, ViewCamera, ViewScreen, WorldPoint } from './types'

interface Vector { readonly x: number; readonly y: number }

export function panCamera(camera: ViewCamera, screen: ViewScreen, deltaPx: ScreenPoint): ViewCamera {
  if (deltaPx.x === 0 && deltaPx.y === 0) return camera
  const centre = screenToMercator(camera, screen, { x: screen.width / 2 - deltaPx.x, y: screen.height / 2 - deltaPx.y })
  return { center: geoPoint(centre), zoom: camera.zoom, bearingDeg: camera.bearingDeg, pitchDeg: 0 }
}

/**
 * A factor of 1 (the driver's clamped factor when the zoom limit is reached) returns the camera itself: no centre-only move. The
 * drivers refuse a factor that is not finite and positive before calling it.
 */
export function zoomCameraAround(camera: ViewCamera, screen: ViewScreen, anchorPx: ScreenPoint, factor: number): ViewCamera {
  if (factor === 1) return camera
  const zoom = camera.zoom + Math.log2(factor)
  const center = centreKeeping(screenToMercator(camera, screen, anchorPx), zoom, camera.bearingDeg, screen, anchorPx)
  return { center, zoom, bearingDeg: camera.bearingDeg, pitchDeg: 0 }
}

export function rotateCameraAround(camera: ViewCamera, screen: ViewScreen, anchorPx: ScreenPoint | 'centre', bearingDeg: number): ViewCamera {
  const bearing = normaliseBearing(bearingDeg)
  if (bearing === camera.bearingDeg) return camera
  if (anchorPx === 'centre') return { center: camera.center, zoom: camera.zoom, bearingDeg: bearing, pitchDeg: 0 }
  const center = centreKeeping(screenToMercator(camera, screen, anchorPx), camera.zoom, bearing, screen, anchorPx)
  return { center, zoom: camera.zoom, bearingDeg: bearing, pitchDeg: 0 }
}

export function screenToGeo(camera: ViewCamera, screen: ViewScreen, s: ScreenPoint): GeoPoint {
  return geoPoint(screenToMercator(camera, screen, s))
}

/** The camera that shows a plane placement: the driver host's follow of a new plane keeps the placement through it. */
export function planarToViewCamera(camera: PlanarCamera, screen: ViewScreen, plane: SessionPlane): ViewCamera {
  return {
    center: plane.toGeo(placementCentre(camera, screen)),
    zoom: stageScaleToMapZoom(camera.scale, plane.origin.lat),
    bearingDeg: normaliseBearing(camera.bearingDeg),
    pitchDeg: 0,
  }
}

/** The plane point a placement shows at the screen centre. */
export function placementCentre(camera: PlanarCamera, screen: ViewScreen): WorldPoint {
  return screenToPlaneAxes({
    x: (screen.width / 2 - camera.x) / camera.scale,
    y: (screen.height / 2 - camera.y) / camera.scale,
  }, camera.bearingDeg)
}

/** CSS px per Mercator unit at a zoom: MapLibre's worldSize. */
function worldSizeAt(zoom: number): number {
  return MAPLIBRE_WORLD_TILE_SIZE * 2 ** zoom
}

/** The Mercator point under a screen point. */
function screenToMercator(camera: ViewCamera, screen: ViewScreen, s: ScreenPoint): Vector {
  const centre = geoToMercator(camera.center.lon, camera.center.lat)
  const worldSize = worldSizeAt(camera.zoom)
  const offset = screenToPlaneAxes({ x: s.x - screen.width / 2, y: s.y - screen.height / 2 }, camera.bearingDeg)
  return { x: centre.x + offset.x / worldSize, y: centre.y + offset.y / worldSize }
}

/** The centre that puts a Mercator point under a screen point at a zoom and bearing. */
function centreKeeping(point: Vector, zoom: number, bearingDeg: number, screen: ViewScreen, s: ScreenPoint): GeoPoint {
  const worldSize = worldSizeAt(zoom)
  const offset = screenToPlaneAxes({ x: s.x - screen.width / 2, y: s.y - screen.height / 2 }, bearingDeg)
  return geoPoint({ x: point.x - offset.x / worldSize, y: point.y - offset.y / worldSize })
}

function geoPoint(mercator: Vector): GeoPoint {
  const { lng, lat } = mercatorToGeo(mercator.x, mercator.y)
  return { lon: lng, lat }
}

/** A screen-axis vector in plane (or Mercator) axes: the inverse turn. The identity at bearing 0. */
function screenToPlaneAxes(vector: Vector, bearingDeg: number): Vector {
  const [cos, sin] = bearingCosSin(bearingDeg)
  if (cos === 1 && sin === 0) return vector
  return { x: cos * vector.x - sin * vector.y, y: sin * vector.x + cos * vector.y }
}
