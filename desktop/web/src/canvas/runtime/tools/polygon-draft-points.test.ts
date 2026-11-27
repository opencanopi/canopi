// Behavioural tests for 2.1-Q88: Polygon and Profile drafting points follow Plant a row's grammar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  stubTool,
  useStubTools,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
import type { ToolHandleId } from '../interaction-types'
import type { WorldPoint } from '../../../geo/view/types'
import type { DraftShape } from './draft'
import { createPolygonTool } from './polygon'
import { createProfileLineTool } from './profile-line'

vi.mock('./registry', () => ({ TOOL_REGISTRY: {} }))

const harnesses: ToolHarness[] = []
let activePolygonTool = createPolygonTool()

beforeEach(() => {
  activePolygonTool = createPolygonTool()
  useStubTools(activePolygonTool, createProfileLineTool(), stubTool('select'))
})

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
  useStubTools()
})

function harness(options: ToolHarnessOptions = {}): ToolHarness {
  const tool = options.tool ?? 'polygon'
  const created = createToolHarness({ tool, ...options })
  created.arm(tool)
  harnesses.push(created)
  return created
}

function shapes(h: ToolHarness): readonly DraftShape[] {
  return h.renderer.lastDraft()?.shapes ?? []
}

function cornerMarkers(h: ToolHarness): WorldPoint[] {
  return shapes(h).flatMap((shape) => shape.kind === 'circle-px' ? [shape.center] : [])
}

function handleIds(h: ToolHarness): ToolHandleId[] {
  return h.chrome.handles.map((handle) => handle.id)
}

describe('Polygon and Profile draft points follow Plant a row grammar (2.1-Q88)', () => {
  it('exposes point handles and midpoint dot handles while drafting and clears them on finish', () => {
    const h = harness()
    expect(handleIds(h)).toEqual([])

    h.click({ x: 10, y: 10 })
    expect(handleIds(h)).toEqual(['point:draft:0'])

    h.click({ x: 110, y: 10 })
    expect(handleIds(h)).toEqual(['point:draft:0', 'point:draft:1', 'dot:draft:0'])
    const dot0 = h.chrome.handles.find((handle) => handle.id === 'dot:draft:0')!
    const expectedMid = h.world({ x: 60, y: 10 })
    expect(dot0.anchor.x).toBeCloseTo(expectedMid.x, 9)
    expect(dot0.anchor.y).toBeCloseTo(expectedMid.y, 9)

    h.click({ x: 110, y: 110 })
    expect(handleIds(h)).toEqual([
      'point:draft:0',
      'point:draft:1',
      'point:draft:2',
      'dot:draft:0',
      'dot:draft:1',
    ])

    expect(h.host.command({ kind: 'confirm' })).toBe('handled')
    expect(h.store.persisted.zones).toHaveLength(1)
    expect(handleIds(h)).toEqual([])
  })

  it('dragging a drafted point handle moves the vertex and undo/redo steps back the last point (2.1-Q88)', () => {
    const h = harness()
    h.click({ x: 10, y: 10 })
    h.click({ x: 110, y: 10 })
    h.click({ x: 110, y: 110 })

    const point1 = 'point:draft:1' as ToolHandleId
    h.drag({ x: 110, y: 10 }, { x: 150, y: 30 }, { target: { kind: 'handle', id: point1 } })

    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 150, y: 30 }),
      h.world({ x: 110, y: 110 }),
    ])
    expect(h.host.transientHistory.canUndo()).toBe(true)

    // Anchors model: undo removes the last drafted point; redo restores it.
    expect(h.host.command({ kind: 'undo-transient' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 150, y: 30 }),
    ])
    expect(h.host.transientHistory.canRedo()).toBe(true)

    expect(h.host.command({ kind: 'redo-transient' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 150, y: 30 }),
      h.world({ x: 110, y: 110 }),
    ])

    expect(h.host.command({ kind: 'confirm' })).toBe('handled')
    expect(h.store.persisted.zones[0]!.points).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 150, y: 30 }),
      h.world({ x: 110, y: 110 }),
    ])
  })

  it('dragging a midpoint dot handle inserts a new vertex on the segment', () => {
    const h = harness()
    h.click({ x: 10, y: 10 })
    h.click({ x: 110, y: 10 })
    h.click({ x: 110, y: 110 })

    const dot0 = 'dot:draft:0' as ToolHandleId
    h.drag({ x: 60, y: 10 }, { x: 60, y: 40 }, { target: { kind: 'handle', id: dot0 } })

    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 60, y: 40 }),
      h.world({ x: 110, y: 10 }),
      h.world({ x: 110, y: 110 }),
    ])

    expect(h.host.command({ kind: 'undo-transient' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 60, y: 40 }),
      h.world({ x: 110, y: 10 }),
    ])

    expect(h.host.command({ kind: 'redo-transient' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 60, y: 40 }),
      h.world({ x: 110, y: 10 }),
      h.world({ x: 110, y: 110 }),
    ])
  })

  it('deletes a drafted point via point menu (disabled at 1 point), Delete on focused handle, and Alt+click', () => {
    const h = harness()
    h.click({ x: 10, y: 10 })

    // With 1 point, point menu disables delete-point and dot handles return empty menu.
    expect(activePolygonTool.pointMenu?.('point:draft:0' as ToolHandleId)).toEqual([{ action: 'delete-point', disabled: true }])
    expect(activePolygonTool.pointMenu?.('dot:draft:0' as ToolHandleId)).toEqual([])
    expect(h.host.command({ kind: 'point-action', handle: 'point:draft:0' as ToolHandleId, action: 'delete-point' })).toBe('pass')

    h.click({ x: 110, y: 10 })
    h.click({ x: 110, y: 110 })
    h.click({ x: 10, y: 110 })

    // Point menu on point 1 enables delete-point and point-action deletes it.
    const point1 = 'point:draft:1' as ToolHandleId
    expect(activePolygonTool.pointMenu?.(point1)).toEqual([{ action: 'delete-point', disabled: false }])
    expect(h.host.command({ kind: 'point-action', handle: point1, action: 'delete-point' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 110, y: 110 }),
      h.world({ x: 10, y: 110 }),
    ])

    // Focused Delete removes the focused handle.
    h.chrome.focusedHandle = point1
    expect(h.host.command({ kind: 'delete-handle' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 10, y: 110 }),
    ])
    h.chrome.focusedHandle = null

    // Alt+click within CLOSE_DISTANCE_PX deletes point 1 (10, 110).
    h.click({ x: 13, y: 107 }, { mods: { alt: true } })
    expect(cornerMarkers(h)).toEqual([h.world({ x: 10, y: 10 })])

    // Alt+click on the only remaining point refuses to delete it.
    h.click({ x: 10, y: 10 }, { mods: { alt: true }, target: { kind: 'handle', id: 'point:draft:0' as ToolHandleId } })
    expect(cornerMarkers(h)).toEqual([h.world({ x: 10, y: 10 })])
  })

  it('Profile tool shares the same drafted point and midpoint dot handle grammar', () => {
    const h = harness({ tool: 'profile' })
    h.click({ x: 10, y: 10 })
    h.click({ x: 110, y: 10 })
    expect(handleIds(h)).toEqual(['point:draft:0', 'point:draft:1', 'dot:draft:0'])

    h.drag({ x: 60, y: 10 }, { x: 60, y: 50 }, { target: { kind: 'handle', id: 'dot:draft:0' as ToolHandleId } })
    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 60, y: 50 }),
      h.world({ x: 110, y: 10 }),
    ])

    // Undo/redo steps back the last point on Profile drafts too.
    expect(h.host.command({ kind: 'undo-transient' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 50 })])
    expect(h.host.command({ kind: 'redo-transient' })).toBe('handled')
    expect(cornerMarkers(h)).toEqual([
      h.world({ x: 10, y: 10 }),
      h.world({ x: 60, y: 50 }),
      h.world({ x: 110, y: 10 }),
    ])

    expect(h.host.command({ kind: 'confirm' })).toBe('handled')
    expect(h.renderer.lastDraft()).toBeNull()
    expect(handleIds(h)).toEqual([])
  })
})
