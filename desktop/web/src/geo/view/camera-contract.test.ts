// The headless and MapLibre camera drivers against MapLibre's own MercatorTransform (ADR 0016): the same camera scripts run through
// the HeadlessCameraDriver (createTestView's host) and through the MapLibre camera driver on a map backed by that transform, and
// every frame of both must project like the transform to 1e-6 px. The source is loaded through the test-only `maplibre-gl-source`
// alias (desktop/web/vite.config.ts; plan 0A "Contract test source"). Float rounding sets the zooms: MapLibre's own matrices round
// by up to 5e-7 px at zoom 22, and the geographic path rounds its centre to lon/lat doubles on every move (about 1e-7 px per move
// at zoom 21.6, latitude 60), so single frames go up to zoom 22 and scripts stay at or below zoom 20.

import { signal } from '@preact/signals'
import { describe, expect, it } from 'vitest'
import { createTestView } from '../../__tests__/support/test-view'
import { createMapLibreCameraDriver, type MapLibreCameraDriverMap } from '../../maplibre/camera-driver'
import { LngLat as SourceLngLatClass } from 'maplibre-gl-source/geo/lng_lat.ts'
import { MercatorTransform as SourceMercatorTransform } from 'maplibre-gl-source/geo/projection/mercator_transform.ts'
import { mapZoomToStageScale, createSessionPlane, type SessionPlane } from '../session-plane'
import type { CameraMove } from './camera-driver'
import { planarToViewCamera } from './camera-math'
import { createNavigationPolicy } from './navigation-policy'
import type { ScreenPoint, ViewCamera, ViewScreen, ViewTransform, WorldPoint } from './types'

/** The members of MapLibre's LngLat and MercatorTransform this test calls. */
interface SourceLngLat { readonly lng: number; readonly lat: number }
interface SourceTransform {
  resize(width: number, height: number): void
  setBearing(bearing: number): void
  setZoom(zoom: number): void
  setCenter(center: SourceLngLat): void
  setConstrainOverride(constrain: ((center: SourceLngLat, zoom: number) => { center: SourceLngLat; zoom: number }) | null): void
  readonly center: SourceLngLat
  readonly zoom: number
  readonly bearing: number
  locationToScreenPoint(location: SourceLngLat): ScreenPoint
  /** Reads only the point's x and y. */
  screenPointToLocation(point: ScreenPoint): SourceLngLat
}
const LngLat = SourceLngLatClass as new (lng: number, lat: number) => SourceLngLat
const MercatorTransform = SourceMercatorTransform as new (options: {
  readonly minZoom: number
  readonly maxZoom: number
  readonly renderWorldCopies: boolean
}) => SourceTransform

const TOLERANCE_PX = 1e-6
const SCREEN: ViewScreen = { width: 900, height: 600, devicePixelRatio: 1 }
const POLICY = createNavigationPolicy(0, signal(false))

/** Plane points spread over the screen and a little beyond it. */
function samplePoints(view: ViewTransform): WorldPoint[] {
  const points: WorldPoint[] = []
  for (const x of [-0.5, 0, 0.25, 0.5, 0.75, 1, 1.1]) {
    for (const y of [-0.2, 0, 0.3, 0.5, 1]) {
      points.push(view.screenToWorld({ x: x * view.screen.width, y: y * view.screen.height }))
    }
  }
  return points
}

/**
 * Both directions are held to MapLibre's forward projection. Its own screenPointToLocation inverts a 4×4 perspective matrix
 * and drifts from locationToScreenPoint by up to about 1e-5 px at zoom 22, so it is not the reference.
 */
function expectProjectsLikeMapLibre(view: ViewTransform, transform: SourceTransform, plane: SessionPlane): void {
  const project = (point: WorldPoint): ScreenPoint => {
    const ground = plane.toGeo(point)
    return transform.locationToScreenPoint(new LngLat(ground.lon, ground.lat))
  }
  for (const point of samplePoints(view)) {
    const expected = project(point)
    const actual = view.worldToScreen(point)
    expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(TOLERANCE_PX)
    expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(TOLERANCE_PX)

    const screenPoint = { x: actual.x + 0.375, y: actual.y - 0.625 }
    const underIt = project(view.screenToWorld(screenPoint))
    expect(Math.abs(underIt.x - screenPoint.x)).toBeLessThanOrEqual(TOLERANCE_PX)
    expect(Math.abs(underIt.y - screenPoint.y)).toBeLessThanOrEqual(TOLERANCE_PX)
  }
}

const SCRIPT: readonly CameraMove[] = [
  { kind: 'pan-by', deltaPx: { x: 10, y: -7 } },
  { kind: 'zoom-around', anchorPx: { x: 120, y: 80 }, factor: 1.5 },
  { kind: 'rotate-around', anchorPx: { x: 300, y: 50 }, bearingDeg: 30 },
  { kind: 'pan-by', deltaPx: { x: -40.5, y: 25.25 } },
  { kind: 'zoom-around', anchorPx: { x: 50, y: 550 }, factor: 0.8 },
  { kind: 'rotate-around', anchorPx: 'centre', bearingDeg: 300 },
  { kind: 'zoom-around', anchorPx: { x: 700, y: 20 }, factor: 3.2 },
  { kind: 'rotate-around', anchorPx: { x: 10, y: 590 }, bearingDeg: 181.5 },
  { kind: 'pan-by', deltaPx: { x: 333, y: -111 } },
  { kind: 'rotate-around', anchorPx: { x: 890, y: 300 }, bearingDeg: 0 },
  { kind: 'zoom-around', anchorPx: { x: 450, y: 300 }, factor: 0.5 },
]

/**
 * The clamps at 45°, where the headless driver clamps its scale and the MapLibre driver its zoom factor before anchoring: out to the
 * single-world floor (then the one-world hold), a pan the hold stops, and in past CLAMP_MAX_ZOOM about an off-centre anchor.
 */
const CLAMP_SCRIPT: readonly CameraMove[] = [
  { kind: 'rotate-around', anchorPx: 'centre', bearingDeg: 45 },
  { kind: 'zoom-around', anchorPx: { x: 200, y: 150 }, factor: 1e-9 },
  { kind: 'zoom-around', anchorPx: { x: 200, y: 150 }, factor: 4 },
  { kind: 'pan-by', deltaPx: { x: 5_000, y: -3_000 } },
  { kind: 'zoom-around', anchorPx: { x: 450, y: 300 }, factor: 2 ** 14 },
  { kind: 'zoom-around', anchorPx: { x: 700, y: 120 }, factor: 2 ** 10 },
  { kind: 'rotate-around', anchorPx: { x: 100, y: 500 }, bearingDeg: 0 },
]
/** The clamp script's zoom ceiling: today's 27 is beyond the zooms MercatorTransform checks to 1e-6 px. */
const CLAMP_MAX_ZOOM = 20

/**
 * A MapLibre map over the source MercatorTransform, in MapLibre's own order: jumpTo sets the zoom, then the centre (both through the
 * installed constrain), then the bearing (ui/camera.ts jumpTo, mercator_camera_helper.ts handleJumpToCenterZoom), and fires 'move'
 * synchronously; setTransformConstrain is setConstrainOverride.
 */
function mapOnTransform(screen: ViewScreen, start: ViewCamera):
  { readonly map: MapLibreCameraDriverMap; readonly transform: SourceTransform } {
  const transform = new MercatorTransform({ minZoom: POLICY.minZoom, maxZoom: POLICY.maxZoom, renderWorldCopies: false })
  transform.resize(screen.width, screen.height)
  transform.setZoom(start.zoom)
  transform.setCenter(new LngLat(start.center.lon, start.center.lat))
  transform.setBearing(start.bearingDeg)
  const moveListeners = new Set<(event?: unknown) => void>()
  const canvas = { clientWidth: screen.width, clientHeight: screen.height, width: screen.width * screen.devicePixelRatio }
  const map: MapLibreCameraDriverMap = {
    jumpTo(options) {
      if (transform.zoom !== options.zoom) transform.setZoom(options.zoom)
      transform.setCenter(new LngLat(options.center[0], options.center[1]))
      if (transform.bearing !== options.bearing) transform.setBearing(options.bearing)
      for (const listener of [...moveListeners]) listener()
    },
    resize() {},
    stop() {},
    flyTo() {
      throw new Error('The contract scripts do not fly.')
    },
    on(type, listener) {
      if (type === 'move') moveListeners.add(listener)
    },
    off(type, listener) {
      if (type === 'move') moveListeners.delete(listener)
    },
    getCenter: () => transform.center,
    getZoom: () => transform.zoom,
    getBearing: () => transform.bearing,
    getPitch: () => 0,
    setTransformConstrain: (constrain) => transform.setConstrainOverride(constrain),
    getCanvas: () => canvas as unknown as HTMLCanvasElement,
  }
  return { map, transform }
}

describe('camera contract', () => {
  it('headless and MercatorTransform agree for pan, zoom and rotate moves', () => {
    const starts = [
      { origin: { lon: 0, lat: 0 }, zoom: 17, script: SCRIPT },
      { origin: { lon: 2.3522, lat: 49 }, zoom: 18, script: SCRIPT },
      { origin: { lon: -70.65, lat: -33.45 }, zoom: 16.4, script: SCRIPT },
      { origin: { lon: 151.2, lat: 65 }, zoom: 17.2, script: SCRIPT },
      { origin: { lon: 2.3522, lat: 48.8566 }, zoom: 18, script: CLAMP_SCRIPT, maxZoom: CLAMP_MAX_ZOOM },
    ]
    for (const start of starts) {
      const plane = createSessionPlane(start.origin)
      const scale = mapZoomToStageScale(start.zoom, plane.origin.lat)
      const viewport = { x: SCREEN.width / 2 - 25 * scale, y: SCREEN.height / 2 + 12 * scale, scale }
      const headless = createTestView({ screen: SCREEN, plane, maxZoom: start.maxZoom, viewport })
      const shown = mapOnTransform(SCREEN, planarToViewCamera({ ...viewport, bearingDeg: 0 }, SCREEN, plane))
      const today = createNavigationPolicy(plane.origin.lat, signal(false))
      const navigationPolicy = { ...today, maxZoom: start.maxZoom ?? today.maxZoom }
      const attached = createMapLibreCameraDriver(shown.map, plane, { policy: () => navigationPolicy })
      expect(attached.failure.peek()).toBeNull()
      expectProjectsLikeMapLibre(headless.view(), shown.transform, plane)
      expectProjectsLikeMapLibre(attached.frames.viewFrame.peek().view, shown.transform, plane)

      for (const move of start.script) {
        headless.host.current().apply(move)
        attached.apply(move)

        const fromHeadless = headless.view()
        const fromMapLibre = attached.frames.viewFrame.peek().view
        // The MapLibre driver's frame is built from what the map shows.
        expect(fromMapLibre.camera.zoom).toBe(shown.transform.zoom)
        expect(fromMapLibre.camera.center.lon).toBe(shown.transform.center.lng)
        expect(fromMapLibre.camera.center.lat).toBe(shown.transform.center.lat)
        expect(Math.abs(fromHeadless.camera.bearingDeg - fromMapLibre.camera.bearingDeg)).toBeLessThan(1e-9)
        expectProjectsLikeMapLibre(fromHeadless, shown.transform, plane)
        expectProjectsLikeMapLibre(fromMapLibre, shown.transform, plane)
      }
      attached.dispose()
      headless.dispose()
    }
  })
})
