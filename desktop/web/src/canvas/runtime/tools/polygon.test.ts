import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  plantEntity,
  useStubTools,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
import type { SceneDesignObjectTarget } from '../scene/design-object-targets'
import { roundGeoPosition } from '../scene/geo-frame'
import type { WorldPoint } from '../../../geo/view/types'
import type { DraftShape } from './draft'
import { createMeasurementGuideTool } from './measurement-guide'
import { createPolygonTool } from './polygon'
import { createZoneDragTool } from './zone-drag'
import '../../../__tests__/support/camera-tolerance'

vi.mock('./registry', () => ({ TOOL_REGISTRY: {} }))

const harnesses: ToolHarness[] = []

beforeEach(() => {
  // The shape tools; no other tool is listed here.
  useStubTools(
    createZoneDragTool('line'),
    createZoneDragTool('rectangle'),
    createZoneDragTool('ellipse'),
    createPolygonTool(),
    createMeasurementGuideTool(),
  )
})

function harness(options: ToolHarnessOptions = {}): ToolHarness {
  const created = createToolHarness({ tool: 'polygon', ...options })
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
  useStubTools()
})

function shapes(h: ToolHarness): readonly DraftShape[] {
  return h.renderer.lastDraft()?.shapes ?? []
}

function band(h: ToolHarness): readonly WorldPoint[] | null {
  const line = shapes(h).find((shape) => shape.kind === 'polyline')
  return line?.kind === 'polyline' ? line.points : null
}

function chipTexts(h: ToolHarness): string[] {
  return shapes(h).flatMap((shape) => shape.kind === 'label' ? [shape.text] : [])
}

function cornerMarkers(h: ToolHarness): WorldPoint[] {
  return shapes(h).flatMap((shape) => shape.kind === 'circle-px' ? [shape.center] : [])
}

describe('Polygon tool', () => {
  it('each press adds a corner; Enter finishes with 3', () => {
    const h = harness()
    const selectionWrites = vi.spyOn(h.store, 'setSelection')

    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    expect(h.host.command({ kind: 'confirm' })).toBe('handled')
    expect(h.store.persisted.zones).toEqual([])
    h.click({ x: 60, y: 50 })
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }])

    expect(h.host.command({ kind: 'confirm' })).toBe('handled')

    expect(h.store.persisted.zones).toHaveLength(1)
    const zone = h.store.persisted.zones[0]!
    expect(zone).toMatchObject({
      zoneType: 'polygon',
      rotationDeg: 0,
      points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }],
    })
    const stored = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }]
      .map((point) => roundGeoPosition(h.store.sessionPlane.toGeo(point)))
    expect(h.store.toCanopiFile().zones[0]).toMatchObject({ zone_type: 'polygon', rotation: 0, locked: false, points: stored })
    // One Scene Edit selects the new zone, in one selection write; the draft goes and the zone's own chips show.
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'zone', id: zone.id }])
    expect(selectionWrites).toHaveBeenCalledTimes(1)
    expect(shapes(h).every((shape) => shape.kind === 'label')).toBe(true)
    expect(h.host.transientHistory.canUndo()).toBe(false)
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
    expect(h.undo()).toBe(true)
    expect(h.store.persisted.zones).toEqual([])
    expect(h.undo()).toBe(false)
  })

  it('double-click finishes with 3 corners', () => {
    const h = harness()

    // With 2 corners the second press of a double-click adds nothing and finishes nothing.
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 10 }, { clickCount: 2 })
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }])
    expect(h.store.persisted.zones).toEqual([])

    // The first press of the double-click adds the third corner; its second finishes instead of adding one.
    h.click({ x: 60, y: 50 })
    h.click({ x: 60, y: 50 }, { clickCount: 2 })
    expect(h.store.persisted.zones).toHaveLength(1)
    expect(h.store.persisted.zones[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }])
    expect(cornerMarkers(h)).toEqual([])
  })

  it('a double-click whose first press closes the shape on the first corner: the second press starts nothing and keeps the zone selected', () => {
    const h = harness()
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 50 })

    h.click({ x: 10, y: 10 })
    h.click({ x: 10, y: 10 }, { clickCount: 2 })

    expect(h.store.persisted.zones).toHaveLength(1)
    const zoneId = h.store.persisted.zones[0]!.id
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'zone', id: zoneId }])
    expect(cornerMarkers(h)).toEqual([])
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
  })

  it('Finish shape is the first menu entry', () => {
    const h = harness()
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.menu({ x: 200, y: 200 })
    expect(h.record.menus.at(-1)?.finishShape).toBeUndefined()

    h.click({ x: 60, y: 50 })
    h.menu({ x: 200, y: 200 })
    const finishShape = h.record.menus.at(-1)?.finishShape
    expect(finishShape).toBeTypeOf('function')
    finishShape!()
    expect(h.store.persisted.zones[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }])
    expect(cornerMarkers(h)).toEqual([])
  })

  it('the keyboard menu also leads with Finish shape', () => {
    const h = harness()
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 50 })
    h.menu('selection', 'keyboard')
    const finishShape = h.record.menus.at(-1)?.finishShape
    expect(finishShape).toBeTypeOf('function')
    finishShape!()
    expect(h.store.persisted.zones[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }])
  })

  it('Backspace removes the last corner', () => {
    const h = harness()

    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.hover({ x: 60, y: 50 })
    expect(band(h)).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }])

    expect(h.host.command({ kind: 'remove-last' })).toBe('handled')

    expect(band(h)).toEqual([{ x: 10, y: 10 }, { x: 60, y: 50 }])
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }])
    expect(h.host.transientHistory.canRedo()).toBe(true)
    expect(h.store.persisted.zones).toEqual([])
    expect(h.history.canUndo.peek()).toBe(false)

    // The last corner goes too, then Backspace has nothing left and passes to the app.
    expect(h.host.command({ kind: 'remove-last' })).toBe('handled')
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.host.command({ kind: 'remove-last' })).toBe('pass')
  })

  it('a drag after a corner press adds no corner', () => {
    const h = harness()

    h.drag({ x: 10, y: 10 }, { x: 60, y: 40 })

    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }])
    expect(band(h)).toEqual([{ x: 10, y: 10 }, { x: 60, y: 40 }])

    h.click({ x: 90, y: 10 })
    h.drag({ x: 90, y: 60 }, { x: 20, y: 60 })
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 60 }])
    expect(h.store.persisted.zones).toEqual([])
  })

  it('Polygon closes on its first corner under snapping and Shift', () => {
    // Scale 1: the grid is 20 m. A Shift point would turn the closing edge to 45° from the last corner, 14 px away from
    // the first; the close test reads the snapped point without the constraint (today's snap(raw)).
    const h = harness({ snapping: { grid: true } })

    h.click({ x: 21, y: 19 })
    h.click({ x: 99, y: 22 })
    h.click({ x: 101, y: 79 })
    expect(cornerMarkers(h)).toEqual([{ x: 20, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 80 }])

    h.click({ x: 23, y: 21 }, { mods: { shift: true } })

    expect(h.store.persisted.zones).toHaveLength(1)
    expect(h.store.persisted.zones[0]!.points).toEqual([{ x: 20, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 80 }])
    expect(h.renderer.lastDraft()?.shapes.some((shape) => shape.kind === 'circle-px')).toBeFalsy()
  })

  it('a finger\'s tap within 22 px of the first corner closes the shape; a mouse there adds a corner (Q5)', () => {
    const h = harness()
    h.click({ x: 100, y: 100 })
    h.click({ x: 200, y: 100 })
    h.click({ x: 200, y: 200 })

    h.click({ x: 118, y: 100 })
    expect(h.store.persisted.zones).toEqual([])
    expect(cornerMarkers(h)).toHaveLength(4)

    h.click({ x: 112, y: 112 }, { pointer: 'touch' })
    expect(h.store.persisted.zones.map((zone) => zone.points)).toEqual([
      [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 118, y: 100 }],
    ])
  })

  it('Alt+click on a placed corner deletes it, the first included (answer 2)', () => {
    const h = harness()
    for (const at of [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }, { x: 10, y: 100 }]) h.click(at)

    // Alt+click within 8 px deletes the corner, and the redo with it; nothing is committed.
    h.host.command({ kind: 'remove-last' })
    expect(h.host.transientHistory.canRedo()).toBe(true)
    h.click({ x: 104, y: 96 }, { mods: { alt: true } })
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }, { x: 100, y: 10 }])
    expect(h.host.transientHistory.canRedo()).toBe(false)
    h.click({ x: 100, y: 100 })
    h.click({ x: 10, y: 100 })

    // On the first corner Alt deletes it rather than closing the zone.
    h.click({ x: 12, y: 12 }, { mods: { alt: true } })
    expect(cornerMarkers(h)).toEqual([{ x: 100, y: 10 }, { x: 100, y: 100 }, { x: 10, y: 100 }])
    expect(h.store.persisted.zones).toEqual([])
    expect(h.history.canUndo.peek()).toBe(false)

    // Closing on the first corner still works.
    h.click({ x: 98, y: 12 })
    expect(h.store.persisted.zones.map((zone) => zone.points)).toEqual([[{ x: 100, y: 10 }, { x: 100, y: 100 }, { x: 10, y: 100 }]])
  })

  it('a plain click or a finger\'s tap near a placed corner other than the first adds a corner there', () => {
    const h = harness()
    for (const at of [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }]) h.click(at)
    h.click({ x: 96, y: 14 })
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }, { x: 96, y: 14 }])

    const touch = harness()
    touch.click({ x: 100, y: 100 }, { pointer: 'touch' })
    touch.click({ x: 200, y: 100 }, { pointer: 'touch' })
    touch.click({ x: 215, y: 112 }, { pointer: 'touch' })
    expect(cornerMarkers(touch)).toEqual([{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 215, y: 112 }])
  })

  it('a Shift corner keeps the new edge on 45° from the last corner', () => {
    const h = harness()

    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 14 }, { mods: { shift: true } })

    const second = cornerMarkers(h)[1]!
    expect(second.y).toBeCloseTo(10)
    expect(second.x).toBeCloseTo(Math.hypot(50, 4) + 10)
  })

  it('Shift keeps 45 degrees on screen at 30', () => {
    const h = harness({ camera: { bearingDeg: 30 } })

    h.click({ x: 100, y: 100 })
    // 50 px right and 4 px down on screen: Shift turns the edge level on screen, not level with the world.
    h.click({ x: 150, y: 104 }, { mods: { shift: true } })

    const [first, second] = cornerMarkers(h).map((corner) => h.view.view().worldToScreen(corner))
    expect(second!.y).toBeCloseTo(first!.y, 6)
    expect(second!.x - first!.x).toBeCloseTo(Math.hypot(50, 4), 6)
  })

  it('a key zoom with the pointer off the map re-culls the edge chips', () => {
    const h = harness()

    h.click({ x: 10, y: 10 })
    h.click({ x: 48, y: 10 })
    h.leave()
    expect(chipTexts(h)).toEqual(['38 m'])

    // 38 m is 34.5 px after one zoom step out: shorter than a chip needs.
    h.view.navigation.zoomOut()
    expect(chipTexts(h)).toEqual([])
    expect(cornerMarkers(h)).toHaveLength(2)

    h.view.navigation.zoomIn()
    expect(chipTexts(h)).toEqual(['38 m'])
  })

  it('draws a fill-only polygon of the corners, the rubber band, a disc per corner and its chips', () => {
    const h = harness()

    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 50 })
    h.hover({ x: 10, y: 50 })

    const corners = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }]
    const draft = shapes(h)
    expect(draft.slice(0, 5)).toEqual([
      { kind: 'polygon', points: corners, style: { token: 'draft', widthPx: 0 }, fill: { token: 'draft-fill' } },
      { kind: 'polyline', points: [...corners, { x: 10, y: 50 }], style: { token: 'draft', widthPx: 2 } },
      ...corners.map((center) => ({ kind: 'circle-px', center, radiusPx: 1.75, style: { token: 'draft', widthPx: 3.5 } })),
    ])
    const chips = draft.slice(5)
    expect(chips.map((chip) => chip.kind === 'label' ? [chip.text, chip.tone] : null)).toEqual([
      ['50 m', 'measure-quiet'],
      ['40 m', 'measure-quiet'],
      ['50 m', 'measure-quiet'],
      ['40 m', 'measure-quiet'],
      ['2000 m²', 'measure'],
    ])
  })

  it('hovers move the rubber band and skip the passive hover while a draft is open', () => {
    const h = harness({ scene: { plants: [plantEntity('p1', 'Malus domestica', { x: 150, y: 150 })] } })

    h.hover({ x: 150, y: 150 })
    expect(h.record.hovers.at(-1)).toEqual({ kind: 'plant', id: 'p1' })
    expect(h.renderer.lastDraft()).toBeNull()

    h.click({ x: 10, y: 10 })
    h.hover({ x: 150, y: 150 })
    expect(band(h)).toEqual([{ x: 10, y: 10 }, { x: 150, y: 150 }])
    expect(h.record.hovers.at(-1)).toBeNull()

    // Leaving the map keeps the draft.
    h.leave()
    expect(band(h)).toEqual([{ x: 10, y: 10 }, { x: 150, y: 150 }])
  })

  it('the first corner clears the selection without an undo step', () => {
    const plant: SceneDesignObjectTarget = { kind: 'plant', id: 'p1' }
    const h = harness({ scene: { plants: [plantEntity('p1', 'Malus domestica', { x: 150, y: 150 })] } })
    h.select(plant)

    h.click({ x: 10, y: 10 })
    expect(h.store.session.selectedTargets).toEqual([])
    expect(h.record.selections.at(-1)).toEqual([])
    h.click({ x: 60, y: 10 })
    expect(h.record.selections).toHaveLength(1)
    expect(h.history.canUndo.peek()).toBe(false)
  })

  it('Esc steps the draft back corner by corner onto the redo stack; the Esc that removes the last corner empties it and its redo, and the next passes (A17)', () => {
    const h = harness()

    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 50 })
    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }])
    expect(h.host.transientHistory.canRedo()).toBe(true)
    // Ctrl+Shift+Z restores the corner Esc removed.
    expect(h.host.command({ kind: 'redo-transient' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }])

    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }])
    expect(h.host.activeToolHasEscapeTransient()).toBe(true)
    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.host.transientHistory.canRedo()).toBe(false)
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
    expect(h.host.command({ kind: 'escape' })).toBe('pass')
    expect(h.toolState.value).toBe('polygon')
    expect(h.history.canUndo.peek()).toBe(false)
  })

  it('Esc with only a redo left drops it and arms Select in the same press (A17)', () => {
    const h = harness()

    h.click({ x: 10, y: 10 })
    expect(h.host.command({ kind: 'remove-last' })).toBe('handled')
    expect(h.host.activeToolHasEscapeTransient()).toBe(true)
    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(h.host.transientHistory.canRedo()).toBe(false)
    expect(h.toolState.value).toBe('select')
  })

  it('transient history steps corners back and forth, and a new corner clears the redo', () => {
    const h = harness()

    h.click({ x: 10, y: 10 })
    expect(h.host.transientHistory.undo()).toBe(true)
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.host.transientHistory.redo()).toBe(true)
    expect(band(h)).toEqual([{ x: 10, y: 10 }, { x: 10, y: 10 }])

    h.click({ x: 60, y: 10 })
    expect(h.host.transientHistory.undo()).toBe(true)
    h.click({ x: 60, y: 50 })
    expect(h.host.transientHistory.canRedo()).toBe(false)
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }, { x: 60, y: 50 }])
  })

  it('a window blur keeps the draft; overview and a tool change drop it', () => {
    const h = harness()

    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.blur()
    expect(cornerMarkers(h)).toHaveLength(2)
    expect(h.host.transientHistory.canUndo()).toBe(true)

    h.view.setViewport({ x: 200, y: 150, scale: 0.05 })
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
    expect(h.renderer.lastDraft()).toBeNull()

    h.view.setViewport({ x: 0, y: 0, scale: 1 })
    h.click({ x: 10, y: 10 })
    h.arm('select')
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.host.transientHistory.canUndo()).toBe(false)
  })

  it('a window blur keeps a redo beside corners and drops a redo-only history, as today', () => {
    const h = harness()

    // Corners left: the redo stays with them (today's preservePolygonDraft kept both).
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    expect(h.host.transientHistory.undo()).toBe(true)
    h.blur()
    expect(cornerMarkers(h)).toEqual([{ x: 10, y: 10 }])
    expect(h.host.transientHistory.canRedo()).toBe(true)

    // No corner left: today kept the draft only while it had corners (hasPolygonDraft), so the redo goes.
    expect(h.host.transientHistory.undo()).toBe(true)
    expect(h.host.transientHistory.canRedo()).toBe(true)
    h.blur()
    expect(h.host.transientHistory.canRedo()).toBe(false)
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
  })

  it('a closed Zones layer drops the draft and commits nothing', () => {
    const h = harness()

    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => layer.name === 'zones' ? { ...layer, locked: true } : layer)
    })
    h.click({ x: 60, y: 50 })

    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
    expect(h.store.persisted.zones).toEqual([])
  })

  it('a draft holds re-origin until it ends', () => {
    const h = harness()
    expect(h.host.holdsReorigin()).toBe(false)

    h.click({ x: 10, y: 10 })
    expect(h.host.holdsReorigin()).toBe(true)
    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 50 })
    expect(h.host.command({ kind: 'confirm' })).toBe('handled')

    expect(h.store.persisted.zones).toHaveLength(1)
    expect(h.host.holdsReorigin()).toBe(false)
  })
})
