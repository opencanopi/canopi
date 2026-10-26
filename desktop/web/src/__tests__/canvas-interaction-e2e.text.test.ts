// @vitest-environment jsdom

// The canvas interaction end to end through the session, split by the first tool a test arms (canvas v2 plan §4):
// tests that arm Text, and the text note editor describe. Text runs on the ToolHost (tools/text-note.ts, whose own tests
// drive it through the ToolHarness); these stay end to end, and the note field is the host's text entry
// (chrome/text-entry-host.ts).
// Shared fakes, helpers and fixture: support/canvas-interaction-setup.ts.
import { describe, expect, it, vi } from 'vitest'
import { t } from '../i18n'
import type { SceneStore } from '../canvas/runtime/scene'
import { SceneHistory } from '../canvas/runtime/scene-history'
import { SceneRuntimeEditCoordinator } from '../canvas/runtime/scene-runtime/transactions'
import type { SceneInteractionEventHarness } from './support/canvas-interaction-events'
import type { TestView } from './support/test-view'
import {
  createInteractionDeps,
  annotationTarget,
  nextAnimationFrame,
  enterOverview,
  captureWindowErrors,
  makeTextAnnotation,
  installSceneInteractionFixture,
} from './support/canvas-interaction-setup'
import './support/camera-tolerance'

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

  /** The host's text entry: a new note's field, or a note's in-place editor. */
  function noteEntry(): HTMLTextAreaElement | null {
    return container.querySelector<HTMLTextAreaElement>('textarea[data-canvas-text-entry]')
  }

  it('commits a text Annotation with Enter and selects it', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('text')

    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    const textarea = noteEntry()!
    textarea.value = 'Guild note'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations).toHaveLength(1)
    expect(store.persisted.annotations[0]).toMatchObject({
      annotationType: 'text',
      position: { x: 24, y: 32 },
      text: 'Guild note',
    })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-text')
    expect(deps.setSelection).toHaveBeenCalledWith([
      annotationTarget(store.persisted.annotations[0]!.id),
    ])
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('keeps a new text Annotation draft recoverable while the Scene is busy', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('text')

    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    const textarea = noteEntry()!
    textarea.value = 'Deferred guild note'
    const active = deps.sceneEdits.begin('external-preview')

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(noteEntry()).toBe(textarea)
    expect(textarea.value).toBe('Deferred guild note')

    active.abort()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations).toEqual([
      expect.objectContaining({
        annotationType: 'text',
        position: { x: 24, y: 32 },
        text: 'Deferred guild note',
      }),
    ])
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-text')
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('does not create text Annotations on a locked Annotations Layer', () => {
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => (
        layer.name === 'annotations' ? { ...layer, locked: true } : layer
      ))
    })
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('text')

    events.pointerDown({ x: 24, y: 32 }, { button: 0 })

    expect(container.querySelector('textarea')).toBeNull()
    expect(store.persisted.annotations).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    session.dispose()
  })

  it('cancels a pending text Annotation with Escape', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('text')

    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    const textarea = noteEntry()!
    textarea.value = 'Draft note'
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(store.persisted.annotations).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('commits a pending text Annotation on blur', async () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('text')

    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    await nextAnimationFrame()
    const textarea = noteEntry()!
    textarea.value = 'Blurred note'
    textarea.dispatchEvent(new FocusEvent('blur'))
    await nextAnimationFrame()

    expect(store.persisted.annotations).toHaveLength(1)
    expect(store.persisted.annotations[0]).toMatchObject({
      position: { x: 24, y: 32 },
      text: 'Blurred note',
    })
    expect(onSceneEditCommit).toHaveBeenCalledWith('interaction-text')
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('commits an open note on the click that leaves it, which places nothing; the next click places a note', async () => {
    const session = createTestSession(createInteractionDeps(container, store, testView))
    session.setTool('text')
    container.tabIndex = 0
    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    events.pointerUp({ x: 24, y: 32 }, { button: 0 })
    await nextAnimationFrame()
    const textarea = noteEntry()!
    expect(document.activeElement).toBe(textarea)
    textarea.value = 'Left behind'

    events.pointerDown({ x: 80, y: 90 }, { button: 0 })
    events.pointerUp({ x: 80, y: 90 }, { button: 0 })
    expect(store.persisted.annotations).toEqual([expect.objectContaining({ position: { x: 24, y: 32 }, text: 'Left behind' })])
    expect(container.querySelector('textarea')).toBeNull()

    events.pointerDown({ x: 80, y: 90 }, { button: 0 })
    expect(noteEntry()).not.toBeNull()
    expect(noteEntry()!.style.left).toBe('80px')
    session.dispose()
  })

  it('a click on the map commits a note whose blur commit was refused, and places nothing; the next click places a note', async () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('text')
    container.tabIndex = 0
    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    events.pointerUp({ x: 24, y: 32 }, { button: 0 })
    await nextAnimationFrame()
    const textarea = noteEntry()!
    expect(document.activeElement).toBe(textarea)
    textarea.value = 'Busy note'

    // Focus leaves the field while the scene is busy: its blur commit is refused, and the field stays without focus.
    const busy = deps.sceneEdits.begin('external-preview')
    textarea.blur()
    await nextAnimationFrame()
    expect(noteEntry()).toBe(textarea)
    expect(store.persisted.annotations).toHaveLength(0)
    busy.abort()

    events.pointerDown({ x: 80, y: 90 }, { button: 0 })
    events.pointerUp({ x: 80, y: 90 }, { button: 0 })
    expect(store.persisted.annotations).toEqual([expect.objectContaining({ position: { x: 24, y: 32 }, text: 'Busy note' })])
    expect(container.querySelector('textarea')).toBeNull()

    events.pointerDown({ x: 80, y: 90 }, { button: 0 })
    expect(noteEntry()!.style.left).toBe('80px')
    session.dispose()
  })

  it('entering overview with a note whose commit is refused discards it, and Text places the next note (B5)', async () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('text')
    container.tabIndex = 0
    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    events.pointerUp({ x: 24, y: 32 }, { button: 0 })
    await nextAnimationFrame()
    noteEntry()!.value = 'Busy note'

    // The scene is busy: overview's commit is refused, and the note is discarded.
    const busy = deps.sceneEdits.begin('external-preview')
    const leaveOverview = enterOverview(testView)
    expect(noteEntry()).toBeNull()
    busy.abort()
    leaveOverview()
    expect(store.persisted.annotations).toHaveLength(0)

    // Text took the discard: the next press opens a new note where it lands.
    events.pointerDown({ x: 80, y: 90 }, { button: 0 })
    events.pointerUp({ x: 80, y: 90 }, { button: 0 })
    expect(noteEntry()!.style.left).toBe('80px')
    session.dispose()
  })

  it('does not commit empty text Annotations', () => {
    const onSceneEditCommit = vi.fn()
    const deps = createInteractionDeps(container, store, testView, { onSceneEditCommit })
    const session = createTestSession(deps)
    session.setTool('text')

    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    const textarea = noteEntry()!
    textarea.value = '   '
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(store.persisted.annotations).toHaveLength(0)
    expect(onSceneEditCommit).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')).toBeNull()
    session.dispose()
  })

  it('keeps a committed note once when its publication throws, and the next press opens a new note', () => {
    let invalidationFailures = 1
    const baseDeps = createInteractionDeps(container, store, testView)
    const sceneEdits = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      history: new SceneHistory(),
      setSelection: baseDeps.setSelection,
      incrementSceneRevision: () => {},
      syncCanvasSignalsFromScene: () => {},
      invalidate: () => {
        if (invalidationFailures > 0) {
          invalidationFailures -= 1
          throw new Error('text publication failed')
        }
      },
    })
    const session = createTestSession({
      ...baseDeps,
      sceneEdits,
      commandAdmission: sceneEdits,
    })
    session.setTool('text')
    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    const textarea = noteEntry()!
    textarea.value = 'Retained note'

    const errors = captureWindowErrors(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(errors).toHaveLength(1)
    expect(store.persisted.annotations).toHaveLength(1)
    expect(container.querySelector('textarea')).toBeNull()

    // Nothing waits to be resumed: the next press is admitted and opens a new note.
    events.pointerDown({ x: 80, y: 90 }, { button: 0 })

    expect(noteEntry()).not.toBeNull()
    expect(noteEntry()).not.toBe(textarea)
    expect(store.persisted.annotations).toHaveLength(1)
    session.dispose()
  })

  it('cleans up pending text Annotation editors on tool change and disposal', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('text')

    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    expect(noteEntry()).not.toBeNull()
    session.setTool('select')
    expect(container.querySelector('textarea')).toBeNull()

    session.setTool('text')
    events.pointerDown({ x: 48, y: 64 }, { button: 0 })
    expect(noteEntry()).not.toBeNull()
    session.dispose()
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('keeps Space from starting canvas panning while a text Annotation editor is active', async () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('text')
    container.tabIndex = 0
    const before = { ...testView.viewport() }

    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    events.pointerUp({ x: 24, y: 32 }, { button: 0 })
    await nextAnimationFrame()
    const textarea = noteEntry()!
    expect(document.activeElement).toBe(textarea)
    expect(container.style.cursor).toBe('text')

    // Space in the field arms no pan (spec §3.8, fixture G11): the drag that follows on the map pans nothing, and its
    // press commits the blank field, which writes no note.
    events.keyDown({ key: ' ', code: 'Space', cancelable: true, target: textarea })
    expect(container.style.cursor).toBe('text')
    events.pointerDown({ x: 200, y: 200 }, { button: 0 })
    events.pointerMove({ x: 260, y: 230 }, { button: 0 })
    events.pointerUp({ x: 260, y: 230 }, { button: 0 })
    events.keyUp({ key: ' ', code: 'Space', target: container })

    expect(testView.viewport()).toEqual(before)
    expect(noteEntry()).toBeNull()
    expect(store.persisted.annotations).toHaveLength(0)
    session.dispose()
  })

  it('keeps Space from starting canvas panning while a new note\'s field is open but not focused', () => {
    const deps = createInteractionDeps(container, store, testView)
    const session = createTestSession(deps)
    session.setTool('text')
    container.tabIndex = 0
    container.focus()
    const before = { ...testView.viewport() }

    events.pointerDown({ x: 24, y: 32 }, { button: 0 })
    events.pointerUp({ x: 24, y: 32 }, { button: 0 })
    // The field takes focus on the next frame: until then Space reaches the map, which today's open field kept from
    // arming a pan (its Text adapter suppressed the shared keys while the field was open, focused or not).
    expect(noteEntry()).not.toBeNull()
    expect(document.activeElement).toBe(container)
    events.keyDown({ key: ' ', code: 'Space', cancelable: true, target: container })
    expect(container.style.cursor).toBe('text')
    events.pointerDown({ x: 200, y: 200 }, { button: 0 })
    events.pointerMove({ x: 260, y: 230 }, { button: 0 })
    events.pointerUp({ x: 260, y: 230 }, { button: 0 })
    events.keyUp({ key: ' ', code: 'Space', target: container })

    expect(testView.viewport()).toEqual(before)
    expect(noteEntry()).toBeNull()
    expect(store.persisted.annotations).toHaveLength(0)
    session.dispose()
  })

  describe('text note editor', () => {
    it('names the new note field and prompts for the text, as the tool card does', () => {
      const session = createTestSession(createInteractionDeps(container, store, testView))
      session.setTool('text')

      events.pointerDown({ x: 24, y: 32 }, { button: 0 })

      const textarea = noteEntry()!
      expect(textarea.getAttribute('aria-label')).toBe(t('canvas.tools.text'))
      expect(textarea.placeholder).toBe(t('canvas.textNote.placeholder'))
      expect(t('canvas.tools.text')).toBe('Text note')
      expect(t('canvas.textNote.placeholder')).toBe('Type the note')
      session.dispose()
    })

    it('names the field that edits a note in place', () => {
      store.updatePersisted((draft) => {
        draft.annotations = [makeTextAnnotation('note-1', { x: 40, y: 40 }, 'Old')]
      })
      const deps = createInteractionDeps(container, store, testView)
      const session = createTestSession(deps)
      session.setTool('select')
      deps.setSelection([annotationTarget('note-1')])
      container.focus()

      events.keyDown({ key: 'Enter', target: container })

      expect(noteEntry()?.getAttribute('aria-label')).toBe(t('canvas.tools.text'))
      session.dispose()
    })
  })
})
