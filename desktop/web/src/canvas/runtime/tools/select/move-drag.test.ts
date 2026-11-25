import { afterEach, describe, expect, it } from 'vitest'
import {
  createToolHarness,
  plantEntity,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../../__tests__/support/tool-harness'
import type { SceneDesignObjectTarget } from '../../scene/design-object-targets'
import '../../../../__tests__/support/camera-tolerance'

const harnesses: ToolHarness[] = []

function harness(options: ToolHarnessOptions = {}): ToolHarness {
  const created = createToolHarness(options)
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
})

const plant = (id: string): SceneDesignObjectTarget => ({ kind: 'plant', id })

describe('Select move-drag', () => {
  it('a drag from a selected object moves the selection with one undo', () => {
    const h = harness({
      scene: {
        plants: [
          plantEntity('a', 'Malus domestica', { x: 50, y: 50 }),
          plantEntity('b', 'Pyrus communis', { x: 80, y: 50 }),
          plantEntity('c', 'Prunus avium', { x: 300, y: 250 }),
        ],
      },
    })
    h.select(plant('a'), plant('b'))

    h.press(h.screen({ x: 50, y: 50 }))
    // Handles and the passive hover give way to the move, whose one Scene Edit opens at the press.
    expect(h.record.guidance.at(-1)).toMatchObject({ gesture: false })
    h.move(h.screen({ x: 60, y: 55 }))
    h.move(h.screen({ x: 70, y: 65 }))
    h.release()

    expect(h.store.persisted.plants.map((entry) => entry.position)).toEqual([
      { x: expect.closeTo(70, 9), y: expect.closeTo(65, 9) },
      { x: expect.closeTo(100, 9), y: expect.closeTo(65, 9) },
      { x: 300, y: 250 },
    ])
    expect(h.store.session.selectedTargets).toEqual([plant('a'), plant('b')])
    expect(h.undo()).toBe(true)
    expect(h.store.persisted.plants.map((entry) => entry.position)).toEqual([
      { x: 50, y: 50 },
      { x: 80, y: 50 },
      { x: 300, y: 250 },
    ])
    expect(h.history.canUndo.value).toBe(false)
  })

  it('the move snaps the dragged object, not the pointer', () => {
    // At 4 px/m the grid is 5 m. The press is a quarter metre off the plant; the plant, not the pointer, lands on the grid.
    const h = harness({
      viewport: { x: 0, y: 0, scale: 4 },
      snapping: { grid: true },
      scene: {
        plants: [
          plantEntity('a', 'Malus domestica', { x: 50, y: 50 }),
          plantEntity('b', 'Pyrus communis', { x: 70, y: 60 }),
        ],
      },
    })

    h.press({ x: 201, y: 202 })
    h.move({ x: 232, y: 248 })
    // The dragged plant's distance to the nearest plant left behind.
    expect(h.renderer.lastDraft()?.shapes.flatMap((shape) => (shape.kind === 'label' ? [shape.text] : []))).toEqual(['10 m'])
    h.release()

    expect(h.store.persisted.plants[0]!.position).toEqual({ x: 60, y: 60 })
    expect(h.renderer.lastDraft()).toBeNull()
  })

  it('a press that does not move rolls the drag back with no history', () => {
    const h = harness({ scene: { plants: [plantEntity('a', 'Malus domestica', { x: 50, y: 50 })] } })

    h.click({ x: 50, y: 50 })

    expect(h.store.session.selectedTargets).toEqual([plant('a')])
    expect(h.store.persisted.plants[0]!.position).toEqual({ x: 50, y: 50 })
    expect(h.history.canUndo.value).toBe(false)
    expect(h.host.hasLiveGesture()).toBe(false)
  })
})
