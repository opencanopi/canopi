// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubTool, useStubTools } from '../../../__tests__/support/tool-harness'
import { createInteractionDeps, makePlant } from '../../../__tests__/support/canvas-interaction-setup'
import {
  createSceneInteractionEventHarness,
  type SceneInteractionEventHarness,
} from '../../../__tests__/support/canvas-interaction-events'
import { createTestView, type TestView } from '../../../__tests__/support/test-view'
import type { CanvasFocusPort } from '../app-adapter'
import type { InputPlatform } from '../input/platform'
import type { ToolHandleId } from '../interaction-types'
import {
  createSceneInteractionSession,
  type SceneInteractionSession,
  type SceneInteractionSessionDeps,
} from '../interaction-session'
import { SceneStore } from '../scene'
import type { ToolHandle } from '../tools/draft'
import type { TextEntryRequest } from '../tools/tool'
import { expectScreenPx } from '../../../__tests__/support/camera-tolerance'

vi.mock('../tools/registry', () => ({ TOOL_REGISTRY: {} }))

const PLATFORM: InputPlatform = { os: 'linux', gestureEvents: false }
const CORNER: ToolHandle = {
  id: 'vertex:zone-1:0' as ToolHandleId,
  anchor: { x: 40, y: 60 },
  hitRadiusPx: 10,
  glyph: 'vertex',
  label: 'Zone control point 1',
}

let container: HTMLDivElement
let events: SceneInteractionEventHarness
let testView: TestView
let store: SceneStore
let sessions: SceneInteractionSession[]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  events = createSceneInteractionEventHarness(container)
  testView = createTestView({ screen: { width: 400, height: 300 }, viewport: { x: 0, y: 0, scale: 1 } })
  store = new SceneStore()
  sessions = []
})

afterEach(() => {
  for (const session of sessions.splice(0).reverse()) session.dispose()
  events.dispose()
  container.remove()
  useStubTools()
  document.documentElement.removeAttribute('data-story-presenting')
})

function createSession(overrides: Partial<SceneInteractionSessionDeps> = {}): { session: SceneInteractionSession, deps: SceneInteractionSessionDeps } {
  const deps: SceneInteractionSessionDeps = { ...createInteractionDeps(container, store, testView), platform: PLATFORM, ...overrides }
  const session = createSceneInteractionSession(deps)
  sessions.push(session)
  return { session, deps }
}

function drawnHandle(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-canvas-handle="vertex:zone-1:0"]')
}

describe('the session\'s chrome', () => {
  it('a registered tool\'s handles reach the handle layer, and the dragged one is active', () => {
    const rectangle = stubTool('rectangle', {
      activate: (ctx) => ctx.effects.setHandles([CORNER]),
    })
    useStubTools(rectangle)
    const { session } = createSession()

    session.arm('rectangle')
    const handle = drawnHandle()!
    const cornerAt = testView.view().worldToScreen(CORNER.anchor)
    expect(handle.getAttribute('aria-label')).toBe('Zone control point 1')
    expectScreenPx(handle.dataset.canvasHandleScreenX, cornerAt.x)
    expectScreenPx(handle.dataset.canvasHandleScreenY, cornerAt.y)

    events.pointerDown(cornerAt, { target: handle })
    expect(rectangle.last('handle-drag')?.handle).toBe(CORNER.id)
    expect(drawnHandle()!.dataset.canvasHandleActive).toBe('true')

    events.pointerUp(cornerAt)
    expect(drawnHandle()!.dataset.canvasHandleActive).toBeUndefined()

    session.arm('ellipse')
    expect(drawnHandle()).toBeNull()
  })

  it('a presented story shows no handles', async () => {
    useStubTools(stubTool('rectangle', { activate: (ctx) => ctx.effects.setHandles([CORNER]) }))
    const { session } = createSession()
    session.arm('rectangle')
    expect(drawnHandle()).not.toBeNull()

    // Today's CSS hid the rotation handle and the control points while a story is presented.
    document.documentElement.setAttribute('data-story-presenting', '')
    await Promise.resolve()
    expect(drawnHandle()).toBeNull()

    document.documentElement.removeAttribute('data-story-presenting')
    await Promise.resolve()
    expect(drawnHandle()).not.toBeNull()
  })

  it('a registered tool\'s text entry opens over the map and commits on the next press, which the host reads live', async () => {
    const submitted: string[] = []
    const note: TextEntryRequest = {
      anchor: { x: 30, y: 40 },
      rotationDeg: 0,
      initialText: '',
      placeholderKey: 'canvas.textNote.placeholder',
    }
    const text = stubTool('text', {
      gesture: (gesture) => {
        if (gesture.kind === 'press' && submitted.length === 0) {
          text.ctx().effects.requestTextEntry(note, (value) => {
            submitted.push(value)
            return 'close'
          })
        }
        return 'pass'
      },
    })
    useStubTools(text)
    const focus: CanvasFocusPort = { focusMap: vi.fn(() => container.focus()) }
    const { session } = createSession({ focus, translate: (key) => `en:${key}` })
    container.tabIndex = 0
    session.arm('text')

    events.pointerDown({ x: 30, y: 40 })
    events.pointerUp({ x: 30, y: 40 })
    const entry = container.querySelector<HTMLTextAreaElement>('textarea[data-canvas-text-entry]')!
    expectScreenPx(entry.style.left, testView.view().worldToScreen(note.anchor).x)
    expect(entry.placeholder).toBe('en:canvas.textNote.placeholder')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(document.activeElement).toBe(entry)
    entry.value = 'Pond edge'

    // The press moves focus to the map, and the entry commits on its blur; under Text that click places nothing
    // (spec §3.2), so the tool never hears it.
    events.pointerDown({ x: 200, y: 200 })
    expect(focus.focusMap).toHaveBeenCalledWith()
    expect(submitted).toEqual(['Pond edge'])
    expect(container.querySelector('textarea')).toBeNull()
    expect(text.count('press')).toBe(1)
  })

  it('a right or middle press on the map commits a registered tool\'s open text entry, as a left press does', () => {
    for (const button of [2, 1]) {
      const submitted: string[] = []
      const text = stubTool('text', {
        gesture: (gesture) => {
          if (gesture.kind === 'press') {
            text.ctx().effects.requestTextEntry(
              { anchor: { x: 30, y: 40 }, rotationDeg: 0, initialText: '', placeholderKey: 'canvas.textNote.placeholder' },
              (value) => {
                submitted.push(value)
                return 'close'
              },
            )
          }
          return 'pass'
        },
      })
      useStubTools(text)
      const focus: CanvasFocusPort = { focusMap: vi.fn(() => container.focus()) }
      const { session } = createSession({ focus })
      container.tabIndex = 0
      session.arm('text')
      events.pointerDown({ x: 30, y: 40 })
      events.pointerUp({ x: 30, y: 40 })
      const entry = container.querySelector<HTMLTextAreaElement>('textarea[data-canvas-text-entry]')!
      entry.value = 'Gate'

      events.pointerDown({ x: 200, y: 200 }, { button })
      expect(submitted).toEqual(['Gate'])
      expect(container.querySelector('textarea')).toBeNull()
      events.pointerUp({ x: 200, y: 200 }, { button })
      session.dispose()
    }
  })

  it('Esc in a registered tool\'s text entry closes it and tells the tool through onCancel', () => {
    const cancelled = vi.fn()
    const text = stubTool('text', {
      gesture: (gesture) => {
        if (gesture.kind === 'press') {
          text.ctx().effects.requestTextEntry({
            anchor: gesture.point.world,
            rotationDeg: 0,
            initialText: '',
            placeholderKey: 'canvas.textNote.placeholder',
          }, () => 'close', cancelled)
        }
        return 'pass'
      },
    })
    useStubTools(text)
    const { session } = createSession()
    session.arm('text')

    events.pointerDown({ x: 30, y: 40 })
    events.pointerUp({ x: 30, y: 40 })
    const entry = container.querySelector<HTMLTextAreaElement>('textarea[data-canvas-text-entry]')!
    entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    expect(container.querySelector('textarea')).toBeNull()
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('a registered tool\'s passive hover shows the plant tooltip', () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('locked-plant', 'Malus domestica', { x: 20, y: 30 }, { locked: true, commonName: 'Apple' })]
    })
    useStubTools(stubTool('rectangle'))
    const { session } = createSession()
    session.arm('rectangle')

    events.pointerMove({ x: 20, y: 30 })

    // The host's is the chrome's, and the window's tooltip layer carries one.
    expect(document.querySelectorAll('[data-hover-tooltip]')).toHaveLength(1)
    const tooltip = document.querySelector<HTMLElement>('[data-hover-card-layer] > [data-canvas-chrome="hover-tooltip"][data-hover-tooltip]')!
    expect(tooltip.style.display).toBe('block')
    expect(tooltip.textContent).toBe('AppleMalus domestica')
  })

  it('the chrome goes with the session', async () => {
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
    })
    const rectangle = stubTool('rectangle', {
      activate: (ctx) => ctx.effects.setHandles([CORNER]),
      gesture: (gesture) => {
        if (gesture.kind === 'press') {
          rectangle.ctx().effects.requestTextEntry({
            anchor: { x: 0, y: 0 }, rotationDeg: 0, initialText: '', placeholderKey: 'canvas.textNote.placeholder',
          }, () => 'close')
        }
        return 'pass'
      },
    })
    useStubTools(rectangle)
    const { session } = createSession()
    session.arm('rectangle')
    events.pointerMove({ x: 20, y: 30 })
    events.pointerDown({ x: 300, y: 200 })
    events.pointerUp({ x: 300, y: 200 })
    expect(container.querySelector('textarea')).not.toBeNull()

    session.dispose()
    sessions.length = 0

    for (const selector of ['[data-canvas-handle-layer]', 'textarea']) {
      expect(container.querySelector(selector), selector).toBeNull()
    }
    expect(document.querySelector('[data-hover-tooltip]')).toBeNull()
  })

  it('a session whose handle layer cannot be built leaves nothing behind', () => {
    const originalAppendChild = container.appendChild.bind(container)
    const appendChild = vi.spyOn(container, 'appendChild').mockImplementation(
      (<T extends Node>(node: T): T => {
        if (node instanceof HTMLElement && node.dataset.canvasHandleLayer === 'true') throw new Error('handle layer failed')
        return originalAppendChild(node) as T
      }) as typeof container.appendChild,
    )

    try {
      expect(() => createSession()).toThrow('handle layer failed')
    } finally {
      appendChild.mockRestore()
    }

    expect(container.children).toHaveLength(0)
  })
})
