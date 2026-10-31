// @vitest-environment jsdom

// The canvas interaction end to end through the session, split by the first tool a test arms (canvas v2 plan §4):
// tests that arm no tool and drive keys, and the keyboard access, Esc chain and
// arrow-key nudge describes.
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { describe, expect, it, vi } from 'vitest'
import { t } from '../i18n'
import { modKeyName } from '../app/shell-commands/shortcut-text'
import type { SceneStore } from '../canvas/runtime/scene'
import { currentCanvasSelection } from '../canvas/session-state'
import type {
  SceneInteractionSession,
  SceneInteractionSessionDeps,
} from '../canvas/runtime/interaction-session'
import { createRecordingRenderer } from './support/recording-renderer'
import type { SceneInteractionEventHarness } from './support/canvas-interaction-events'
import type { TestView } from './support/test-view'
import {
  contextMenuCommand,
  contextMenuHost,
  createInteractionDeps,
  plantTarget,
  zoneTarget,
  annotationTarget,
  makePlant,
  makeRectZone,
  makeTextAnnotation,
  getDesignObjectSelectionFromStore,
  installSceneInteractionFixture,
  rotationHandle,
  enterOverview,
} from './support/canvas-interaction-setup'
import './support/camera-tolerance'

describe('SceneInteractionSession', () => {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness

  const { createTestSession, spacingInput, openContextMenu, keyCommands } = installSceneInteractionFixture(
    (f) => {
      ({ container, testView, store, events } = f)
    },
    () => ({ events }),
  )

  it('aborts an active Rotation Handle drag on Escape without creating history', () => {
    store.updatePersisted((draft) => {
      draft.zones = [makeRectZone('zone-1', [
        { x: 20, y: 80 },
        { x: 120, y: 80 },
        { x: 120, y: 140 },
        { x: 20, y: 140 },
      ])]
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, {
      getDesignObjectSelection: () => getDesignObjectSelectionFromStore(store, testView),
      onSceneEditCommit,
    })
    const session = createTestSession(deps)
    deps.setSelection([zoneTarget('zone-1')])
    session.refreshMeasurements()

    const handle = rotationHandle(container)!
    const start = {
      x: Number.parseFloat(handle.style.left) + 14,
      y: Number.parseFloat(handle.style.top) + 14,
    }

    events.pointerDown(start, { button: 0, target: handle })
    events.pointerMove({ x: 128, y: 110 }, { button: 0 })
    expect(store.persisted.zones[0]?.rotationDeg).toBeCloseTo(90)

    events.keyDown({ key: 'Escape', code: 'Escape' })
    events.pointerUp({ x: 128, y: 110 }, { button: 0 })

    expect(store.persisted.zones[0]?.rotationDeg).toBe(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(rotationHandle(container)?.querySelector<HTMLElement>('[data-canvas-handle-readout]')?.style.display).toBe('none')
    session.dispose()
  })

  it('opens the empty-map menu mid-map from the keyboard without a selection', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    container.tabIndex = -1
    container.focus()

    events.keyDown({ key: 'ContextMenu', cancelable: true, target: container })

    const request = contextMenuHost.current!
    expect(request.selection).toBeNull()
    expect(request.anchor).toEqual({ left: 200, top: 150, right: 200, bottom: 150 })
    expect(request.world).toEqual({ x: 200, y: 150 })
    session.dispose()
  })

  it('arms the Space pan from the map or with nothing focused, never from a widget outside the map', () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('select')
    const before = { ...testView.viewport() }
    // A focusable widget beside the map that is no control (the inspection lens preview, a plain list row).
    const widget = document.createElement('div')
    widget.setAttribute('role', 'group')
    widget.tabIndex = 0
    document.body.append(widget)
    widget.focus()

    const fromWidget = events.keyDown({ key: ' ', code: 'Space', cancelable: true, target: widget })
    expect(fromWidget.defaultPrevented).toBe(false)
    events.pointerDown({ x: 100, y: 100 })
    events.pointerMove({ x: 130, y: 120 })
    events.pointerUp({ x: 130, y: 120 })
    events.keyUp({ key: ' ', code: 'Space', target: widget })
    expect(testView.viewport()).toEqual(before)

    widget.remove()
    container.tabIndex = 0
    container.focus()
    expect(events.keyDown({ key: ' ', code: 'Space', cancelable: true, target: container }).defaultPrevented).toBe(true)
    events.pointerDown({ x: 100, y: 100 })
    events.pointerMove({ x: 130, y: 120 })
    events.pointerUp({ x: 130, y: 120 })
    events.keyUp({ key: ' ', code: 'Space', target: container })
    expect(testView.viewport().x).toBeCloseTo(before.x + 30, 6)
    session.dispose()
  })

  describe('keyboard access to the map', () => {
    it('puts the map host in the Tab order with an accessible name and a description of its keys', () => {
      const session = createTestSession(createInteractionDeps(container, store, testView))

      expect(container.tabIndex).toBe(0)
      expect(container.getAttribute('role')).toBe('application')
      expect(container.getAttribute('aria-label')).toBe(t('canvas.map.label'))
      const descriptionId = container.getAttribute('aria-describedby')
      expect(descriptionId).toBeTruthy()
      const description = document.getElementById(descriptionId!)?.textContent
      expect(description).toBe(t('canvas.map.description', { mod: modKeyName(t) }))
      expect(description).not.toContain('{{mod}}')
      // It names every key the map takes: tools, the menu, arrows, F6 and Esc.
      expect(t('canvas.map.description', { mod: 'Ctrl' })).toContain('Arrow keys move the selection 10 cm on screen, or 1 m with Ctrl')
      expect(t('canvas.map.description', { mod: 'Cmd' })).toContain('Shift with left or right arrow turns the view; N or Shift with up arrow resets north.')
      expect(t('canvas.map.description')).toContain('F6')
      session.dispose()
    })

    it('restores the host when the session ends', () => {
      container.setAttribute('aria-label', 'Before')
      const session = createTestSession(createInteractionDeps(container, store, testView))

      session.dispose()

      expect(container.hasAttribute('tabindex')).toBe(false)
      expect(container.hasAttribute('role')).toBe(false)
      expect(container.hasAttribute('aria-describedby')).toBe(false)
      expect(container.getAttribute('aria-label')).toBe('Before')
    })

    it('restores the host when its accessible name fails to translate', () => {
      container.setAttribute('aria-label', 'Before')
      const translate = (key: string): string => {
        if (key === 'canvas.map.description') throw new Error('translation failed')
        return key
      }

      expect(() => createTestSession(createInteractionDeps(container, store, testView, { translate })))
        .toThrow('translation failed')

      expect(container.querySelector('[data-map-keys-description]')).toBeNull()
      expect(container.hasAttribute('tabindex')).toBe(false)
      expect(container.hasAttribute('role')).toBe(false)
      expect(container.hasAttribute('aria-describedby')).toBe(false)
      expect(container.getAttribute('aria-label')).toBe('Before')
    })

    it('refreshes the accessible name and description in place on a locale change', () => {
      let language = 'en'
      const translate = (key: string): string => `${language}:${key}`
      const session = createTestSession(createInteractionDeps(container, store, testView, { translate }))
      const description = document.getElementById(container.getAttribute('aria-describedby')!)

      language = 'fr'
      session.refreshTranslations()

      expect(container.getAttribute('aria-label')).toBe('fr:canvas.map.label')
      expect(document.getElementById(container.getAttribute('aria-describedby')!)).toBe(description)
      expect(description?.textContent).toBe('fr:canvas.map.description')
      session.dispose()
    })

    it('opens the right-click menu with Shift F10 after Tab focus, with no pointer press first', () => {
      store.updatePersisted((draft) => {
        draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 20, y: 30 })]
      })
      const deps = createInteractionDeps(container, store, testView)
      const session = createTestSession(deps)
      deps.setSelection([plantTarget('plant-1')])

      container.focus()
      expect(document.activeElement).toBe(container)
      events.keyDown({ key: 'F10', shiftKey: true, target: container })

      expect(contextMenuHost.current).not.toBeNull()
      session.dispose()
    })

    it('keeps focusing the host on a pointer press', () => {
      const session = createTestSession(createInteractionDeps(container, store, testView))
      session.setTool('select')

      events.pointerDown({ x: 40, y: 40 })

      expect(document.activeElement).toBe(container)
      session.dispose()
    })
  })

  describe('the Esc chain', () => {
    function escapeOnMap(): KeyboardEvent {
      return events.keyDown({ key: 'Escape', target: container })
    }

    function sessionWithToolLog(
      renderer?: SceneInteractionSessionDeps['renderer'],
    ): { session: SceneInteractionSession, deps: SceneInteractionSessionDeps, tools: string[] } {
      const tools: string[] = []
      const deps = createInteractionDeps(container, store, testView, { setTool: (name: string) => { tools.push(name) } })
      return { session: createTestSession(renderer ? { ...deps, renderer } : deps), deps, tools }
    }

    it.each([
      'hand',
      'plant-stamp',
      'plant-spacing',
      'object-stamp',
      'polygon',
      'rectangle',
      'ellipse',
      'line',
      'text',
      'measurement-guide',
    ] as const)('returns %s to Select, then clears the selection', (tool) => {
      store.updatePersisted((draft) => {
        draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 200, y: 200 })]
      })
      const { session, deps, tools } = sessionWithToolLog()
      session.setTool(tool)
      deps.setSelection([plantTarget('plant-1')])
      container.focus()

      const first = escapeOnMap()
      expect(first.defaultPrevented).toBe(true)
      expect(tools.at(-1)).toBe('select')
      expect(deps.clearSelection).not.toHaveBeenCalled()

      const second = escapeOnMap()
      expect(second.defaultPrevented).toBe(true)
      expect(deps.clearSelection).toHaveBeenCalledTimes(1)

      const third = escapeOnMap()
      expect(third.defaultPrevented).toBe(false)
      session.dispose()
    })

    it('leaves the tool from focus outside the map (I2), keeps the selection there and leaves Esc in a text field alone', () => {
      store.updatePersisted((draft) => {
        draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 200, y: 200 })]
      })
      const { session, deps, tools } = sessionWithToolLog()
      session.setTool('rectangle')
      deps.setSelection([plantTarget('plant-1')])
      const field = document.createElement('input')
      const panelRow = document.createElement('div')
      document.body.append(field, panelRow)

      expect(events.keyDown({ key: 'Escape', target: field }).defaultPrevented).toBe(false)
      expect(tools).not.toContain('select')
      expect(events.keyDown({ key: 'Escape', target: panelRow }).defaultPrevented).toBe(true)
      expect(tools.at(-1)).toBe('select')
      expect(events.keyDown({ key: 'Escape', target: panelRow }).defaultPrevented).toBe(false)
      expect(deps.clearSelection).not.toHaveBeenCalled()
      field.remove()
      panelRow.remove()
      session.dispose()
    })

    it('cancels a new text note, returns focus to the map, then returns to Select', () => {
      const { session, tools } = sessionWithToolLog()
      session.setTool('text')
      events.pointerDown({ x: 24, y: 32 }, { button: 0 })
      events.pointerUp({ x: 24, y: 32 }, { button: 0 })
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
      textarea.focus()

      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

      expect(container.querySelector('textarea')).toBeNull()
      expect(document.activeElement).toBe(container)
      expect(tools).not.toContain('select')
      escapeOnMap()
      expect(tools.at(-1)).toBe('select')
      session.dispose()
    })

    it('lets a click inside a new text note field move the caret instead of committing the note', () => {
      const { session } = sessionWithToolLog()
      session.setTool('text')
      events.pointerDown({ x: 24, y: 32 }, { button: 0 })
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
      textarea.focus()
      textarea.value = 'Mulch in November'

      const event = events.pointerDown({ x: 30, y: 36 }, { button: 0, target: textarea })

      expect(event.defaultPrevented).toBe(false)
      expect(container.querySelector('textarea')).toBe(textarea)
      expect(document.activeElement).toBe(textarea)
      expect(store.persisted.annotations).toHaveLength(0)
      session.dispose()
    })

    it('returns focus to the map after a text note is finished with Enter', () => {
      const { session } = sessionWithToolLog()
      session.setTool('text')
      events.pointerDown({ x: 24, y: 32 }, { button: 0 })
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
      textarea.focus()
      textarea.value = 'Mulch in November'

      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

      expect(store.persisted.annotations).toHaveLength(1)
      expect(document.activeElement).toBe(container)
      session.dispose()
    })

    it('returns focus to the map after editing a note in place', () => {
      store.updatePersisted((draft) => {
        draft.annotations = [makeTextAnnotation('note-1', { x: 40, y: 40 }, 'Old')]
      })
      const deps = createInteractionDeps(container, store, testView)
      const session = createTestSession(deps)
      session.setTool('select')
      deps.setSelection([annotationTarget('note-1')])
      container.focus()
      events.keyDown({ key: 'Enter', target: container })
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
      textarea.focus()

      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

      expect(container.querySelector('textarea')).toBeNull()
      expect(document.activeElement).toBe(container)
      session.dispose()
    })

    it('in overview Esc keeps the selection and leaves the tool armed (U36)', () => {
      store.updatePersisted((draft) => {
        draft.zones = [makeRectZone('zone-1', [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 60 }, { x: 20, y: 60 }])]
      })
      const { session, deps, tools } = sessionWithToolLog()
      session.setTool('rectangle')
      enterOverview(testView)
      deps.setSelection([zoneTarget('zone-1')])
      container.focus()

      escapeOnMap()
      expect(deps.clearSelection).not.toHaveBeenCalled()
      expect(tools).not.toContain('select')
      session.dispose()
    })

    it('cancels a zone drag first, then returns to Select', () => {
      const { session, tools } = sessionWithToolLog()
      session.setTool('rectangle')
      events.pointerDown({ x: 20, y: 20 })
      events.pointerMove({ x: 80, y: 60 })

      escapeOnMap()
      expect(tools).not.toContain('select')
      expect(store.persisted.zones).toHaveLength(0)
      expect(document.activeElement).toBe(container)

      escapeOnMap()
      expect(tools.at(-1)).toBe('select')
      session.dispose()
    })

    it('drops the Plant a row source from its spacing field, returns focus to the map, then returns to Select', () => {
      store.updatePersisted((draft) => {
        draft.plants = [makePlant('source', 'Malus domestica', { x: 20, y: 30 })]
      })
      // The row's source ring draws in the session's draft sink (plan §1, exception 2), not the DOM.
      const drafts = createRecordingRenderer()
      const { session, tools } = sessionWithToolLog(drafts)
      session.setTool('plant-spacing')
      events.pointerDown({ x: 20, y: 30 })
      events.pointerUp({ x: 20, y: 30 })
      expect(drafts.lastDraft()?.shapes.some((shape) => shape.kind === 'circle-px')).toBe(true)
      const input = spacingInput()!
      input.focus()

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

      expect(drafts.lastDraft()).toBeNull()
      expect(document.activeElement).toBe(container)
      expect(tools).not.toContain('select')
      escapeOnMap()
      expect(tools.at(-1)).toBe('select')
      session.dispose()
    })
    it('steps a drawn Plant a row back point by point with Esc, then drops the source, then returns to Select (U58)', () => {
      store.updatePersisted((draft) => {
        draft.plants = [makePlant('source', 'Malus domestica', { x: 20, y: 30 })]
      })
      const drafts = createRecordingRenderer()
      const { session, tools } = sessionWithToolLog(drafts)
      session.setTool('plant-spacing')
      for (const x of [20, 120, 220]) {
        events.pointerDown({ x, y: 30 })
        events.pointerUp({ x, y: 30 })
      }
      container.focus()
      const points = () => document.querySelectorAll('[data-canvas-handle^="point:"]').length
      expect(points(), 'the picked plant and two points').toBe(3)

      // Below 3 points the picked plant has no handle: one point left shows one handle. (Ctrl+Z and Ctrl+Shift+Z go through
      // Edit > Undo and Redo, the edition's commands: e2e/canvas/plant-path.spec.ts.)
      escapeOnMap()
      expect(points(), 'Esc removes the last point').toBe(1)
      escapeOnMap()
      expect(points(), 'Esc steps back to the picked plant').toBe(0)
      expect(drafts.lastDraft()?.shapes.some((shape) => shape.kind === 'circle-px'), 'the picked plant stays').toBe(true)
      escapeOnMap()
      expect(drafts.lastDraft()).toBeNull()
      expect(tools).not.toContain('select')
      escapeOnMap()
      expect(tools.at(-1)).toBe('select')
      expect(store.persisted.plants).toHaveLength(1)
      session.dispose()
    })
  })

  describe('key admission (canopi-f47t.21)', () => {
    const DELETES = ['canvas.deleteSelected', 'canvas.cut']
    const deletesRun = () => keyCommands.mock.calls.map(([command]) => command).filter((command) => DELETES.includes(command))
    /** Delete and Ctrl+X, and Backspace unless the armed tool takes it (Polygon removes its last corner). */
    const pressDeletes = (target: HTMLElement, backspace = true) => {
      events.keyDown({ key: 'Delete', target })
      if (backspace) events.keyDown({ key: 'Backspace', target })
      events.keyDown({ key: 'x', code: 'KeyX', ctrlKey: true, target })
    }

    it('Delete and Ctrl+X delete nothing while a polygon draft has two corners, from the map or a map control', () => {
      store.updatePersisted((draft) => {
        draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 200, y: 200 })]
      })
      const deps = createInteractionDeps(container, store, testView)
      const session = createTestSession(deps)
      session.setTool('polygon')
      container.focus()
      events.pointerDown({ x: 20, y: 20 })
      events.pointerUp({ x: 20, y: 20 })
      events.pointerDown({ x: 80, y: 20 })
      events.pointerUp({ x: 80, y: 20 })
      deps.setSelection([plantTarget('plant-1')])

      pressDeletes(container, false)
      const control = document.createElement('button')
      container.appendChild(control)
      control.focus()
      pressDeletes(control, false)
      expect(deletesRun()).toEqual([])
      expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

      // Esc steps the draft back to nothing, one corner at a time (A17): the selection deletes again.
      events.keyDown({ key: 'Escape', target: container })
      events.keyDown({ key: 'Escape', target: container })
      events.keyDown({ key: 'Delete', target: container })
      expect(deletesRun()).toEqual(['canvas.deleteSelected'])
      control.remove()
      session.dispose()
    })

    it('Delete deletes nothing while Place plants\' point waits', () => {
      store.updatePersisted((draft) => {
        draft.plants = [makePlant('plant-1', 'Malus domestica', { x: 200, y: 200 })]
      })
      const deps = createInteractionDeps(container, store, testView, { setTool: (name: string) => { session.setTool(name as 'plant-stamp') } })
      const session: SceneInteractionSession = createTestSession(deps)
      deps.setSelection([plantTarget('plant-1')])
      openContextMenu({ x: 30, y: 30 })
      contextMenuCommand('place-plants-here').run()
      expect(session.tool).toBe('plant-stamp')
      container.focus()

      pressDeletes(container)
      expect(deletesRun()).toEqual([])
      session.dispose()
    })
  })

  describe('arrow-key nudges', () => {
    function nudgeSession(selected = true): { nudge: { nudgeSelected: ReturnType<typeof vi.fn>, endNudge: ReturnType<typeof vi.fn> }, session: SceneInteractionSession, deps: SceneInteractionSessionDeps, render: ReturnType<typeof vi.fn> } {
      const nudge = { nudgeSelected: vi.fn(() => true), endNudge: vi.fn() }
      const render = vi.fn()
      const deps = createInteractionDeps(container, store, testView, { nudge, render })
      const session = createTestSession(deps)
      if (selected) deps.setSelection([plantTarget('plant-1')])
      container.tabIndex = 0
      container.focus()
      return { nudge, session, deps, render }
    }

    it('pans the map 64 px per arrow, 256 px with mod, when nothing is selected', () => {
      const { nudge, render } = nudgeSession(false)
      const before = testView.viewport()
      render.mockClear()

      const right = events.keyDown({ key: 'ArrowRight', cancelable: true, target: container })
      expect(right.defaultPrevented).toBe(true)
      expect(testView.viewport()).toEqual({ x: before.x - 64, y: before.y, scale: before.scale })
      expect(render, 'its camera frame repaints the layer, not the session').not.toHaveBeenCalled()

      events.keyDown({ key: 'ArrowDown', ctrlKey: true, target: container })
      events.keyDown({ key: 'ArrowLeft', target: container })
      events.keyDown({ key: 'ArrowUp', target: container })
      expect(testView.viewport()).toEqual({ x: before.x, y: before.y - 256 + 64, scale: before.scale })
      // Shift+↓ is unbound (reserved for tilt): it no longer pans farther.
      events.keyDown({ key: 'ArrowDown', shiftKey: true, target: container })
      expect(testView.viewport()).toEqual({ x: before.x, y: before.y - 256 + 64, scale: before.scale })
      expect(nudge.nudgeSelected).not.toHaveBeenCalled()
      expect(nudge.endNudge).not.toHaveBeenCalled()
    })

    it('pans with an empty selection under any tool and in overview, but not from a field or with Alt', () => {
      const { session, deps } = nudgeSession(false)
      const before = testView.viewport()
      session.setTool('polygon')
      events.keyDown({ key: 'ArrowRight', target: container })
      session.setTool('select')
      expect(testView.viewport().x).toBeCloseTo(before.x - 64, 6)
      const leaveOverview = enterOverview(testView)
      const overview = testView.viewport()
      events.keyDown({ key: 'ArrowRight', target: container })
      expect(testView.viewport().x).toBeCloseTo(overview.x - 64, 6)
      leaveOverview()
      const site = testView.viewport()

      const field = document.createElement('textarea')
      container.append(field)
      field.focus()
      const inField = events.keyDown({ key: 'ArrowRight', cancelable: true, target: field })
      expect(inField.defaultPrevented).toBe(false)
      field.remove()
      container.focus()
      events.keyDown({ key: 'ArrowRight', altKey: true, target: container })
      expect(testView.viewport().x).toBeCloseTo(site.x, 6)
      // mod is the large step (it was Shift before phase 1).
      events.keyDown({ key: 'ArrowRight', ctrlKey: true, target: container })
      expect(testView.viewport().x).toBeCloseTo(site.x - 256, 6)

      // With a selection the same key nudges instead.
      deps.setSelection([plantTarget('plant-1')])
      events.keyDown({ key: 'ArrowRight', target: container })
      expect(testView.viewport().x).toBeCloseTo(site.x - 256, 6)
      expect(deps.nudge!.nudgeSelected).toHaveBeenCalledExactlyOnceWith({ x: 0.1, y: 0 })
    })

    it('nudges the selection 0.1 m per arrow, 1 m with mod, north-up', () => {
      const { nudge } = nudgeSession()
      const right = events.keyDown({ key: 'ArrowRight', cancelable: true, target: container })
      events.keyDown({ key: 'ArrowLeft', target: container })
      events.keyDown({ key: 'ArrowUp', ctrlKey: true, target: container })
      events.keyDown({ key: 'ArrowDown', target: container })
      expect(right.defaultPrevented).toBe(true)
      expect(nudge.nudgeSelected.mock.calls.map(([delta]) => delta)).toEqual([
        { x: 0.1, y: 0 }, { x: -0.1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 0.1 },
      ])
      expect(nudge.endNudge).not.toHaveBeenCalled()
    })

    it('ends the series on another key, a press, leaving the map, a pause or a tool change', () => {
      vi.useFakeTimers()
      try {
        const { nudge, session, deps } = nudgeSession()
        events.keyDown({ key: 'ArrowRight', target: container })
        events.keyDown({ key: 'z', ctrlKey: true, target: container })
        expect(nudge.endNudge).toHaveBeenCalledTimes(1)
        expect(nudge.endNudge).toHaveBeenLastCalledWith()

        events.keyDown({ key: 'ArrowRight', target: container })
        events.pointerDown({ x: 200, y: 200 }, { button: 0 })
        expect(nudge.endNudge).toHaveBeenCalledTimes(2)
        events.pointerUp({ x: 200, y: 200 }, { button: 0 })
        // The press on empty map cleared the selection; the series needs one.
        deps.setSelection([plantTarget('plant-1')])

        events.keyDown({ key: 'ArrowRight', target: container })
        vi.advanceTimersByTime(1000)
        expect(nudge.endNudge).toHaveBeenCalledTimes(3)

        events.keyDown({ key: 'ArrowRight', target: container })
        container.dispatchEvent(new FocusEvent('focusout', { relatedTarget: document.body }))
        expect(nudge.endNudge).toHaveBeenCalledTimes(4)

        events.keyDown({ key: 'ArrowRight', target: container })
        session.setTool('polygon')
        expect(nudge.endNudge).toHaveBeenCalledTimes(5)
      } finally {
        vi.useRealTimers()
      }
    })

    it('cancels the series with Esc instead of clearing the selection', () => {
      const { nudge, deps } = nudgeSession()
      deps.setSelection([plantTarget('plant-1')])
      events.keyDown({ key: 'ArrowRight', target: container })
      events.keyDown({ key: 'Escape', cancelable: true, target: container })
      expect(nudge.endNudge).toHaveBeenCalledWith({ abort: true })
      expect(deps.clearSelection).not.toHaveBeenCalled()
      // The next Esc continues the chain.
      events.keyDown({ key: 'Escape', cancelable: true, target: container })
      expect(deps.clearSelection).toHaveBeenCalled()
    })

    it('leaves the arrows alone off the map, under other tools and with Alt', () => {
      const { nudge, session } = nudgeSession()
      const field = document.createElement('input')
      document.body.append(field)
      try {
        events.keyDown({ key: 'ArrowRight', target: field })
        events.keyDown({ key: 'ArrowRight', altKey: true, target: container })
        session.setTool('polygon')
        events.keyDown({ key: 'ArrowRight', target: container })
        expect(nudge.nudgeSelected).not.toHaveBeenCalled()
      } finally {
        field.remove()
      }
    })
  })
})
