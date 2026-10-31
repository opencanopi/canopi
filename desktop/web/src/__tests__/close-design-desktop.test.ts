import { signal } from '@preact/signals'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  canvasSession: null as unknown,
  saveDesign: vi.fn(),
  saveDesignDraft: vi.fn(),
  loadDesign: vi.fn(),
  newDesign: vi.fn(),
  requestSaveDecision: vi.fn(),
  message: vi.fn(),
}))

vi.mock('../canvas/session', async (importOriginal) => {
  const actual = await importOriginal<typeof CanvasSessionModule>()
  return {
    ...actual,
    getCurrentCanvasSession: () => mocks.canvasSession,
    getCurrentCanvasDocumentSurface: () => mocks.canvasSession,
  }
})

vi.mock('../ipc/design', async () => {
  const { prepareDesignWriteDestination } = await import(
    '../app/document-session/write-admission'
  )
  return {
    selectDesignSavePath: vi.fn(),
    prepareDesignWrite: (
      path: string,
      _expectedFingerprint: string | null,
      onWritten: (fingerprint: string) => void,
    ) => prepareDesignWriteDestination({
      resource: `native-design:${path}`,
      destinationPath: path,
      write: (content) => mocks.saveDesign(path, content).then(() => onWritten(`fp-${path}`)),
    }),
    prepareDraftWrite: (id: string) => prepareDesignWriteDestination({
      resource: `native-draft:${id}`,
      write: (content) => mocks.saveDesignDraft(id, content),
    }),
    deleteDesignDraft: vi.fn(async () => undefined),
    openDesignDialog: vi.fn(),
    loadDesign: mocks.loadDesign,
    newDesign: mocks.newDesign,
  }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({ message: mocks.message }))

vi.mock('../app/document-session/save-problem', () => ({
  requestSaveProblemDecision: mocks.requestSaveDecision,
}))

vi.mock('../app/document-session/workflows', () => ({
  DESIGN_SESSION_WORKFLOWS: [],
}))

import type { CanvasDocumentSurface } from '../canvas/runtime/runtime'
import { SceneHistory } from '../canvas/runtime/scene-history'
import { SceneStore } from '../canvas/runtime/scene'
import { SceneRuntimeEditCoordinator } from '../canvas/runtime/scene-runtime/transactions'
import type { SceneCommand } from '../canvas/runtime/scene-commands'
import {
  createDesignSessionStateMachine,
  type DesignSessionStateMachine,
} from '../app/document-session/state-machine'
import {
  createDesignSessionStore,
  type PersistenceCapableDesignSessionStore,
} from '../app/document-session/store'
import { closeDesign } from '../app/document-session/actions'
import { resetDesignSessionStateForTests } from '../app/document-session/transition'
import { designSessionFixture, currentDesign } from './support/design-session-state'
import { editDesignSessionForTest } from './support/design-session-edit'
import type { CanopiFile } from '../types/design'
import type * as CanvasSessionModule from '../canvas/session'

function makeFile(name: string, plantCount = 0): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: Array.from({ length: plantCount }, (_, index) => ({
      id: `plant-${index}`,
      canonical_name: 'Malus domestica',
      common_name: null,
      color: null,
      position: { lon: 2 + index * 1e-5, lat: 48 },
      rotation: null,
      scale: null,
      notes: null,
      planted_date: null,
      quantity: null,
    })) as CanopiFile['plants'],
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
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    extra: {},
  }
}

interface SceneSession extends CanvasDocumentSurface {
  readonly history: SceneHistory
  readonly sceneStore: SceneStore
}

// A document surface over the real Scene authority, so a close is observed
// through the Scene content and undo history it leaves behind.
function makeSceneSession(file: CanopiFile): SceneSession {
  const history = new SceneHistory()
  const sceneStore = new SceneStore().hydrate(file)
  const authority = new SceneRuntimeEditCoordinator({
    sceneStore,
    history,
    setSelection: (ids) => sceneStore.setSelection(ids),
    incrementSceneRevision: () => {},
    syncCanvasSignalsFromScene: () => {},
    invalidate: () => {},
  })
  return {
    history,
    sceneStore,
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
    showCanvasChrome: vi.fn(),
    hideCanvasChrome: vi.fn(),
    zoomToFit: vi.fn(),
    loadDocument: vi.fn((next: CanopiFile) => authority.hydrate(next)),
    replaceDocument: vi.fn((next, token, finalizeReplacement) => ({
      callerFinalizerInvoked: authority.replaceDocument(next, {
        token,
        prepare: () => {},
        finalizeReplacement,
      }),
    })),
    hasLoadedDocument: vi.fn(() => true),
    captureForPersistence: vi.fn((metadata, document) => {
      const capture = authority.capturePersistence()
      return {
        content: { ...document, name: metadata.name },
        isCurrent: () => capture.isCurrent(),
        acknowledgeSaved: () => capture.acknowledgeSaved(),
      }
    }),
    resize: vi.fn(),
    destroy: vi.fn(() => authority.disposePersistence()),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let store: PersistenceCapableDesignSessionStore
let machine: DesignSessionStateMachine
let session: SceneSession

function openCurrent(file = makeFile('Current', 2)): void {
  store = createDesignSessionStore({ file, path: '/designs/current.canopi', name: 'Current' })
  session = makeSceneSession(file)
  machine = createDesignSessionStateMachine({
    store,
    getCurrentSession: () => session,
    requestSaveDecision: mocks.requestSaveDecision,
  })
  machine.beginEmptyDocumentSession(session)
  machine.continuousSave.beginSession({
    draftId: null,
    fingerprint: 'fp-current',
    writePending: false,
  })
}

function makeDirty(description: string): void {
  editDesignSessionForTest(store, (design) => ({ ...design, description }))
  // An undoable Scene edit the close must drop.
  session.history.record({ type: 'test-edit' } as unknown as SceneCommand, () => {})
}

beforeEach(() => {
  mocks.canvasSession = null
  mocks.saveDesign.mockReset()
  mocks.saveDesign.mockResolvedValue(undefined)
  mocks.saveDesignDraft.mockReset()
  mocks.saveDesignDraft.mockResolvedValue(undefined)
  mocks.loadDesign.mockReset()
  mocks.newDesign.mockReset()
  mocks.requestSaveDecision.mockReset()
  mocks.requestSaveDecision.mockResolvedValue('cancel')
  mocks.message.mockReset()
  openCurrent()
})

describe('Desktop Close Design', () => {
  it('writes pending changes home, then empties the store, the Scene and undo history', async () => {
    makeDirty('last edit')
    expect(session.history.canUndo.value).toBe(true)
    vi.mocked(session.showCanvasChrome).mockClear()

    const result = await machine.closeDesign()

    expect(result.status).toBe('applied')
    expect(mocks.saveDesign).toHaveBeenCalledTimes(1)
    expect(mocks.saveDesign.mock.calls[0]?.[0]).toBe('/designs/current.canopi')
    expect(mocks.saveDesign.mock.calls[0]?.[1]).toMatchObject({ description: 'last edit' })
    expect(mocks.requestSaveDecision).not.toHaveBeenCalled()

    expect(store.readCurrentDesign()).toBeNull()
    expect(store.readDesignPath()).toBeNull()
    expect(store.isDesignDirty()).toBe(false)
    expect(session.sceneStore.persisted.plants.length).toBe(0)
    expect(session.history.canUndo.value).toBe(false)
    expect(session.hideCanvasChrome).toHaveBeenCalled()
    expect(session.showCanvasChrome).not.toHaveBeenCalled()
  })

  it('ends continuous save: the closed Design home is never written again', async () => {
    vi.useFakeTimers()
    const uninstall = machine.continuousSave.install()
    try {
      await machine.closeDesign()
      mocks.saveDesign.mockClear()

      expect(machine.continuousSave.sessionToken()).toBeNull()
      expect(machine.continuousSave.readHome()).toBeNull()
      expect(machine.continuousSave.status.value).toBe('saved')
      expect(machine.continuousSave.revertAvailable.value).toBe(false)
      await expect(machine.continuousSave.flush()).resolves.toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mocks.saveDesign).not.toHaveBeenCalled()
      expect(mocks.saveDesignDraft).not.toHaveBeenCalled()
    } finally {
      uninstall()
      vi.useRealTimers()
    }
  })

  it('asks when the write fails; Cancel keeps the Design open and Discard closes it', async () => {
    makeDirty('unwritable')
    mocks.saveDesign.mockRejectedValue(new Error('disk full'))
    mocks.requestSaveDecision.mockResolvedValueOnce('cancel')

    await expect(machine.closeDesign()).resolves.toMatchObject({ status: 'cancelled' })

    // The dialog offers "Close without saving", not "Discard changes".
    expect(mocks.requestSaveDecision).toHaveBeenCalledWith({
      kind: 'flush-failed',
      purpose: 'close',
      conflict: false,
    })
    expect(store.readCurrentDesign()?.description).toBe('unwritable')
    expect(session.sceneStore.persisted.plants.length).toBe(2)
    expect(session.history.canUndo.value).toBe(true)
    expect(machine.continuousSave.sessionToken()).not.toBeNull()

    mocks.requestSaveDecision.mockResolvedValueOnce('discard')
    await expect(machine.closeDesign()).resolves.toMatchObject({ status: 'applied' })
    expect(store.readCurrentDesign()).toBeNull()
    expect(session.history.canUndo.value).toBe(false)
  })

  it('does nothing when no Design is open', async () => {
    await machine.closeDesign()
    vi.mocked(session.replaceDocument).mockClear()
    vi.mocked(session.hideCanvasChrome).mockClear()

    await expect(machine.closeDesign()).resolves.toMatchObject({ status: 'cancelled' })

    expect(session.replaceDocument).not.toHaveBeenCalled()
    expect(session.hideCanvasChrome).not.toHaveBeenCalled()
    expect(mocks.requestSaveDecision).not.toHaveBeenCalled()
  })

  it('opens and creates Designs normally after a close', async () => {
    await machine.closeDesign()
    const opened = makeFile('Opened', 1)
    mocks.loadDesign.mockResolvedValue({ file: opened, fingerprint: 'fp-opened' })

    const result = await machine.transitionDocument({
      source: 'open-path',
      dirtyGuard: 'flush',
      load: async () => {
        const loaded = await mocks.loadDesign('/designs/opened.canopi')
        return { file: loaded.file, path: '/designs/opened.canopi', name: 'Opened', fingerprint: loaded.fingerprint }
      },
    })

    expect(result.status).toBe('applied')
    expect(store.readDesignName()).toBe('Opened')
    expect(session.sceneStore.persisted.plants.length).toBe(1)
    expect(session.showCanvasChrome).toHaveBeenCalled()
    expect(machine.continuousSave.readHome()).toEqual({
      kind: 'file',
      path: '/designs/opened.canopi',
      fingerprint: 'fp-opened',
    })

    await machine.closeDesign()
    await machine.transitionDocument({
      source: 'new',
      dirtyGuard: 'flush',
      load: async () => ({ file: makeFile('Untitled'), path: null, name: 'Untitled', draftId: 'draft-new' }),
    })
    expect(store.readDesignName()).toBe('Untitled')
    expect(machine.continuousSave.readHome()).toEqual({ kind: 'draft', id: 'draft-new' })
  })

  it('closes a Design while no Canvas is attached', async () => {
    store = createDesignSessionStore({ file: makeFile('Detached'), path: null, name: 'Detached' })
    machine = createDesignSessionStateMachine({
      store,
      getCurrentSession: () => null,
      requestSaveDecision: mocks.requestSaveDecision,
    })

    await expect(machine.closeDesign()).resolves.toMatchObject({ status: 'applied' })
    expect(store.readCurrentDesign()).toBeNull()
  })

  it('does not clear a Design opened while the close was still writing', async () => {
    makeDirty('pending')
    const write = deferred<void>()
    mocks.saveDesign.mockReturnValueOnce(write.promise)
    const closing = machine.closeDesign()

    const opened = makeFile('Opened', 1)
    const opening = machine.transitionDocument({
      source: 'open-path',
      dirtyGuard: 'flush',
      load: async () => ({ file: opened, path: '/designs/opened.canopi', name: 'Opened', fingerprint: 'fp-opened' }),
    })
    write.resolve()

    await expect(closing).resolves.toMatchObject({ status: 'cancelled' })
    await expect(opening).resolves.toMatchObject({ status: 'applied' })
    expect(store.readDesignName()).toBe('Opened')
    expect(session.sceneStore.persisted.plants.length).toBe(1)
    expect(machine.continuousSave.readHome()).toMatchObject({ path: '/designs/opened.canopi' })
  })

  it('a close issued while an open is loading wins and the open does not apply', async () => {
    const load = deferred<CanopiFile>()
    const opening = machine.transitionDocument({
      source: 'open-path',
      dirtyGuard: 'flush',
      load: async () => ({ file: await load.promise, path: '/designs/opened.canopi', name: 'Opened' }),
    })
    await Promise.resolve()
    const closing = machine.closeDesign()
    load.resolve(makeFile('Opened', 1))

    await expect(closing).resolves.toMatchObject({ status: 'applied' })
    await expect(opening).resolves.toMatchObject({ status: 'cancelled' })
    expect(store.readCurrentDesign()).toBeNull()
    expect(session.sceneStore.persisted.plants.length).toBe(0)
  })
})

describe('closeDesign action', () => {
  beforeEach(() => {
    resetDesignSessionStateForTests()
    designSessionFixture.file = makeFile('Current')
    designSessionFixture.path = '/designs/current.canopi'
    designSessionFixture.name = 'Current'
  })

  it('closes the current Design through the shared Desktop Design Session', async () => {
    await closeDesign()
    expect(currentDesign.value).toBeNull()
  })

  it('throws when the close fails', async () => {
    const failing = makeSceneSession(makeFile('Current'))
    vi.mocked(failing.replaceDocument).mockImplementation(() => {
      throw new Error('Scene refused the close')
    })
    mocks.canvasSession = failing
    await expect(closeDesign()).rejects.toThrow('Scene refused the close')
    mocks.canvasSession = null
  })
})
