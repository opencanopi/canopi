import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  createToolSceneSource,
  measurementGuide,
  plantEntity,
  rectZone,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../../__tests__/support/tool-harness'
import type { ScreenPoint } from '../../../../geo/view/types'
import { getEllipticalZonePolygon, getRectangularZoneCorners } from '../../zone-geometry'
import { createToolScene } from '../spatial-index'
import { ROTATE_HANDLE_ID, rotationReadout } from './rotate-handle'

const harnesses: ToolHarness[] = []

function harness(options: ToolHarnessOptions = {}): ToolHarness {
  const created = createToolHarness(options)
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
  vi.useRealTimers()
})

/** A bed whose bounds centre, the rotation pivot, is (70, 110); its rotation handle sits 28 px above its top edge. */
function bedHarness(): ToolHarness {
  const h = harness({
    scene: { zones: [rectZone('bed', [{ x: 20, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 140 }, { x: 20, y: 140 }])] },
  })
  h.select({ kind: 'zone', id: 'bed' })
  return h
}

const PIVOT = { x: 70, y: 110 }
const ROTATE = { kind: 'handle', id: ROTATE_HANDLE_ID } as const

/** The screen point at `angleDeg` about the world pivot, `radius` m away. */
function aroundPivot(h: ToolHarness, angleDeg: number, radius: number): ScreenPoint {
  const radians = (angleDeg * Math.PI) / 180
  return h.screen({ x: PIVOT.x + Math.cos(radians) * radius, y: PIVOT.y + Math.sin(radians) * radius })
}

describe('Select rotation handle', () => {
  it('shows above a rotatable selection, centred on its top edge', () => {
    const h = bedHarness()

    expect(h.chrome.handles.find((handle) => handle.id === ROTATE_HANDLE_ID)).toMatchObject({
      anchor: { x: expect.closeTo(70, 9), y: expect.closeTo(80, 9) },
      offsetPx: { x: 0, y: -28 },
      hitRadiusPx: 14,
      glyph: 'rotate',
      label: 'canvas.rotationHandle.label',
    })
  })

  it('while the selected polygon shows its midpoint dots, the handle rises clear of a dotted edge\'s chip (canopi-f47t.29)', () => {
    // The top edge's midpoint is under the handle, and its dot puts the edge's chip beside it, outside the top edge (U38):
    // 6 px out, up to about 22 px tall. The handle's 28 px button and its 3 px ring sit above that.
    const triangle = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 150, y: 250 }]
    const h = harness({ scene: { zones: [rectZone('poly', triangle, { zoneType: 'polygon' })] } })
    h.select({ kind: 'zone', id: 'poly' })
    const handle = () => h.chrome.handles.find((entry) => entry.id === ROTATE_HANDLE_ID)!
    const chips = () => (h.renderer.lastDraft()?.shapes ?? []).flatMap((shape) =>
      shape.kind === 'label' && shape.tone === 'measure-quiet' ? [shape] : [])

    expect(chips()[0]).toMatchObject({ anchor: { x: 200, y: 100 }, beside: { normalPx: { x: 0, y: -1 }, gapPx: 6 } })
    expect(handle()).toMatchObject({ anchor: { x: expect.closeTo(200, 9), y: expect.closeTo(100, 9) }, offsetPx: { x: 0, y: -48 } })

    // At a fifth of the scale the edges are under 52 px: no dots, every chip on its edge, and the handle back at 28 px.
    h.view.setViewport({ x: 0, y: 0, scale: 0.2 })
    expect(h.chrome.handles.some((entry) => entry.glyph === 'midpoint')).toBe(false)
    expect(handle().offsetPx).toEqual({ x: 0, y: -28 })
  })

  it('the handle sits 28 px above the projected hull', () => {
    vi.useFakeTimers()
    const h = harness({
      camera: { bearingDeg: 45 },
      scene: { zones: [rectZone('bed', [{ x: 20, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 140 }, { x: 20, y: 140 }])] },
    })
    h.select({ kind: 'zone', id: 'bed' })
    /** The handle's centre on screen, and where it belongs: centred 28 px above the screen box of the bed's four corners. */
    const placement = () => {
      const view = h.view.view()
      const handle = h.chrome.handles.find((entry) => entry.id === ROTATE_HANDLE_ID)!
      const anchor = view.worldToScreen(handle.anchor)
      const hull = view.worldQuadToScreen([{ x: 20, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 140 }, { x: 20, y: 140 }])
      const xs = hull.map((corner) => corner.x)
      return {
        at: { x: anchor.x + handle.offsetPx!.x, y: anchor.y + handle.offsetPx!.y },
        expected: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.min(...hull.map((corner) => corner.y)) - 28 },
      }
    }

    let { at, expected } = placement()
    expect(at.x).toBeCloseTo(expected.x, 6)
    expect(at.y).toBeCloseTo(expected.y, 6)

    // It follows a turn of the view with the pointer resting on the map.
    h.hover({ x: 10, y: 10 })
    h.view.navigation.rotateBy(1)
    vi.advanceTimersByTime(400)
    expect(h.view.view().camera.bearingDeg).toBe(60);
    ({ at, expected } = placement())
    expect(at.x).toBeCloseTo(expected.x, 6)
    expect(at.y).toBeCloseTo(expected.y, 6)
  })

  it('a key turn during a band drag moves the rotation handle with the view', () => {
    vi.useFakeTimers()
    const h = harness({
      camera: { bearingDeg: 45 },
      scene: { zones: [rectZone('bed', [{ x: 20, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 140 }, { x: 20, y: 140 }])] },
    })
    h.select({ kind: 'zone', id: 'bed' })
    const placement = () => {
      const view = h.view.view()
      const handle = h.chrome.handles.find((entry) => entry.id === ROTATE_HANDLE_ID)!
      const anchor = view.worldToScreen(handle.anchor)
      const hull = view.worldQuadToScreen([{ x: 20, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 140 }, { x: 20, y: 140 }])
      const xs = hull.map((corner) => corner.x)
      return {
        at: { x: anchor.x + handle.offsetPx!.x, y: anchor.y + handle.offsetPx!.y },
        expected: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.min(...hull.map((corner) => corner.y)) - 28 },
      }
    }

    // A Shift band from an empty corner of the map, held mid-drag.
    h.press({ x: 390, y: 290 }, { mods: { shift: true } })
    h.move({ x: 360, y: 260 }, { shift: true })
    h.view.navigation.rotateBy(1)
    vi.advanceTimersByTime(400)
    expect(h.view.view().camera.bearingDeg).toBe(60)
    const { at, expected } = placement()
    expect(at.x).toBeCloseTo(expected.x, 6)
    expect(at.y).toBeCloseTo(expected.y, 6)
    h.release({ x: 360, y: 260 }, { shift: true })
  })

  it('a zoom moves the rotation handle with a screen-sized plant at the top of the hull (U40)', () => {
    const h = harness({
      scene: {
        zones: [rectZone('bed', [{ x: 20, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 140 }, { x: 20, y: 140 }])],
        plants: [plantEntity('apple', 'Malus domestica', { x: 70, y: 60 })],
      },
    })
    h.select({ kind: 'zone', id: 'bed' }, { kind: 'plant', id: 'apple' })
    const anchor = () => h.chrome.handles.find((entry) => entry.id === ROTATE_HANDLE_ID)!.anchor

    for (const factor of [0.5, 4]) {
      const before = anchor()
      h.wheelZoom({ x: 300, y: 250 }, factor)
      const zoomed = anchor()
      // The plant's circle keeps its size on screen, so the top of the hull moves on the ground.
      expect(Math.abs(zoomed.y - before.y)).toBeGreaterThan(0.1)
      // Where a redraw from scratch puts it.
      h.host.sceneChanged()
      expect(anchor()).toEqual(zoomed)
    }
  })

  describe('on a turned map it sits 28 px above the drawn shapes, not above their world box', () => {
    /** The handle's centre on screen. */
    function handleCentre(h: ToolHarness): ScreenPoint {
      const handle = h.chrome.handles.find((entry) => entry.id === ROTATE_HANDLE_ID)!
      const anchor = h.view.view().worldToScreen(handle.anchor)
      return { x: anchor.x + handle.offsetPx!.x, y: anchor.y + handle.offsetPx!.y }
    }

    /** Centred 28 px above the screen box of `outline` (screen points). */
    function above(outline: readonly ScreenPoint[]): ScreenPoint {
      const xs = outline.map((point) => point.x)
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.min(...outline.map((point) => point.y)) - 28 }
    }

    it('a rectangle drawn level at 45', () => {
      const bed = rectZone('bed', [{ x: -50, y: -10 }, { x: 50, y: -10 }, { x: 50, y: 10 }, { x: -50, y: 10 }], { rotationDeg: 45 })
      const h = harness({ camera: { bearingDeg: 45 }, scene: { zones: [bed] } })
      h.select({ kind: 'zone', id: 'bed' })
      const corners = getRectangularZoneCorners(bed)!.map((corner) => h.view.view().worldToScreen(corner))
      // Level on screen (within WGS84 ellipsoid flattening, sub-pixel vs the ~85 px world box).
      expect(corners.map((corner) => corner.y).sort((a, b) => a - b)[1]!).toBeCloseTo(Math.min(...corners.map((c) => c.y)), 0)

      const at = handleCentre(h)
      const expected = above(corners)
      expect(at.x).toBeCloseTo(expected.x, 6)
      expect(at.y).toBeCloseTo(expected.y, 6)
    })

    it('an ellipse drawn level at 30', () => {
      const pond = rectZone('pond', [{ x: 0, y: 0 }, { x: 80, y: 20 }], { zoneType: 'ellipse', rotationDeg: 30 })
      const h = harness({ camera: { bearingDeg: 30 }, scene: { zones: [pond] } })
      h.select({ kind: 'zone', id: 'pond' })
      const outline = getEllipticalZonePolygon(pond, 3600)!.map((point) => h.view.view().worldToScreen(point))

      const at = handleCentre(h)
      const expected = above(outline)
      expect(at.x).toBeCloseTo(expected.x, 2)
      expect(at.y).toBeCloseTo(expected.y, 2)
    })

    it('a plant above a bed: the plant drawn as its circle', () => {
      const bed = rectZone('bed', [{ x: -50, y: -10 }, { x: 50, y: -10 }, { x: 50, y: 10 }, { x: -50, y: 10 }], { rotationDeg: 45 })
      const h = harness({ camera: { bearingDeg: 45 }, scene: { zones: [bed], plants: [plantEntity('apple', 'Malus domestica', { x: 30, y: -60 })] } })
      h.select({ kind: 'zone', id: 'bed' }, { kind: 'plant', id: 'apple' })
      const plant = h.store.persisted.plants[0]!
      const radiusPx = createToolScene(createToolSceneSource(h.store)).plantPresentation(plant).radiusPx
      const centre = h.view.view().worldToScreen(plant.position)
      const corners = getRectangularZoneCorners(bed)!.map((corner) => h.view.view().worldToScreen(corner))
      expect(centre.y - radiusPx).toBeLessThan(Math.min(...corners.map((corner) => corner.y)))

      const at = handleCentre(h)
      const expected = above([...corners, { x: centre.x - radiusPx, y: centre.y - radiusPx }, { x: centre.x + radiusPx, y: centre.y + radiusPx }])
      expect(at.x).toBeCloseTo(expected.x, 6)
      expect(at.y).toBeCloseTo(expected.y, 6)
    })
  })

  it('a lone measurement guide shows the handle, and a quarter turn turns its ends (canopi-xjym)', () => {
    const h = harness({ scene: { measurementGuides: [measurementGuide('guide', { x: 20, y: 110 }, { x: 120, y: 110 })] } })
    h.select({ kind: 'measurement-guide', id: 'guide' })

    expect(h.chrome.handles.find((handle) => handle.id === ROTATE_HANDLE_ID)).toMatchObject({
      anchor: { x: expect.closeTo(70, 9), y: expect.closeTo(110, 9) },
    })
    h.press(aroundPivot(h, -90, 28), { target: ROTATE })
    h.move(aroundPivot(h, 0, 28))
    h.release(aroundPivot(h, 0, 28))

    const guide = h.store.persisted.measurementGuides[0]!
    expect(guide.start.x).toBeCloseTo(70)
    expect(guide.start.y).toBeCloseTo(60)
    expect(guide.end.x).toBeCloseTo(70)
    expect(guide.end.y).toBeCloseTo(160)
  })

  it('Shift steps 15 degrees from the press angle', () => {
    const h = bedHarness()
    // A press off the handle's centre, so the press angle is no multiple of 15.
    const pressWorld = { x: 78, y: 52 }
    const pressAngle = Math.atan2(pressWorld.y - PIVOT.y, pressWorld.x - PIVOT.x) * 180 / Math.PI
    expect(pressAngle % 15).not.toBeCloseTo(0)

    h.press(h.screen(pressWorld), { target: ROTATE })
    h.move(aroundPivot(h, pressAngle + 22, 58), { shift: true })
    // Relative steps: 22 degrees turned is 15, whatever the absolute angle.
    expect(h.store.persisted.zones[0]!.rotationDeg).toBe(15)
    h.move(aroundPivot(h, pressAngle + 38, 58), { shift: true })
    expect(h.store.persisted.zones[0]!.rotationDeg).toBe(45)
    h.move(aroundPivot(h, pressAngle + 22, 58))
    expect(h.store.persisted.zones[0]!.rotationDeg).toBeCloseTo(22)
    h.release(aroundPivot(h, pressAngle + 22, 58))

    expect(h.store.persisted.zones[0]!.rotationDeg).toBeCloseTo(22)
    expect(h.undo()).toBe(true)
    expect(h.store.persisted.zones[0]!.rotationDeg).toBe(0)
    expect(h.history.canUndo.value).toBe(false)
  })

  it('the handle reads 0° at its press, then hides with the others while the turn changes the scene', () => {
    const h = bedHarness()
    h.press(aroundPivot(h, -90, 58), { target: ROTATE })
    expect(h.chrome.activeHandle).toBe(ROTATE_HANDLE_ID)
    expect(h.chrome.handles.find((handle) => handle.id === ROTATE_HANDLE_ID)?.readout).toBe('0°')

    h.move(aroundPivot(h, 0, 58))
    expect(h.store.persisted.zones[0]!.rotationDeg).toBeCloseTo(90)
    expect(h.chrome.handles).toEqual([])

    h.release()
    expect(h.chrome.handles.find((handle) => handle.id === ROTATE_HANDLE_ID)?.readout).toBeUndefined()
    expect(h.chrome.activeHandle).toBeNull()
  })

  it('the readout is the whole degrees turned, signed', () => {
    expect(rotationReadout(90)).toBe('+90°')
    expect(rotationReadout(15)).toBe('+15°')
    expect(rotationReadout(0.4)).toBe('0°')
    expect(rotationReadout(-30.4)).toBe('-30°')
  })

  it('a turn of a quarter degree or less commits nothing', () => {
    const h = bedHarness()

    h.press({ x: 70, y: 52 }, { target: ROTATE })
    h.move({ x: 70.1, y: 52 })
    h.release()

    expect(h.store.persisted.zones[0]!.rotationDeg).toBe(0)
    expect(h.history.canUndo.value).toBe(false)
  })
})
