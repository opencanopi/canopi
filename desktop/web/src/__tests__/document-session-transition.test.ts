// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signal } from '@preact/signals'
import { scenePortOf } from '../app/canvas-map-surface/scene-port'
import { designSessionStore } from '../app/document-session/store'
import type { CanvasDocumentSurface } from '../canvas/runtime/runtime'
import type { CanopiFile } from '../types/design'
import { createTestSessionCore, type TestSessionCoreHandle } from './support/session-core-fixture'

function makeFile(name: string, overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 10,
    name,
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-28T00:00:00.000Z',
    updated_at: '2026-04-28T00:00:00.000Z',
    extra: {},
    ...overrides,
  }
}

function makeSession(): CanvasDocumentSurface {
  let loaded = false
  return {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('unused') },
    showCanvasChrome: vi.fn(),
    hideCanvasChrome: vi.fn(),
    zoomToFit: vi.fn(),
    loadDocument: vi.fn(() => { loaded = true }),
    replaceDocument: vi.fn((_file, _token, finalizeReplacement) => {
      loaded = true
      finalizeReplacement()
      return { callerFinalizerInvoked: true }
    }),
    hasLoadedDocument: vi.fn(() => loaded),
    captureForPersistence: vi.fn((metadata, doc) => ({
      content: { ...doc, name: metadata.name },
      isCurrent: vi.fn(() => true),
      acknowledgeSaved: vi.fn(() => 'applied' as const),
    })),
    serializeSceneFields: vi.fn(() => ({})),
    replaySceneCommand: vi.fn(() => true),
    resize: vi.fn(),
    destroy: vi.fn(),
  }
}

let handle: TestSessionCoreHandle

beforeEach(() => {
  handle = createTestSessionCore({
    file: makeFile('Current'),
    path: '/designs/current.canopi',
    name: 'Current',
    newDesignFactory: () => makeFile('Untitled'),
  })
})

afterEach(() => {
  handle.dispose()
})

describe('Document Session transitions (SessionCore)', () => {
  it('opens a file home, flushes dirty edits on the outgoing design, and updates store signals', async () => {
    const surface = makeSession()
    handle.core.attachScene(scenePortOf(surface))
    handle.core.document('edit', () => ({ description: 'unsaved change' }))
    handle.home.seedFile('/designs/next.canopi', makeFile('Next'))

    const result = await handle.core.openFrom({ kind: 'file', grant: '/designs/next.canopi' })

    expect(result.status).toBe('opened')
    const saved = handle.home.files.get('/designs/current.canopi')
    expect(JSON.parse(new TextDecoder().decode(saved!.bytes))).toMatchObject({ description: 'unsaved change' })
    expect(designSessionStore.readDesignName()).toBe('Next')
    expect(designSessionStore.readDesignPath()).toBe('/designs/next.canopi')
    expect(designSessionStore.isDesignDirty()).toBe(false)
    expect(surface.replaceDocument).toHaveBeenCalledWith(expect.objectContaining({ name: 'Next' }), expect.anything(), expect.any(Function))
  })

  it('returns already-open when opening the same file path that is already open', async () => {
    const result = await handle.core.openFrom({ kind: 'file', grant: '/designs/current.canopi' })

    expect(result.status).toBe('already-open')
    expect(designSessionStore.readDesignName()).toBe('Current')
  })

  it('refuses to open a missing file without disturbing the current design', async () => {
    const result = await handle.core.openFrom({ kind: 'file', grant: '/designs/missing.canopi' })

    expect(result.status).toBe('refused')
    expect(designSessionStore.readDesignName()).toBe('Current')
    expect(designSessionStore.readDesignPath()).toBe('/designs/current.canopi')
  })

  it('asks the user when flushing fails before opening another design; cancel keeps current, discard opens next', async () => {
    const readQuestion = () => {
      const state = handle.core.state.value
      return state.kind === 'closing' || state.kind === 'replacing' ? state.question ?? null : null
    }
    handle.core.document('edit', () => ({ description: 'cannot write' }))
    handle.home.setWriteResult({
      kind: 'failed',
      failure: { code: { kind: 'io', io: 'other' }, op: 'design.write', operation: 'design.write' as never, detail: 'EACCES' as never, user_may_retry: true },
    })
    handle.home.seedFile('/designs/next.canopi', makeFile('Next'))

    const firstAttempt = handle.core.openFrom({ kind: 'file', grant: '/designs/next.canopi' })
    await vi.waitFor(() => { expect(readQuestion()).not.toBeNull() })
    handle.core.answer(readQuestion()!.id, 'cancel')
    await expect(firstAttempt).resolves.toMatchObject({ status: 'cancelled' })
    expect(designSessionStore.readDesignName()).toBe('Current')

    const secondAttempt = handle.core.openFrom({ kind: 'file', grant: '/designs/next.canopi' })
    await vi.waitFor(() => { expect(readQuestion()).not.toBeNull() })
    handle.core.answer(readQuestion()!.id, 'discard')
    await expect(secondAttempt).resolves.toMatchObject({ status: 'opened' })
    expect(designSessionStore.readDesignName()).toBe('Next')
  })

  it('creates a new draft design and promotes it to a file home on saveAs', async () => {
    const created = await handle.core.createNew()
    expect(created.status).toBe('opened')
    expect(designSessionStore.readDesignPath()).toBeNull()
    expect(handle.core.currentDesign.value?.home.kind).toBe('draft')

    handle.fileAccess.setPickHomeTarget({ kind: 'picked', grant: '/designs/promoted.canopi' })
    await expect(handle.core.saveAs()).resolves.toBe('saved')
    expect(designSessionStore.readDesignPath()).toBe('/designs/promoted.canopi')
    expect(handle.home.files.has('/designs/promoted.canopi')).toBe(true)
  })

  it('detects a write conflict and resolves it with keep-mine', async () => {
    handle.core.document('edit', () => ({ description: 'mine' }))
    handle.home.seedFile('/designs/current.canopi', makeFile('External'), 'v-external')

    await expect(handle.core.flushNow()).resolves.toBe(false)
    expect(handle.core.currentDesign.value?.save.kind).toBe('conflict')

    await expect(handle.core.resolveConflict('keep-mine')).resolves.toBe('resolved')
    expect(handle.core.currentDesign.value?.save.kind).toBe('idle')
    const saved = handle.home.files.get('/designs/current.canopi')
    expect(JSON.parse(new TextDecoder().decode(saved!.bytes))).toMatchObject({ description: 'mine' })
  })

  it('reverts to the opened snapshot after edits have been saved', async () => {
    handle.home.seedFile('/designs/reverted.canopi', makeFile('Reverted', { description: 'initial' }))
    await handle.core.openFrom({ kind: 'file', grant: '/designs/reverted.canopi' })
    expect(handle.core.revertAvailable.value).toBe(false)

    handle.core.document('edit', () => ({ description: 'changed' }))
    await handle.core.flushNow()
    expect(handle.core.revertAvailable.value).toBe(true)

    await expect(handle.core.revert()).resolves.toBe('reverted')
    expect(designSessionStore.readCurrentDesign()?.description).toBe('initial')
  })

  it('closes cleanly and destroys the window on app-close lifecycle event', async () => {
    handle.core.document('edit', () => ({ description: 'flush on quit' }))
    handle.lifecycle.emit({ kind: 'close-requested' })

    await vi.waitFor(() => {
      expect(handle.lifecycle.destroyedCount()).toBe(1)
    })
    const saved = handle.home.files.get('/designs/current.canopi')
    expect(JSON.parse(new TextDecoder().decode(saved!.bytes))).toMatchObject({ description: 'flush on quit' })
  })
})
