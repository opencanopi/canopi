import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  useStubTools,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
import type { ScreenPoint, WorldPoint } from '../../../geo/view/types'
import { getEllipticalZonePolygon, getRectangularZoneCorners } from '../zone-geometry'
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
  const created = createToolHarness(options)
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

function chips(h: ToolHarness): [string, string][] {
  return shapes(h).flatMap((shape) => shape.kind === 'label' ? [[shape.text, shape.tone] as [string, string]] : [])
}

function lockZones(h: ToolHarness): void {
  h.store.updatePersisted((draft) => {
    draft.layers = draft.layers.map((layer) => layer.name === 'zones' ? { ...layer, locked: true } : layer)
  })
}

function expectPoints(actual: readonly WorldPoint[], expected: readonly WorldPoint[]): void {
  expect(actual).toHaveLength(expected.length)
  for (const [index, point] of expected.entries()) {
    expect(actual[index]!.x).toBeCloseTo(point.x, 9)
    expect(actual[index]!.y).toBeCloseTo(point.y, 9)
  }
}

function expectScreen(h: ToolHarness, actual: readonly WorldPoint[], expected: readonly ScreenPoint[]): void {
  const view = h.view.view()
  expect(actual).toHaveLength(expected.length)
  for (const [index, point] of expected.entries()) {
    const screen = view.worldToScreen(actual[index]!)
    expect(screen.x).toBeCloseTo(point.x, 6)
    expect(screen.y).toBeCloseTo(point.y, 6)
  }
}

const DRAFT_STROKE = { token: 'draft', widthPx: 2 } as const
const ZONE_FILL = { token: 'draft-fill' } as const

describe('Zone drag tools', () => {
  it('a rectangle drag commits one zone', () => {
    const h = harness({ tool: 'rectangle' })
    const selectionWrites = vi.spyOn(h.store, 'setSelection')

    h.drag({ x: 10, y: 20 }, { x: 40, y: 60 })

    expect(h.store.persisted.zones).toHaveLength(1)
    const zone = h.store.persisted.zones[0]!
    expect(zone).toMatchObject({
      zoneType: 'rect',
      rotationDeg: 0,
      points: [{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 60 }, { x: 10, y: 60 }],
    })
    // One selection write, the Scene Edit's.
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'zone', id: zone.id }])
    expect(selectionWrites).toHaveBeenCalledTimes(1)
    // The draft goes with the release; the new zone's own chips show.
    expect(shapes(h).every((shape) => shape.kind === 'label')).toBe(true)
    expect(h.undo()).toBe(true)
    expect(h.store.persisted.zones).toEqual([])
    expect(h.undo()).toBe(false)
  })

  it('a rectangle draft is the dragged box, filled as a zone, with its edge and area chips', () => {
    const h = harness({ tool: 'rectangle' })

    h.press({ x: 10, y: 20 })
    // The press draws the zero-size shape without chips.
    expect(shapes(h)).toEqual([{
      kind: 'polygon',
      points: [{ x: 10, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 20 }],
      style: DRAFT_STROKE,
      fill: ZONE_FILL,
    }])
    expect(h.record.guidance.at(-1)).toMatchObject({ gesture: true })

    h.move({ x: 70, y: 100 })
    expect(shapes(h)[0]).toEqual({
      kind: 'polygon',
      points: [{ x: 10, y: 20 }, { x: 70, y: 20 }, { x: 70, y: 100 }, { x: 10, y: 100 }],
      style: DRAFT_STROKE,
      fill: ZONE_FILL,
    })
    expect(chips(h)).toEqual([
      ['60 m', 'measure-quiet'],
      ['80 m', 'measure-quiet'],
      ['60 m', 'measure-quiet'],
      ['80 m', 'measure-quiet'],
      ['4800 m²', 'measure'],
    ])
    expect(h.store.persisted.zones).toEqual([])
  })

  it('an ellipse draft is a world ellipse filled as a zone, with its size and area chips', () => {
    const h = harness({ tool: 'ellipse' })

    h.press({ x: 10, y: 20 })
    h.move({ x: 70, y: 100 })

    expect(shapes(h)[0]).toEqual({
      kind: 'ellipse',
      center: { x: 40, y: 60 },
      radiusX: 30,
      radiusY: 40,
      rotationDeg: 0,
      style: DRAFT_STROKE,
      fill: ZONE_FILL,
    })
    expect(chips(h)).toEqual([['W 60 m', 'measure-quiet'], ['H 80 m', 'measure-quiet'], ['3770 m²', 'measure']])

    h.release({ x: 70, y: 100 })
    expect(h.store.persisted.zones[0]).toMatchObject({
      zoneType: 'ellipse',
      points: [{ x: 40, y: 60 }, { x: 30, y: 40 }],
    })
  })

  it('a line draft is a stroke with its length chip', () => {
    const h = harness({ tool: 'line' })

    h.press({ x: 10, y: 20 })
    h.move({ x: 70, y: 20 })

    expect(shapes(h)).toEqual([
      { kind: 'polyline', points: [{ x: 10, y: 20 }, { x: 70, y: 20 }], style: DRAFT_STROKE },
      { kind: 'label', anchor: { x: 40, y: 20 }, offsetPx: { x: 0, y: 0 }, text: '60 m', tone: 'measure-quiet' },
    ])

    h.release({ x: 70, y: 20 })
    expect(h.store.persisted.zones[0]).toMatchObject({ zoneType: 'line', points: [{ x: 10, y: 20 }, { x: 70, y: 20 }] })
  })

  it('the draft and the zone come from the snapped points', () => {
    const h = harness({ tool: 'rectangle', viewport: { x: 0, y: 0, scale: 4 }, snapping: { grid: true } })

    // At 4 px/m the grid is 5 m.
    h.press({ x: 43, y: 87 })
    h.move({ x: 148, y: 254 })
    expect(shapes(h)[0]).toMatchObject({ points: [{ x: 10, y: 20 }, { x: 35, y: 20 }, { x: 35, y: 65 }, { x: 10, y: 65 }] })
    h.release({ x: 148, y: 254 })

    expect(h.store.persisted.zones[0]!.points).toEqual([{ x: 10, y: 20 }, { x: 35, y: 20 }, { x: 35, y: 65 }, { x: 10, y: 65 }])
  })

  it('the draft\'s start stays on the ground through a wheel zoom', () => {
    const h = harness({ tool: 'rectangle' })
    const start = h.world({ x: 100, y: 100 })

    h.press({ x: 100, y: 100 })
    h.move({ x: 160, y: 140 })
    h.wheelZoom({ x: 300, y: 200 }, 2)

    // The drag is re-emitted under the still pointer, from the same ground point.
    const end = h.world({ x: 160, y: 140 })
    const box = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }]
    const draft = shapes(h)[0]
    expectPoints(draft?.kind === 'polygon' ? draft.points : [], box)
    h.release({ x: 160, y: 140 })
    expectPoints(h.store.persisted.zones[0]!.points, box)
  })

  it('a cancel aborts the drag and clears the draft', () => {
    const h = harness({ tool: 'rectangle' })

    h.press({ x: 10, y: 20 })
    h.move({ x: 40, y: 60 })
    h.cancel('pointercancel')

    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.store.persisted.zones).toEqual([])
    expect(h.record.guidance.at(-1)).toMatchObject({ gesture: false })
    // The scene is free again: the next drag commits.
    h.drag({ x: 10, y: 20 }, { x: 40, y: 60 })
    expect(h.store.persisted.zones).toHaveLength(1)
  })

  it('a rectangle or an ellipse under half a metre, and a click, commit nothing', () => {
    const h = harness({ tool: 'rectangle' })

    h.drag({ x: 10, y: 10 }, { x: 10.2, y: 40 })
    h.click({ x: 50, y: 50 })
    h.arm('ellipse')
    h.drag({ x: 10, y: 10 }, { x: 40, y: 10.4 })

    expect(h.store.persisted.zones).toEqual([])
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.history.canUndo.peek()).toBe(false)
  })

  it('a drag on a closed Zones layer draws and commits nothing', () => {
    const h = harness({ tool: 'line' })
    lockZones(h)

    h.press({ x: 10, y: 20 })
    h.move({ x: 40, y: 60 })
    expect(h.renderer.lastDraft()).toBeNull()
    h.release({ x: 40, y: 60 })

    expect(h.store.persisted.zones).toEqual([])
  })

  it('a release whose commit publication fails keeps the shape once, and the next press draws', () => {
    const h = harness({ tool: 'rectangle' })
    const record = h.history.record.bind(h.history)
    let failures = 1
    vi.spyOn(h.history, 'record').mockImplementation((command, accepted) => {
      record(command, accepted)
      if (command.type === 'interaction-rectangle' && failures > 0) {
        failures -= 1
        throw new Error('rectangle publication failed')
      }
    })

    // History accepted the rectangle before its publication threw: the commit keeps it and runs no step again.
    expect(() => h.drag({ x: 10, y: 20 }, { x: 40, y: 60 })).toThrow('rectangle publication failed')
    expect(shapes(h).some((shape) => shape.kind === 'polygon')).toBe(false)
    expect(h.store.persisted.zones).toHaveLength(1)

    expect(h.press({ x: 50, y: 70 })).not.toEqual({ quarantine: true, rejectSession: true })
    h.drag({ x: 50, y: 70 }, { x: 80, y: 100 })
    expect(h.store.persisted.zones).toHaveLength(2)
    expect(h.undo()).toBe(true)
    expect(h.undo()).toBe(true)
    expect(h.undo()).toBe(false)
  })

  it('a tool change aborts a live drag', () => {
    const h = harness({ tool: 'ellipse' })

    h.press({ x: 10, y: 20 })
    h.move({ x: 40, y: 60 })
    h.arm('select')

    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.store.persisted.zones).toEqual([])
    expect(h.host.hasLiveGesture()).toBe(false)
  })

  it('a rectangle drawn at 30 stores 30', () => {
    const h = harness({ tool: 'rectangle', camera: { bearingDeg: 30 } })
    const box = [{ x: 100, y: 100 }, { x: 220, y: 100 }, { x: 220, y: 180 }, { x: 100, y: 180 }]

    h.press({ x: 100, y: 100 })
    h.move({ x: 220, y: 180 })
    // The draft is level with the screen, and so are its edge chips.
    const draft = shapes(h)[0]
    expectScreen(h, draft?.kind === 'polygon' ? draft.points : [], box)
    expect(chips(h)).toHaveLength(5)
    h.release({ x: 220, y: 180 })

    const zone = h.store.persisted.zones[0]!
    expect(zone).toMatchObject({ zoneType: 'rect', rotationDeg: 30 })
    expectScreen(h, getRectangularZoneCorners(zone) ?? [], box)
  })

  it('an ellipse drawn at 30 stores 30', () => {
    const h = harness({ tool: 'ellipse', camera: { bearingDeg: 30 } })

    h.press({ x: 100, y: 100 })
    h.move({ x: 220, y: 180 })
    const draft = shapes(h)[0]
    expect(draft).toMatchObject({ kind: 'ellipse', rotationDeg: 30 })
    if (draft?.kind !== 'ellipse') return
    expectScreen(h, [draft.center], [{ x: 160, y: 140 }])
    expect(chips(h).map(([text]) => text.slice(0, 2))).toEqual(['W ', 'H ', expect.any(String)])
    h.release({ x: 220, y: 180 })

    const zone = h.store.persisted.zones[0]!
    expect(zone).toMatchObject({ zoneType: 'ellipse', rotationDeg: 30 })
    // The ellipse's right, bottom, left and top extremes land on the dragged box's edge midpoints.
    const outline = getEllipticalZonePolygon(zone, 4) ?? []
    expectScreen(h, outline, [{ x: 220, y: 140 }, { x: 160, y: 180 }, { x: 100, y: 140 }, { x: 160, y: 100 }])
  })

  it('Shift draws a square', () => {
    const h = harness({ tool: 'rectangle', camera: { bearingDeg: 30 } })

    h.press({ x: 100, y: 100 })
    h.move({ x: 220, y: 160 }, { shift: true })
    const draft = shapes(h)[0]
    // The longer side wins, level on screen: 120 px by 120 px from the press.
    expectScreen(h, draft?.kind === 'polygon' ? draft.points : [], [
      { x: 100, y: 100 }, { x: 220, y: 100 }, { x: 220, y: 220 }, { x: 100, y: 220 },
    ])
    h.release({ x: 220, y: 160 }, { shift: true })

    const zone = h.store.persisted.zones[0]!
    expect(zone).toMatchObject({ zoneType: 'rect', rotationDeg: 30 })
    expectScreen(h, getRectangularZoneCorners(zone) ?? [], [
      { x: 100, y: 100 }, { x: 220, y: 100 }, { x: 220, y: 220 }, { x: 100, y: 220 },
    ])
  })

  it('Shift draws a circle', () => {
    const h = harness({ tool: 'ellipse' })

    h.press({ x: 100, y: 100 })
    h.move({ x: 140, y: 190 }, { shift: true })
    expect(shapes(h)[0]).toMatchObject({ kind: 'ellipse', radiusX: 45, radiusY: 45 })
    h.release({ x: 140, y: 190 }, { shift: true })

    const zone = h.store.persisted.zones[0]!
    expect(zone.points[1]).toEqual({ x: 45, y: 45 })
  })

  it('a Shift change at the release applies at the next move, so a drag commits as its last preview drew it (B3, A17)', () => {
    // Rectangle: square in the preview, Shift let go before the up: still a square.
    const square = harness({ tool: 'rectangle' })
    square.press({ x: 100, y: 100 })
    square.move({ x: 220, y: 160 }, { shift: true })
    square.release({ x: 220, y: 160 })
    expectScreen(square, getRectangularZoneCorners(square.store.persisted.zones[0]!) ?? [], [
      { x: 100, y: 100 }, { x: 220, y: 100 }, { x: 220, y: 220 }, { x: 100, y: 220 },
    ])

    // Ellipse: free in the preview, Shift pressed before the up: still free.
    const ellipse = harness({ tool: 'ellipse' })
    ellipse.press({ x: 100, y: 100 })
    ellipse.move({ x: 140, y: 190 })
    ellipse.release({ x: 140, y: 190 }, { shift: true })
    expect(ellipse.store.persisted.zones[0]!.points[1]).toEqual({ x: 20, y: 45 })

    // Line and measure: on 45° in the preview, Shift let go before the up: still level.
    for (const tool of ['line', 'measurement-guide'] as const) {
      const h = harness({ tool })
      h.press({ x: 100, y: 100 })
      h.move({ x: 180, y: 106 }, { shift: true })
      h.release({ x: 180, y: 106 })
      const ends = tool === 'line'
        ? h.store.persisted.zones[0]!.points
        : [h.store.persisted.measurementGuides[0]!.start, h.store.persisted.measurementGuides[0]!.end]
      expectScreen(h, ends, [{ x: 100, y: 100 }, { x: 100 + Math.hypot(80, 6), y: 100 }])
    }
  })

  it('Shift keeps a line and a measure on 45° steps against the screen at 30', () => {
    for (const tool of ['line', 'measurement-guide'] as const) {
      const h = harness({ tool, camera: { bearingDeg: 30 } })

      h.press({ x: 100, y: 100 })
      // 80 px right and 6 px down on screen: Shift levels it on screen, its length kept.
      h.move({ x: 180, y: 106 }, { shift: true })
      h.release({ x: 180, y: 106 }, { shift: true })

      const ends = tool === 'line'
        ? h.store.persisted.zones[0]!.points
        : [h.store.persisted.measurementGuides[0]!.start, h.store.persisted.measurementGuides[0]!.end]
      expectScreen(h, ends, [{ x: 100, y: 100 }, { x: 100 + Math.hypot(80, 6), y: 100 }])
    }
  })
})
