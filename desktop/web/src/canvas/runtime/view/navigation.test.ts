import { signal } from '@preact/signals'
import { describe, expect, it } from 'vitest'
import { createTestView, type TestView } from '../../../__tests__/support/test-view'
import { mapZoomToStageScale } from '../../projection'
import { getAnnotationWorldBounds } from '../annotation-layout'
import { getPlantWorldBounds } from '../plant-presentation'
import type { ScenePersistedState } from '../scene'
import { getZoneWorldBounds } from '../zone-geometry'
import { createViewNavigation } from './navigation'
import { createNavigationPolicy } from './navigation-policy'
import type { PlanarCamera, SceneExtent, ViewFrame, WorldPoint } from './types'
import { planarCameraOf } from './view-transform'

const EQUATOR_MAX_SCALE = mapZoomToStageScale(27, 0)
/** The world floor of a 1000 × 800 screen at every bearing (spec §4.14): its diagonal is one world. */
const WIDE_FLOOR_SCALE = mapZoomToStageScale(Math.log2(Math.hypot(1000, 800) / 512), 0)

function createScene(): ScenePersistedState {
  return {
    plantSpeciesColors: {},
    plantSpeciesSymbols: {},
    plantSpeciesCodes: {},
    layers: [],
    plants: [
      {
        kind: 'plant',
        locked: false,
        id: 'p1',
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
        color: null,
        canopySpreadM: null,
        position: { x: 10, y: 20 },
        rotationDeg: null,
        notes: null,
        plantedDate: null,
        quantity: null,
      },
    ],
    zones: [
      {
        kind: 'zone',
        locked: false,
        id: 'z1', name: null,
        zoneType: 'rect',
        points: [
          { x: 0, y: 0 },
          { x: 30, y: 0 },
          { x: 30, y: 40 },
          { x: 0, y: 40 },
        ],
        rotationDeg: 0,
        fillColor: null,
        notes: null,
      },
    ],
    annotations: [],
    measurementGuides: [],
    groups: [],
  }
}

function emptyScene(): ScenePersistedState {
  return { ...createScene(), plants: [], zones: [] }
}

/** Corner points of every plant, zone and note footprint at a scale, from the helpers today's computeSceneBounds reads. */
function boundsOf(scene: ScenePersistedState, emptySceneScale = 0): SceneExtent {
  return {
    emptySceneScale,
    extentPoints(pixelsPerMetre) {
      const points: WorldPoint[] = []
      const corners = (box: { x: number; y: number; width: number; height: number }) => {
        points.push({ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height })
      }
      for (const plant of scene.plants) {
        corners(getPlantWorldBounds(plant, { pixelsPerMetre, plants: scene.plants }))
      }
      for (const zone of scene.zones) {
        const box = getZoneWorldBounds(zone)
        if (box) corners(box)
      }
      for (const annotation of scene.annotations) corners(getAnnotationWorldBounds(annotation, pixelsPerMetre))
      return points
    },
  }
}

function sceneView(width: number, height: number, scene: ScenePersistedState, viewport?: { x: number; y: number; scale: number }): TestView {
  const view = createTestView({ screen: { width, height }, viewport })
  view.setScene(scene, boundsOf(scene))
  return view
}

function frameOf(view: TestView): ViewFrame {
  return view.frames.viewFrame.peek()
}

function placement(view: TestView): PlanarCamera {
  return planarCameraOf(view.view())
}

/** The headless camera is geographic: a placement reads back within 1e-6 px (D7). */
function expectPlacement(actual: PlanarCamera, expected: PlanarCamera): void {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
  expect(actual.scale).toBeCloseTo(expected.scale, 9)
  expect(actual.bearingDeg).toBeCloseTo(expected.bearingDeg, 9)
}

describe('view navigation', () => {
  // Moved from __tests__/camera-controller.test.ts (CameraController > …), on the navigation and its driver host.

  it('zooms around the provided screen point', () => {
    const view = createTestView({ screen: { width: 1000, height: 800 }, viewport: { x: 100, y: 0, scale: 8 } })

    const pointer = { x: 250, y: 200 }
    const before = view.view().screenToWorld(pointer)
    view.navigation.zoomAroundPx(pointer, 2)
    const after = view.view().screenToWorld(pointer)

    expect(view.view().pixelsPerMetre).toBeCloseTo(16, 9)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    view.dispose()
  })

  it('clamps viewport scale to the configured map zoom range', () => {
    const view = createTestView({ screen: { width: 1000, height: 800 } })

    view.navigation.showCamera({ center: { lon: 0, lat: 0 }, zoom: 30, bearingDeg: 0, pitchDeg: 0 })
    expect(view.view().pixelsPerMetre).toBe(EQUATOR_MAX_SCALE)
    view.navigation.showCamera({ center: { lon: 0, lat: 0 }, zoom: -5, bearingDeg: 0, pitchDeg: 0 })
    expect(view.view().pixelsPerMetre / WIDE_FLOOR_SCALE).toBeCloseTo(1, 6)
    view.dispose()
  })

  it('lets zoom-in reach the precision maximum without exceeding it', () => {
    const view = createTestView({ screen: { width: 1000, height: 800 }, viewport: { x: 0, y: 0, scale: EQUATOR_MAX_SCALE / 1.05 } })

    view.navigation.zoomIn()
    expect(view.view().pixelsPerMetre).toBe(EQUATOR_MAX_SCALE)
    const revision = frameOf(view).revision
    view.navigation.zoomIn()
    expect(view.view().pixelsPerMetre).toBe(EQUATOR_MAX_SCALE)
    expect(frameOf(view).revision).toBe(revision)
    view.dispose()
  })

  it('derives overview below 0.1 while keeping the threshold editable', () => {
    const view = createTestView({ screen: { width: 1000, height: 800 } })

    // A camera holds a zoom, so 0.1 px/m reads back within 1e-15 of it: just above it is site.
    view.setViewport({ x: 0, y: 0, scale: 0.1 + 1e-12 })
    expect(frameOf(view).mode).toBe('site')
    view.setViewport({ x: 0, y: 0, scale: 0.099 })
    expect(frameOf(view).mode).toBe('overview')
    view.dispose()
  })

  it('returns an empty overview to an origin-centred site frame', () => {
    const view = sceneView(400, 300, emptyScene(), { x: 12, y: 18, scale: 0.01 })

    view.navigation.returnToDesign()

    expectPlacement(placement(view), { x: 200, y: 150, scale: 3, bearingDeg: 0 })
    expect(frameOf(view).mode).toBe('site')
    view.dispose()
  })

  it('zooms an empty overview in to the site frame about the view centre when asked', () => {
    // The ground at the screen centre (200, 150) is (18800, 13200) m before and after.
    const view = sceneView(400, 300, emptyScene(), { x: 12, y: 18, scale: 0.01 })

    view.navigation.returnToDesign({ around: 'view-centre' })

    expectPlacement(placement(view), { x: 200 - 18_800 * 3, y: 150 - 13_200 * 3, scale: 3, bearingDeg: 0 })
    expect(frameOf(view).mode).toBe('site')
    view.dispose()
  })

  it('returns ordinary content with the existing fit policy', () => {
    const scene = createScene()
    const expectedView = sceneView(1000, 800, scene, { x: 100, y: 0, scale: 8 })
    expectedView.navigation.zoomToFit()
    const expected = placement(expectedView)
    const view = sceneView(1000, 800, scene, { x: 0, y: 0, scale: 0.01 })

    view.navigation.returnToDesign()

    expectPlacement(placement(view), expected)
    expect(frameOf(view).mode).toBe('site')
    // Today's CameraController (zoomToFit from its 1000 × 800 initial frame) landed on the same placement.
    expectPlacement(expected, { x: 260, y: 80, scale: 16, bearingDeg: 0 })
    expectedView.dispose()
    view.dispose()
  })

  it('keeps Fit to content global while Return restores a usable site view', () => {
    const scene = createScene()
    scene.zones[0]!.points = [
      { x: -5_000_000, y: -5_000_000 },
      { x: 5_000_000, y: -5_000_000 },
      { x: 5_000_000, y: 5_000_000 },
      { x: -5_000_000, y: 5_000_000 },
    ]
    const view = sceneView(1000, 800, scene, { x: 100, y: 0, scale: 8 })

    view.navigation.zoomToFit()
    expect(view.view().pixelsPerMetre).toBeLessThan(0.1)
    expect(frameOf(view).mode).toBe('overview')
    view.navigation.returnToDesign()
    expectPlacement(placement(view), { x: 500, y: 400, scale: 8, bearingDeg: 0 })
    expect(frameOf(view).mode).toBe('site')
    view.dispose()
  })

  it('returns to a fit that reads back as site scale, even just below 0.1 px/m', () => {
    // A 1000 × 800 fit pads 10 % a side: 800 px across the content. Content this wide fits within read-back tolerance below 0.1 px/m.
    const scale = 0.1 * (1 - 1e-10)
    const across = 800 / scale
    const extent: SceneExtent = { emptySceneScale: 0, extentPoints: () => [{ x: 0, y: 0 }, { x: across, y: 1 }] }
    const scene = createScene()
    const view = createTestView({ screen: { width: 1000, height: 800 }, viewport: { x: 100, y: 0, scale: 8 } })
    view.setScene(scene, extent)

    view.navigation.returnToDesign()

    // The fit, not the plane origin at the 100 m fallback (8 px/m on this screen).
    expect(view.view().pixelsPerMetre).toBeCloseTo(scale, 12)
    expect(view.view().pixelsPerMetre).toBeLessThan(0.1)
    expect(frameOf(view).mode).toBe('site')
    view.dispose()
  })

  it('rejects nonfinite zoom input without publishing', () => {
    const view = createTestView()
    const before = frameOf(view)

    view.navigation.zoomAroundPx({ x: 10, y: 20 }, Number.NaN)
    view.navigation.zoomAroundPx({ x: Number.POSITIVE_INFINITY, y: 20 }, 2)
    view.navigation.zoomBy(Number.NaN)

    expect(frameOf(view)).toBe(before)
    view.dispose()
  })

  it('focuses temporary bounds with one retained bookmark and restores it once', () => {
    const view = createTestView({ viewport: { x: 10, y: 20, scale: 2 } })
    const before = placement(view)

    expect(view.navigation.focusTemporaryBounds(
      { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      { paddingCssPx: 48, maximumScale: 5 },
    )).toBe(true)
    const afterFirstFocus = placement(view)
    expectPlacement(afterFirstFocus, { x: 48, y: 74, scale: 3.04, bearingDeg: 0 })
    expect(afterFirstFocus).not.toEqual(before)

    // A chained focus keeps the bookmark the first one took: a return lands on the view before the first focus.
    expect(view.navigation.focusTemporaryBounds(
      { minX: 300, minY: 100, maxX: 350, maxY: 150 },
      { paddingCssPx: 48, maximumScale: 5 },
    )).toBe(true)
    expect(view.navigation.returnFromTemporaryFocus()).toBe(true)
    expectPlacement(placement(view), before)
    const returnedRevision = frameOf(view).revision
    expect(view.navigation.returnFromTemporaryFocus()).toBe(false)
    expect(frameOf(view).revision).toBe(returnedRevision)
    view.dispose()
  })

  it('frameBounds frames as a temporary focus does and leaves no bookmark', () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 }
    const options = { paddingCssPx: 48, maximumScale: 5 }
    const focused = createTestView({ viewport: { x: 10, y: 20, scale: 2 } })
    expect(focused.navigation.focusTemporaryBounds(bounds, options)).toBe(true)
    const framedView = createTestView({ viewport: { x: 10, y: 20, scale: 2 } })

    expect(framedView.navigation.frameBounds(bounds, options)).toBe(true)

    expectPlacement(placement(framedView), placement(focused))
    expect(framedView.navigation.returnFromTemporaryFocus()).toBe(false)
    expect(framedView.navigation.frameBounds({ minX: 1, minY: 0, maxX: 1, maxY: 10 }, options)).toBe(false)
    focused.dispose()
    framedView.dispose()
  })

  it('a return lands before the first focus, whatever frameBounds did in between', () => {
    const view = createTestView({ viewport: { x: 10, y: 20, scale: 2 } })
    const before = placement(view)
    expect(view.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, { paddingCssPx: 48 })).toBe(true)

    expect(view.navigation.frameBounds({ minX: 300, minY: 100, maxX: 350, maxY: 150 }, { paddingCssPx: 48 })).toBe(true)
    expect(placement(view)).not.toEqual(before)

    expect(view.navigation.returnFromTemporaryFocus()).toBe(true)
    expectPlacement(placement(view), before)
    expect(view.navigation.returnFromTemporaryFocus()).toBe(false)
    view.dispose()
  })

  it('manual navigation and Fit to Design drop the bookmark', () => {
    const scene = createScene()
    const moves: ReadonlyArray<readonly [string, (view: TestView) => void]> = [
      ['pan', (view) => view.navigation.panByPx({ x: 30, y: -12 })],
      ['wheel or pinch zoom', (view) => view.navigation.zoomAroundPx({ x: 120, y: 80 }, 1.3)],
      ['zoom in', (view) => view.navigation.zoomIn()],
      ['zoom out', (view) => view.navigation.zoomOut()],
      ['zoom by', (view) => view.navigation.zoomBy(2)],
      ['Fit to Design', (view) => view.navigation.zoomToFit()],
      ['Return to Design', (view) => view.navigation.returnToDesign()],
      ['rotate by a key step', (view) => view.navigation.rotateBy(1)],
      ['turn to an edge', (view) => view.navigation.turnToEdge({ x: 0, y: 0 }, { x: 10, y: 10 })],
      ['rotate by dragging', (view) => { const session = view.navigation.beginRotation('centre'); session.update(30, { step: false }); session.end() }],
    ]
    for (const [name, move] of moves) {
      const view = sceneView(400, 300, scene, { x: 10, y: 20, scale: 2 })
      expect(view.navigation.focusTemporaryBounds({ minX: 300, minY: 100, maxX: 350, maxY: 150 }, { paddingCssPx: 48 }), name).toBe(true)
      move(view)
      expect(view.navigation.returnFromTemporaryFocus(), name).toBe(false)
      view.dispose()
    }
  })

  it('a move the camera refuses keeps the bookmark', () => {
    const refused: ReadonlyArray<readonly [string, (view: TestView) => void]> = [
      ...[Number.NaN, 0, Number.POSITIVE_INFINITY, -2].map((factor) =>
        [`zoom by ${factor}`, (view: TestView) => view.navigation.zoomBy(factor)] as const),
      ['zoom about a non-finite point', (view) => view.navigation.zoomAroundPx({ x: Number.NaN, y: 0 }, 2)],
      ['pan by a non-finite delta', (view) => view.navigation.panByPx({ x: Number.POSITIVE_INFINITY, y: 0 })],
      ['jump to an invalid camera', (view) => view.navigation.showCamera({ center: { lon: Number.NaN, lat: 0 }, zoom: 10, bearingDeg: 0, pitchDeg: 0 })],
    ]
    for (const [name, move] of refused) {
      const view = createTestView({ viewport: { x: 10, y: 20, scale: 2 } })
      expect(view.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, { paddingCssPx: 48 }), name).toBe(true)
      const focused = frameOf(view)
      move(view)
      expect(frameOf(view), name).toBe(focused)
      expect(view.navigation.returnFromTemporaryFocus(), name).toBe(true)
      view.dispose()
    }
  })

  it('rejects invalid temporary bounds without publishing a frame', () => {
    const view = createTestView({ screen: { width: 0, height: 0 } })
    expect(view.navigation.focusTemporaryBounds(
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      { paddingCssPx: 0 },
    )).toBe(false)
    expect(frameOf(view).revision).toBe(0)

    view.host.current().setScreen({ width: 400, height: 300, devicePixelRatio: 1 })
    const revision = frameOf(view).revision

    expect(view.navigation.focusTemporaryBounds(
      { minX: 1, minY: 0, maxX: 1, maxY: 10 },
      { paddingCssPx: 48 },
    )).toBe(false)
    expect(view.navigation.focusTemporaryBounds(
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      { paddingCssPx: 201 },
    )).toBe(false)
    expect(frameOf(view).revision).toBe(revision)
    view.dispose()
  })

  it('fits temporary bounds with CSS-pixel padding and both scale ceilings', () => {
    const view = createTestView()

    view.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 0.001, maxY: 0.001 }, { paddingCssPx: 48 })
    expectPlacement(placement(view), {
      x: 200 - 0.0005 * EQUATOR_MAX_SCALE,
      y: 150 - 0.0005 * EQUATOR_MAX_SCALE,
      scale: EQUATOR_MAX_SCALE,
      bearingDeg: 0,
    })
    view.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { paddingCssPx: 48, maximumScale: 2 })
    expectPlacement(placement(view), { x: 199, y: 149, scale: 2, bearingDeg: 0 })
    view.dispose()
  })

  it('clears a temporary bookmark during initialization and disposal', () => {
    // The opening fit (openAt) is today's initialize; clearTemporaryFocus is what a disposal calls.
    const view = sceneView(400, 300, createScene())
    view.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { paddingCssPx: 48 })
    view.navigation.openAt(0)
    expect(view.navigation.returnFromTemporaryFocus()).toBe(false)

    view.navigation.focusTemporaryBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { paddingCssPx: 48 })
    view.navigation.clearTemporaryFocus()
    expect(view.navigation.returnFromTemporaryFocus()).toBe(false)
    view.dispose()
  })

  it('fits to the scene bounds', () => {
    const view = sceneView(1000, 800, createScene(), { x: 100, y: 0, scale: 8 })

    view.navigation.zoomToFit()

    expect(view.view().pixelsPerMetre).toBeGreaterThan(0)
    const topLeft = view.view().worldToScreen({ x: 0, y: 0 })
    const bottomRight = view.view().worldToScreen({ x: 30, y: 40 })
    expect(topLeft.x).toBeGreaterThanOrEqual(0)
    expect(topLeft.y).toBeGreaterThanOrEqual(0)
    expect(bottomRight.x).toBeLessThanOrEqual(1000)
    expect(bottomRight.y).toBeLessThanOrEqual(800)
    view.dispose()
  })

  it('fits the full rotated note envelope consistently from marker and text scales', () => {
    const scene = createScene()
    scene.annotations = [{ kind: 'annotation', id: 'note', annotationType: 'text', locked: false,
      position: { x: 50, y: 60 }, text: 'A long note\nWith another line', fontSize: 16, rotationDeg: 45 }]
    const results = [1, 14, 1000].map((scale) => {
      const view = sceneView(1000, 800, scene, { x: 0, y: 0, scale })
      view.navigation.zoomToFit()
      const fitted = placement(view)
      view.dispose()
      return fitted
    })
    for (const result of results) {
      expect(result.scale).toBeCloseTo(results[0]!.scale, 2)
      expect(result.x).toBeCloseTo(results[0]!.x, 1)
      expect(result.y).toBeCloseTo(results[0]!.y, 1)
    }
  })

  it('converges in a single call despite scale-dependent bounds', () => {
    const scene = createScene()
    scene.annotations = [{
      kind: 'annotation',
      locked: false,
      id: 'a1',
      annotationType: 'text',
      position: { x: 50, y: 60 },
      text: 'A long annotation that affects bounds',
      fontSize: 20,
      rotationDeg: null,
    }]
    const view = sceneView(1000, 800, scene, { x: 100, y: 0, scale: 8 })

    view.navigation.zoomToFit()
    const first = placement(view)
    view.navigation.zoomToFit()
    const second = placement(view)

    expect(first.scale).toBeCloseTo(second.scale, 2)
    expect(first.x).toBeCloseTo(second.x, 1)
    expect(first.y).toBeCloseTo(second.y, 1)
    view.dispose()
  })

  // Navigation of its own.

  it('fits, zooms and focuses within 1e-6 of today\'s CameraController at bearing 0', () => {
    const scene = createScene()
    scene.annotations = [{ kind: 'annotation', id: 'sign', annotationType: 'text', locked: false,
      position: { x: -20, y: 70 }, text: 'Gate', fontSize: 16, rotationDeg: null }]
    const insets = { top: 40, right: 300, bottom: 20, left: 60 }
    const view = sceneView(1000, 800, scene, { x: 3, y: -7, scale: 2 })
    view.navigation.setFramingInsets(insets)
    // Today's CameraController after the same calls on the same screen, placement and insets (zoomToFit, zoomIn and zoomOut twice,
    // zoomAroundScreenPoint about the centre, panBy, focusTemporaryBounds, returnFromTemporaryFocus, returnToDesign),
    // recorded at 52cbff10 before the class became the legacy shim.
    const today: ReadonlyArray<readonly [number, number, number]> = [
      [339.14286269122294, 114, 8.171427461755401],
      [353.7662388102027, 140, 7.428570419777637],
      [-11.818164164290579, -510, 25.99999646922173],
      [-52.31816416429058, -497.75, 25.99999646922173],
      [181.31506849315068, 259.972602739726, 8.10958904109589],
      [-52.31816416429058, -497.75, 25.99999646922173],
      [-1128.25, 991.5, 6.5],
      [339.1428708288235, 114, 8.171425834235297],
    ]
    let step = 0
    const expectSame = () => {
      const [x, y, scale] = today[step++]!
      const actual = placement(view)
      expect(actual.x).toBeCloseTo(x, 6)
      expect(actual.y).toBeCloseTo(y, 6)
      expect(actual.scale).toBeCloseTo(scale, 6)
      expect(actual.bearingDeg).toBe(0)
    }

    view.navigation.zoomToFit()
    expectSame()
    view.navigation.zoomIn()
    view.navigation.zoomOut()
    view.navigation.zoomOut()
    expectSame()
    view.navigation.zoomBy(3.5)
    expectSame()
    view.navigation.panByPx({ x: -40.5, y: 12.25 })
    expectSame()
    view.navigation.focusTemporaryBounds({ minX: -12, minY: 4, maxX: 61, maxY: 33 }, { paddingCssPx: 24 })
    expectSame()
    view.navigation.returnFromTemporaryFocus()
    expectSame()
    // Today's centerOn({ x: 250.5, y: -91 }, 6.5): the point at the screen centre at 6.5 px/m.
    view.setViewport({ x: 500 - 250.5 * 6.5, y: 400 + 91 * 6.5, scale: 6.5 })
    expectSame()
    view.navigation.returnToDesign()
    expectSame()
    expect(step).toBe(today.length)
    view.dispose()
  })

  it('setFramingInsets reaches the frame and refuses invalid edges', () => {
    const view = createTestView()

    view.navigation.setFramingInsets({ top: 40, right: 12, bottom: 0, left: 60 })
    expect(frameOf(view).insets).toEqual({ top: 40, right: 12, bottom: 0, left: 60 })
    view.navigation.setFramingInsets({ top: -1, right: 12, bottom: Number.NaN, left: 60 })
    expect(frameOf(view).insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    view.dispose()
  })

  it('shows a place at its zoom and keeps the bearing', () => {
    const view = createTestView({ screen: { width: 800, height: 600 }, camera: { bearingDeg: 30, zoom: 12 } })

    expect(view.navigation.showPlace({ lon: 0.01, lat: -0.02 }, 17)).toBe(true)

    const { camera } = view.view()
    expect(camera.center.lon).toBeCloseTo(0.01, 9)
    expect(camera.center.lat).toBeCloseTo(-0.02, 9)
    expect(camera.zoom).toBeCloseTo(17, 9)
    expect(camera.bearingDeg).toBe(30)
    expect(view.navigation.showPlace({ lon: Number.NaN, lat: 0 }, 17)).toBe(false)
    view.dispose()
  })

  it('Shift+→ jumps to the next 15° multiple', () => {
    const view = createTestView({ camera: { bearingDeg: 22 } })
    const published: ViewFrame[] = []
    view.frames.onViewFrame('tools', (frame) => published.push(frame))
    const centre = { x: 200, y: 150 }
    const ground = view.view().screenToWorld(centre)

    // One frame, at once: no animation (U34).
    view.navigation.rotateBy(1)
    expect(published).toHaveLength(1)
    expect(view.view().camera.bearingDeg).toBe(30)
    expect(view.host.current().bearingTarget()).toBe(30)
    const kept = view.view().worldToScreen(ground)
    expect(kept.x).toBeCloseTo(centre.x, 6)
    expect(kept.y).toBeCloseTo(centre.y, 6)

    view.navigation.rotateBy(1)
    view.navigation.rotateBy(-1)
    view.navigation.rotateBy(-1)
    expect(published).toHaveLength(4)
    expect(view.view().camera.bearingDeg).toBe(15)
    view.dispose()
  })

  it('a compass click jumps to north', () => {
    // The compass click runs reset-north, which is this call.
    const view = createTestView({ camera: { bearingDeg: 30 } })
    const published: ViewFrame[] = []
    view.frames.onViewFrame('tools', (frame) => published.push(frame))
    const centre = { x: 200, y: 150 }
    const ground = view.view().screenToWorld(centre)

    view.navigation.resetNorth()

    expect(published).toHaveLength(1)
    expect(view.view().camera.bearingDeg).toBe(0)
    const kept = view.view().worldToScreen(ground)
    expect(kept.x).toBeCloseTo(centre.x, 6)
    expect(kept.y).toBeCloseTo(centre.y, 6)
    view.dispose()
  })

  it('a turn at the world floor keeps the zoom', () => {
    const view = createTestView({ screen: { width: 1000, height: 800 }, camera: { center: { lon: 0, lat: 0 }, zoom: 0 } })
    const floor = view.view().camera.zoom
    expect(floor).toBeCloseTo(Math.log2(Math.hypot(1000, 800) / 512), 6)

    for (const direction of [1, 1, 1, -1] as const) {
      view.navigation.rotateBy(direction)
      expect(view.view().camera.zoom).toBe(floor)
    }
    expect(view.view().camera.bearingDeg).toBe(30)
    view.dispose()
  })

  it('turns an edge level on screen by the smaller turn, at once', () => {
    const view = createTestView()

    // An edge running south-east: level at 45° or at 225°; from north, 45° is the smaller turn.
    view.navigation.turnToEdge({ x: 0, y: 0 }, { x: 10, y: 10 })
    const turned = view.view()
    expect(turned.camera.bearingDeg).toBeCloseTo(45, 9)
    const a = turned.worldToScreen({ x: 0, y: 0 })
    const b = turned.worldToScreen({ x: 10, y: 10 })
    expect(b.y - a.y).toBeCloseTo(0, 9)
    view.dispose()
  })

  it('turnToEdge 3 degrees off horizontal ends at 3', () => {
    const view = createTestView()
    const rad = 3 * Math.PI / 180

    // An explicit target is never snapped to north, however close it is (spec §4.4).
    view.navigation.turnToEdge({ x: 0, y: 0 }, { x: 10 * Math.cos(rad), y: 10 * Math.sin(rad) })

    expect(view.view().camera.bearingDeg).toBeCloseTo(3, 9)
    view.dispose()
  })

  it('a saved view at 3 restores at 3', () => {
    const view = createTestView()

    view.navigation.showCamera({ ...view.view().camera, bearingDeg: 3 }, { motion: 'fly' })

    expect(view.view().camera.bearingDeg).toBeCloseTo(3, 9)
    view.dispose()
  })

  it('a rotation session steps, jumps to north on release, and cancel restores the start', () => {
    const view = createTestView()
    const session = view.navigation.beginRotation('centre')

    session.update(22, { step: false })
    expect(view.view().camera.bearingDeg).toBe(22)
    session.update(22, { step: true })
    expect(view.view().camera.bearingDeg).toBe(15)
    // Key turns wait while the session owns the bearing.
    view.navigation.rotateBy(1)
    expect(view.host.current().bearingTarget()).toBe(15)
    session.update(-5, { step: false })
    session.end()
    expect(view.view().camera.bearingDeg).toBe(0)
    // Esc after the release does not restore the pre-release bearing.
    session.cancel()
    expect(view.view().camera.bearingDeg).toBe(0)

    const start = placement(view)
    const cancelled = view.navigation.beginRotation({ x: 40, y: 60 })
    cancelled.update(-80, { step: false })
    expect(view.view().camera.bearingDeg).toBe(280)
    cancelled.cancel()
    expectPlacement(placement(view), start)
    view.dispose()
  })

  it('a rotation session turns about its moving anchor: the world point under the centroid stays within 2 px through a pan plus a twist (A5)', () => {
    const view = createTestView({ screen: { width: 1000, height: 800 } })
    let centroid = { x: 400, y: 300 }
    const world = view.view().screenToWorld(centroid)
    const session = view.navigation.beginRotation(centroid)

    // Two fingers drift 100 px right while they twist 40°, panning then turning on each move as the recogniser sends it.
    for (let move = 1; move <= 10; move += 1) {
      const next = { x: 400 + 10 * move, y: 300 }
      view.navigation.panByPx({ x: next.x - centroid.x, y: next.y - centroid.y })
      centroid = next
      session.update(-4 * move, { step: false, anchorPx: centroid })
    }

    const under = view.view().worldToScreen(world)
    expect(Math.hypot(under.x - centroid.x, under.y - centroid.y)).toBeLessThan(2)
    expect(view.view().camera.bearingDeg).toBeCloseTo(320, 6)
    session.end()
    view.dispose()
  })

  it('a rotation session released within 7° of north snaps about its last anchor', () => {
    const view = createTestView({ screen: { width: 1000, height: 800 } })
    const session = view.navigation.beginRotation({ x: 400, y: 300 })
    view.navigation.panByPx({ x: 100, y: 0 })
    session.update(-5, { step: false, anchorPx: { x: 500, y: 300 } })
    const world = view.view().screenToWorld({ x: 500, y: 300 })

    session.end()

    expect(view.view().camera.bearingDeg).toBe(0)
    const under = view.view().worldToScreen(world)
    expect(under.x).toBeCloseTo(500, 6)
    expect(under.y).toBeCloseTo(300, 6)
    view.dispose()
  })

  it('opens a Design fitted at the given bearing', () => {
    const scene = createScene()
    const view = sceneView(1000, 800, scene, { x: 100, y: 0, scale: 8 })

    view.navigation.openAt(90)

    const opened = view.view()
    expect(opened.camera.bearingDeg).toBe(90)
    // The zone's four corners are on screen, inside the 10 % padding.
    for (const corner of [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 }]) {
      const onScreen = opened.worldToScreen(corner)
      expect(onScreen.x).toBeGreaterThanOrEqual(100 - 1e-6)
      expect(onScreen.x).toBeLessThanOrEqual(900 + 1e-6)
      expect(onScreen.y).toBeGreaterThanOrEqual(80 - 1e-6)
      expect(onScreen.y).toBeLessThanOrEqual(720 + 1e-6)
    }
    view.dispose()
  })

  it('openAt opens an empty scene at 0', () => {
    const scene = emptyScene()
    const view = createTestView({ screen: { width: 1000, height: 800 }, camera: { bearingDeg: 30 } })
    view.setScene(scene, boundsOf(scene, 4))

    view.navigation.openAt(30)

    // The new-Design overview: the plane origin at the screen centre, at the empty scene's scale, north up.
    expectPlacement(placement(view), { x: 500, y: 400, scale: 4, bearingDeg: 0 })
    view.dispose()
  })

  it('zooms to the selection at the current bearing', () => {
    const view = createTestView({ screen: { width: 1000, height: 800 } })
    const navigation = createViewNavigation({
      driver: view.host,
      policy: () => createNavigationPolicy(0, signal(false)),
      readSceneExtent: () => boundsOf(emptyScene()),
      readSelectionPoints: () => [{ x: 10, y: 10 }, { x: 110, y: 60 }],
    })

    navigation.zoomToSelection()

    // 100 × 50 m inside 80 % of the screen: 8 px/m, centred.
    expectPlacement(placement(view), { x: 500 - 60 * 8, y: 400 - 35 * 8, scale: 8, bearingDeg: 0 })
    view.dispose()
  })
})

describe('reopening an empty Design', () => {
  it.fails('[1b-c7 canopi-eon8.9] canopi-eon8.9: an empty reopened Design opens at its saved map_view, bearing 0', () => {
    const scene = emptyScene()
    const view = createTestView({ screen: { width: 1000, height: 800 } })
    view.setScene(scene, boundsOf(scene, 4))
    // Placed by a coordinate search and saved: nothing drawn, but a map_view the user chose.
    const saved = { center: { lon: 2.3522, lat: 48.8566 }, zoom: 17, bearingDeg: 40, pitchDeg: 0 as const }

    view.navigation.openAt(40, saved)

    const opened = view.view().camera
    expect(opened.center.lon).toBeCloseTo(saved.center.lon, 6)
    expect(opened.center.lat).toBeCloseTo(saved.center.lat, 6)
    expect(opened.zoom).toBeCloseTo(saved.zoom, 6)
    expect(opened.bearingDeg).toBe(0)
    view.dispose()
  })
})
