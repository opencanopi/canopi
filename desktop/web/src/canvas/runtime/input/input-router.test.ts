import { describe, expect, it, vi } from 'vitest'
import type { GestureOutcome, InputRouterDeps, ToolHost } from '../interaction-ports'
import type { ToolHandleId } from '../interaction-types'
import type { RotationSession } from '../../../geo/view/read-surface'
import type { Gesture } from './gestures'
import { createInputRouter } from './input-router'

const MODS = { shift: false, ctrl: false, alt: false, meta: false }

const NAVIGATION_GESTURES: readonly Gesture[] = [
  { kind: 'pan', phase: 'start', deltaPx: { x: 0, y: 0 }, source: 'space-drag' },
  { kind: 'pan', phase: 'move', deltaPx: { x: 5, y: -3 }, source: 'space-drag' },
  { kind: 'pan', phase: 'end', deltaPx: { x: 0, y: 0 }, source: 'space-drag' },
  { kind: 'zoom', anchorPx: { x: 10, y: 20 }, factor: 1.2, source: 'wheel' },
  { kind: 'rotate', phase: 'start', anchorPx: { x: 10, y: 20 }, totalDeltaDeg: 0, step: false, source: 'auxiliary-drag' },
  { kind: 'rotate', phase: 'move', anchorPx: { x: 10, y: 20 }, totalDeltaDeg: 12, step: true, source: 'auxiliary-drag' },
  { kind: 'rotate', phase: 'end', anchorPx: { x: 10, y: 20 }, totalDeltaDeg: 12, step: false, source: 'auxiliary-drag' },
]

const EDITING_GESTURES: readonly Gesture[] = [
  { kind: 'hover', at: { x: 1, y: 2 }, pointer: 'mouse', mods: MODS, target: { kind: 'surface' } },
  { kind: 'hover-end' },
  { kind: 'press', id: 1, at: { x: 1, y: 2 }, pointer: 'mouse', mods: MODS, clickCount: 1, target: { kind: 'surface' } },
  { kind: 'tap', id: 1, at: { x: 1, y: 2 }, pointer: 'mouse', mods: MODS, clickCount: 1 },
  { kind: 'drag-start', id: 1, at: { x: 3, y: 4 }, mods: MODS },
  { kind: 'drag-move', id: 1, at: { x: 5, y: 6 }, mods: MODS },
  { kind: 'drag-end', id: 1, at: { x: 5, y: 6 }, mods: MODS },
  { kind: 'drop', phase: 'over', at: { x: 5, y: 6 }, payload: { kind: 'unknown' } },
  { kind: 'cancel', reason: 'escape' },
]

function harness(outcome: GestureOutcome = {}) {
  const rotation: RotationSession = { update: vi.fn(), end: vi.fn(), cancel: vi.fn() }
  const navigation = {
    panByPx: vi.fn(),
    zoomAroundPx: vi.fn(),
    beginRotation: vi.fn(() => rotation),
  }
  const gesture = vi.fn((_g: Gesture) => outcome)
  const menuAt = vi.fn(() => outcome)
  const notePointer = vi.fn()
  const toolHost = { gesture, menuAt, notePointer } as unknown as ToolHost
  const deps: InputRouterDeps = { navigation, toolHost }
  return { router: createInputRouter(deps), navigation, rotation, gesture, menuAt, notePointer }
}

describe('createInputRouter', () => {
  it('navigation never reaches tools', () => {
    const { router, navigation, rotation, gesture, menuAt } = harness()
    for (const g of NAVIGATION_GESTURES) expect(router.route(g)).toEqual({})
    expect(gesture).not.toHaveBeenCalled()
    expect(menuAt).not.toHaveBeenCalled()
    // A pan start or end carries no movement: only the move reaches the camera.
    expect(navigation.panByPx.mock.calls).toEqual([[{ x: 5, y: -3 }]])
    expect(navigation.zoomAroundPx).toHaveBeenCalledWith({ x: 10, y: 20 }, 1.2)
    expect(navigation.beginRotation).toHaveBeenCalledWith({ x: 10, y: 20 })
    expect(rotation.update).toHaveBeenCalledWith(12, { step: true, anchorPx: { x: 10, y: 20 } })
    expect(rotation.end).toHaveBeenCalledTimes(1)
  })

  it('editing never reaches navigation', () => {
    const { router, navigation, gesture } = harness()
    for (const g of EDITING_GESTURES) router.route(g)
    expect(gesture.mock.calls.map(([g]) => g)).toEqual(EDITING_GESTURES)
    expect(navigation.panByPx).not.toHaveBeenCalled()
    expect(navigation.zoomAroundPx).not.toHaveBeenCalled()
    expect(navigation.beginRotation).not.toHaveBeenCalled()
  })

  it('a pointer pan notes the pointer, a wheel pan does not', () => {
    const { router, navigation, gesture, notePointer } = harness()
    router.route({ kind: 'pan', phase: 'start', deltaPx: { x: 0, y: 0 }, source: 'auxiliary-drag', at: { x: 10, y: 10 } })
    router.route({ kind: 'pan', phase: 'move', deltaPx: { x: 4, y: 0 }, source: 'auxiliary-drag', at: { x: 14, y: 10 } })
    router.route({ kind: 'pan', phase: 'end', deltaPx: { x: 0, y: 0 }, source: 'auxiliary-drag', at: { x: 14, y: 10 } })
    router.route({ kind: 'pan', phase: 'move', deltaPx: { x: 0, y: -30 }, source: 'wheel' })
    // The resting pointer follows a pointer pan; the host re-emits it on the next camera frame, not here.
    expect(notePointer.mock.calls).toEqual([[{ x: 10, y: 10 }], [{ x: 14, y: 10 }], [{ x: 14, y: 10 }]])
    expect(navigation.panByPx.mock.calls).toEqual([[{ x: 4, y: 0 }], [{ x: 0, y: -30 }]])
    expect(gesture).not.toHaveBeenCalled()
  })

  it('route returns the host\'s outcome', () => {
    const outcome: GestureOutcome = { quarantine: true, rejectSession: true, dropEffect: 'none' }
    const { router, menuAt } = harness(outcome)
    expect(router.route(EDITING_GESTURES[2]!)).toBe(outcome)
    expect(router.route({ kind: 'menu-request', at: 'selection', source: 'keyboard' })).toBe(outcome)
    expect(menuAt).toHaveBeenCalledWith('selection', 'keyboard', undefined)
  })

  it('a menu request carries its pressed handle to the host (A16)', () => {
    const { router, menuAt, gesture } = harness()
    router.route({ kind: 'menu-request', at: { x: 4, y: 5 }, source: 'mouse', handle: 'vertex:z1:2' as ToolHandleId })
    router.route({ kind: 'menu-request', at: { x: 6, y: 7 }, source: 'long-press' })
    expect(menuAt.mock.calls).toEqual([
      [{ x: 4, y: 5 }, 'mouse', 'vertex:z1:2'],
      [{ x: 6, y: 7 }, 'long-press', undefined],
    ])
    expect(gesture).not.toHaveBeenCalled()
  })

  it('a rotate cancel restores through its session, and a new start cancels a stale one', () => {
    const { router, navigation, rotation } = harness()
    router.route({ kind: 'rotate', phase: 'start', anchorPx: { x: 0, y: 0 }, totalDeltaDeg: 0, step: false, source: 'secondary-drag' })
    router.route({ kind: 'rotate', phase: 'start', anchorPx: { x: 1, y: 1 }, totalDeltaDeg: 0, step: false, source: 'secondary-drag' })
    expect(rotation.cancel).toHaveBeenCalledTimes(1)
    router.route({ kind: 'rotate', phase: 'cancel', anchorPx: { x: 1, y: 1 }, totalDeltaDeg: 4, step: false, source: 'secondary-drag' })
    expect(rotation.cancel).toHaveBeenCalledTimes(2)
    router.route({ kind: 'rotate', phase: 'move', anchorPx: { x: 1, y: 1 }, totalDeltaDeg: 8, step: false, source: 'secondary-drag' })
    expect(rotation.update).not.toHaveBeenCalled()
    expect(navigation.beginRotation).toHaveBeenCalledTimes(2)
  })
})
