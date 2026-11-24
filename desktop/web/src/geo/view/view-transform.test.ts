import { describe, expect, it } from 'vitest'
import { mapZoomToStageScale } from '../projection'
import { createSessionPlane, type SessionPlane } from '../session-plane'
import { planarToViewCamera } from './camera-math'
import type { PlanarCamera, ViewCamera, ViewScreen, WorldPoint } from './types'
import { buildViewTransform, planarCameraOf } from './view-transform'

const SCREEN: ViewScreen = { width: 1000, height: 800, devicePixelRatio: 1 }

/** The view of a placement: its camera through the plane. */
function fromPlane(planar: PlanarCamera, plane: SessionPlane, screen: ViewScreen = SCREEN) {
  return fromCamera(planarToViewCamera(planar, screen, plane), plane, screen)
}

function fromCamera(camera: ViewCamera, plane: SessionPlane, screen: ViewScreen = SCREEN) {
  return buildViewTransform({ camera, screen, plane, planeRevision: 3 })
}

function expectClose(actual: WorldPoint | null, expected: WorldPoint, digits = 6): void {
  expect(actual!.x).toBeCloseTo(expected.x, digits)
  expect(actual!.y).toBeCloseTo(expected.y, digits)
}

function expectNear(actual: WorldPoint, expected: WorldPoint, tolerance: number): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance)
}

describe('view transform', () => {
  it('round trips at bearing 0', () => {
    const planes = [createSessionPlane({ lon: -122.68, lat: 45.52 }), createSessionPlane({ lon: 0, lat: 0 })]
    const placements = [
      { x: -200, y: -100, scale: 2 },
      { x: 0.3, y: 7.25, scale: 1 / 3 },
      { x: 1e4, y: -3e3, scale: 1500 },
    ]
    const worldPoints = [{ x: 0, y: 0 }, { x: 350, y: 250 }, { x: -12.5, y: 3.75 }, { x: 1e3, y: -2e3 }]
    const screenPoints = [{ x: 0, y: 0 }, { x: 1000, y: 800 }, { x: 140, y: 110 }]
    for (const plane of planes) {
      for (const { x, y, scale } of placements) {
        const view = fromPlane({ x, y, scale, bearingDeg: 0 }, plane)

        // Today's CameraController arithmetic, within 1e-5 px (the camera holds the centre in lon/lat: at 1500 px/m its last bits
        // are a few micropixels).
        for (const point of worldPoints) {
          expectNear(view.worldToScreen(point), { x: point.x * scale + x, y: point.y * scale + y }, 1e-5)
          expectNear(view.screenToWorld(view.worldToScreen(point)), point, 1e-9 * Math.max(1, Math.abs(point.x), Math.abs(point.y)))
        }
        for (const point of screenPoints) {
          expectClose(view.screenToWorld(point), { x: (point.x - x) / scale, y: (point.y - y) / scale })
        }
        const affine = view.planar.affine
        ;[scale, 0, 0, scale, x, y].forEach((value, index) => expect(Math.abs(affine[index]! - value)).toBeLessThanOrEqual(1e-5))
        expect(view.pixelsPerMetre).toBeCloseTo(scale, 9)
        expect(view.northUp).toBe(true)
        expect(view.screenAxesInWorld()).toEqual({ right: { x: 1, y: 0 }, down: { x: 0, y: 1 } })
        expect(view.planeRevision).toBe(3)

        const geographic = fromCamera(view.camera, plane)
        for (const point of worldPoints) {
          const tolerance = 1e-9 * Math.max(1, Math.abs(point.x), Math.abs(point.y))
          expectNear(geographic.screenToWorld(geographic.worldToScreen(point)), point, tolerance)
        }
      }
    }
  })

  it('affine is not null at zoom 27, latitude 60', () => {
    const plane = createSessionPlane({ lon: 10, lat: 60 })
    for (const bearingDeg of [0, 37]) {
      const view = fromCamera({ center: { lon: 10.001, lat: 60.0005 }, zoom: 27, bearingDeg, pitchDeg: 0 }, plane)
      const { affine } = view.planar

      expect(affine.every(Number.isFinite)).toBe(true)
      expect(Math.hypot(affine[0], affine[1])).toBeCloseTo(mapZoomToStageScale(27, 60), 9)
      expect(view.pixelsPerMetre).toBeCloseTo(mapZoomToStageScale(27, 60), 9)
      const centre = view.screenToWorld({ x: 500, y: 400 })
      for (const point of [centre, { x: centre.x + 0.01, y: centre.y - 0.02 }, { x: centre.x - 0.1, y: centre.y + 0.07 }]) {
        const [a, b, c, d, tx, ty] = affine
        expectNear(view.worldToScreen(point), { x: a * point.x + c * point.y + tx, y: b * point.x + d * point.y + ty }, 1e-6)
        expectNear(view.screenToWorld(view.worldToScreen(point)), point, 1e-9)
      }
      expectNear(view.worldToScreen(centre), { x: 500, y: 400 }, 1e-6)
    }
  })

  it('turns the plane counter-clockwise on screen, so the bearing points up', () => {
    const plane = createSessionPlane({ lon: 0, lat: 0 })
    const view = fromPlane({ x: 300, y: 200, scale: 4, bearingDeg: 90 }, plane)

    expectClose(view.worldToScreen({ x: 0, y: 0 }), { x: 300, y: 200 })
    expectClose(view.worldToScreen({ x: 1, y: 0 }), { x: 300, y: 196 })  // east is up
    expectClose(view.worldToScreen({ x: 0, y: -1 }), { x: 296, y: 200 }) // north is left
    expect(view.screenAxesInWorld()).toEqual({ right: { x: 0, y: 1 }, down: { x: -1, y: 0 } })
    ;[0, -4, 4, 0, 300, 200].forEach((value, index) => expect(view.planar.affine[index]).toBeCloseTo(value, 6))
    expect(view.northUp).toBe(false)
    expect(view.camera.bearingDeg).toBe(90)
    expect(fromPlane({ x: 300, y: 200, scale: 4, bearingDeg: 359.98 }, plane).northUp).toBe(true)

    const turned = fromPlane({ x: 300, y: 200, scale: 4, bearingDeg: 30 }, plane)
    const { right, down } = turned.screenAxesInWorld()
    const origin = turned.worldToScreen({ x: 0, y: 0 })
    expectNear(turned.worldToScreen(right), { x: origin.x + 4, y: origin.y }, 1e-12)
    expectNear(turned.worldToScreen(down), { x: origin.x, y: origin.y + 4 }, 1e-12)
    expect(turned.screenDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(20, 12)
  })

  it('the centre and the corners at bearing 0 are the viewport\'s', () => {
    const plane = createSessionPlane({ lon: -122.68, lat: 45.52 })
    const view = fromPlane({ x: -200, y: -100, scale: 2, bearingDeg: 0 }, plane)

    const centre = plane.toGeo({ x: 350, y: 250 })
    expect(view.camera.center.lon).toBeCloseTo(centre.lon, 10)
    expect(view.camera.center.lat).toBeCloseTo(centre.lat, 10)
    expect(view.camera.zoom).toBeCloseTo(Math.log2(mapZoomToStageScale(0, 45.52) ** -1 * 2), 12)
    view.visibleWorldQuad().forEach((corner, index) => expectClose(corner, [
      { x: 100, y: 50 }, { x: 600, y: 50 }, { x: 600, y: 450 }, { x: 100, y: 450 },
    ][index]!))
    const quad = view.visibleWorldQuad()
    view.worldQuadToScreen(quad).forEach((corner, index) => expectClose(corner, [
      { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }, { x: 0, y: 800 },
    ][index]!))
  })

  it('reads the ground resolution at a point, not the plane scale', () => {
    const plane = createSessionPlane({ lon: 13.4, lat: 52.5 })
    const view = fromPlane({ x: 500, y: 400, scale: 5, bearingDeg: 0 }, plane)

    expect(view.metresPerPixelAt()).toBeCloseTo(1 / 5, 12)
    expect(view.metresPerPixelAt({ x: 0, y: 0 })).toBeCloseTo(1 / 5, 12)
    const north = view.metresPerPixelAt({ x: 0, y: -100_000 })
    expect(north).toBeLessThan(1 / 5)
    expect(north).toBeCloseTo(1 / mapZoomToStageScale(view.camera.zoom, plane.toGeo({ x: 0, y: -100_000 }).lat), 12)
  })

  it('projectAnchors writes what worldToScreen returns', () => {
    const plane = createSessionPlane({ lon: 0, lat: 0 })
    const anchors = Float64Array.of(0, 0, 12.5, -3, -40, 250, 99, 99)
    for (const bearingDeg of [0, 30]) {
      const view = fromPlane({ x: 17, y: -9, scale: 3.5, bearingDeg }, plane)
      const out = new Float32Array(8).fill(-1)

      view.projectAnchors(anchors, out, 3)

      for (let index = 0; index < 3; index++) {
        const screen = view.worldToScreen({ x: anchors[index * 2]!, y: anchors[index * 2 + 1]! })
        expect(out[index * 2]).toBe(Math.fround(screen.x))
        expect(out[index * 2 + 1]).toBe(Math.fround(screen.y))
      }
      expect(Array.from(out.slice(6))).toEqual([-1, -1])
    }
  })

  it('reads back the placement of the camera it was built from', () => {
    const plane = createSessionPlane({ lon: 2.35, lat: 48.85 })
    const planar = { x: 12, y: 34, scale: 6, bearingDeg: -30 }
    const screen = { width: 640, height: 480, devicePixelRatio: 2 }
    const camera = planarToViewCamera(planar, screen, plane)
    const view = fromCamera(camera, plane, screen)

    expect(view.camera).toBe(camera)
    expect(view.camera.bearingDeg).toBe(330)
    expect(view.screen).toBe(screen)
    const placement = planarCameraOf(view)
    expect(placement.x).toBeCloseTo(12, 6)
    expect(placement.y).toBeCloseTo(34, 6)
    expect(placement.scale).toBeCloseTo(6, 9)
    expect(placement.bearingDeg).toBe(330)
  })
})

// Moved from __tests__/projection.test.ts: the centre and the corners of a ViewTransform at bearing 0, in place of
// projection.ts's viewportCenterGeo and viewportCornerGeoPoints (deleted with canvas/maplibre-camera.ts at the end of 0A).
describe('ViewTransform.camera center', () => {
  it('projects the viewport center from viewport state', () => {
    const plane = createSessionPlane({ lon: -122.68, lat: 45.52 })
    const view = fromPlane({ x: -200, y: -100, scale: 2, bearingDeg: 0 }, plane)

    const expected = plane.toGeo({ x: 350, y: 250 })
    expect(view.camera.center.lon).toBeCloseTo(expected.lon, 8)
    expect(view.camera.center.lat).toBeCloseTo(expected.lat, 8)
  })
})

describe('ViewTransform.visibleWorldQuad corners', () => {
  it('returns four projected corner points for the current viewport', () => {
    const plane = createSessionPlane({ lon: -122.68, lat: 45.52 })
    const view = fromPlane({ x: -200, y: -100, scale: 2, bearingDeg: 0 }, plane)

    const corners = view.visibleWorldQuad().map((corner) => plane.toGeo(corner))

    expect(corners).toHaveLength(4)
    expect(corners[0]!.lon).toBeLessThan(corners[1]!.lon)
    expect(corners[0]!.lat).toBeGreaterThan(corners[2]!.lat)
  })
})
