// The read-only Session kind (2.1-M478, design check F3; canopi-f47t.52.270): a Design a newer Canopi saved opens on the
// one replacement path in `read-only{origin: newer-version}`, with no home, Draft id or write destination; continuous
// save writes nothing, Design Edit refuses edits, Save, Save As and Revert are off, and Close ends it through the close
// replacement without asking. The Canvas here is the real Scene authority, so what a close leaves is read from its
// Scene content and undo history.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  saveDesign: vi.fn(),
  saveDesignDraft: vi.fn(),
  prepareDesignWrite: vi.fn(),
  prepareDraftWrite: vi.fn(),
  selectDesignSavePath: vi.fn(),
  requestSaveDecision: vi.fn(),
  createDraftId: vi.fn(() => 'draft-minted'),
}))

vi.mock('./save-problem', () => ({ requestSaveProblemDecision: mocks.requestSaveDecision }))
vi.mock('./workflows', () => ({ DESIGN_SESSION_WORKFLOWS: [] }))

import { DesignHomeConflictError } from './continuous-save'
import { prepareDesignWriteDestination } from './write-admission'
import { draftLoadResultOf, loadResultOf, type DocumentTransitionLoadResult } from './load-result'
import { createDesignSessionStateMachine, type DesignSessionStateMachine } from './state-machine'
import { createDesignSessionStore, designSessionStore, type PersistenceCapableDesignSessionStore } from './store'
import { createAppCanvasRuntimeAppAdapter } from '../canvas-runtime/app-adapter'
import type { CanvasDocumentSurface } from '../../canvas/runtime/runtime'
import { createDetachedCanvasRuntimeAppAdapter } from '../../canvas/runtime/app-adapter'
import { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'
import type { ReadOnlyDesign } from '../../generated/contracts'
import type { CanopiFile } from '../../types/design'
import {
  editDesignSessionForTest,
  markDesignSessionDirtyForTest,
  reconcileDesignSessionForTest,
} from '../../__tests__/support/design-session-edit'

const EMPTY_DESIGN: Omit<CanopiFile, 'name' | 'plants'> = {
  version: 9,
  description: null,
  plant_species_colors: {},
  plant_species_symbols: {},
  layers: [],
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

/** The `index`th apple tree of a row a metre or so apart. */
function apple(index: number): CanopiFile['plants'][number] {
  return {
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
  } as CanopiFile['plants'][number]
}

function makeFile(name: string, plantCount = 0): CanopiFile {
  return { ...EMPTY_DESIGN, name, plants: Array.from({ length: plantCount }, (_, index) => apple(index)) }
}

interface SceneSession extends CanvasDocumentSurface {
  readonly runtime: SceneCanvasRuntime
  /** The Scene's plants, as its query surface reads them. */
  plantCount(): number
  readonly canUndo: () => boolean
  undo(): void
}

/**
 * The real Scene runtime, built by the real construction with the app adapter's read-only query answering the Design
 * session (as app/canvas-runtime/app-adapter.ts does): its document surface is the Session's surface.
 */
function makeSceneSession(file: CanopiFile): SceneSession {
  const runtime = new SceneCanvasRuntime({
    appAdapter: { ...createDetachedCanvasRuntimeAppAdapter(), isReadOnly: () => store.isReadOnly() },
  })
  const surface = runtime.documentSurface
  surface.loadDocument(file)
  vi.spyOn(surface, 'showCanvasChrome')
  vi.spyOn(surface, 'hideCanvasChrome')
  return Object.assign(surface, {
    runtime,
    plantCount: () => runtime.querySurface.getSceneSnapshot().plants.length,
    canUndo: () => runtime.commandSurface.history.canUndo.value,
    undo: () => runtime.commandSurface.history.undo(),
  })
}

/** What load_design answers for a `.canopi` v10 file: the read view, never a fingerprint. */
function newerDesign(name: string, plantCount = 3): ReadOnlyDesign {
  return { view: makeFile(name, plantCount), saved_by_version: 10 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

let store: PersistenceCapableDesignSessionStore
let machine: DesignSessionStateMachine
let session: SceneSession

/** An editing Design open from its file, as the reader release has one before the user opens a newer file. */
function openEditing(): void {
  const file = makeFile('Current', 2)
  store = createDesignSessionStore({ file, path: '/designs/current.canopi', name: 'Current' })
  session = makeSceneSession(file)
  machine = createDesignSessionStateMachine({
    store,
    getCurrentSession: () => session,
    requestSaveDecision: mocks.requestSaveDecision,
    selectDesignSavePath: mocks.selectDesignSavePath,
    prepareDesignWrite: mocks.prepareDesignWrite,
    prepareDraftWrite: mocks.prepareDraftWrite,
    createDraftId: mocks.createDraftId,
  })
  machine.beginEmptyDocumentSession(session)
  machine.continuousSave.beginSession({ draftId: null, fingerprint: 'fp-current', writePending: false })
}

function openPath(load: () => Promise<DocumentTransitionLoadResult>) {
  return machine.transitionDocument({ source: 'open-path', dirtyGuard: 'flush', load })
}

function openNewer(name = 'Orchard 2.1', plantCount = 3) {
  return openPath(async () => loadResultOf(newerDesign(name, plantCount), `/designs/${name}.canopi`))
}

/** An edit the user tries on the map, and the canvas reporting a change: over a read-only Design the edit is refused. */
function editScene(): void {
  session.runtime.commandSurface.sceneEdits.selectAll()
  session.runtime.commandSurface.sceneEdits.deleteSelected()
  store.setCanvasClean(false)
}

function expectNothingWritten(): void {
  expect(mocks.prepareDesignWrite).not.toHaveBeenCalled()
  expect(mocks.prepareDraftWrite).not.toHaveBeenCalled()
  expect(mocks.saveDesign).not.toHaveBeenCalled()
  expect(mocks.saveDesignDraft).not.toHaveBeenCalled()
  expect(mocks.createDraftId).not.toHaveBeenCalled()
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.saveDesign.mockResolvedValue(undefined)
  mocks.saveDesignDraft.mockResolvedValue(undefined)
  mocks.prepareDesignWrite.mockImplementation((path: string, _fingerprint: string | null, onWritten: (fingerprint: string) => void) =>
    prepareDesignWriteDestination({
      resource: `native-design:${path}`,
      destinationPath: path,
      write: (content) => mocks.saveDesign(path, content).then(() => onWritten(`fp-${path}`)),
    }))
  mocks.prepareDraftWrite.mockImplementation((id: string) => prepareDesignWriteDestination({
    resource: `native-draft:${id}`,
    write: (content) => mocks.saveDesignDraft(id, content),
  }))
  mocks.requestSaveDecision.mockResolvedValue('cancel')
  openEditing()
})

describe('the read-only Session kind (canopi-f47t.52.270)', () => {
  it('A newer Design opens in the read-only view outside the editing Session', async () => {
    const result = await openNewer('Orchard 2.1', 3)

    expect(result.status).toBe('applied')
    expect(store.sessionKind.value).toEqual({ kind: 'read-only', origin: 'newer-version', savedByVersion: 10 })
    expect(store.readDesignName()).toBe('Orchard 2.1')
    expect(session.plantCount()).toBe(3)
    expect(session.showCanvasChrome).toHaveBeenCalled()
    // No home, Draft id or write destination.
    expect(store.readDesignPath()).toBeNull()
    expect(machine.continuousSave.sessionToken()).toBeNull()
    expect(machine.continuousSave.readHome()).toBeNull()
    expect(machine.continuousSave.status.value).toBe('read-only')
    expect(machine.continuousSave.revertAvailable.value).toBe(false)
    expect(machine.continuousSave.leaveGuardArmed.value).toBe(false)
    expectNothingWritten()
  })

  it("the app's canvas adapter answers the Design session's read-only state, which the Scene authority refuses edits on", () => {
    const adapter = createAppCanvasRuntimeAppAdapter({ presentationData: {} })
    try {
      expect(adapter.isReadOnly?.()).toBe(false)
      designSessionStore.replaceCurrentDesignState(makeFile('Orchard 2.1'), null, 'Orchard 2.1', {
        kind: 'read-only', origin: 'newer-version', savedByVersion: 10,
      })
      expect(adapter.isReadOnly?.()).toBe(true)
    } finally {
      designSessionStore.clearCurrentDesign()
    }
    expect(adapter.isReadOnly?.()).toBe(false)
  })

  it('a newer Draft opens read-only without its Draft id; a 2.0 Draft keeps it', () => {
    expect(draftLoadResultOf(newerDesign('Newer draft'), 'draft-newer')).toMatchObject({
      path: null,
      name: 'Newer draft',
      session: { kind: 'read-only', origin: 'newer-version', savedByVersion: 10 },
    })
    expect(draftLoadResultOf(newerDesign('Newer draft'), 'draft-newer').draftId).toBeUndefined()
    expect(draftLoadResultOf(makeFile('Old draft'), 'draft-old')).toEqual({
      file: makeFile('Old draft'),
      path: null,
      name: 'Old draft',
      draftId: 'draft-old',
    })
  })

  it('Design Edit refuses edits and rename; reconciling marks nothing', async () => {
    await openNewer()
    const shown = store.readCurrentDesign()

    expect(editDesignSessionForTest(store, (design) => ({ ...design, description: 'edited' }))).toBeNull()
    markDesignSessionDirtyForTest(store)
    expect(store.renameCurrentDesign('Renamed')).toBe(false)
    reconcileDesignSessionForTest(store, (design) => ({ ...design, description: 'reconciled' }))

    expect(store.readCurrentDesign()?.description).toBe('reconciled')
    expect(store.readDesignName()).toBe('Orchard 2.1')
    expect(store.isDesignDirty()).toBe(false)
    expect(shown?.description).toBeNull()
  })

  it('the Scene refuses edits: Duplicate, Delete or Undo leaves the shown Design; a selection still applies', async () => {
    await openNewer('Orchard 2.1', 3)
    const { runtime } = session
    const shown = runtime.querySurface.getSceneSnapshot()
    expect(runtime.cameraHost.frames.viewFrame.peek().mode).toBe('site')

    runtime.commandSurface.sceneEdits.selectAll()
    expect(runtime.querySurface.getSelection()).toHaveLength(3)
    runtime.commandSurface.sceneEdits.duplicateSelected()
    runtime.commandSurface.sceneEdits.deleteSelected()

    expect(runtime.querySurface.getSceneSnapshot()).toEqual(shown)
    expect(session.plantCount()).toBe(3)
    expect(session.canUndo()).toBe(false)
    session.undo()
    expect(runtime.querySurface.getSceneSnapshot()).toEqual(shown)

    // The same Delete removes an editing Design's plants: the read-only refusal, not the view, kept them.
    await machine.closeDesign()
    await openPath(async () => ({ file: makeFile('Mine', 2), path: '/designs/mine.canopi', name: 'Mine', fingerprint: 'fp-mine' }))
    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.sceneEdits.deleteSelected()
    expect(session.plantCount()).toBe(0)
    expect(session.canUndo()).toBe(true)
  })

  it('runs no continuous save or page-hide flush, even after a Scene change', async () => {
    vi.useFakeTimers()
    const uninstall = machine.continuousSave.install()
    try {
      await openNewer()
      editScene()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(machine.continuousSave.hasPendingChanges()).toBe(false)
      expect(machine.continuousSave.flushNow()).toBe(true)
      await expect(machine.continuousSave.flush()).resolves.toBe(true)
      await expect(machine.continuousSave.save()).resolves.toBe(true)
      expect(machine.continuousSave.status.value).toBe('read-only')
      expect(machine.continuousSave.leaveGuardArmed.value).toBe(false)
      expectNothingWritten()
    } finally {
      uninstall()
      vi.useRealTimers()
    }
  })

  it('Save, Save As and Revert are off: nothing is written and no path is asked for', async () => {
    await openNewer()
    editScene()

    await expect(machine.saveCurrentDesign()).resolves.toBe(false)
    await expect(machine.saveCurrentDesignEdits()).resolves.toBe(false)
    await expect(machine.saveAsCurrentDesign()).resolves.toBeNull()
    await expect(machine.revertToOpenedVersion()).resolves.toMatchObject({ status: 'cancelled' })

    expect(mocks.selectDesignSavePath).not.toHaveBeenCalled()
    expect(mocks.requestSaveDecision).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('reader release: closing the read-only view leaves no scene or Document state for the next Design', async () => {
    await openNewer('Orchard 2.1', 3)
    editScene()
    // The Scene authority refused the edit: the read-only view has no undo step to leave behind.
    expect(session.canUndo()).toBe(false)

    await expect(machine.closeDesign()).resolves.toMatchObject({ status: 'applied' })

    // Close asks nothing and writes nothing (no leave prompt, 2.1-M478).
    expect(mocks.requestSaveDecision).not.toHaveBeenCalled()
    expectNothingWritten()
    expect(store.readCurrentDesign()).toBeNull()
    expect(store.sessionKind.value).toEqual({ kind: 'editing' })
    expect(store.isDesignDirty()).toBe(false)
    expect(session.plantCount()).toBe(0)
    expect(session.canUndo()).toBe(false)
    expect(session.hideCanvasChrome).toHaveBeenCalled()

    // The next Design is an editing session with its own home and nothing of the read-only one.
    const next = makeFile('Next', 1)
    await openPath(async () => ({ file: next, path: '/designs/next.canopi', name: 'Next', fingerprint: 'fp-next' }))
    expect(store.sessionKind.value).toEqual({ kind: 'editing' })
    expect(session.plantCount()).toBe(1)
    expect(session.canUndo()).toBe(false)
    expect(machine.continuousSave.readHome()).toEqual({ kind: 'file', path: '/designs/next.canopi', fingerprint: 'fp-next' })
    expect(editDesignSessionForTest(store, (design) => ({ ...design, description: 'mine' }))?.description).toBe('mine')
    await expect(machine.continuousSave.flush()).resolves.toBe(true)
    expect(mocks.saveDesign).toHaveBeenCalledTimes(1)
    expect(mocks.saveDesign.mock.calls[0]?.[0]).toBe('/designs/next.canopi')
  })

  it('opening a newer Design writes the editing Design home first, then holds no home of it', async () => {
    editDesignSessionForTest(store, (design) => ({ ...design, description: 'last edit' }))

    await openNewer()

    expect(mocks.saveDesign).toHaveBeenCalledTimes(1)
    expect(mocks.saveDesign.mock.calls[0]?.[0]).toBe('/designs/current.canopi')
    mocks.saveDesign.mockClear()
    editScene()
    await expect(machine.continuousSave.flush()).resolves.toBe(true)
    expect(mocks.saveDesign).not.toHaveBeenCalled()
  })

  describe('failure states', () => {
    it('another open or Close while a decode is pending: the pending result is discarded and nothing applies', async () => {
      const decode = deferred<ReadOnlyDesign>()
      const opening = openPath(async () => loadResultOf(await decode.promise, '/designs/newer.canopi'))
      await Promise.resolve()
      const closing = machine.closeDesign()
      decode.resolve(newerDesign('Too late'))

      await expect(closing).resolves.toMatchObject({ status: 'applied' })
      await expect(opening).resolves.toMatchObject({ status: 'cancelled' })
      expect(store.readCurrentDesign()).toBeNull()
      expect(store.sessionKind.value).toEqual({ kind: 'editing' })
      expect(session.plantCount()).toBe(0)

      const second = deferred<ReadOnlyDesign>()
      const pending = openPath(async () => loadResultOf(await second.promise, '/designs/newer.canopi'))
      await Promise.resolve()
      const other = openPath(async () => ({ file: makeFile('Other', 2), path: '/designs/other.canopi', name: 'Other', fingerprint: 'fp-other' }))
      second.resolve(newerDesign('Too late'))

      await expect(other).resolves.toMatchObject({ status: 'applied' })
      await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
      expect(store.readDesignName()).toBe('Other')
      expect(store.sessionKind.value).toEqual({ kind: 'editing' })
      expect(machine.continuousSave.readHome()).toMatchObject({ kind: 'file', path: '/designs/other.canopi' })
      expect(mocks.createDraftId).not.toHaveBeenCalled()
    })

    it('file changed or removed on disk while shown: nothing is watched or written, and Close asks nothing', async () => {
      await openNewer()
      // Were anything written, the file would answer that it is gone.
      mocks.saveDesign.mockRejectedValue(new DesignHomeConflictError(true))
      editScene()

      await expect(machine.continuousSave.flush()).resolves.toBe(true)
      expect(machine.continuousSave.conflict.value).toBeNull()
      expect(machine.continuousSave.status.value).toBe('read-only')
      await expect(machine.resolveSaveConflict()).resolves.toBeNull()
      await expect(machine.closeDesign()).resolves.toMatchObject({ status: 'applied' })

      expect(mocks.requestSaveDecision).not.toHaveBeenCalled()
      expectNothingWritten()
    })
  })
})
