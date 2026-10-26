// @vitest-environment jsdom

// The canvas interaction end to end through the session, split by the first tool a test arms (canvas v2 plan §4):
// tests that arm Pan, or arm no tool and assert listener installation or removal,
// and the tool guidance describe.
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import { writePlantStampDragData } from '../canvas/plant-stamp-source'
import { writeSavedObjectStampDragData } from '../canvas/saved-object-stamp-source'
import { currentCanvasSelection, type CanvasToolGuidance } from '../canvas/session-state'
import type { SceneStore } from '../canvas/runtime/scene'
import {
  createSceneInteractionSession,
  type SceneInteractionSession,
  type SceneInteractionSessionDeps,
} from '../canvas/runtime/interaction-session'
import type { SettledSceneReader } from '../canvas/runtime/scene-runtime/transactions'
import {
  createSceneInteractionEventHarness,
  type SceneInteractionEventHarness,
} from './support/canvas-interaction-events'
import {
  createInteractionDeps,
  captureWindowErrors,
  makePlant,
  installSceneInteractionFixture,
} from './support/canvas-interaction-setup'
import type { TestView } from './support/test-view'

describe('SceneInteractionSession', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness

  const { createTestSession } = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )

  it('does not run Species Selection outside the Select tool', () => {
    store.updatePersisted((draft) => {
      draft.plants = [
        makePlant('apple-1', 'Malus domestica', { x: 20, y: 30 }),
        makePlant('apple-2', 'Malus domestica', { x: 80, y: 30 }),
      ]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('hand')

    events.pointerDown({ x: 20, y: 30 }, { button: 0, detail: 2 })
    events.pointerUp({ x: 20, y: 30 }, { button: 0, detail: 2 })

    expect(currentCanvasSelection.value).toEqual(new Set())
    expect(deps.setSelection).not.toHaveBeenCalled()
    session.dispose()
  })

  it('clears accepted dragover feedback and reaches the app when the settled read fails', () => {
    const settledReadFailure = new Error('dragover settled read failed')
    let failRead = false
    const settledReader: SettledSceneReader = {
      revision: signal(0),
      readWhenSettled<T>(operation: () => T): T {
        if (failRead) throw settledReadFailure
        return operation()
      },
    }
    const deps = createInteractionDeps(container, store, testView, { settledReader })
    const session = createTestSession(deps)
    const dragData = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() {
        return Array.from(dragData.keys())
      },
      setData(type: string, value: string) {
        dragData.set(type, value)
      },
      getData(type: string) {
        return dragData.get(type) ?? ''
      },
    }
    writePlantStampDragData(dataTransfer, {
      canonical_name: 'Pyrus communis',
      common_name: 'Pear',
      stratum: 'mid',
      width_max_m: 3,
    })
    const dragOverEvent = () => {
      const event = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
      Object.defineProperties(event, {
        clientX: { configurable: true, value: 80 },
        clientY: { configurable: true, value: 90 },
        dataTransfer: { configurable: true, value: dataTransfer },
      })
      return event
    }
    // The drop preview is the host's draft (spec §1.4 "Drops"): a species' band cue, a saved stamp's ghosts.
    const previewKinds = () => deps.renderer.lastDraft()?.shapes.map((shape) => shape.kind) ?? []

    container.dispatchEvent(dragOverEvent())
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(previewKinds()).toEqual(['quad'])

    failRead = true
    const downstreamDragOver = vi.fn()
    container.addEventListener('dragover', downstreamDragOver)
    const rejectedDragOver = dragOverEvent()
    const errors = captureWindowErrors(() => {
      container.dispatchEvent(rejectedDragOver)
    })

    // A dragover is not a press on the map host, so it rethrows and reaches the app rather than being quarantined;
    // the host's own catch still clears the preview and the drop effect before the error leaves it.
    expect(errors).toEqual([settledReadFailure])
    expect(rejectedDragOver.defaultPrevented).toBe(false)
    expect(downstreamDragOver).toHaveBeenCalled()
    expect(dataTransfer.dropEffect).toBe('none')
    expect(deps.renderer.lastDraft()).toBeNull()

    container.removeEventListener('dragover', downstreamDragOver)
    failRead = false
    writeSavedObjectStampDragData(dataTransfer, {
      id: 'stamp-1',
      name: 'Apple',
      sort_order: 0,
      created_at: '2026-06-19T09:00:00Z',
      updated_at: '2026-06-19T09:00:00Z',
      payload_json: JSON.stringify({
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [{
          id: 'plant-1',
          canonicalName: 'Malus domestica',
          commonName: 'Apple',
          color: null,
          symbol: null,
          position: { x: 0, y: 0 },
          rotationDeg: null,
        }],
        zones: [],
        annotations: [],
        groups: [],
      }),
    })
    container.dispatchEvent(dragOverEvent())
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(previewKinds()).toEqual(['ghost'])

    failRead = true
    const savedStampErrors = captureWindowErrors(() => {
      container.dispatchEvent(dragOverEvent())
    })
    expect(savedStampErrors).toEqual([settledReadFailure])
    expect(dataTransfer.dropEffect).toBe('none')
    expect(deps.renderer.lastDraft()).toBeNull()
    session.dispose()
  })

  it('continues Session teardown after one owned resource fails', () => {
    events.dispose()
    events = createSceneInteractionEventHarness(container, { trackListeners: true })
    store.updatePersisted((draft) => {
      draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 300, y: 250 })]
    })
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    // Hovering a plant brings the session's plant tooltip into the window's tooltip layer.
    events.pointerMove({ x: 300, y: 250 })
    expect(document.querySelector('[data-hover-tooltip]')).not.toBeNull()
    expect(container.hasAttribute('tabindex')).toBe(true)
    expect(container.querySelector('[data-canvas-handle-layer]')).not.toBeNull()
    // The story-presentation observer: the host, the chrome, the handle layer and the map host's keyboard stop are torn
    // down after it.
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect').mockImplementationOnce(() => {
      throw new Error('story observer disconnect failed')
    })

    expect(() => session.dispose()).toThrow('story observer disconnect failed')

    // The source's press listener and the selection-drag guard's.
    expect(events.listenerLog?.containerRemoves('pointerdown')).toHaveLength(2)
    expect(events.listenerLog?.containerRemoves('pointermove')).toHaveLength(1)
    expect(events.listenerLog?.windowRemoves('blur')).toHaveLength(1)
    expect(document.querySelector('[data-hover-tooltip]')).toBeNull()
    expect(container.querySelector('[data-canvas-handle-layer]')).toBeNull()
    expect(container.hasAttribute('tabindex')).toBe(false)
    expect(() => session.dispose()).not.toThrow()
    disconnect.mockRestore()
  })

  it('attempts every host-listener removal when one removal fails', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    const originalRemoveEventListener = container.removeEventListener.bind(container)
    const removeHostListener = vi.spyOn(container, 'removeEventListener').mockImplementation(
      ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        originalRemoveEventListener(type, listener, options)
        if (type === 'pointermove') throw new Error('pointermove removal failed')
      }) as typeof container.removeEventListener,
    )
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')

    try {
      expect(() => session.dispose()).toThrow('pointermove removal failed')
      expect(removeHostListener.mock.calls.filter(([type]) => type === 'focusout')).toHaveLength(1)
      expect(removeWindowListener.mock.calls.filter(([type]) => type === 'blur')).toHaveLength(1)
    } finally {
      removeHostListener.mockRestore()
      removeWindowListener.mockRestore()
    }
  })

  it('rolls back installed listeners and resources when Session construction fails', () => {
    events.dispose()
    events = createSceneInteractionEventHarness(container)
    const deps = createInteractionDeps(container, store, testView)
    const removeContainerListener = vi.spyOn(container, 'removeEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    const originalAddEventListener = window.addEventListener.bind(window)
    const addWindowListener = vi.spyOn(window, 'addEventListener').mockImplementation(
      ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === 'blur') throw new Error('listener installation failed')
        originalAddEventListener(type, listener, options)
      }) as typeof window.addEventListener,
    )

    try {
      expect(() => createSceneInteractionSession(deps)).toThrow('listener installation failed')
    } finally {
      addWindowListener.mockRestore()
    }

    expect(removeContainerListener.mock.calls.filter(([type]) => type === 'pointerdown')).toHaveLength(1)
    expect(removeContainerListener.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(1)
    expect(removeWindowListener.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(0)
    expect(container.children).toHaveLength(0)
    removeContainerListener.mockRestore()
    removeWindowListener.mockRestore()
  })

  describe('tool guidance for the tool card', () => {
    function guidedSession(): { session: SceneInteractionSession, deps: SceneInteractionSessionDeps, latest: () => CanvasToolGuidance } {
      const published: CanvasToolGuidance[] = []
      const deps = createInteractionDeps(container, store, testView, {
        publishToolGuidance: (guidance) => { published.push(guidance) },
      })
      return { session: createTestSession(deps), deps, latest: () => published.at(-1)! }
    }

    it('reports a polygon draft as a gesture until it is cancelled', () => {
      const { session, latest } = guidedSession()
      session.setTool('polygon')
      expect(latest()).toEqual({ gesture: false, stamp: null, stampRotationDeg: null, speciesPrompts: 0, plantRow: null })

      events.pointerDown({ x: 10, y: 10 })
      events.pointerUp({ x: 10, y: 10 })
      expect(latest().gesture).toBe(true)

      events.keyDown({ key: 'Escape', target: container })
      expect(latest().gesture).toBe(false)
      session.dispose()
    })

    it('reports a zone drag as a gesture while the pointer is down', () => {
      const { session, latest } = guidedSession()
      session.setTool('rectangle')

      events.pointerDown({ x: 10, y: 10 })
      events.pointerMove({ x: 60, y: 40 })
      expect(latest().gesture).toBe(true)

      events.pointerUp({ x: 60, y: 40 })
      expect(latest().gesture).toBe(false)
      session.dispose()
    })

    it('reports an open text note field as a gesture until it closes', () => {
      const { session, latest } = guidedSession()
      session.setTool('text')

      events.pointerDown({ x: 24, y: 32 })
      expect(latest().gesture).toBe(true)

      container.querySelector('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(latest().gesture).toBe(false)
      session.dispose()
    })

    it('names a picked plant and counts a picked group for Place a stamp', () => {
      store.updatePersisted((draft) => {
        draft.plants = [
          makePlant('apple', 'Malus domestica', { x: 20, y: 30 }),
          makePlant('pear-1', 'Pyrus communis', { x: 200, y: 200 }),
          makePlant('pear-2', 'Pyrus communis', { x: 210, y: 200 }),
          makePlant('plum', 'Prunus domestica', { x: 220, y: 200 }),
        ]
        draft.groups = [{
          kind: 'group',
          id: 'guild',
          locked: false,
          name: 'Pear guild',
          members: [
            { kind: 'plant', id: 'pear-1' },
            { kind: 'plant', id: 'pear-2' },
            { kind: 'plant', id: 'plum' },
          ],
        }]
      })
      const { session, latest } = guidedSession()
      session.setTool('object-stamp')
      expect(latest().stamp).toBeNull()

      events.pointerDown({ x: 20, y: 30 })
      expect(latest().stamp).toEqual({ kind: 'plant', name: 'Malus domestica', plants: 1, species: 1 })

      session.setTool('select')
      session.setTool('object-stamp')
      events.pointerDown({ x: 200, y: 200 })
      expect(latest().stamp).toEqual({ kind: 'group', name: 'Pear guild', plants: 3, species: 2 })
      session.dispose()
    })

    it('goes idle when the session ends', () => {
      const { session, latest } = guidedSession()
      session.setTool('polygon')
      events.pointerDown({ x: 10, y: 10 })

      session.dispose()

      expect(latest()).toEqual({ gesture: false, stamp: null, stampRotationDeg: null, speciesPrompts: 0, plantRow: null })
    })
  })
})
