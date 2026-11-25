import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  useStubTools,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
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
  const created = createToolHarness({ tool: 'measurement-guide', ...options })
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
  useStubTools()
})

describe('Measure tool', () => {
  it('a Measure drag commits one guide and selects it', () => {
    const h = harness()

    h.drag({ x: 10, y: 20 }, { x: 40, y: 60 })

    expect(h.store.persisted.measurementGuides).toEqual([
      expect.objectContaining({ start: h.world({ x: 10, y: 20 }), end: h.world({ x: 40, y: 60 }) }),
    ])
    const guide = h.store.persisted.measurementGuides[0]!
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'measurement-guide', id: guide.id }])
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.undo()).toBe(true)
    expect(h.store.persisted.measurementGuides).toEqual([])
  })

  it('the draft is a stroke with its length chip', () => {
    const h = harness()
    const startScreen = h.screen({ x: 10, y: 20 })
    const endScreen = h.screen({ x: 40, y: 60 })
    const start = h.world(startScreen)
    const end = h.world(endScreen)

    h.press(startScreen)
    expect(h.renderer.lastDraft()).toEqual({
      shapes: [{ kind: 'polyline', points: [start, start], style: { token: 'draft', widthPx: 2 } }],
    })
    h.move(endScreen)

    expect(h.renderer.lastDraft()).toEqual({
      shapes: [
        { kind: 'polyline', points: [start, end], style: { token: 'draft', widthPx: 2 } },
        { kind: 'label', anchor: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, offsetPx: { x: 0, y: 0 }, text: '50 m', tone: 'measure-quiet' },
      ],
    })
    expect(h.store.persisted.measurementGuides).toEqual([])
  })

  it('a cancel aborts the guide and clears the draft', () => {
    const h = harness()

    h.press({ x: 10, y: 20 })
    h.move({ x: 40, y: 60 })
    h.cancel('lost-capture')

    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.store.persisted.measurementGuides).toEqual([])
    expect(h.history.canUndo.peek()).toBe(false)
  })

  it('a closed Measurements layer draws and commits nothing', () => {
    const h = harness()
    h.store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => layer.name === 'measurement-guides' ? { ...layer, visible: false } : layer)
    })

    h.drag({ x: 10, y: 20 }, { x: 40, y: 60 })

    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.store.persisted.measurementGuides).toEqual([])
  })
})
