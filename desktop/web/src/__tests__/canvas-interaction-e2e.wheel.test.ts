// @vitest-environment jsdom

// The canvas interaction end to end through the session, split by the first tool a test arms (canvas v2 plan §4):
// tests that arm no tool and drive the wheel, and the Scroll wheel settings describe.
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { describe, expect, it, vi } from 'vitest'
import type { SceneStore } from '../canvas/runtime/scene'
import type { SceneInteractionSessionDeps } from '../canvas/runtime/interaction-session'
import type { SceneInteractionEventHarness } from './support/canvas-interaction-events'
import type { TestView } from './support/test-view'
import {
  contextMenuHost,
  createInteractionDeps,
  expectPointCloseTo,
  installSceneInteractionFixture,
  enterOverview,
} from './support/canvas-interaction-setup'
import './support/camera-tolerance'

describe('SceneInteractionSession', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness

  const { createTestSession, openContextMenu } = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )

  it('closes the context menu on a map press, wheel, overview and document replacement', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))

    openContextMenu({ x: 200, y: 180 })
    expect(contextMenuHost.current).not.toBeNull()
    events.pointerDown({ x: 20, y: 20 })
    expect(contextMenuHost.current).toBeNull()
    events.pointerUp({ x: 20, y: 20 })

    openContextMenu({ x: 200, y: 180 })
    events.wheel({ x: 200, y: 180 }, { deltaY: 10 })
    expect(contextMenuHost.current).toBeNull()

    openContextMenu({ x: 200, y: 180 })
    session.prepareForDocumentReplacement()
    expect(contextMenuHost.current).toBeNull()

    openContextMenu({ x: 200, y: 180 })
    const leaveOverview = enterOverview(testView)
    expect(contextMenuHost.current).toBeNull()
    const overviewContext = openContextMenu({ x: 200, y: 180 })
    expect(overviewContext.defaultPrevented).toBe(true)
    expect(contextMenuHost.current).toBeNull()

    leaveOverview()
    openContextMenu({ x: 200, y: 180 })
    session.dispose()
    expect(contextMenuHost.current).toBeNull()
  })

  it('zooms with an unmodified mouse wheel around the pointer without changing Design content', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    const pointer = { x: 200, y: 150 }
    const anchor = testView.view().screenToWorld(pointer)
    const scene = structuredClone(store.persisted)

    events.wheel(pointer, { deltaY: -120 })
    expect(testView.viewport().scale).toBeCloseTo(1.271249, 6)
    expectPointCloseTo(testView.view().screenToWorld(pointer), anchor)
    events.wheel(pointer, { deltaY: 120 })
    expect(testView.viewport().scale).toBeCloseTo(1, 10)
    expectPointCloseTo(testView.view().screenToWorld(pointer), anchor)
    expect(store.persisted).toEqual(scene)
    session.dispose()
  })

  it('pans both axes with Shift scrolling without changing scale or Design content', () => {
    const render = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { render })
    const session = createTestSession(deps)
    const before = testView.viewport()
    const scene = structuredClone(store.persisted)
    const wheel = events.wheel({ x: 200, y: 150 }, { deltaX: 24, deltaY: -40, shiftKey: true })

    expect(wheel.defaultPrevented).toBe(true)
    expect(testView.viewport()).toEqual({ x: before.x - 24, y: before.y + 40, scale: before.scale })
    expect(store.persisted).toEqual(scene)
    expect(render, 'its camera frame repaints the layer, not the session').not.toHaveBeenCalled()
    session.dispose()
  })

  it.each([
    { ctrlKey: true }, { metaKey: true },
    { ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true },
  ])('zooms proportionally around the pointer with modifiers %j', (modifiers) => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    const pointer = { x: 200, y: 150 }
    const anchor = testView.view().screenToWorld(pointer)

    events.wheel(pointer, { deltaY: -1, ...modifiers })
    expect(testView.viewport().scale).toBeCloseTo(1.002002, 6)
    expectPointCloseTo(testView.view().screenToWorld(pointer), anchor)
    events.wheel(pointer, { deltaY: -119, ...modifiers })
    expect(testView.viewport().scale).toBeCloseTo(1.271249, 6)
    expectPointCloseTo(testView.view().screenToWorld(pointer), anchor)
    events.wheel(pointer, { deltaY: 120, ...modifiers })
    expect(testView.viewport().scale).toBeCloseTo(1, 10)
    expectPointCloseTo(testView.view().screenToWorld(pointer), anchor)
    session.dispose()
  })

  it.each([
    { mode: 1, x: 2, y: -3, expected: { x: -32, y: 48, scale: 1 } },
    { mode: 2, x: 0.25, y: -0.5, expected: { x: -100, y: 150, scale: 1 } },
  ])('normalizes Shift pan units for deltaMode $mode', ({ mode, x, y, expected }) => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    events.wheel({ x: 200, y: 150 }, { deltaMode: mode, deltaX: x, deltaY: y, shiftKey: true })
    expect(testView.viewport()).toEqual(expected)
    session.dispose()
  })

  it.each([
    { mode: 0, deltaY: -48 },
    { mode: 1, deltaY: -3 },
    { mode: 2, deltaY: -0.16 },
  ])('normalizes unmodified wheel zoom units for deltaMode $mode', ({ mode, deltaY }) => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    const pointer = { x: 200, y: 150 }
    const anchor = testView.view().screenToWorld(pointer)
    events.wheel(pointer, { deltaMode: mode, deltaY })
    expect(testView.viewport().scale).toBeCloseTo(1.100759, 6)
    expectPointCloseTo(testView.view().screenToWorld(pointer), anchor)
    session.dispose()
  })

  it('ignores empty or nonfinite wheel input without publishing or rendering', () => {
    const render = vi.fn()
    const session = createTestSession(createInteractionDeps(container, store, testView, { render }))
    const before = testView.frames.viewFrame.peek()
    render.mockClear()
    for (const input of [
      { deltaY: 0 }, { deltaY: 0, ctrlKey: true }, { deltaY: 0, shiftKey: true },
      { deltaX: 24, deltaY: 0 },
      { deltaX: Number.MAX_VALUE, deltaMode: 2 }, { deltaY: Number.MAX_VALUE, deltaMode: 1, ctrlKey: true },
    ]) events.wheel({ x: 200, y: 150 }, input)
    expect(testView.frames.viewFrame.peek()).toBe(before)
    expect(render).not.toHaveBeenCalled()
    session.dispose()
  })

  it('bounds unusually large zoom gestures and avoids rendering beyond the precision limit', () => {
    const render = vi.fn()
    const session = createTestSession(createInteractionDeps(container, store, testView, { render }))
    const point = { x: 200, y: 150 }
    events.wheel(point, { deltaY: -10000, ctrlKey: true })
    expect(testView.viewport().scale).toBeCloseTo(2.718282, 6)
    testView.setViewport({ x: 0, y: 0, scale: testView.frames.viewFrame.peek().scaleBounds.max })
    const before = testView.frames.viewFrame.peek()
    render.mockClear()
    events.wheel(point, { deltaY: -120, ctrlKey: true })
    expect(testView.frames.viewFrame.peek()).toBe(before)
    expect(render).not.toHaveBeenCalled()
    session.dispose()
  })

  it('leaves editor scrolling alone and releases wheel ownership on disposal', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    const textarea = document.createElement('textarea')
    container.appendChild(textarea)
    const before = testView.frames.viewFrame.peek()
    const wheel = new WheelEvent('wheel', { deltaY: 30, bubbles: true, cancelable: true })
    textarea.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
    expect(testView.frames.viewFrame.peek()).toBe(before)
    session.dispose()
    const afterDispose = events.wheel({ x: 200, y: 150 }, { deltaY: -120, ctrlKey: true })
    expect(afterDispose.defaultPrevented).toBe(false)
    expect(testView.frames.viewFrame.peek()).toBe(before)
  })

  it('publishes wheel zoom once through the camera, whose frame is the only repaint', () => {
    const render = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { render })
    const session = createTestSession(deps)
    const published: unknown[] = []
    const stop = testView.frames.onViewFrame('tools', (frame) => { published.push(frame) })

    const wheel = events.wheel({ x: 200, y: 150 }, { deltaY: -120, ctrlKey: true })

    expect(wheel.defaultPrevented).toBe(true)
    expect(published).toHaveLength(1)
    stop()
    expect(render, 'its camera frame repaints the layer, not the session').not.toHaveBeenCalled()
    session.dispose()
  })

  describe('Settings › Canvas › Scroll wheel', () => {
    function wheelSession(scrollWheel: 'zoom' | 'pan') {
      const navigation = {
        panByPx: vi.spyOn(testView.navigation, 'panByPx').mockImplementation(() => {}),
        zoomAroundPx: vi.spyOn(testView.navigation, 'zoomAroundPx').mockImplementation(() => {}),
      }
      const deps: SceneInteractionSessionDeps = {
        ...createInteractionDeps(container, store, testView),
        readScrollWheel: () => scrollWheel,
      }
      return { navigation, session: createTestSession(deps) }
    }
    const pointer = { x: 200, y: 150 }

    it.each([
      { input: { deltaY: -120 }, expects: 'zoom' },
      { input: { deltaX: 24, deltaY: -40, shiftKey: true }, expects: 'pan' },
      { input: { deltaY: -120, ctrlKey: true }, expects: 'zoom' },
      { input: { deltaY: -120, ctrlKey: true, shiftKey: true }, expects: 'zoom' },
    ])('with Zooms the map, $input $expects', ({ input, expects }) => {
      const { navigation, session } = wheelSession('zoom')
      const wheel = events.wheel(pointer, input)
      expect(wheel.defaultPrevented).toBe(true)
      if (expects === 'zoom') {
        expect(navigation.zoomAroundPx).toHaveBeenCalledExactlyOnceWith(pointer, expect.closeTo(1.271249, 6))
        expect(navigation.panByPx).not.toHaveBeenCalled()
      } else {
        expect(navigation.panByPx).toHaveBeenCalledExactlyOnceWith({ x: -24, y: 40 })
        expect(navigation.zoomAroundPx).not.toHaveBeenCalled()
      }
      session.dispose()
    })

    it.each([
      { input: { deltaX: 24, deltaY: -40 }, expects: 'pan', delta: { x: -24, y: 40 } },
      { input: { deltaY: -40, shiftKey: true }, expects: 'pan', delta: { x: 40, y: 0 } },
      { input: { deltaX: 24, deltaY: -40, shiftKey: true }, expects: 'pan', delta: { x: -24, y: 40 } },
      { input: { deltaY: -120, ctrlKey: true }, expects: 'zoom' },
      { input: { deltaY: -120, metaKey: true, shiftKey: true }, expects: 'zoom' },
    ])('with Pans the map, $input $expects', ({ input, expects, delta }) => {
      const { navigation, session } = wheelSession('pan')
      const wheel = events.wheel(pointer, input)
      expect(wheel.defaultPrevented).toBe(true)
      if (expects === 'zoom') {
        expect(navigation.zoomAroundPx).toHaveBeenCalledExactlyOnceWith(pointer, expect.closeTo(1.271249, 6))
        expect(navigation.panByPx).not.toHaveBeenCalled()
      } else {
        expect(navigation.panByPx).toHaveBeenCalledExactlyOnceWith(delta)
        expect(navigation.zoomAroundPx).not.toHaveBeenCalled()
      }
      session.dispose()
    })

    it('pans on a plain scroll through the camera, whose frame is the only repaint', () => {
      const render = vi.fn()
      const deps: SceneInteractionSessionDeps = {
        ...createInteractionDeps(container, store, testView, { render }),
        readScrollWheel: () => 'pan',
      }
      const session = createTestSession(deps)
      const before = testView.viewport()
      const scene = structuredClone(store.persisted)

      events.wheel(pointer, { deltaX: 12, deltaY: 30 })

      expect(testView.viewport()).toEqual({ x: before.x - 12, y: before.y - 30, scale: before.scale })
      expect(store.persisted).toEqual(scene)
      expect(render, 'its camera frame repaints the layer, not the session').not.toHaveBeenCalled()
      session.dispose()
    })
  })
})
