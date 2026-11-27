// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flattenDocumentForJson as encodeCanopiDesign } from '../app/contracts/document'
import { designRevertAvailable, newDesignAction, openDesignDraft } from '../app/document-session/actions'
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore, type SessionCore } from '../app/document-session/live-core'
import { designSessionStore } from '../app/document-session/store'
import type { ScenePort } from '../app/document-session/core/scene-half'
import type { SceneCommand } from '../canvas/runtime/scene-commands'
import type { CanopiFile } from '../types/design'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../web/browser-app-data'
import { browserAppLifecyclePort, browserFileAccessPort } from '../editions/web/session-ports'
import { createBrowserSessionHomeStore } from './support/browser-session-home-store'
import { readWebDesignIdentity } from '../editions/web/web-session'
import { editDesignSessionForTest } from './support/design-session-edit'
import { createTestDesignCore } from './support/design-wire'

const CONTINUOUS_SAVE_DELAY_MS = 1500
const NOW = new Date('2026-09-27T12:00:00.000Z')

interface MemoryStorage extends BrowserStorageAdapter {
  failWrites: boolean
}

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>()
  return {
    failWrites: false,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (this.failWrites) throw new Error('storage unavailable')
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

function makeFile(name: string): CanopiFile {
  return {
    version: 10,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    extra: {},
  }
}

function makeScenePort() {
  return {
    load: vi.fn<ScenePort['load']>(),
    serialize: vi.fn<ScenePort['serialize']>(() => ({
      plant_species_colors: {},
      layers: [],
      plants: [],
      zones: [],
      annotations: [],
      measurement_guides: [],
      groups: [],
    })),
    replay: vi.fn<ScenePort['replay']>(),
  } satisfies ScenePort
}

const disposers: Array<() => void> = []

function setup() {
  const storage = memoryStorage()
  const appDataStore = createBrowserAppDataStore({ storage })
  const designHome = createBrowserSessionHomeStore(appDataStore, () => NOW)
  const core: SessionCore = createSessionCore({
    designHome,
    fileAccess: browserFileAccessPort,
    lifecycle: browserAppLifecyclePort,
    codec: createJsonSessionCodec({ designCore: createTestDesignCore() }),
    settings: {
      readLastOpenHome: async () => null,
      writeLastOpenHome: async () => {},
    },
    newDesignFactory: () => makeFile('Untitled'),
    flushDelayMs: CONTINUOUS_SAVE_DELAY_MS,
  })
  const dispose = installLiveSessionCore(core)
  disposers.push(dispose)
  const scenePort = makeScenePort()
  core.attachScene(scenePort)
  return { storage, appDataStore, core, scenePort, dispose }
}

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Web Close Design', () => {
  it('writes the Draft, then empties the store, Scene history and continuous save', async () => {
    const { appDataStore, core } = setup()
    await newDesignAction()
    const draftId = core.currentDesign.peek()!.home.key
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'last edit' }))
    core.recordSceneEdit('test-edit', { type: 'test-edit' } as unknown as SceneCommand)
    expect(core.canUndo.value).toBe(true)

    await expect(core.close('close')).resolves.toBe('closed')

    expect(appDataStore.loadRawDraft(draftId)?.description).toBe('last edit')
    expect(designSessionStore.readCurrentDesign()).toBeNull()
    expect(designSessionStore.hasCurrentDesign()).toBe(false)
    expect(readWebDesignIdentity()).toBeNull()
    expect(core.canUndo.value).toBe(false)
    expect(designRevertAvailable.value).toBe(false)
    // The Draft stays in storage for the Start screen.
    expect(appDataStore.listDrafts().map((draft) => draft.id)).toEqual([draftId])
  })

  it('never writes the closed Design Draft again', async () => {
    vi.useFakeTimers()
    const { appDataStore, core } = setup()
    await newDesignAction()
    const draftId = core.currentDesign.peek()!.home.key
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'kept' }))
    await core.close('close')
    const writeRecord = vi.spyOn(appDataStore, 'writeRecord')

    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS * 4)
    await expect(core.flushNow()).resolves.toBe(true)

    expect(writeRecord).not.toHaveBeenCalled()
    expect(appDataStore.loadRawDraft(draftId)?.description).toBe('kept')
  })

  it('asks when the Draft write fails; Cancel keeps the Design and Discard closes it', async () => {
    const { storage, core } = setup()
    await newDesignAction()
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'unwritable' }))
    storage.failWrites = true

    const firstClose = core.close('close')
    await vi.waitFor(() => expect(core.state.value.kind).toBe('closing'))
    const q1 = core.state.value
    expect(q1.kind).toBe('closing')
    if (q1.kind === 'closing') {
      expect(q1.question?.kind).toBe('flush-failed-before-close')
      expect(q1.question?.purpose).toBe('close')
      core.answer(q1.question!.id, 'cancel')
    }
    await expect(firstClose).resolves.toBe('cancelled')
    expect(designSessionStore.readCurrentDesign()?.description).toBe('unwritable')

    const secondClose = core.close('close')
    await vi.waitFor(() => expect(core.state.value.kind).toBe('closing'))
    const q2 = core.state.value
    if (q2.kind === 'closing') {
      core.answer(q2.question!.id, 'discard')
    }
    await expect(secondClose).resolves.toBe('closed')
    expect(designSessionStore.readCurrentDesign()).toBeNull()
  })

  it('does nothing when no Design is open', async () => {
    const { core, scenePort } = setup()
    scenePort.load.mockClear()

    await expect(core.close('close')).resolves.toBe('closed')
    expect(scenePort.load).not.toHaveBeenCalled()
    expect(core.state.value.kind).toBe('idle')
  })

  it('creates, opens and reopens Drafts normally after a close', async () => {
    const { core } = setup()
    await newDesignAction()
    const firstDraftId = core.currentDesign.peek()!.home.key
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'first Draft' }))
    await core.close('close')

    await newDesignAction()
    expect(designSessionStore.readDesignName()).toBe('Untitled')
    await core.close('close')

    const bytes = new TextEncoder().encode(JSON.stringify(encodeCanopiDesign(makeFile('Opened'))))
    const openResult = await core.openFrom({ kind: 'bytes', name: 'opened.canopi', bytes })
    expect(openResult.status).toBe('opened')
    expect(designSessionStore.readDesignName()).toBe('Opened')
    await core.close('close')

    await openDesignDraft(firstDraftId, { presentFailure: false })
    expect(designSessionStore.readCurrentDesign()?.description).toBe('first Draft')
  })

  it('does not leave a stale closing question able to close after retry succeeds', async () => {
    const { storage, core } = setup()
    await newDesignAction()
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'unwritable' }))
    storage.failWrites = true

    const closing = core.close('close')
    await vi.waitFor(() => expect(core.state.value.kind).toBe('closing'))
    const q = core.state.value
    expect(q.kind).toBe('closing')
    const questionId = q.kind === 'closing' ? q.question!.id : null
    expect(questionId).not.toBeNull()

    // Fix storage and answer retry: close flushes the edit and closes cleanly.
    storage.failWrites = false
    expect(core.answer(questionId!, 'retry')).toBe('answered')
    await expect(closing).resolves.toBe('closed')
    // Answering the same question id again is stale.
    expect(core.answer(questionId!, 'discard')).toBe('stale')
    expect(designSessionStore.readCurrentDesign()).toBeNull()
  })
})
