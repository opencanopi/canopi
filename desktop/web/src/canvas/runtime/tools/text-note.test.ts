import { afterEach, describe, expect, it } from 'vitest'
import {
  createToolHarness,
  textNote,
  type ToolHarness,
  type ToolHarnessOptions,
} from '../../../__tests__/support/tool-harness'
import type { SceneLayerEntity } from '../scene/types'
import '../../../__tests__/support/camera-tolerance'

const harnesses: ToolHarness[] = []

function harness(options: ToolHarnessOptions = {}): ToolHarness {
  const created = createToolHarness({ tool: 'text', ...options })
  harnesses.push(created)
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
})

const OVERVIEW = { x: 200, y: 150, scale: 0.05 }
const SITE = { x: 0, y: 0, scale: 1 }

function annotationsLayer(h: ToolHarness, change: Partial<SceneLayerEntity>): void {
  h.store.updatePersisted((draft) => {
    draft.layers = draft.layers.map((layer) => (layer.name === 'annotations' ? { ...layer, ...change } : layer))
  })
}

describe('the Text tool', () => {
  it('a press opens a new note\'s entry where it lands; Enter writes the note as one edit and selects it', () => {
    const h = harness()

    h.press({ x: 24, y: 32 })
    expect(h.chrome.textEntry?.request).toEqual({
      anchor: h.world({ x: 24, y: 32 }),
      rotationDeg: 0,
      initialText: '',
      placeholderKey: 'canvas.textNote.placeholder',
    })
    expect(h.record.guidance.at(-1)?.gesture).toBe(true)
    h.release()

    h.typeText('  Guild note\n')
    expect(h.enterText()).toBe('close')
    expect(h.chrome.textEntry).toBeNull()
    expect(h.store.persisted.annotations).toEqual([expect.objectContaining({
      annotationType: 'text',
      position: h.world({ x: 24, y: 32 }),
      text: 'Guild note',
      fontSize: 16,
      // Level with the screen at bearing 0: 0, which draws as the null of older notes.
      rotationDeg: 0,
    })])
    const note = h.store.persisted.annotations[0]!
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'annotation', id: note.id }])
    expect(h.record.guidance.at(-1)?.gesture).toBe(false)
    expect(h.undo()).toBe(true)
    expect(h.store.persisted.annotations).toEqual([])

    // The next click places a new note.
    h.click({ x: 60, y: 70 })
    expect(h.chrome.textEntry?.request.anchor).toEqual(h.world({ x: 60, y: 70 }))
  })

  it('a note created at 30 stores 30', () => {
    const h = harness({ camera: { bearingDeg: 30 } })

    h.click({ x: 120, y: 80 })
    // The entry is drawn at rotationDeg − bearing: level with the screen.
    expect(h.chrome.textEntry?.request.rotationDeg).toBe(30)
    h.typeText('Mulch in November')
    expect(h.enterText()).toBe('close')

    expect(h.store.persisted.annotations).toEqual([expect.objectContaining({ text: 'Mulch in November', rotationDeg: 30 })])
  })

  it('a blur commits the note; the click that blurred it places nothing, and the next one does', () => {
    const h = harness()
    h.click({ x: 24, y: 32 })
    h.typeText('Blurred note')

    h.click({ x: 80, y: 90 })
    expect(h.record.focus.at(-1)).toBe('map')
    expect(h.store.persisted.annotations).toEqual([expect.objectContaining({ position: h.world({ x: 24, y: 32 }), text: 'Blurred note' })])
    expect(h.chrome.textEntry).toBeNull()

    h.click({ x: 80, y: 90 })
    expect(h.chrome.textEntry?.request.anchor).toEqual(h.world({ x: 80, y: 90 }))
  })

  it('Esc discards the note, and the next click opens a new one', () => {
    const h = harness()
    h.click({ x: 24, y: 32 })
    h.typeText('Draft note')

    h.escapeTextEntry()
    expect(h.store.persisted.annotations).toEqual([])
    expect(h.record.guidance.at(-1)?.gesture).toBe(false)

    h.click({ x: 48, y: 64 })
    expect(h.chrome.textEntry?.request.anchor).toEqual(h.world({ x: 48, y: 64 }))
    expect(h.record.guidance.at(-1)?.gesture).toBe(true)
  })

  it('blank text, or an Annotations layer locked or hidden since the press, writes nothing and closes the entry', () => {
    const h = harness()
    h.click({ x: 24, y: 32 })
    h.typeText('   ')
    expect(h.enterText()).toBe('close')

    h.click({ x: 24, y: 32 })
    h.typeText('Locked out')
    annotationsLayer(h, { locked: true })
    expect(h.enterText()).toBe('close')

    annotationsLayer(h, { locked: false })
    h.click({ x: 24, y: 32 })
    h.typeText('Hidden away')
    annotationsLayer(h, { visible: false })
    h.click({ x: 90, y: 90 })

    expect(h.chrome.textEntry).toBeNull()
    expect(h.store.persisted.annotations).toEqual([])
    expect(h.history.canUndo.value).toBe(false)
    expect(h.record.guidance.at(-1)?.gesture).toBe(false)
  })

  it('a press on a locked or hidden Annotations layer opens no entry', () => {
    const h = harness()
    annotationsLayer(h, { locked: true })
    h.click({ x: 24, y: 32 })
    expect(h.chrome.textEntry).toBeNull()

    annotationsLayer(h, { locked: false, visible: false })
    h.click({ x: 24, y: 32 })
    expect(h.chrome.textEntry).toBeNull()
  })

  it('while the scene refuses the edit the entry stays open with its text, and commits once the scene is settled', () => {
    const h = harness()
    h.click({ x: 24, y: 32 })
    h.typeText('Deferred guild note')
    const external = h.edits.begin('external-preview')

    expect(h.enterText()).toBe('keep')
    expect(h.store.persisted.annotations).toEqual([])
    expect(h.chrome.textEntry?.text).toBe('Deferred guild note')
    expect(h.record.guidance.at(-1)?.gesture).toBe(true)

    external.abort()
    expect(h.enterText()).toBe('close')
    expect(h.store.persisted.annotations).toEqual([expect.objectContaining({ text: 'Deferred guild note' })])
    expect(h.chrome.textEntry).toBeNull()
  })

  it('a click commits a note whose blur commit was refused, and places nothing; the next click does', () => {
    const h = harness()
    h.click({ x: 24, y: 32 })
    h.typeText('Busy note')
    const external = h.edits.begin('external-preview')
    expect(h.blurTextEntry()).toBe('keep')
    external.abort()

    h.click({ x: 80, y: 90 })
    expect(h.store.persisted.annotations).toEqual([expect.objectContaining({ position: h.world({ x: 24, y: 32 }), text: 'Busy note' })])
    expect(h.chrome.textEntry).toBeNull()

    h.click({ x: 80, y: 90 })
    expect(h.chrome.textEntry?.request.anchor).toEqual(h.world({ x: 80, y: 90 }))
  })

  it('a press on a note opens a new note there: Text never edits', () => {
    const h = harness({ scene: { annotations: [textNote('note', { x: 100, y: 150 }, 'Prune in March')] } })

    h.click({ x: 104, y: 154 }, { clickCount: 2 })
    expect(h.chrome.textEntry?.request).toMatchObject({ anchor: h.world({ x: 104, y: 154 }), initialText: '' })
  })

  it('entering overview saves an in-place edit and commits a new note; a tool change discards an entry', () => {
    const h = harness()
    const firstAnchor = h.world({ x: 24, y: 32 })
    h.click({ x: 24, y: 32 })
    h.typeText('Zoomed out')

    h.view.setViewport(OVERVIEW)
    h.advance(0)
    expect(h.chrome.textEntry).toBeNull()
    expect(h.store.persisted.annotations).toEqual([expect.objectContaining({ position: firstAnchor, text: 'Zoomed out' })])
    h.view.setViewport(SITE)
    h.advance(0)

    // An in-place edit is saved too.
    h.arm('select')
    h.select({ kind: 'annotation', id: h.store.persisted.annotations[0]!.id })
    h.host.command({ kind: 'edit-text' })
    h.typeText('Zoomed out twice')
    h.view.setViewport(OVERVIEW)
    h.advance(0)
    expect(h.chrome.textEntry).toBeNull()
    expect(h.store.persisted.annotations).toEqual([expect.objectContaining({ text: 'Zoomed out twice' })])
    h.view.setViewport(SITE)
    h.advance(0)
    h.arm('text')

    h.click({ x: 48, y: 64 })
    h.typeText('Abandoned')
    h.arm('select')
    expect(h.chrome.textEntry).toBeNull()
    expect(h.store.persisted.annotations).toHaveLength(1)
  })
})

describe('editing a note in place under Select', () => {
  const NOTE = textNote('note', { x: 100, y: 150 }, 'Prune in March')

  it('Enter or F2 on the selected note opens it; the submit rewrites its text as one edit, and blank text deletes it', () => {
    const h = harness({ tool: 'select', scene: { annotations: [NOTE] } })
    h.select({ kind: 'annotation', id: 'note' })

    expect(h.host.command({ kind: 'edit-text' })).toBe('handled')
    expect(h.chrome.textEntry?.request).toMatchObject({ initialText: 'Prune in March', fontSizePx: 16 })
    h.typeText('Prune in April')
    expect(h.enterText()).toBe('close')
    expect(h.store.persisted.annotations[0]!.text).toBe('Prune in April')
    expect(h.undo()).toBe(true)
    expect(h.store.persisted.annotations[0]!.text).toBe('Prune in March')

    h.host.command({ kind: 'edit-text' })
    h.typeText('  ')
    expect(h.enterText()).toBe('close')
    expect(h.store.persisted.annotations).toEqual([])
    expect(h.store.session.selectedTargets).toEqual([])
  })

  it('the same text, or a note locked since it opened, changes nothing; a busy scene keeps the entry open', () => {
    const h = harness({ tool: 'select', scene: { annotations: [NOTE] } })
    h.select({ kind: 'annotation', id: 'note' })

    h.host.command({ kind: 'edit-text' })
    expect(h.enterText()).toBe('close')
    h.host.command({ kind: 'edit-text' })
    h.typeText('Prune in April')
    const external = h.edits.begin('external-preview')
    expect(h.enterText()).toBe('keep')
    expect(h.chrome.textEntry?.text).toBe('Prune in April')
    external.abort()
    h.store.updatePersisted((draft) => {
      draft.annotations = draft.annotations.map((entry) => ({ ...entry, locked: true }))
    })
    expect(h.enterText()).toBe('close')

    expect(h.store.persisted.annotations[0]!.text).toBe('Prune in March')
    expect(h.history.canUndo.value).toBe(false)
  })

  it('a double-click on a note opens it for editing, and the click that blurs the entry commits it', () => {
    const h = harness({ tool: 'select', scene: { annotations: [NOTE] } })

    h.click({ x: 104, y: 154 })
    h.click({ x: 104, y: 154 }, { clickCount: 2 })
    expect(h.store.session.selectedTargets).toEqual([{ kind: 'annotation', id: 'note' }])
    expect(h.chrome.textEntry?.request).toMatchObject({ anchor: { x: 100, y: 150 }, initialText: 'Prune in March' })
    h.typeText('Mulch in November')

    h.click({ x: 300, y: 250 })
    expect(h.chrome.textEntry).toBeNull()
    expect(h.store.persisted.annotations[0]!.text).toBe('Mulch in November')
    // The click went on to Select, which cleared the selection on empty ground.
    expect(h.store.session.selectedTargets).toEqual([])
  })
})
