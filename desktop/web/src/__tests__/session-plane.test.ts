import { describe, expect, it } from 'vitest'
import { createSessionPlane, geographicViewOfCamera, roundGeoDegrees, SESSION_PLANE_REORIGIN_DISTANCE_METERS, sessionPlaneOriginForPoints } from '../geo/session-plane'
import { buildViewTransform } from '../geo/view/view-transform'
import { bandDraft } from '../canvas/runtime/tools/select/band'
import { applyToolConstraint } from '../canvas/runtime/tools/constraints'
import { measureLabelShapes } from '../canvas/runtime/tools/measure-labels'
import { screenBasisOf } from '../canvas/runtime/tools/screen-basis'
import type { ToolView } from '../canvas/runtime/tools/tool'
import { createTestView } from './support/test-view'

const EARTH_RADIUS_METERS = 6371008.8

function haversineMeters(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLon = (b.lon - a.lon) * toRad
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h))
}

describe('session plane', () => {
  it('maps its origin to plane (0, 0) with x east and y south', () => {
    const plane = createSessionPlane({ lon: 2.2945, lat: 48.8584 })
    expect(plane.toPlane({ lon: 2.2945, lat: 48.8584 })).toEqual({ x: 0, y: 0 })
    const east = plane.toPlane({ lon: 2.2955, lat: 48.8584 })
    const north = plane.toPlane({ lon: 2.2945, lat: 48.8594 })
    expect(east.x).toBeGreaterThan(0)
    expect(Math.abs(east.y)).toBeLessThan(1e-9)
    expect(north.y).toBeLessThan(0)
    expect(Math.abs(north.x)).toBeLessThan(1e-9)
  })

  it('round-trips lon/lat through the plane within 0.1 mm up to 10 km from the origin', () => {
    for (const origin of [
      { lon: 13, lat: 23 },
      { lon: -122.4194, lat: 37.7749 },
      { lon: 174.7633, lat: -36.8485 },
      { lon: 25.7482, lat: 66.5039 },
    ]) {
      const plane = createSessionPlane(origin)
      for (let i = 0; i < 64; i += 1) {
        const angle = (i / 64) * 2 * Math.PI
        const radius = 10_000 * ((i % 8) + 1) / 8
        const planePoint = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
        const geo = plane.toGeo(planePoint)
        const back = plane.toGeo(plane.toPlane(geo))
        expect(haversineMeters(geo, back)).toBeLessThan(1e-4)
        const replane = plane.toPlane(geo)
        expect(Math.hypot(replane.x - planePoint.x, replane.y - planePoint.y)).toBeLessThan(1e-4)
      }
    }
  })

  it('keeps plane distances metric near the origin', () => {
    const plane = createSessionPlane({ lon: 5.5, lat: 45 })
    expect(plane.groundLength({ x: -50, y: 0 }, { x: 50, y: 0 })).toBeCloseTo(100, 3)
    const a = plane.toGeo({ x: -50, y: 0 })
    const b = plane.toGeo({ x: 50, y: 0 })
    // Sphere haversine differs from WGS84 by ~0.28% at 45°N (ADR 0001, 2.1-Q78d)
    expect(haversineMeters(a, b)).toBeGreaterThan(99.5)
    expect(haversineMeters(a, b)).toBeLessThan(100.5)
  })

  it('rounds degrees to 1e-9 and prints them without float noise', () => {
    expect(roundGeoDegrees(2.29448123449999)).toBe(2.294481234)
    expect(String(roundGeoDegrees(48.85837012351))).toBe('48.858370124')
    expect(roundGeoDegrees(-0.0000000001)).toBe(0)
    expect(Object.is(roundGeoDegrees(-0.0000000001), -0)).toBe(false)
  })

  it('centres the origin on the bounds of the given points', () => {
    expect(sessionPlaneOriginForPoints([
      { lon: 10, lat: 40 },
      { lon: 12, lat: 44 },
      { lon: 11, lat: 41 },
    ], { lon: 0, lat: 0 })).toEqual({ lon: 11, lat: 42 })
  })

  it('uses the fallback origin when there are no points', () => {
    expect(sessionPlaneOriginForPoints([], { lon: 13, lat: 23 })).toEqual({ lon: 13, lat: 23 })
  })

  it('re-origins beyond 10 km', () => {
    expect(SESSION_PLANE_REORIGIN_DISTANCE_METERS).toBe(10_000)
    const plane = createSessionPlane({ lon: 13, lat: 23 })
    expect(plane.needsReorigin({ x: 9_999, y: 0 })).toBe(false)
    expect(plane.needsReorigin({ x: 7_072, y: 7_072 })).toBe(true)
  })
})

describe('the geographic view of a camera', () => {
  /** The geographic view a camera at this placement shows (ViewReadSurface.captureView's camera). */
  function geographicViewAt(view: { viewport: { x: number; y: number; scale: number }; screenSize: { width: number; height: number } }, onPlane: ReturnType<typeof createSessionPlane>) {
    const camera = createTestView({ plane: onPlane, screen: view.screenSize, viewport: view.viewport })
    const geographic = geographicViewOfCamera(camera.view().camera)
    camera.dispose()
    return geographic
  }

  it('reads the zoom of a view at the plane origin', () => {
    const origin = { lon: 2.2945, lat: 48.8584 }
    const plane = createSessionPlane(origin)
    const scale = plane.pixelsPerMetre(18).mean
    const view = geographicViewAt({ viewport: { x: 400, y: 300, scale }, screenSize: { width: 800, height: 600 } }, plane)
    expect(view.lon).toBeCloseTo(origin.lon, 9)
    expect(view.lat).toBeCloseTo(origin.lat, 9)
    expect(view.zoom).toBeCloseTo(18, 6)
  })

  it('reads the zoom of a view far from the plane origin at the origin latitude', () => {
    const farPlane = createSessionPlane({ lon: 13, lat: 23 })
    const oslo = farPlane.toView(farPlane.toPlane({ lon: 10.75, lat: 59.91 }))
    const scale = farPlane.pixelsPerMetre(17).mean
    const view = geographicViewAt({
      viewport: { x: 400 - oslo.x * scale, y: 300 - oslo.y * scale, scale },
      screenSize: { width: 800, height: 600 },
    }, farPlane)
    expect(view.lat).toBeCloseTo(59.91, 6)
    expect(view.zoom).toBeCloseTo(17, 6)
  })
})

describe('turned views under anisotropic WGS84 affine (2m-1 R2)', () => {
  for (const lat of [0, 49]) {
    it(`keeps band quad, direction constraint, and edge normals exact at bearing 45° (lat ${lat}°)`, () => {
      const plane = createSessionPlane({ lon: 2.35, lat })
      const view = buildViewTransform({
        camera: { center: plane.origin, zoom: 17, bearingDeg: 45, pitchDeg: 0 },
        screen: { width: 1000, height: 800, devicePixelRatio: 1 },
        plane,
        planeRevision: 1,
      })
      const toolView: ToolView = {
        bearingDeg: view.camera.bearingDeg,
        mode: 'site',
        metresPerPixelAt: (p) => view.metresPerPixelAt(p),
        screenDistance: (a, b) => view.screenDistance(a, b),
        screenAxesInWorld: () => view.screenAxesInWorld(),
        worldDeltaToScreen: (d) => view.worldDeltaToScreen(d),
        screenDeltaToWorld: (d) => view.screenDeltaToWorld(d),
        screenAlignedRect: () => ({ center: { x: 0, y: 0 }, width: 0, height: 0, rotationDeg: 0 }),
      }
      const basis = screenBasisOf(view)

      const startScreen = { x: 100, y: 100 }
      const endScreen = { x: 900, y: 700 }
      const startWorld = view.screenToWorld(startScreen)
      const endWorld = view.screenToWorld(endScreen)

      // 1. Band select quad projects back to exact screen-aligned rectangle (100,100)-(900,700)
      const draft = bandDraft(toolView, { start: startWorld, additive: false }, endWorld)
      const quadShape = draft.shapes[0]
      expect(quadShape?.kind).toBe('quad')
      if (quadShape?.kind === 'quad') {
        const projected = quadShape.corners.map((c) => view.worldToScreen(c))
        expect(projected[0]!.x).toBeCloseTo(100, 6)
        expect(projected[0]!.y).toBeCloseTo(100, 6)
        expect(projected[1]!.x).toBeCloseTo(900, 6)
        expect(projected[1]!.y).toBeCloseTo(100, 6)
        expect(projected[2]!.x).toBeCloseTo(900, 6)
        expect(projected[2]!.y).toBeCloseTo(700, 6)
        expect(projected[3]!.x).toBeCloseTo(100, 6)
        expect(projected[3]!.y).toBeCloseTo(700, 6)
      }

      // 2. Shift direction constraint preserves exact ground length along screen-right
      const origin = { x: 0, y: 0 }
      const raw = { x: 10, y: 9.8 }
      const constrained = applyToolConstraint({ kind: 'direction', origin, stepDeg: 45 }, raw, basis)
      expect(Math.hypot(constrained.x - origin.x, constrained.y - origin.y)).toBeCloseTo(Math.hypot(raw.x, raw.y), 9)

      // 3. Outward edge normal in measure-labels is strictly perpendicular to the drawn edge on screen
      const poly = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 0, y: 40 }]
      const labels = measureLabelShapes(
        [{ id: 'edge-0', kind: 'edge', text: '50 m', worldPosition: { x: 25, y: 0 }, worldStart: poly[0]!, worldEnd: poly[1]! }],
        (a, b) => view.screenDistance(a, b),
        { corners: poly, edges: new Set([0]), screenAxes: basis },
      )
      const label = labels[0]
      expect(label?.kind).toBe('label')
      if (label?.kind === 'label' && label.beside) {
        const s0 = view.worldToScreen(poly[0]!)
        const s1 = view.worldToScreen(poly[1]!)
        const edgeX = s1.x - s0.x
        const edgeY = s1.y - s0.y
        const edgeLen = Math.hypot(edgeX, edgeY)
        const dotScreen = (edgeX / edgeLen) * label.beside.normalPx.x + (edgeY / edgeLen) * label.beside.normalPx.y
        expect(Math.abs(dotScreen)).toBeLessThan(1e-9)
      }
    })
  }
})
