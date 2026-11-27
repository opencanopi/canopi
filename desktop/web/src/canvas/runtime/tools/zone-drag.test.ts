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

function expectedAlignedCorners(
  a: WorldPoint,
  b: WorldPoint,
  bearingDeg: number,
  square = false,
): WorldPoint[] {
  const rad = (bearingDeg * Math.PI) / 180
  const right = { x: Math.cos(rad), y: Math.sin(rad) }
  const down = { x: -right.y, y: right.x }
  let across = (b.x - a.x) * right.x + (b.y - a.y) * right.y
  let along = (b.x - a.x) * down.x + (b.y - a.y) * down.y
  if (square) {
    const side = Math.max(Math.abs(across), Math.abs(along))
    across = (across < 0 ? -1 : 1) * side
    along = (along < 0 ? -1 : 1) * side
  }
  const center = { x: a.x + (right.x * across + down.x * along) / 2, y: a.y + (right.y * across + down.y * along) / 2 }
  const halfW = Math.abs(across) / 2
  const halfH = Math.abs(along) / 2
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({
    x: center.x + sx! * halfW * right.x + sy! * halfH * down.x,
    y: center.y + sx! * halfW * right.y + sy! * halfH * down.y,
  }))
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
    const start = h.world({ x: 10, y: 20 })
    const end = h.world({ x: 40, y: 60 })
    expect(zone).toMatchObject({ zoneType: 'rect', rotationDeg: 0 })
    expectPoints(zone.points, [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }])
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
    const sa = h.screen({ x: 10, y: 20 })
    const sb = h.screen({ x: 70, y: 100 })
    const a = h.world(sa)
    const b = h.world(sb)

    h.press(sa)
    // The press draws the zero-size shape without chips.
    expect(shapes(h)).toEqual([{
      kind: 'polygon',
      points: [a, a, a, a],
      style: DRAFT_STROKE,
      fill: ZONE_FILL,
    }])
    expect(h.record.guidance.at(-1)).toMatchObject({ gesture: true })

    h.move(sb)
    const draft = shapes(h)[0]
    expect(draft).toMatchObject({ kind: 'polygon', style: DRAFT_STROKE, fill: ZONE_FILL })
    expectPoints(draft?.kind === 'polygon' ? draft.points : [], [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }])
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
    const sa = h.screen({ x: 10, y: 20 })
    const sb = h.screen({ x: 70, y: 100 })

    h.press(sa)
    h.move(sb)

    expect(shapes(h)[0]).toEqual({
      kind: 'ellipse',
      center: { x: expect.closeTo(40, 9), y: expect.closeTo(60, 9) },
      radiusX: expect.closeTo(30, 9),
      radiusY: expect.closeTo(40, 9),
      rotationDeg: 0,
      style: DRAFT_STROKE,
      fill: ZONE_FILL,
    })
    expect(chips(h)).toEqual([['60 m × 80 m', 'measure-quiet'], ['3770 m²', 'measure']])

    h.release(sb)
    expect(h.store.persisted.zones[0]).toMatchObject({
      zoneType: 'ellipse',
      points: [
        { x: expect.closeTo(40, 9), y: expect.closeTo(60, 9) },
        { x: expect.closeTo(30, 9), y: expect.closeTo(40, 9) },
      ],
    })
  })

  it('a line draft is a stroke with its length chip', () => {
    const h = harness({ tool: 'line' })
    const sa = h.screen({ x: 10, y: 20 })
    const sb = h.screen({ x: 70, y: 20 })
    const a = h.world(sa)
    const b = h.world(sb)

    h.press(sa)
    h.move(sb)

    expect(shapes(h)).toEqual([
      { kind: 'polyline', points: [a, b], style: DRAFT_STROKE },
      { kind: 'label', anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, offsetPx: { x: 0, y: 0 }, text: '60 m', tone: 'measure-quiet' },
    ])

    h.release(sb)
    expect(h.store.persisted.zones[0]).toMatchObject({ zoneType: 'line', points: [a, b] })
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
    const begin = h.edits.begin.bind(h.edits)
    let failures = 1
    vi.spyOn(h.edits, 'begin').mockImplementation((type, options) =>
      begin(type, {
        ...options,
        onCommitted: () => {
          options?.onCommitted?.()
          if (type === 'interaction-rectangle' && failures > 0) {
            failures -= 1
            throw new Error('rectangle publication failed')
          }
        },
      }),
    )

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
    const start = h.world({ x: 100, y: 100 })
    const end = h.world({ x: 220, y: 180 })
    const expected = expectedAlignedCorners(start, end, 30)

    h.press({ x: 100, y: 100 })
    h.move({ x: 220, y: 180 })
    // The draft is aligned to the bearing with opposite corners on the press and pointer, and so are its edge chips.
    const draft = shapes(h)[0]
    expectPoints(draft?.kind === 'polygon' ? draft.points : [], expected)
    expectScreen(h, draft?.kind === 'polygon' ? [draft.points[0]!, draft.points[2]!] : [], [{ x: 100, y: 100 }, { x: 220, y: 180 }])
    expect(chips(h)).toHaveLength(5)
    h.release({ x: 220, y: 180 })

    const zone = h.store.persisted.zones[0]!
    expect(zone).toMatchObject({ zoneType: 'rect', rotationDeg: 30 })
    expectPoints(getRectangularZoneCorners(zone) ?? [], expected)
  })

  it('an ellipse drawn at 30 stores 30', () => {
    const h = harness({ tool: 'ellipse', camera: { bearingDeg: 30 } })
    const start = h.world({ x: 100, y: 100 })
    const end = h.world({ x: 220, y: 180 })
    const corners = expectedAlignedCorners(start, end, 30)
    const mid = (a: WorldPoint, b: WorldPoint): WorldPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

    h.press({ x: 100, y: 100 })
    h.move({ x: 220, y: 180 })
    const draft = shapes(h)[0]
    expect(draft).toMatchObject({ kind: 'ellipse', rotationDeg: 30 })
    if (draft?.kind !== 'ellipse') return
    expectScreen(h, [draft.center], [{ x: 160, y: 140 }])
    expect(chips(h).map(([text]) => text)).toEqual([expect.stringContaining(' × '), expect.any(String)])
    h.release({ x: 220, y: 180 })

    const zone = h.store.persisted.zones[0]!
    expect(zone).toMatchObject({ zoneType: 'ellipse', rotationDeg: 30 })
    // The ellipse's right, bottom, left and top extremes land on the dragged box's edge midpoints.
    const outline = getEllipticalZonePolygon(zone, 4) ?? []
    expectPoints(outline, [mid(corners[1]!, corners[2]!), mid(corners[2]!, corners[3]!), mid(corners[3]!, corners[0]!), mid(corners[0]!, corners[1]!)])
  })

  it('Shift draws a square', () => {
    const h = harness({ tool: 'rectangle', camera: { bearingDeg: 30 } })
    const start = h.world({ x: 100, y: 100 })
    const end = h.world({ x: 220, y: 160 })
    const expected = expectedAlignedCorners(start, end, 30, true)

    h.press({ x: 100, y: 100 })
    h.move({ x: 220, y: 160 }, { shift: true })
    const draft = shapes(h)[0]
    // The longer side wins, aligned to the bearing from the press.
    expectPoints(draft?.kind === 'polygon' ? draft.points : [], expected)
    h.release({ x: 220, y: 160 }, { shift: true })

    const zone = h.store.persisted.zones[0]!
    expect(zone).toMatchObject({ zoneType: 'rect', rotationDeg: 30 })
    expectPoints(getRectangularZoneCorners(zone) ?? [], expected)
  })

  it('Shift draws a circle', () => {
    const h = harness({ tool: 'ellipse' })
    const sa = h.screen({ x: 100, y: 100 })
    const sb = h.screen({ x: 140, y: 190 })

    h.press(sa)
    h.move(sb, { shift: true })
    expect(shapes(h)[0]).toMatchObject({ kind: 'ellipse', radiusX: expect.closeTo(45, 9), radiusY: expect.closeTo(45, 9) })
    h.release(sb, { shift: true })

    const zone = h.store.persisted.zones[0]!
    expectPoints([zone.points[1]!], [{ x: 45, y: 45 }])
  })

  it('a Shift change at the release applies at the next move, so a drag commits as its last preview drew it (B3, A17)', () => {
    // Rectangle: square in the preview, Shift let go before the up: still a square.
    const square = harness({ tool: 'rectangle' })
    const sqA = square.screen({ x: 100, y: 100 })
    const sqB = square.screen({ x: 220, y: 160 })
    square.press(sqA)
    square.move(sqB, { shift: true })
    square.release(sqB)
    expectPoints(getRectangularZoneCorners(square.store.persisted.zones[0]!) ?? [], [
      { x: 100, y: 100 }, { x: 220, y: 100 }, { x: 220, y: 220 }, { x: 100, y: 220 },
    ])

    // Ellipse: free in the preview, Shift pressed before the up: still free.
    const ellipse = harness({ tool: 'ellipse' })
    const elA = ellipse.screen({ x: 100, y: 100 })
    const elB = ellipse.screen({ x: 140, y: 190 })
    ellipse.press(elA)
    ellipse.move(elB)
    ellipse.release(elB, { shift: true })
    expectPoints([ellipse.store.persisted.zones[0]!.points[1]!], [{ x: 20, y: 45 }])

    const assertLevelSegment = (h: ToolHarness, tool: 'line' | 'measurement-guide') => {
      const ends = tool === 'line'
        ? h.store.persisted.zones[0]!.points
        : [h.store.persisted.measurementGuides[0]!.start, h.store.persisted.measurementGuides[0]!.end]
      const start = h.world({ x: 100, y: 100 }), rawEnd = h.world({ x: 180, y: 106 }), endScreen = h.screen(ends[1]!)
      expectScreen(h, [ends[0]!], [{ x: 100, y: 100 }])
      expect(endScreen.y).toBeCloseTo(100, 6)
      expect(endScreen.x).toBeGreaterThan(100)
      expect(Math.hypot(ends[1]!.x - start.x, ends[1]!.y - start.y)).toBeCloseTo(Math.hypot(rawEnd.x - start.x, rawEnd.y - start.y), 6)
    }

    // Line and measure: on 45° in the preview, Shift let go before the up: still level.
    for (const tool of ['line', 'measurement-guide'] as const) {
      const h = harness({ tool })
      h.press({ x: 100, y: 100 })
      h.move({ x: 180, y: 106 }, { shift: true })
      h.release({ x: 180, y: 106 })
      assertLevelSegment(h, tool)
    }
  })

  it('Shift keeps a line and a measure on 45° steps against the screen at 30', () => {
    for (const tool of ['line', 'measurement-guide'] as const) {
      const h = harness({ tool, camera: { bearingDeg: 30 } })
      h.press({ x: 100, y: 100 })
      // 80 px right and 6 px down on screen: Shift levels it on screen, its world length kept.
      h.move({ x: 180, y: 106 }, { shift: true })
      h.release({ x: 180, y: 106 }, { shift: true })
      const ends = tool === 'line'
        ? h.store.persisted.zones[0]!.points
        : [h.store.persisted.measurementGuides[0]!.start, h.store.persisted.measurementGuides[0]!.end]
      expectScreen(h, [ends[0]!], [{ x: 100, y: 100 }])
      expect(h.screen(ends[1]!).y).toBeCloseTo(100, 6)
      expect(h.screen(ends[1]!).x).toBeGreaterThan(100)
      const start = h.world({ x: 100, y: 100 }), rawEnd = h.world({ x: 180, y: 106 })
      expect(Math.hypot(ends[1]!.x - start.x, ends[1]!.y - start.y)).toBeCloseTo(Math.hypot(rawEnd.x - start.x, rawEnd.y - start.y), 6)
    }
  })
})
