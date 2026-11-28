// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createSessionPlane, type SessionPlane } from '../geo/session-plane'
import { setCurrentCanvasSession } from '../canvas/session'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import type { PlanarCamera } from '../geo/view/types'
import { planarCameraOf } from '../geo/view/view-transform'
import {
  lidarBoundsToLocalWorld,
  viewDesignLocation,
  viewLidarCoverage,
} from '../app/data-library/camera-request'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestView, type TestView } from './support/test-view'

const plane = createSessionPlane({ lon: 2.3522, lat: 48.8566 })

function surfacesFor(view: TestView, sessionPlane: SessionPlane | null) {
  return createTestCanvasRuntimeSurfaces({
    queries: createTestCanvasQuerySurface({ sessionPlane }),
    commands: createTestCanvasCommandSurface({
      viewport: {
        focusTemporaryBounds: (bounds, options) => view.navigation.focusTemporaryBounds(bounds, options),
        returnFromTemporaryFocus: () => view.navigation.returnFromTemporaryFocus(),
        returnToDesign: () => view.navigation.returnToDesign(),
      },
    }),
  })
}

afterEach(() => {
  setCurrentCanvasSession(null)
})

/** The headless camera is geographic: a placement reads back within 1e-6 px. */
function expectSamePlacement(actual: PlanarCamera, expected: PlanarCamera): void {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
  expect(actual.scale).toBeCloseTo(expected.scale, 9)
  expect(actual.bearingDeg).toBeCloseTo(expected.bearingDeg, 9)
}

describe('LiDAR workspace camera navigation', () => {
  it('maps east/west to plane x and north/south to plane y', () => {
    const result = lidarBoundsToLocalWorld([2.34, 48.85, 2.37, 48.87], plane)

    expect(result).not.toBeNull()
    expect(result!.minX).toBeLessThan(0)
    expect(result!.maxX).toBeGreaterThan(0)
    expect(result!.minY).toBeLessThan(0)
    expect(result!.maxY).toBeGreaterThan(0)
  })

  it('converts the geographic corners into the north-up session plane', () => {
    const result = lidarBoundsToLocalWorld([2.34, 48.85, 2.37, 48.87], plane)

    // Independent WGS84 ellipsoid per-axis control values at origin lat 48.8566° (2.1-Q78d).
    const nw = plane.toPlane({ lon: 2.34, lat: 48.87 })
    const se = plane.toPlane({ lon: 2.37, lat: 48.85 })
    expect(result?.minX).toBeCloseTo(nw.x, 6)
    expect(result?.minY).toBeCloseTo(nw.y, 6)
    expect(result?.maxX).toBeCloseTo(se.x, 6)
    expect(result?.maxY).toBeCloseTo(se.y, 6)
  })

  it('returns null without a session plane', () => {
    expect(lidarBoundsToLocalWorld([2.34, 48.85, 2.37, 48.87], null)).toBeNull()
  })

  it('focuses and returns only the live Canvas viewport; Return to Design lands on the view before the first fit', () => {
    const view = createTestView({ screen: { width: 800, height: 600 }, viewport: { x: 30, y: 40, scale: 2 } })
    const before = planarCameraOf(view.view())
    setCurrentCanvasSession(surfacesFor(view, plane))

    expect(viewLidarCoverage([2.34, 48.85, 2.37, 48.87])).toBe(true)
    const afterFirstFocus = planarCameraOf(view.view())
    expect(afterFirstFocus).not.toEqual(before)
    const firstFocusRevision = view.frames.viewFrame.value.revision
    expect(viewLidarCoverage([2.345, 48.852, 2.35, 48.858])).toBe(true)
    expect(view.frames.viewFrame.value.revision).toBeGreaterThan(firstFocusRevision)
    // Fit to data on a second layer keeps the first fit's bookmark: Return to Design lands on the view before both fits.
    expect(viewDesignLocation()).toBe(true)
    expectSamePlacement(planarCameraOf(view.view()), before)
    // The bookmark is spent: a second Return to Design frames the Design.
    expect(viewDesignLocation()).toBe(true)
    const scaleAtMapZoom18 = createSessionPlane({ lon: 0, lat: plane.origin.lat }).pixelsPerMetre(18).mean
    expect(scaleAtMapZoom18).toBeGreaterThan(0.1)
    expect(createSessionPlane({ lon: 0, lat: plane.origin.lat }).zoomForPixelsPerMetre(scaleAtMapZoom18)).toBeCloseTo(18, 12)
  })

  it('Return to Design without a bookmark frames the Design', () => {
    const design = { extentPoints: () => [{ x: -60, y: -25 }, { x: 60, y: 25 }] }
    const view = createTestView({ screen: { width: 800, height: 600 }, viewport: { x: 30, y: 40, scale: 0.5 } })
    view.setScene(createDefaultScenePersistedState(), design)
    const before = planarCameraOf(view.view())
    setCurrentCanvasSession(surfacesFor(view, plane))

    // No Fit to data left a bookmark (a place search, a story step or a saved view dropped it): the Design is framed.
    expect(viewDesignLocation()).toBe(true)

    const framed = planarCameraOf(view.view())
    expect(framed).not.toEqual(before)
    const backToMyDesign = createTestView({ screen: { width: 800, height: 600 }, viewport: { x: 30, y: 40, scale: 0.5 } })
    backToMyDesign.setScene(createDefaultScenePersistedState(), design)
    backToMyDesign.navigation.returnToDesign()
    expect(framed).toEqual(planarCameraOf(backToMyDesign.view()))
    backToMyDesign.dispose()
    view.dispose()
  })

  it('a pan after Fit to data drops the bookmark: Return to Design frames the Design', () => {
    const design = { extentPoints: () => [{ x: -60, y: -25 }, { x: 60, y: 25 }] }
    const view = createTestView({ screen: { width: 800, height: 600 }, viewport: { x: 30, y: 40, scale: 0.5 } })
    view.setScene(createDefaultScenePersistedState(), design)
    setCurrentCanvasSession(surfacesFor(view, plane))

    expect(viewLidarCoverage([2.34, 48.85, 2.37, 48.87])).toBe(true)
    view.navigation.panByPx({ x: 120, y: -40 })
    expect(viewDesignLocation()).toBe(true)

    const designView = createTestView({ screen: { width: 800, height: 600 }, viewport: { x: 30, y: 40, scale: 0.5 } })
    designView.setScene(createDefaultScenePersistedState(), design)
    designView.navigation.returnToDesign()
    expectSamePlacement(planarCameraOf(view.view()), planarCameraOf(designView.view()))
    designView.dispose()
    view.dispose()
  })

  it('rejects invalid bounds, a missing session plane, and missing canvas commands without moving the camera', () => {
    // Today's initial 800 × 600 frame.
    const view = createTestView({ screen: { width: 800, height: 600 }, viewport: { x: 100, y: 0, scale: 6 } })
    const before = view.frames.viewFrame.value
    setCurrentCanvasSession(surfacesFor(view, plane))

    expect(viewLidarCoverage([2.37, 48.85, 2.34, 48.87])).toBe(false)
    setCurrentCanvasSession(surfacesFor(view, null))
    expect(viewLidarCoverage([2.34, 48.85, 2.37, 48.87])).toBe(false)
    setCurrentCanvasSession(null)
    expect(viewLidarCoverage([2.34, 48.85, 2.37, 48.87])).toBe(false)
    expect(view.frames.viewFrame.value).toBe(before)
  })
})
