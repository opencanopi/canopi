import { describe, expect, it } from 'vitest'
import { createTestView } from '../../__tests__/support/test-view'
import { conformalFixturePlaneForTests, createSessionPlane, type SessionPlane } from '../session-plane'
import type { ViewFrame, ViewTransform } from './types'
import { planarCameraOf } from './view-transform'

const SCREEN_POINTS = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }, { x: 200, y: 150 }, { x: 37.5, y: 211 }]

function groundUnder(view: ViewTransform, plane: SessionPlane) {
  return SCREEN_POINTS.map((point) => plane.toGeo(view.screenToWorld(point)))
}

describe('re-origin', () => {
  it('planeChanged keeps the camera', () => {
    const first = createSessionPlane({ lon: 2.3522, lat: 48.8566 })
    // A re-origin about 20 km east, as the runtime makes after panning away.
    const next = createSessionPlane(first.toGeo({ x: 20_000, y: -5_000 }))

    for (const setup of [{ viewport: { x: -19_850.25, y: 5_100.5, scale: 1.25 } }, { camera: { center: first.toGeo({ x: 19_900, y: -4_950 }), zoom: 17.5, bearingDeg: 30 } }]) {
      const view = createTestView({ plane: first, ...setup })
      const driver = view.host.current()
      const published: ViewFrame[] = []
      view.frames.onViewFrame('overlays', (frame) => published.push(frame))
      const before = view.frames.viewFrame.peek()
      const groundBefore = groundUnder(before.view, first)

      driver.planeChanged(next)

      // One frame, in the next plane, with the same camera: the same ground under every screen point.
      expect(published).toHaveLength(1)
      const after = published[0]!
      expect(after.view.planeRevision).toBe(before.view.planeRevision + 1)
      expect(after.view.camera.bearingDeg).toBe(before.view.camera.bearingDeg)
      expect(after.view.camera.zoom).toBeCloseTo(before.view.camera.zoom, 9)
      expect(after.view.camera.center.lon).toBeCloseTo(before.view.camera.center.lon, 9)
      expect(after.view.camera.center.lat).toBeCloseTo(before.view.camera.center.lat, 9)
      for (const [index, ground] of groundUnder(after.view, next).entries()) {
        expect(ground.lon).toBeCloseTo(groundBefore[index]!.lon, 9)
        expect(ground.lat).toBeCloseTo(groundBefore[index]!.lat, 9)
      }
      view.dispose()
    }

    // On a conformal fixture plane, the camera keeps its ground through lon/lat at bearing 0 within 1e-6 px.
    const conformalFirst = conformalFixturePlaneForTests({ lon: 2.3522, lat: 48.8566 })
    const conformalNext = conformalFixturePlaneForTests(conformalFirst.toGeo({ x: 20_000, y: -5_000 }))
    const view = createTestView({ plane: conformalFirst, viewport: { x: -19_850.25, y: 5_100.5, scale: 1.25 } })
    const groundBefore = groundUnder(view.view(), conformalFirst)
    view.host.current().planeChanged(conformalNext)
    const placement = planarCameraOf(view.view())
    expect(placement.bearingDeg).toBe(0)
    expect(placement.scale).toBeCloseTo(1.25 * (conformalNext.pixelsPerMetre(0).mean / conformalFirst.pixelsPerMetre(0).mean), 6)
    for (const [index, ground] of groundUnder(view.view(), conformalNext).entries()) {
      expect(ground.lon).toBeCloseTo(groundBefore[index]!.lon, 9)
      expect(ground.lat).toBeCloseTo(groundBefore[index]!.lat, 9)
    }
    view.dispose()
  })

  it('keeps a temporary focus bookmark across a re-origin so the return lands on the original view', () => {
    const first = createSessionPlane({ lon: 2.3522, lat: 48.8566 })
    const view = createTestView({ plane: first, camera: { center: first.origin, zoom: 16 } })
    const designView = view.view().camera

    // Coverage about 20 km away, as "View coverage" frames it.
    expect(view.navigation.focusTemporaryBounds(
      { minX: 19_900, minY: -5_100, maxX: 20_100, maxY: -4_900 },
      { paddingCssPx: 24 },
    )).toBe(true)

    // The settled frame re-origins at the new centre.
    const next = createSessionPlane(first.toGeo(view.view().screenToWorld({ x: 200, y: 150 })))
    view.host.current().planeChanged(next)

    expect(view.navigation.returnFromTemporaryFocus()).toBe(true)
    const returned = view.view().camera
    expect(returned.center.lon).toBeCloseTo(designView.center.lon, 7)
    expect(returned.center.lat).toBeCloseTo(designView.center.lat, 7)
    expect(returned.zoom).toBeCloseTo(designView.zoom, 7)
    view.dispose()
  })

  it('planeChanged to the plane it already has publishes nothing', () => {
    const plane = createSessionPlane({ lon: 2.3522, lat: 48.8566 })
    const view = createTestView({ plane, viewport: { x: 12, y: -30, scale: 2 } })
    const published: ViewFrame[] = []
    view.frames.onViewFrame('overlays', (frame) => published.push(frame))
    const before = view.frames.viewFrame.peek()

    view.host.current().planeChanged(plane)

    expect(published).toHaveLength(0)
    expect(view.frames.viewFrame.peek()).toBe(before)
    view.dispose()
  })
})
