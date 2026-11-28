import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createToolHarness,
  plantEntity,
  stubTool,
  useStubTools,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
import type { SceneDesignObjectTarget } from '../scene/design-object-targets'
import type { WorldPoint } from '../../../geo/view/types'
import type { DraftShape } from './draft'
import { createProfileLineTool } from './profile-line'
import '../../../__tests__/support/camera-tolerance'

vi.mock('./registry', () => ({ TOOL_REGISTRY: {} }))

const harnesses: ToolHarness[] = []

beforeEach(() => {
  useStubTools(createProfileLineTool(), stubTool('select'))
})

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
  useStubTools()
})

function harness(options: ToolHarnessOptions = {}): { h: ToolHarness; finishProfile: ReturnType<typeof vi.fn> } {
  const finishProfile = vi.fn()
  const h = createToolHarness({ tool: 'profile', finishProfile, ...options })
  harnesses.push(h)
  return { h, finishProfile }
}

function shapes(h: ToolHarness): readonly DraftShape[] {
  return h.renderer.lastDraft()?.shapes ?? []
}

function band(h: ToolHarness): readonly WorldPoint[] | null {
  const line = shapes(h).find((shape) => shape.kind === 'polyline')
  return line?.kind === 'polyline' ? line.points : null
}

function vertices(h: ToolHarness): WorldPoint[] {
  return shapes(h).flatMap((shape) => shape.kind === 'circle-px' ? [shape.center] : [])
}

function chipTexts(h: ToolHarness): string[] {
  return shapes(h).flatMap((shape) => shape.kind === 'label' ? [shape.text] : [])
}

describe('Profile tool', () => {
  it('each press adds a point; the second press of a double-click finishes with 2, hands the line over and arms Select', () => {
    const { h, finishProfile } = harness()

    // One point: the second press of a double-click adds nothing and finishes nothing.
    h.click({ x: 10, y: 10 })
    h.click({ x: 10, y: 10 }, { clickCount: 2 })
    expect(vertices(h)).toEqual([h.world({ x: 10, y: 10 })])
    expect(finishProfile).not.toHaveBeenCalled()

    // The first press of the double-click adds the second point; its second finishes.
    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 10 }, { clickCount: 2 })

    expect(finishProfile).toHaveBeenCalledTimes(1)
    expect(finishProfile).toHaveBeenCalledWith([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 10 })])
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.toolState.value).toBe('select')
  })

  it('a finger\'s double tap finishes as a double-click does', () => {
    const { h, finishProfile } = harness()

    h.click({ x: 10, y: 10 }, { pointer: 'touch' })
    h.click({ x: 60, y: 30 }, { pointer: 'touch' })
    h.click({ x: 62, y: 31 }, { pointer: 'touch', clickCount: 2 })

    expect(finishProfile).toHaveBeenCalledWith([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 30 })])
    expect(h.toolState.value).toBe('select')
  })

  it('Enter finishes with 2 points or more; with 1 it waits', () => {
    const { h, finishProfile } = harness()
    expect(h.host.command({ kind: 'confirm' })).toBe('pass')

    h.click({ x: 10, y: 10 })
    expect(h.host.command({ kind: 'confirm' })).toBe('handled')
    expect(finishProfile).not.toHaveBeenCalled()

    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 50 })
    expect(h.host.command({ kind: 'confirm' })).toBe('handled')

    expect(finishProfile).toHaveBeenCalledWith([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 10 }), h.world({ x: 60, y: 50 })])
    expect(h.toolState.value).toBe('select')
  })

  it('Finish shape leads the menu from 2 points', () => {
    const { h, finishProfile } = harness()
    h.click({ x: 10, y: 10 })
    h.menu({ x: 200, y: 200 })
    expect(h.record.menus.at(-1)?.finishShape).toBeUndefined()

    h.click({ x: 60, y: 10 })
    h.menu({ x: 200, y: 200 })
    h.record.menus.at(-1)!.finishShape!()

    expect(finishProfile).toHaveBeenCalledWith([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 10 })])
  })

  it('a press on the first point adds a point: a profile never closes', () => {
    const { h, finishProfile } = harness()
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 50 })

    h.click({ x: 10, y: 10 })

    expect(vertices(h)).toEqual([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 10 }), h.world({ x: 60, y: 50 }), h.world({ x: 10, y: 10 })])
    expect(finishProfile).not.toHaveBeenCalled()
  })

  it('Alt+click on a placed point deletes it (Polygon\'s rule)', () => {
    const { h, finishProfile } = harness()
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.click({ x: 60, y: 50 })

    h.click({ x: 57, y: 13 }, { mods: { alt: true } })
    expect(vertices(h)).toEqual([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 50 })])
    expect(finishProfile).not.toHaveBeenCalled()
  })

  it('Backspace and Undo take the last point back; Redo restores it', () => {
    const { h } = harness()
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.hover({ x: 60, y: 50 })

    expect(h.host.command({ kind: 'remove-last' })).toBe('handled')
    expect(band(h)).toEqual([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 50 })])
    expect(h.host.transientHistory.redo()).toBe(true)
    expect(vertices(h)).toEqual([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 10 })])

    expect(h.host.transientHistory.undo()).toBe(true)
    expect(h.host.transientHistory.undo()).toBe(true)
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.host.command({ kind: 'remove-last' })).toBe('pass')
    expect(h.history.canUndo.peek()).toBe(false)
  })

  it('Esc steps the draft back point by point, then passes so the tool layer leaves (spec §3.7, A17)', () => {
    const { h, finishProfile } = harness()
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })

    expect(h.host.activeToolHasEscapeTransient()).toBe(true)
    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    // One point left; the rubber band still runs from it to the resting pointer.
    expect(band(h)).toEqual([h.world({ x: 10, y: 10 }), h.world({ x: 60, y: 10 })])
    expect(h.host.activeToolHasEscapeTransient()).toBe(true)
    expect(h.host.command({ kind: 'escape' })).toBe('handled')
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.host.activeToolHasEscapeTransient()).toBe(false)
    expect(h.host.command({ kind: 'escape' })).toBe('pass')
    expect(finishProfile).not.toHaveBeenCalled()
  })

  it('draws the rubber band, a disc per point and one chip per segment: no fill, closing edge or area', () => {
    const { h } = harness()
    const [s1, s2, s3, s4] = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 50 }, { x: 10, y: 50 }].map((p) => h.screen(p))
    for (const pt of [s1!, s2!, s3!]) h.click(pt)
    h.hover(s4!)

    const points = [s1!, s2!, s3!].map((pt) => h.world(pt))
    expect(shapes(h).slice(0, 4)).toEqual([
      { kind: 'polyline', points: [...points, h.world(s4!)], style: { token: 'draft', widthPx: 2 } },
      ...points.map((center) => ({ kind: 'circle-px', center, radiusPx: 1.75, style: { token: 'draft', widthPx: 3.5 } })),
    ])
    expect(shapes(h).some((shape) => shape.kind === 'polygon')).toBe(false)
    expect(chipTexts(h)).toEqual(['50 m', '40 m', '50 m'])
  })

  it('a Shift point keeps the new segment on 45° from the last point, on screen at bearing 30', () => {
    const { h } = harness({ camera: { bearingDeg: 30 } })

    h.click({ x: 100, y: 100 })
    h.click({ x: 150, y: 104 }, { mods: { shift: true } })

    const [a, b] = vertices(h)
    const screenA = h.screen(a!), screenB = h.screen(b!), target = h.world({ x: 150, y: 104 })
    expect(screenB.y).toBeCloseTo(screenA.y, 6)
    expect(screenB.x).toBeGreaterThan(screenA.x)
    const snappedLen = Math.hypot(b!.x - a!.x, b!.y - a!.y), rawLen = Math.hypot(target.x - a!.x, target.y - a!.y)
    expect(snappedLen).toBeCloseTo(rawLen, 6)
  })

  it('points snap to the grid', () => {
    const { h } = harness({ snapping: { grid: true } })
    h.click({ x: 21, y: 19 })
    h.click({ x: 99, y: 22 })
    expect(vertices(h)).toEqual([{ x: 20, y: 20 }, { x: 100, y: 20 }])
  })

  it('never selects, deselects or edits the Design', () => {
    const plant: SceneDesignObjectTarget = { kind: 'plant', id: 'p1' }
    const { h } = harness({ scene: { plants: [plantEntity('p1', 'Malus domestica', { x: 150, y: 150 })] } })
    h.select(plant)
    const selections = h.record.selections.length

    h.click({ x: 150, y: 150 })
    h.click({ x: 60, y: 10 })
    h.host.command({ kind: 'confirm' })

    expect(h.record.selections).toHaveLength(selections)
    expect(h.store.session.selectedTargets).toEqual([plant])
    expect(h.store.persisted.zones).toEqual([])
    expect(h.history.canUndo.peek()).toBe(false)
  })

  it('a draft holds re-origin until it finishes; a window blur keeps it, overview drops it', () => {
    const { h } = harness()
    expect(h.host.holdsReorigin()).toBe(false)

    h.click({ x: 10, y: 10 })
    expect(h.host.holdsReorigin()).toBe(true)
    h.blur()
    expect(vertices(h)).toEqual([h.world({ x: 10, y: 10 })])
    h.view.setViewport({ x: 200, y: 150, scale: 0.05 })
    expect(h.renderer.lastDraft()).toBeNull()
    expect(h.host.holdsReorigin()).toBe(false)

    h.view.setViewport({ x: 0, y: 0, scale: 1 })
    h.click({ x: 10, y: 10 })
    h.click({ x: 60, y: 10 })
    h.host.command({ kind: 'confirm' })
    expect(h.host.holdsReorigin()).toBe(false)
  })
})
