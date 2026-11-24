import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  measurementGuide,
  plantEntity,
  rectZone,
  type ToolHarness,
} from '../../../../__tests__/support/tool-harness'
import type { ToolHandleId } from '../../interaction-types'
import type { ScreenPoint, WorldPoint } from '../../../../geo/view/types'
import '../../../../__tests__/support/camera-tolerance'

/** Calls of Select's midpoint-dot query (reshape.ts zoneEdgeMidpoints), counted through the real function. */
const midpointQueries = vi.hoisted(() => ({ count: 0 }))
vi.mock('./reshape', async (importOriginal) => {
  const actual = await importOriginal<{ readonly zoneEdgeMidpoints: (...args: never[]) => unknown }>()
  return {
    ...actual,
    zoneEdgeMidpoints: (...args: never[]) => {
      midpointQueries.count += 1
      return actual.zoneEdgeMidpoints(...args)
    },
  }
})

const harnesses: ToolHarness[] = []

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
})

/**
 * The drag of one point handle under Select, for a rectangle's corner (tools/select/reshape.ts) and a guide's end
 * (tools/select/guide-ends.ts): the successors of today's control-point overlays.
 */
const cases = [
  {
    label: 'Zone',
    handle: 'rect-corner:zone-1:se' as ToolHandleId,
    start: { x: 60, y: 50 },
    create: () => createToolHarness({
      scene: { zones: [rectZone('zone-1', [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }, { x: 10, y: 50 }])] },
    }),
    select: (h: ToolHarness) => h.select({ kind: 'zone', id: 'zone-1' }),
    draggedPoint: (h: ToolHarness): WorldPoint => h.store.persisted.zones[0]!.points[2]!,
  },
  {
    label: 'Measurement Guide',
    handle: 'guide-end:guide-1:b' as ToolHandleId,
    start: { x: 60, y: 10 },
    create: () => createToolHarness({
      scene: { measurementGuides: [measurementGuide('guide-1', { x: 10, y: 10 }, { x: 60, y: 10 })] },
    }),
    select: (h: ToolHarness) => h.select({ kind: 'measurement-guide', id: 'guide-1' }),
    draggedPoint: (h: ToolHarness): WorldPoint => h.store.persisted.measurementGuides[0]!.end,
  },
] as const

describe.each(cases)('$label point handle drags', ({ handle, start, create, select, draggedPoint }) => {
  function harness(): ToolHarness {
    const created = create()
    harnesses.push(created)
    select(created)
    return created
  }

  function pressHandle(h: ToolHarness, at: ScreenPoint = start): void {
    h.press(at, { target: { kind: 'handle', id: handle } })
  }

  it('shows the handle on the selected object and none once it is deselected', () => {
    const h = harness()
    expect(h.chrome.handles.map((entry) => entry.id)).toContain(handle)
    expect(h.chrome.handles.find((entry) => entry.id === handle)?.anchor).toEqual(start)

    h.select()
    expect(h.chrome.handles).toEqual([])
  })

  it('a handle the selection no longer owns begins no Scene Edit', () => {
    const h = harness()
    const begin = vi.spyOn(h.edits, 'begin')
    pressHandle(h)
    h.release()
    expect(begin).toHaveBeenCalledTimes(1)

    // The handle list is refreshed when the selection changes; a press on a stale id starts nothing.
    h.store.setSelection([])
    begin.mockClear()
    pressHandle(h)
    h.move({ x: 90, y: 70 })
    h.release()
    expect(begin).not.toHaveBeenCalled()
    expect(draggedPoint(h)).toEqual(start)
  })

  it('the release point is applied and commits one changed edit', () => {
    const h = harness()

    pressHandle(h)
    h.move({ x: 80, y: 60 })
    h.release({ x: 90, y: 70 })

    expect(draggedPoint(h)).toEqual({ x: 90, y: 70 })
    expect(h.history.canUndo.value).toBe(true)
    expect(h.undo()).toBe(true)
    expect(draggedPoint(h)).toEqual(start)
    expect(h.history.canUndo.value).toBe(false)
  })

  it('a cancelled drag rolls back its live change without history', () => {
    const h = harness()

    pressHandle(h)
    h.move({ x: 90, y: 70 })
    expect(draggedPoint(h)).toEqual({ x: 90, y: 70 })
    h.cancel('pointercancel')

    expect(draggedPoint(h)).toEqual(start)
    expect(h.history.canUndo.value).toBe(false)
    expect(h.host.hasLiveGesture()).toBe(false)
  })

  it('disposing the host mid-drag rolls the object back and removes the handles', () => {
    const h = harness()

    pressHandle(h)
    h.move({ x: 90, y: 70 })
    expect(draggedPoint(h)).toEqual({ x: 90, y: 70 })
    h.dispose()
    harnesses.splice(harnesses.indexOf(h), 1)

    expect(draggedPoint(h)).toEqual(start)
    expect(h.history.canUndo.value).toBe(false)
    expect(h.chrome.handles).toEqual([])
  })
})

describe('the rotation handle during a zone corner press', () => {
  it('a corner press hides the rotation handle at once and keeps the corners; its release shows it again', () => {
    const h = cases[0].create()
    harnesses.push(h)
    cases[0].select(h)
    const shown = h.chrome.handles.map((entry) => entry.id)
    expect(shown).toContain('rotate')

    // Today's control-point press hid the rotation handle in its drag presentation, before any move.
    h.press(cases[0].start, { target: { kind: 'handle', id: cases[0].handle } })
    expect(h.chrome.handles.map((entry) => entry.id)).toEqual(shown.filter((id) => id !== 'rotate'))
    expect(h.chrome.activeHandle).toBe(cases[0].handle)
    h.release()
    expect(h.chrome.handles.map((entry) => entry.id)).toEqual(shown)

    h.press(cases[0].start, { target: { kind: 'handle', id: cases[0].handle } })
    h.cancel('pointercancel')
    expect(h.chrome.handles.map((entry) => entry.id)).toEqual(shown)
  })
})

describe('polygon corners (spec §3.2, U33: every corner route)', () => {
  const SQUARE = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }]
  const POLY = { kind: 'zone', id: 'poly' } as const
  const vertex = (index: number) => `vertex:poly:${index}` as ToolHandleId
  const midpoint = (index: number) => `edge-mid:poly:${index}` as ToolHandleId

  function polygonHarness(points: readonly WorldPoint[] = SQUARE): ToolHarness {
    const h = createToolHarness({ scene: { zones: [rectZone('poly', [...points], { zoneType: 'polygon' })] } })
    harnesses.push(h)
    h.select(POLY)
    return h
  }

  const corners = (h: ToolHarness): readonly WorldPoint[] => h.store.persisted.zones[0]!.points

  function clickHandle(h: ToolHarness, id: ToolHandleId, options: { clickCount?: number; alt?: boolean } = {}): void {
    const at = h.chrome.handles.find((entry) => entry.id === id)!.anchor
    h.click(at, { target: { kind: 'handle', id }, clickCount: options.clickCount ?? 1, mods: { alt: options.alt ?? false } })
  }

  it('a polygon shows a fainter midpoint dot on each edge, labelled with its edge; a rectangle shows none', () => {
    const h = polygonHarness()
    const midpoints = h.chrome.handles.filter((entry) => entry.glyph === 'midpoint')
    expect(midpoints.map((entry) => [entry.id, entry.anchor, entry.label])).toEqual([
      [midpoint(0), { x: 150, y: 100 }, 'canvas.zoneEdgeMidpoint.label'],
      [midpoint(1), { x: 200, y: 150 }, 'canvas.zoneEdgeMidpoint.label'],
      [midpoint(2), { x: 150, y: 200 }, 'canvas.zoneEdgeMidpoint.label'],
      [midpoint(3), { x: 100, y: 150 }, 'canvas.zoneEdgeMidpoint.label'],
    ])

    const rect = createToolHarness({ scene: { zones: [rectZone('bed', SQUARE)] } })
    harnesses.push(rect)
    rect.select({ kind: 'zone', id: 'bed' })
    expect(rect.chrome.handles.filter((entry) => entry.glyph === 'midpoint')).toEqual([])
  })

  /** The selected polygon's edge chips as the renderer gets them: each one's `beside`, or null on its edge. */
  function edgeChipPlacements(h: ToolHarness): ({ normalPx: ScreenPoint; gapPx: number } | null)[] {
    return (h.renderer.lastDraft()?.shapes ?? []).flatMap((shape) =>
      shape.kind === 'label' && shape.tone === 'measure-quiet' ? [shape.beside ?? null] : [])
  }

  it('while its midpoint dots show, each dotted edge\'s length chip sits beside its dot, outside the polygon (U38)', () => {
    // 40 × 60 px at scale 1: dots on the 60 px edges 1 (x = 140) and 3 (x = 100); the 40 px edges keep their chips on the edge.
    const tall = [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 160 }, { x: 100, y: 160 }]
    const outside = (x: number) => ({ normalPx: { x, y: expect.closeTo(0, 9) }, gapPx: 6 })
    for (const corners of [tall, [...tall].reverse()]) {
      const h = polygonHarness(corners)
      const placements = edgeChipPlacements(h)
      // Wound either way, the chip goes away from the interior: right of the right edge, left of the left one.
      expect(placements).toEqual([null, outside(1), null, outside(-1)])

      // Under another tool no dots show, so every chip is back on its edge.
      h.arm('rectangle')
      expect(edgeChipPlacements(h)).toEqual([null, null, null, null])
    }
  })

  it('on a turned map an edge chip goes out along the edge\'s normal on screen (U38)', () => {
    const h = createToolHarness({ scene: { zones: [rectZone('poly', [...SQUARE], { zoneType: 'polygon' })] }, camera: { bearingDeg: 30 } })
    harnesses.push(h)
    h.select(POLY)
    const view = h.view.view()
    const centre = view.worldToScreen({ x: 150, y: 150 })
    const placements = edgeChipPlacements(h)
    expect(placements).toHaveLength(4)
    SQUARE.forEach((start, index) => {
      const end = SQUARE[(index + 1) % SQUARE.length]!
      const middle = view.worldToScreen({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 })
      const length = Math.hypot(middle.x - centre.x, middle.y - centre.y)
      expect(placements[index]!.normalPx.x).toBeCloseTo((middle.x - centre.x) / length, 9)
      expect(placements[index]!.normalPx.y).toBeCloseTo((middle.y - centre.y) / length, 9)
    })
  })

  it('a pan under a resting pointer recomputes no midpoint dots', () => {
    const h = polygonHarness()
    h.hover({ x: 300, y: 250 })
    midpointQueries.count = 0
    h.pan({ x: 300, y: 250 }, { x: 320, y: 260 })
    expect(midpointQueries.count).toBe(0)
  })

  it('an edge shows its dot only with room for it and free outline beside it (52 px on screen); a zoom redraws the dots', () => {
    // At scale 1 the 40 m edges are 40 px: the corners' 10 px and the dot's 16 px would cover the outline that moves the zone.
    const h = polygonHarness([{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 140, y: 160 }, { x: 100, y: 160 }])
    const dots = () => h.chrome.handles.filter((entry) => entry.glyph === 'midpoint').map((entry) => entry.id)
    expect(dots()).toEqual([midpoint(1), midpoint(3)])

    h.view.setViewport({ x: 0, y: 0, scale: 2 })
    expect(dots()).toEqual([midpoint(0), midpoint(1), midpoint(2), midpoint(3)])

    h.view.setViewport({ x: 0, y: 0, scale: 0.5 })
    expect(dots()).toEqual([])
  })

  it('after a finger\'s tap the handles are 44 px targets and dots need 132 px; a mouse hover makes them 20 px again (Q1, Q2)', () => {
    // At scale 1 the square's edges are 100 px: dots for a mouse (52 px), none for a finger (2 × 44 + 44 px of outline).
    const h = polygonHarness()
    const radii = (glyph: string) => h.chrome.handles.filter((entry) => entry.glyph === glyph).map((entry) => entry.hitRadiusPx)
    expect(radii('vertex')).toEqual([10, 10, 10, 10])
    expect(radii('midpoint')).toEqual([8, 8, 8, 8])
    expect(radii('rotate')).toEqual([14])

    // A finger's tap 8 px inside the outline: within its 16 px, it keeps the polygon (canopi-qd2k).
    h.click({ x: 150, y: 108 }, { pointer: 'touch' })
    expect(h.store.session.selectedTargets).toEqual([POLY])
    expect(radii('vertex')).toEqual([22, 22, 22, 22])
    expect(radii('midpoint')).toEqual([])
    expect(radii('rotate')).toEqual([22])

    // At scale 2 the edges are 200 px: each shows its 44 px dot.
    h.view.setViewport({ x: 0, y: 0, scale: 2 })
    expect(radii('midpoint')).toEqual([22, 22, 22, 22])

    h.hover({ x: 20, y: 20 })
    expect(radii('vertex')).toEqual([10, 10, 10, 10])
    expect(radii('midpoint')).toEqual([8, 8, 8, 8])
    expect(radii('rotate')).toEqual([14])
  })

  it('a finger that presses a guide\'s end gets 44 px end targets (Q1)', () => {
    const h = createToolHarness({ scene: { measurementGuides: [measurementGuide('guide-1', { x: 10, y: 10 }, { x: 160, y: 10 })] } })
    harnesses.push(h)
    h.select({ kind: 'measurement-guide', id: 'guide-1' })
    const ends = () => h.chrome.handles.filter((entry) => entry.id.startsWith('guide-end:')).map((entry) => entry.hitRadiusPx)
    expect(ends()).toEqual([10, 10])

    h.click({ x: 10, y: 10 }, { pointer: 'touch', target: { kind: 'handle', id: 'guide-end:guide-1:a' as ToolHandleId } })
    expect(ends()).toEqual([22, 22])
  })

  it('double-click an edge midpoint adds a corner', () => {
    const h = polygonHarness()

    clickHandle(h, midpoint(0))
    expect(corners(h)).toEqual(SQUARE)

    clickHandle(h, midpoint(0), { clickCount: 2 })
    expect(corners(h)).toEqual([SQUARE[0], { x: 150, y: 100 }, SQUARE[1], SQUARE[2], SQUARE[3]])
    expect(h.store.session.selectedTargets).toEqual([POLY])
    // The two 50 px halves of the split edge leave no room for a dot.
    expect(h.chrome.handles.filter((entry) => entry.glyph === 'midpoint').map((entry) => entry.id))
      .toEqual([midpoint(2), midpoint(3), midpoint(4)])

    h.undo()
    expect(corners(h)).toEqual(SQUARE)
  })

  it('double-click a polygon edge adds a corner', () => {
    const h = polygonHarness()

    h.click({ x: 130, y: 201 })
    expect(corners(h)).toEqual(SQUARE)
    h.click({ x: 130, y: 201 }, { clickCount: 2 })
    expect(corners(h)).toEqual([SQUARE[0], SQUARE[1], SQUARE[2], { x: 130, y: 200 }, SQUARE[3]])
    expect(h.store.session.selectedTargets).toEqual([POLY])

    h.undo()
    expect(corners(h)).toEqual(SQUARE)
  })

  it('double-click a polygon edge adds a corner under a locked plant\'s crown: the edge follows Select\'s editable pick (canopi-qd2k)', () => {
    const h = createToolHarness({
      scene: {
        zones: [rectZone('poly', [...SQUARE], { zoneType: 'polygon' })],
        plants: [plantEntity('apple', 'Malus domestica', { x: 130, y: 200 }, { canopySpreadM: 20 })],
      },
    })
    harnesses.push(h)
    h.store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (layer.name === 'plants' ? { ...layer, locked: true } : layer))
    })
    h.select(POLY)

    h.click({ x: 130, y: 201 })
    h.click({ x: 130, y: 201 }, { clickCount: 2 })
    expect(corners(h)).toEqual([SQUARE[0], SQUARE[1], SQUARE[2], { x: 130, y: 200 }, SQUARE[3]])
    expect(h.store.session.selectedTargets).toEqual([POLY])
  })

  it('a double tap whose first press was inside the polygon adds no corner (U42)', () => {
    const h = polygonHarness()

    h.click({ x: 130, y: 180 })
    h.click({ x: 130, y: 201 }, { clickCount: 2 })
    expect(corners(h)).toEqual(SQUARE)
  })

  it('Alt+click on a corner removes it, keeping at least 3', () => {
    const h = polygonHarness()

    clickHandle(h, vertex(1), { alt: true })
    expect(corners(h)).toEqual([SQUARE[0], SQUARE[2], SQUARE[3]])
    clickHandle(h, vertex(0), { alt: true })
    expect(corners(h)).toEqual([SQUARE[0], SQUARE[2], SQUARE[3]])
    expect(h.history.canUndo.value).toBe(true)
  })

  it('Delete on a focused or selected corner keeps at least 3', () => {
    const h = polygonHarness()

    // No corner pressed or focused: Delete falls back to deleting the selection.
    expect(h.host.command({ kind: 'delete-handle' })).toBe('pass')

    // The last corner pressed without moving is the selected corner, shown as the active handle.
    clickHandle(h, vertex(1))
    expect(h.chrome.activeHandle).toBe(vertex(1))
    expect(h.host.command({ kind: 'delete-handle' })).toBe('handled')
    expect(corners(h)).toEqual([SQUARE[0], SQUARE[2], SQUARE[3]])
    // The corner now at the removed index is the selected corner (U37).
    expect(h.chrome.activeHandle).toBe(vertex(1))

    // A focused corner: at 3 corners Delete keeps the shape and deletes nothing else.
    h.chrome.focusedHandle = vertex(0)
    expect(h.host.command({ kind: 'delete-handle' })).toBe('handled')
    expect(corners(h)).toEqual([SQUARE[0], SQUARE[2], SQUARE[3]])
    expect(h.store.persisted.zones).toHaveLength(1)
  })

  it('a corner dragged out and back to its press is not selected; only a still press selects it (U40)', () => {
    const h = polygonHarness()
    const at = h.chrome.handles.find((entry) => entry.id === vertex(1))!.anchor

    h.press(at, { target: { kind: 'handle', id: vertex(1) } })
    h.move({ x: at.x + 30, y: at.y })
    h.move(at)
    h.release(at)

    expect(corners(h)).toEqual(SQUARE)
    expect(h.chrome.activeHandle).toBeNull()
    expect(h.host.command({ kind: 'delete-handle' })).toBe('pass')
    expect(corners(h)).toEqual(SQUARE)
  })
})
