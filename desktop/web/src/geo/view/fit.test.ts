import { describe, expect, it } from 'vitest'
import { sceneExtentPoints } from '../../canvas/runtime/scene-extent'
import type { SceneAnnotationEntity, ScenePersistedState } from '../../canvas/runtime/scene'
import { createSessionPlane } from '../session-plane'
import { fitScene, fitTemporaryBounds, framingRect, type FitFrame } from './fit'
import type { PlanarCamera, SceneBounds, ScreenInsets, WorldPoint } from './types'

const PLANE = createSessionPlane({ lon: 0, lat: 0 })

/** Plants sized without species data, as the renderer sizes a plant whose species is not cached. */
const PLANTS = { pixelsPerMetre: 1, speciesCache: new Map() }

function note(id: string, x: number, y: number, text: string, rotationDeg: number | null): SceneAnnotationEntity {
  return { kind: 'annotation', id, annotationType: 'text', locked: false, position: { x, y }, text, fontSize: 16, rotationDeg }
}

function scene(): ScenePersistedState {
  return {
    plantSpeciesColors: {},
    plantSpeciesSymbols: {},
    plantSpeciesCodes: {},
    layers: [],
    plants: [
      {
        kind: 'plant', locked: false, id: 'apple', canonicalName: 'Malus domestica', commonName: 'Apple', color: null,
        canopySpreadM: null, position: { x: 10, y: 20 }, rotationDeg: null, notes: null, plantedDate: null, quantity: null,
      },
      {
        kind: 'plant', locked: false, id: 'walnut', canonicalName: 'Juglans regia', commonName: 'Walnut', color: null,
        canopySpreadM: 12, position: { x: -35, y: 62 }, rotationDeg: null, notes: null, plantedDate: null, quantity: null,
      },
    ],
    zones: [
      {
        kind: 'zone', locked: false, id: 'bed', name: null, zoneType: 'rect',
        points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 }],
        rotationDeg: 0, fillColor: null, notes: null,
      },
      {
        kind: 'zone', locked: false, id: 'pond', name: 'pond', zoneType: 'ellipse',
        points: [{ x: 80, y: -10 }, { x: 14, y: 6 }], rotationDeg: 30, fillColor: null, notes: null,
      },
    ],
    annotations: [note('label', 50, 60, 'A long note\nWith another line', 45), note('sign', -20, -15, 'Gate', null)],
    measurementGuides: [],
    groups: [],
  }
}

/** The scene's extent (scene-extent.ts), counting the scales it is measured at. */
function countedExtent(design: ScenePersistedState, calls: { count: number }) {
  const extent = sceneExtentPoints(design, PLANTS)
  return (pixelsPerMetre: number): readonly WorldPoint[] => {
    calls.count += 1
    return extent(pixelsPerMetre)
  }
}

type Placement = readonly [x: number, y: number, scale: number]

/** Today's CameraController scale bounds (the default policy's), recorded at 52cbff10. */
const TODAY_SCALE_BOUNDS = { min: 1.2790334061860095e-05, max: 1716.6895781438734 }

/** The fit frame of today's CameraController placed at `placement` on a screen. */
function fitFrame(width: number, height: number, placement: Placement, insets?: ScreenInsets): FitFrame {
  const [x, y, scale] = placement
  return { screen: { width, height }, insets, scaleBounds: TODAY_SCALE_BOUNDS, current: { x, y, scale, bearingDeg: 0 }, toView: PLANE.toView }
}

/** Checks a fit's placement against a tolerant golden literal (precision 6: close, not bit for bit). */
function expectPlacement(actual: PlanarCamera | null, expected: Placement | null, precision = 6): void {
  if (!expected) {
    expect(actual).toBeNull()
    return
  }
  expect(actual).not.toBeNull()
  const [x, y, scale] = expected
  expect(actual!.x).toBeCloseTo(x, precision)
  expect(actual!.y).toBeCloseTo(y, precision)
  expect(actual!.scale).toBeCloseTo(scale, precision)
  expect(actual!.bearingDeg).toBe(0)
}

/** A world-axis box around points, as computeSceneBounds returned it. */
function worldAxisBox(points: readonly WorldPoint[]): SceneBounds | null {
  if (points.length === 0) return null
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

function orientedSpan(points: readonly WorldPoint[], bearingDeg: number): { width: number; height: number } {
  const radians = bearingDeg * Math.PI / 180
  const projected = points.map(PLANE.toView)
  const across = projected.map(({ x, y }) => x * Math.cos(radians) + y * Math.sin(radians))
  const down = projected.map(({ x, y }) => -x * Math.sin(radians) + y * Math.cos(radians))
  return { width: Math.max(...across) - Math.min(...across), height: Math.max(...down) - Math.min(...down) }
}

function screenOf(camera: PlanarCamera, point: WorldPoint): WorldPoint {
  const v = PLANE.toView(point)
  const radians = camera.bearingDeg * Math.PI / 180
  return {
    x: (v.x * Math.cos(radians) + v.y * Math.sin(radians)) * camera.scale + camera.x,
    y: (-v.x * Math.sin(radians) + v.y * Math.cos(radians)) * camera.scale + camera.y,
  }
}

describe('fit', () => {
  it('at bearing 0 the fit frames plants, zones and notes inside the framing rect with 10 % padding', () => {
    const insetCases: Array<ScreenInsets | undefined> = [
      undefined,
      { top: 40, right: 300, bottom: 20, left: 60 },
    ]
    const designs: Record<string, ScenePersistedState> = {
      'all': scene(),
      'no plants': { ...scene(), plants: [] },
      'notes only': { ...scene(), zones: [], plants: [] },
      'no notes': { ...scene(), annotations: [] },
    }
    for (const [name, design] of Object.entries(designs)) {
      for (const insets of insetCases) {
        const rect = framingRect({ width: 1000, height: 800 }, insets)
        for (const scale of [0.05, 1, 14, 1000]) {
          const frame = fitFrame(1000, 800, [3, -7, scale], insets)
          const extentPoints = sceneExtentPoints(design, PLANTS)
          const fitted = fitScene(frame, { extentPoints, emptySceneScale: 0 }, 0)
          expect(fitted.bearingDeg, `${name} start=${scale}`).toBe(0)
          const pts = extentPoints(fitted.scale)
          const span = orientedSpan(pts, 0)
          const fill = Math.max(span.width * fitted.scale / rect.width, span.height * fitted.scale / rect.height)
          expect(fill, `${name} start=${scale}`).toBeCloseTo(0.8, 3)
          const xs = pts.map((p) => screenOf(fitted, p).x)
          const ys = pts.map((p) => screenOf(fitted, p).y)
          expect((Math.min(...xs) + Math.max(...xs)) / 2, `${name} cx`).toBeCloseTo(rect.x + rect.width / 2, 1)
          expect((Math.min(...ys) + Math.max(...ys)) / 2, `${name} cy`).toBeCloseTo(rect.y + rect.height / 2, 1)
        }
      }
    }

    // An empty scene: today's placement under a zero empty-scene scale, else that scale (clamped) about the screen centre.
    const empty = { ...scene(), plants: [], zones: [], annotations: [] }
    const frame = fitFrame(1000, 800, [3, -7, 2])
    const todayEmpty: readonly Placement[] = [[3, -7, 2], [500, 400, 25], [500, 400, 1716.6895781438734]]
    ;[0, 25, 1e9].forEach((emptySceneScale, index) => {
      expectPlacement(fitScene(frame, { extentPoints: sceneExtentPoints(empty, PLANTS), emptySceneScale }, 0), todayEmpty[index]!)
    })
    const unsized = fitFrame(0, 0, [3, -7, 2])
    expect(fitScene(unsized, { extentPoints: sceneExtentPoints(scene(), PLANTS), emptySceneScale: 0 }, 0)).toBe(unsized.current)
  })

  it('screen-sized notes converge within 20 rounds', () => {
    const notesOnly: ScenePersistedState = {
      ...scene(),
      plants: [],
      zones: [],
      annotations: [note('a', 50, 60, 'A long annotation that affects bounds', null), note('b', 52, 61, 'Another\nnote', 30)],
    }
    for (const bearingDeg of [0, 30]) {
      for (const start of [1e-3, 1, 1000]) {
        const frame = fitFrame(1000, 800, [0, 0, start])
        const calls = { count: 0 }
        const extentPoints = countedExtent(notesOnly, calls)

        const fitted = fitScene(frame, { extentPoints, emptySceneScale: 0 }, bearingDeg)

        expect(calls.count).toBeLessThanOrEqual(20)
        expect(fitted.bearingDeg).toBe(bearingDeg)
        // A fixed point: at the fitted scale the notes fill 80 % of the limiting side of the screen.
        const span = orientedSpan(extentPoints(fitted.scale), bearingDeg)
        const filled = Math.max(span.width * fitted.scale / 1000, span.height * fitted.scale / 800)
        expect(filled).toBeCloseTo(0.8, 3)
        for (const point of extentPoints(fitted.scale)) {
          const onScreen = screenOf(fitted, point)
          expect(onScreen.x).toBeGreaterThanOrEqual(99)
          expect(onScreen.x).toBeLessThanOrEqual(901)
          expect(onScreen.y).toBeGreaterThanOrEqual(79)
          expect(onScreen.y).toBeLessThanOrEqual(721)
        }
      }
    }
  })

  it('at bearing 0 temporary focus centres and pads the box inside the framing rect and refuses invalid options', () => {
    const boxes = [
      { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      { minX: 0, minY: 0, maxX: 0.001, maxY: 0.001 },
      { minX: -3, minY: 7, maxX: 1, maxY: 7.5 },
      { minX: 1, minY: 0, maxX: 1, maxY: 10 },
    ]
    const options = [{ paddingCssPx: 48 }, { paddingCssPx: 48, maximumScale: 2 }, { paddingCssPx: 201 }, { paddingCssPx: -1 }, { paddingCssPx: 0, maximumScale: 1e-9 }]
    for (const insets of [undefined, { top: 10, right: 20, bottom: 30, left: 40 }]) {
      const frame = fitFrame(400, 300, [10, 20, 2], insets)
      const rect = framingRect({ width: 400, height: 300 }, insets)
      boxes.forEach((box, boxIndex) => {
        options.forEach((option, optionIndex) => {
          const result = fitTemporaryBounds(frame, box, option, 0)
          const shouldRefuse = boxIndex === 3 || optionIndex >= 2
          if (shouldRefuse) {
            expect(result).toBeNull()
            return
          }
          expect(result).not.toBeNull()
          const tl = screenOf(result!, { x: box.minX, y: box.minY })
          const br = screenOf(result!, { x: box.maxX, y: box.maxY })
          expect((tl.x + br.x) / 2).toBeCloseTo(rect.x + rect.width / 2, 6)
          expect((tl.y + br.y) / 2).toBeCloseTo(rect.y + rect.height / 2, 6)
          expect(tl.x).toBeGreaterThanOrEqual(rect.x + option.paddingCssPx - 1e-6)
          expect(br.x).toBeLessThanOrEqual(rect.x + rect.width - option.paddingCssPx + 1e-6)
          expect(tl.y).toBeGreaterThanOrEqual(rect.y + option.paddingCssPx - 1e-6)
          expect(br.y).toBeLessThanOrEqual(rect.y + rect.height - option.paddingCssPx + 1e-6)
          if (option.maximumScale !== undefined) expect(result!.scale).toBeLessThanOrEqual(option.maximumScale + 1e-9)
        })
      })
    }
    expect(fitTemporaryBounds(fitFrame(0, 0, [0, 0, 1]), boxes[0]!, options[0]!, 0)).toBeNull()
  })

  it('a turned fit frames the box\'s corners, not its world-axis box', () => {
    const frame = fitFrame(400, 300, [0, 0, 1])
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 20 }

    const turned = fitTemporaryBounds(frame, box, { paddingCssPx: 10 }, 90)!

    // At 90° the 100 m side runs down the screen: the 280 px of height limit the scale.
    expect(turned.scale).toBeCloseTo(280 / PLANE.toView({ x: 100, y: 0 }).x, 12)
    expect(turned.bearingDeg).toBe(90)
    const centre = screenOf(turned, { x: 50, y: 10 })
    expect(centre.x).toBeCloseTo(200, 9)
    expect(centre.y).toBeCloseTo(150, 9)
  })

  it('frames inside the chrome insets; invalid insets frame the whole screen', () => {
    expect(framingRect({ width: 1000, height: 800 })).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
    expect(framingRect({ width: 1000, height: 800 }, { top: 40, right: 300, bottom: 20, left: 60 }))
      .toEqual({ x: 60, y: 40, width: 640, height: 740 })
    expect(framingRect({ width: 1000, height: 800 }, { top: Number.NaN, right: 0, bottom: 0, left: 0 }))
      .toEqual({ x: 0, y: 0, width: 1000, height: 800 })
  })

  // Answer 17 (2026-10-11): chrome that leaves an axis under 120 px grows that axis to 120 px around the centre of its
  // free band, clamped to the screen, and keeps the other axis's insets, instead of framing the whole screen.
  it('a short height grows to 120 px around the free band and keeps the side insets', () => {
    // A 390x844 phone with the Plant a row card down to 360 px and the half sheet up from 422 px: a 62 px band.
    expect(framingRect({ width: 390, height: 844 }, { top: 360, right: 0, bottom: 422, left: 0 }))
      .toEqual({ x: 0, y: 331, width: 390, height: 120 })
    expect(framingRect({ width: 1000, height: 800 }, { top: 400, right: 20, bottom: 390, left: 60 }))
      .toEqual({ x: 60, y: 345, width: 920, height: 120 })
    // A band at an edge grows into the screen, never past it.
    expect(framingRect({ width: 1000, height: 800 }, { top: 0, right: 0, bottom: 760, left: 0 }))
      .toEqual({ x: 0, y: 0, width: 1000, height: 120 })
    expect(framingRect({ width: 1000, height: 800 }, { top: 770, right: 0, bottom: 0, left: 0 }))
      .toEqual({ x: 0, y: 680, width: 1000, height: 120 })
    // Chrome that overlaps leaves no band: the frame grows around the middle of the overlap.
    expect(framingRect({ width: 1000, height: 800 }, { top: 500, right: 0, bottom: 400, left: 0 }))
      .toEqual({ x: 0, y: 390, width: 1000, height: 120 })
  })

  it('a short width grows to 120 px around the free band and keeps the top and bottom insets', () => {
    expect(framingRect({ width: 500, height: 800 }, { top: 40, right: 300, bottom: 20, left: 100 }))
      .toEqual({ x: 90, y: 40, width: 120, height: 740 })
    expect(framingRect({ width: 500, height: 800 }, { top: 0, right: 0, bottom: 0, left: 450 }))
      .toEqual({ x: 380, y: 0, width: 120, height: 800 })
    // Both axes short: each grows on its own.
    expect(framingRect({ width: 500, height: 800 }, { top: 360, right: 300, bottom: 422, left: 100 }))
      .toEqual({ x: 90, y: 309, width: 120, height: 120 })
    // A screen under 120 px on an axis frames all of it.
    expect(framingRect({ width: 100, height: 800 }, { top: 0, right: 60, bottom: 0, left: 20 }))
      .toEqual({ x: 0, y: 0, width: 100, height: 800 })
  })

  // The plant finder's and Species detail's 72 px padding left no room in a grown 120 px band, so their zoom did nothing.
  it('temporary focus on a thin band keeps half of each short axis for the box, centred on the free band', () => {
    // The 62 px phone mix: the frame grows to y 331..451, and the padding takes a quarter (30 px) from each side.
    const frame = fitFrame(390, 844, [3, -7, 1], { top: 360, right: 0, bottom: 422, left: 0 })
    const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    for (const paddingCssPx of [72, 48]) {
      const focused = fitTemporaryBounds(frame, box, { paddingCssPx }, 0)
      expect(focused, `padding ${paddingCssPx}`).not.toBeNull()
      expect(screenOf(focused!, { x: 0, y: 10 }).y - screenOf(focused!, { x: 0, y: 0 }).y).toBeCloseTo(60, 9)
      for (const corner of [{ x: 0, y: 0 }, { x: 10, y: 10 }]) {
        const onScreen = screenOf(focused!, corner)
        expect(onScreen.y).toBeGreaterThanOrEqual(361 - 1e-6)
        expect(onScreen.y).toBeLessThanOrEqual(421 + 1e-6)
      }
    }
    // A band of 120 to 144 px, never grown, frames too: its 130 px keep 65 for the box.
    const band = fitTemporaryBounds(fitFrame(390, 844, [0, 0, 1], { top: 357, right: 0, bottom: 357, left: 0 }), box, { paddingCssPx: 72 }, 0)
    expect(screenOf(band!, { x: 0, y: 10 }).y - screenOf(band!, { x: 0, y: 0 }).y).toBeCloseTo(65, 9)
    // The full padding stays where the axis holds it: 246 of the 390 px width.
    const wide = fitTemporaryBounds(frame, { minX: 0, minY: 0, maxX: 100, maxY: 1 }, { paddingCssPx: 72 }, 0)
    expect(screenOf(wide!, { x: 100, y: 0 }).x - screenOf(wide!, { x: 0, y: 0 }).x).toBeCloseTo(246, 9)
    // Padding the screen itself cannot hold is still refused.
    expect(fitTemporaryBounds(frame, box, { paddingCssPx: 195 }, 0)).toBeNull()
  })

  // A band too thin for the box's room would frame it under the chrome and still report success, so the view is left alone.
  it('temporary focus refuses a band the framed box would not land inside', () => {
    const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const insetCases: readonly [string, ScreenInsets][] = [
      // 390x844, the full sheet 8 px below the title bar: an 8 px band.
      ['8 px band under the title bar', { top: 60, right: 0, bottom: 776, left: 0 }],
      // The same with a Plant a row card down to 94 px: the chrome overlaps.
      ['overlapping chrome', { top: 94, right: 0, bottom: 776, left: 0 }],
      // A 30 px band at the bottom edge: the grown frame is clamped to the screen, off the band's centre.
      ['30 px band at the edge', { top: 814, right: 0, bottom: 0, left: 0 }],
    ]
    for (const [label, insets] of insetCases) {
      expect(fitTemporaryBounds(fitFrame(390, 844, [3, -7, 1], insets), box, { paddingCssPx: 72 }, 0), label).toBeNull()
    }
    // A scale ceiling that keeps the box inside the band still frames it there.
    const capped = fitTemporaryBounds(
      fitFrame(390, 844, [3, -7, 1], { top: 60, right: 0, bottom: 776, left: 0 }), box, { paddingCssPx: 72, maximumScale: 0.5 }, 0,
    )
    expect(capped).not.toBeNull()
    for (const corner of [{ x: 0, y: 0 }, { x: 10, y: 10 }]) {
      const onScreen = screenOf(capped!, corner)
      expect(onScreen.y).toBeGreaterThanOrEqual(60 - 1e-6)
      expect(onScreen.y).toBeLessThanOrEqual(68 + 1e-6)
    }
  })

  it('Fit to Design centres the Design on the grown band, inside 120 px', () => {
    const frame = fitFrame(390, 844, [3, -7, 1], { top: 360, right: 0, bottom: 422, left: 0 })
    const extent = sceneExtentPoints(scene(), PLANTS)
    const fitted = fitScene(frame, { extentPoints: extent, emptySceneScale: 0 }, 0)
    for (const point of extent(fitted.scale)) {
      const onScreen = screenOf(fitted, point)
      expect(onScreen.y).toBeGreaterThanOrEqual(331 - 1e-6)
      expect(onScreen.y).toBeLessThanOrEqual(451 + 1e-6)
    }
    const span = orientedSpan(extent(fitted.scale), 0)
    // The height limits the scale: the Design fills 80 % of the grown frame's 120 px.
    expect(span.height * fitted.scale).toBeCloseTo(96, 3)
  })
})

// Moved from __tests__/camera-controller.test.ts (computeSceneBounds > …): the fits' extent is canvas/runtime/scene-extent.ts's
// footprint corners, and its world-axis box is what computeSceneBounds returned.
describe('scene extent', () => {
  function boundsScene(): ScenePersistedState {
    return {
      plantSpeciesColors: {},
      plantSpeciesSymbols: {},
      plantSpeciesCodes: {},
      layers: [],
      plants: [
        {
          kind: 'plant', locked: false, id: 'p1', canonicalName: 'Malus domestica', commonName: 'Apple', color: null,
          canopySpreadM: null, position: { x: 10, y: 20 }, rotationDeg: null, notes: null, plantedDate: null, quantity: null,
        },
      ],
      zones: [
        {
          kind: 'zone', locked: false, id: 'z1', name: null, zoneType: 'rect',
          points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 }],
          rotationDeg: 0, fillColor: null, notes: null,
        },
      ],
      annotations: [],
      measurementGuides: [],
      groups: [],
    }
  }

  /** The world-axis box of the extent at a scale (1 px/m unless given, as computeSceneBounds defaulted). */
  function extentBox(design: ScenePersistedState, pixelsPerMetre = 1): SceneBounds | null {
    return worldAxisBox(sceneExtentPoints(design, PLANTS)(pixelsPerMetre))
  }

  it('uses the symbolic Placed Plant Visual Footprint for plant-only bounds', () => {
    const design = boundsScene()
    design.zones = []

    const bounds = extentBox(design, 10)

    expect(bounds?.minX).toBeCloseTo(8.6, 2)
    expect(bounds?.minY).toBeCloseTo(18.6, 2)
    expect(bounds?.maxX).toBeCloseTo(11.4, 2)
    expect(bounds?.maxY).toBeCloseTo(21.4, 2)
  })

  it('includes both plant and zone geometry', () => {
    expect(extentBox(boundsScene())).toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 40 })
  })

  it('includes elliptical zone center and radii geometry', () => {
    const design = boundsScene()
    design.plants = []
    design.zones = [{
      kind: 'zone', locked: false, id: 'ellipse-1', name: 'ellipse-1', zoneType: 'ellipse',
      points: [{ x: 50, y: 60 }, { x: 30, y: 20 }], rotationDeg: 0, fillColor: null, notes: null,
    }]

    expect(extentBox(design)).toEqual({ minX: 20, minY: 40, maxX: 80, maxY: 80 })
  })

  it('includes oriented Elliptical Zone bounds', () => {
    const design = boundsScene()
    design.plants = []
    design.zones = [{
      kind: 'zone', locked: false, id: 'ellipse-1', name: 'ellipse-1', zoneType: 'ellipse',
      points: [{ x: 0, y: 0 }, { x: 4, y: 1 }], rotationDeg: 90, fillColor: null, notes: null,
    }]

    expect(extentBox(design)).toEqual({ minX: -1, minY: -4, maxX: 1, maxY: 4 })
  })

  it('includes annotation extents instead of only the annotation anchor point', () => {
    const design = boundsScene()
    design.annotations = [{
      kind: 'annotation', locked: false, id: 'annotation-1', annotationType: 'text',
      position: { x: 50, y: 60 }, text: 'Long note', fontSize: 20, rotationDeg: null,
    }]

    expect(extentBox(design, 1)).toEqual({ minX: 0, minY: 0, maxX: 158, maxY: 85 })
  })

  it('an empty scene has no extent', () => {
    expect(sceneExtentPoints({ ...boundsScene(), plants: [], zones: [] }, PLANTS)(1)).toEqual([])
  })
})
