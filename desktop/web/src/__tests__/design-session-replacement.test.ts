import { afterEach, describe, expect, it, vi } from 'vitest'
import { designSessionStore } from '../app/document-session/store'
import { scenePortOf } from '../app/canvas-map-surface/scene-port'
import { createCanvasDocumentReplacementToken, type CanvasDocumentSurface } from '../canvas/runtime/runtime'
import { SceneStore } from '../canvas/runtime/scene'
import { createDetachedSceneSessionAdapter, SceneRuntimeEditCoordinator } from '../canvas/runtime/scene-runtime/transactions'
import { signal } from '@preact/signals'
import type { CanopiFile } from '../types/design'
import { createTestSessionCore, type TestSessionCoreHandle } from './support/session-core-fixture'

function makeFile(name: string, description: string | null = null): CanopiFile {
  return {
    version: 9,
    name,
    description,
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
  }
}

function makeCanvas(events: string[]): CanvasDocumentSurface {
  let loaded = false
  return {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('unused') },
    showCanvasChrome: vi.fn(() => { events.push('show-chrome') }),
    hideCanvasChrome: vi.fn(() => { events.push('hide-chrome') }),
    zoomToFit: vi.fn(() => { events.push('zoom-to-fit') }),
    loadDocument: vi.fn((file: CanopiFile) => {
      events.push(`load:${file.name}`)
      loaded = true
    }),
    replaceDocument: vi.fn((file: CanopiFile, _token, finalizeReplacement) => {
      events.push(`replace:${file.name}`)
      loaded = true
      finalizeReplacement()
      return { callerFinalizerInvoked: true }
    }),
    hasLoadedDocument: vi.fn(() => loaded),
    captureForPersistence: vi.fn((metadata, doc) => ({
      content: { ...doc, name: metadata.name },
      isCurrent: () => true,
      acknowledgeSaved: () => 'applied' as const,
    })),
    serializeSceneFields: vi.fn(() => ({})),
    replaySceneCommand: vi.fn(() => true),
    resize: vi.fn(),
    destroy: vi.fn(),
  }
}

const handles: TestSessionCoreHandle[] = []

afterEach(() => {
  for (const h of handles.splice(0)) h.dispose()
})

describe('Design Session replacement (SessionCore)', () => {
  it('changes the public session identity only when the Design is replaced, not on in-place edits', async () => {
    const h = createTestSessionCore({
      file: makeFile('Garden'),
      path: '/designs/garden.canopi',
      name: 'Garden',
    })
    handles.push(h)
    const firstIdentity = designSessionStore.sessionIdentity.value

    h.core.document('rename', () => ({ name: 'Garden renamed' }))
    expect(designSessionStore.sessionIdentity.value).toBe(firstIdentity)

    h.home.seedFile('/designs/next.canopi', makeFile('Next'))
    await h.core.openFrom({ kind: 'file', grant: '/designs/next.canopi' })

    expect(designSessionStore.sessionIdentity.value).not.toBe(firstIdentity)
    expect(designSessionStore.readDesignName()).toBe('Next')
  })

  it('hydrates the attached Scene port when opening a replacement Design', async () => {
    const events: string[] = []
    const canvas = makeCanvas(events)
    const h = createTestSessionCore({
      file: makeFile('Previous'),
      path: '/designs/previous.canopi',
      name: 'Previous',
    })
    handles.push(h)
    h.core.attachScene(scenePortOf(canvas))
    events.length = 0

    h.home.seedFile('/designs/requested.canopi', makeFile('Requested'))
    const result = await h.core.openFrom({ kind: 'file', grant: '/designs/requested.canopi' })

    expect(result.status).toBe('opened')
    expect(events).toEqual(['replace:Requested', 'zoom-to-fit'])
    expect(designSessionStore.readDesignName()).toBe('Requested')
    expect(designSessionStore.isDesignDirty()).toBe(false)
  })

  it('aborts an open Scene edit during document replacement handoff', () => {
    const store = new SceneStore().hydrate(makeFile('Before'))
    const sceneSession = createDetachedSceneSessionAdapter()
    const coordinator = new SceneRuntimeEditCoordinator({
      sceneStore: store,
      sceneSession,
      setSelection: (ids) => store.setSelection(ids),
      incrementSceneRevision: () => {},
      syncCanvasSignalsFromScene: () => {},
      invalidate: () => {},
    })
    sceneSession.bindReplay((command, direction) => coordinator.replayCommand(command, direction))
    const active = coordinator.begin('drag')
    active.mutate((draft) => {
      draft.plantSpeciesColors['Malus domestica'] = '#123456'
    })

    const finalized = vi.fn()
    coordinator.replaceDocument(makeFile('After'), {
      token: createCanvasDocumentReplacementToken(),
      prepare: () => { active.abort() },
      finalizeReplacement: finalized,
    })

    expect(finalized).toHaveBeenCalledOnce()
    expect(store.persisted.plantSpeciesColors['Malus domestica']).toBeUndefined()
  })

  it('clears undo history and dirty state when replacing with a new Design', async () => {
    const h = createTestSessionCore({
      file: makeFile('Previous'),
      path: '/designs/previous.canopi',
      name: 'Previous',
      newDesignFactory: () => makeFile('Untitled'),
    })
    handles.push(h)
    h.core.document('edit', () => ({ description: 'dirty' }))
    expect(h.core.dirty.value).toBe(true)
    expect(h.core.canUndo.value).toBe(true)

    const result = await h.core.createNew()

    expect(result.status).toBe('opened')
    expect(designSessionStore.readDesignName()).toBe('Untitled')
    expect(h.core.dirty.value).toBe(false)
    expect(h.core.canUndo.value).toBe(false)
  })
})
