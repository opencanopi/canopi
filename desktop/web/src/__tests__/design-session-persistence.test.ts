import { effect, signal } from '@preact/signals'
import { describe, expect, it, vi } from 'vitest'
import type {
  CanvasDocumentSurface,
  CanvasPersistenceAcknowledgement,
} from '../canvas/runtime/runtime'
import type { CanopiFile } from '../types/design'

import {
  createDesignSessionPersistence,
  DesignPersistenceBusyError,
  DesignPersistenceSettlementError,
} from '../app/document-session/persistence'
import { disposeDesignEditAuthority } from '../app/design-edit/authority-capability'
import {
  prepareDesignWriteDestination,
  prepareSynchronousDesignWriteDestination,
} from '../app/document-session/write-admission'
import {
  createDesignSessionStoreTestFixture,
  createDesignSessionStore,
} from '../app/document-session/store'
import { captureDesignSessionPersistenceState } from '../app/document-session/persistence-capability'
import {
  editDesignSessionForTest,
  markDesignSessionDirtyForTest,
  reconcileDesignSessionForTest,
} from './support/design-session-edit'

function makeDesign(name = 'Design'): CanopiFile {
  return {
    version: 9,
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
    created_at: '2026-04-13T00:00:00.000Z',
    updated_at: '2026-04-13T00:00:00.000Z',
    extra: {},
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

type TestWrite = (content: CanopiFile) => void | Promise<void>

function designDestination(path: string, write: TestWrite = () => undefined) {
  return prepareDesignWriteDestination({
    resource: `native-design:${path}`,
    destinationPath: path,
    write,
  })
}

function downloadDestination(write: TestWrite = () => undefined) {
  return prepareDesignWriteDestination({
    resource: 'browser-download:test',
    blocksReplacement: false,
    write,
  })
}

function draftDestination(
  write: (content: CanopiFile) => undefined = () => undefined,
) {
  return prepareSynchronousDesignWriteDestination({
    resource: 'browser-app-data:drafts',
    write,
  })
}

describe('purpose-aware Design persistence operations', () => {
  function checkpointSession(
    capture: (metadata: { name: string }, doc: CanopiFile) => CanopiFile =
      (metadata, doc) => ({ ...doc, name: metadata.name }),
  ): {
    readonly session: CanvasDocumentSurface
    readonly acknowledgeSaved: ReturnType<
      typeof vi.fn<() => CanvasPersistenceAcknowledgement>
    >
  } {
    const acknowledgeSaved = vi.fn<() => CanvasPersistenceAcknowledgement>(
      () => 'applied',
    )
    const session: CanvasDocumentSurface = {
      presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
      showCanvasChrome: vi.fn(),
      hideCanvasChrome: vi.fn(),
      zoomToFit: vi.fn(),
      loadDocument: vi.fn(),
      replaceDocument: vi.fn((_file, _token, finalizeReplacement) => {
        finalizeReplacement()
        return { callerFinalizerInvoked: true }
      }),
      hasLoadedDocument: vi.fn(() => true),
      captureForPersistence: vi.fn((metadata, doc) => ({
        content: capture(metadata, doc),
        isCurrent: () => true,
        acknowledgeSaved,
      })),
      resize: vi.fn(),
      destroy: vi.fn(),
    }
    return { session, acknowledgeSaved }
  }

  it('invalidates an empty-session replacement guard across authority rollover', () => {
    const operationStore = createDesignSessionStore()
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const guard = persistence.beginReplacementGuard().guard
    expect(guard?.isCurrent()).toBe(true)

    disposeDesignEditAuthority(operationStore)

    expect(guard?.isCurrent()).toBe(false)
  })

  it('writes captures to one durable resource in issue order', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const firstWrite = deferred<void>()
    const writes: Array<string | null> = []
    const destination = prepareDesignWriteDestination({
      resource: 'native-design:/designs/original.canopi',
      destinationPath: '/designs/original.canopi',
      async write(content) {
        writes.push(content.description)
        if (writes.length === 1) await firstWrite.promise
      },
    })

    const first = persistence.beginSave().execute(destination)
    await Promise.resolve()
    expect(writes).toEqual([null])

    editDesignSessionForTest(operationStore, (design) => ({
      ...design,
      description: 'newer capture',
    }))
    const second = persistence.beginSave().execute(destination)
    await Promise.resolve()

    expect(writes).toEqual([null])

    firstWrite.resolve()
    await expect(first).resolves.toMatchObject({ status: 'stale' })
    await expect(second).resolves.toMatchObject({
      status: 'applied',
      content: { description: 'newer capture' },
    })
    expect(writes).toEqual([null, 'newer capture'])
  })

  it('stays dirty when a successful write predates committed reconciliation', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const firstWrite = deferred<void>()
    const written: Array<string | null> = []
    const destination = designDestination('/designs/original.canopi', async (content) => {
      written.push(content.description)
      if (written.length === 1) await firstWrite.promise
    })

    const saving = persistence.beginSave().execute(destination)
    await Promise.resolve()
    reconcileDesignSessionForTest(operationStore, (design) => ({
      ...design,
      description: 'derived reconciliation',
    }))
    expect(operationStore.isDesignDirty()).toBe(false)

    firstWrite.resolve()
    await expect(saving).resolves.toMatchObject({
      status: 'applied',
      content: { description: null },
    })

    expect(operationStore.readCurrentDesign()?.description).toBe('derived reconciliation')
    expect(operationStore.isDesignDirty()).toBe(true)
    const dirtyGuard = persistence.beginReplacementGuard().guard
    expect(dirtyGuard?.isCurrent()).toBe(true)

    await expect(persistence.beginSave().execute(destination)).resolves.toMatchObject({
      status: 'applied',
      content: { description: 'derived reconciliation' },
    })
    expect(written).toEqual([null, 'derived reconciliation'])
    expect(operationStore.isDesignDirty()).toBe(false)
    expect(dirtyGuard?.isCurrent()).toBe(true)
  })

  it('invalidates an exact replacement guard when an older write latches divergence', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const pendingWrite = deferred<void>()
    const saving = persistence.beginSave().execute(designDestination(
      '/designs/original.canopi',
      () => pendingWrite.promise,
    ))
    await Promise.resolve()
    reconcileDesignSessionForTest(operationStore, (design) => ({
      ...design,
      description: 'derived reconciliation',
    }))
    const guard = persistence.beginReplacementGuard().guard
    expect(guard?.isCurrent()).toBe(true)

    pendingWrite.resolve()
    await expect(saving).resolves.toMatchObject({ status: 'applied' })

    expect(operationStore.isDesignDirty()).toBe(true)
    expect(guard?.isCurrent()).toBe(false)
  })

  it('latches divergence when clean acknowledgement reactively reconciles content', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    markDesignSessionDirtyForTest(operationStore)
    let reconcileWhenClean = true
    const dispose = effect(() => {
      if (!reconcileWhenClean || operationStore.designDirty.value) return
      reconcileWhenClean = false
      reconcileDesignSessionForTest(operationStore, (design) => ({
        ...design,
        description: 'reactive reconciliation',
      }))
    })

    try {
      await expect(persistence.beginSave().execute(
        designDestination('/designs/original.canopi'),
      )).resolves.toMatchObject({
        status: 'applied',
        content: { description: null },
      })

      expect(operationStore.readCurrentDesign()?.description)
        .toBe('reactive reconciliation')
      expect(operationStore.isDesignDirty()).toBe(true)
    } finally {
      dispose()
    }
  })

  it('does not apply an old acknowledgement latch to a reactively installed successor', async () => {
    const original = makeDesign('Original')
    const successor = makeDesign('Successor')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    markDesignSessionDirtyForTest(operationStore)
    let replaceWhenClean = true
    const dispose = effect(() => {
      if (!replaceWhenClean || operationStore.designDirty.value) return
      replaceWhenClean = false
      operationStore.replaceCurrentDesignState(successor, null, successor.name)
      operationStore.resetDirtyBaselines()
    })

    try {
      await expect(persistence.beginSave().execute(
        designDestination('/designs/original.canopi'),
      )).resolves.toMatchObject({ status: 'stale' })

      expect(operationStore.readCurrentDesign()).toBe(successor)
      expect(operationStore.isDesignDirty()).toBe(false)
    } finally {
      dispose()
    }
  })

  it('does not overwrite a reentrantly newer exact acknowledgement', () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    markDesignSessionDirtyForTest(operationStore)
    const olderCapture = captureDesignSessionPersistenceState(operationStore)
    reconcileDesignSessionForTest(operationStore, (design) => ({
      ...design,
      description: 'newer reconciliation',
    }))
    const newerCapture = captureDesignSessionPersistenceState(operationStore)
    const fixture = createDesignSessionStoreTestFixture(operationStore)
    let acknowledgeWhenSaved = true
    const dispose = effect(() => {
      if (!acknowledgeWhenSaved || fixture.nonCanvasSavedRevision.value === 0) return
      acknowledgeWhenSaved = false
      expect(newerCapture.acknowledgeSaved()).toBe('applied')
    })

    try {
      expect(olderCapture.acknowledgeSaved()).toBe('applied')

      expect(operationStore.readCurrentDesign()?.description)
        .toBe('newer reconciliation')
      expect(operationStore.isDesignDirty()).toBe(false)
    } finally {
      dispose()
    }
  })

  it('executes Save As only after a destination has been prepared', async () => {
    const operationStore = createDesignSessionStore({
      file: makeDesign('Garden Plan'),
      name: 'Garden Plan',
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const writes: string[] = []
    const destination = prepareDesignWriteDestination({
      resource: 'native-design:/designs/garden-plan.canopi',
      destinationPath: '/designs/garden-plan.canopi',
      write(content) {
        writes.push(content.name)
      },
    })

    const operation = persistence.beginSaveAs()
    const settlement = await operation.execute(destination)

    expect(writes).toEqual(['Garden Plan'])
    expect(settlement).toMatchObject({
      status: 'applied',
      path: '/designs/garden-plan.canopi',
    })
    expect(operationStore.readDesignPath()).toBe('/designs/garden-plan.canopi')
  })

  it('starts writes to different durable resources concurrently', async () => {
    const operationStore = createDesignSessionStore({
      file: makeDesign('Garden Plan'),
      name: 'Garden Plan',
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const firstWrite = deferred<void>()
    const started: string[] = []
    const firstDestination = prepareDesignWriteDestination({
      resource: 'native-design:/designs/first.canopi',
      destinationPath: '/designs/first.canopi',
      async write() {
        started.push('first')
        await firstWrite.promise
      },
    })
    const secondDestination = prepareDesignWriteDestination({
      resource: 'native-design:/designs/second.canopi',
      destinationPath: '/designs/second.canopi',
      write() {
        started.push('second')
      },
    })

    const first = persistence.beginSaveAs().execute(firstDestination)
    await Promise.resolve()
    const second = persistence.beginSaveAs().execute(secondDestination)
    await Promise.resolve()

    expect(started).toEqual(['first', 'second'])
    await expect(second).resolves.toMatchObject({ status: 'applied' })

    firstWrite.resolve()
    await expect(first).resolves.toMatchObject({ status: 'stale' })
  })

  it('skips queued writes whose Design Session was replaced', async () => {
    const operationStore = createDesignSessionStore({
      file: makeDesign('Predecessor'),
      path: '/designs/shared.canopi',
      name: 'Predecessor',
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const firstWrite = deferred<void>()
    const writes: string[] = []
    const destination = prepareDesignWriteDestination({
      resource: 'native-design:/designs/shared.canopi',
      destinationPath: '/designs/shared.canopi',
      async write(content) {
        writes.push(content.name)
        if (writes.length === 1) await firstWrite.promise
      },
    })

    const first = persistence.beginSave().execute(destination)
    await Promise.resolve()
    const queued = persistence.beginSave().execute(destination)
    operationStore.replaceCurrentDesignState(
      makeDesign('Successor'),
      '/designs/shared.canopi',
      'Successor',
    )
    firstWrite.resolve()

    await expect(first).resolves.toMatchObject({ status: 'stale' })
    await expect(queued).resolves.toMatchObject({ status: 'stale' })
    expect(writes).toEqual(['Predecessor'])
  })

  it('skips a queued capture after its Canvas attachment lease changes', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const firstCanvas = checkpointSession()
    const secondCanvas = checkpointSession()
    persistence.attachCanvas(firstCanvas.session)
    const firstWrite = deferred<void>()
    const writes: string[] = []
    const destination = designDestination('/designs/original.canopi', async (content) => {
      writes.push(content.name)
      if (writes.length === 1) await firstWrite.promise
    })

    const active = persistence.beginSnapshotSave().execute(destination)
    await Promise.resolve()
    const queued = persistence.beginSave().execute(destination)
    persistence.detachCanvas(firstCanvas.session)
    persistence.attachCanvas(secondCanvas.session)
    firstWrite.resolve()

    await expect(active).resolves.toMatchObject({ status: 'stale' })
    await expect(queued).resolves.toMatchObject({ status: 'stale' })
    expect(writes).toEqual(['Original'])
    expect(secondCanvas.session.captureForPersistence).not.toHaveBeenCalled()
  })

  it('releases a durable-resource lane after its writer fails', async () => {
    const operationStore = createDesignSessionStore({
      file: makeDesign('Garden Plan'),
      path: '/designs/shared.canopi',
      name: 'Garden Plan',
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const failedWrite = deferred<void>()
    const writes: string[] = []
    const destination = prepareDesignWriteDestination({
      resource: 'native-design:/designs/shared.canopi',
      destinationPath: '/designs/shared.canopi',
      async write() {
        writes.push(writes.length === 0 ? 'failed' : 'successor')
        if (writes.length === 1) await failedWrite.promise
      },
    })

    const first = persistence.beginSave().execute(destination)
    await Promise.resolve()
    const second = persistence.beginSave().execute(destination)
    failedWrite.reject(new Error('disk full'))

    await expect(first).rejects.toThrow('disk full')
    await expect(second).resolves.toMatchObject({ status: 'applied' })
    expect(writes).toEqual(['failed', 'successor'])
  })

  it('retries exact settlement without repeating a successful write', async () => {
    const operationStore = createDesignSessionStore({
      file: makeDesign('Garden Plan'),
      path: '/designs/garden-plan.canopi',
      name: 'Garden Plan',
    })
    const capture = checkpointSession()
    capture.acknowledgeSaved
      .mockImplementationOnce(() => {
        throw new Error('clean publication failed')
      })
      .mockReturnValue('applied')
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    const write = vi.fn()
    const destination = prepareDesignWriteDestination({
      resource: 'native-design:/designs/garden-plan.canopi',
      destinationPath: '/designs/garden-plan.canopi',
      write,
    })

    await expect(persistence.beginSave().execute(destination)).resolves.toMatchObject({
      status: 'applied',
    })
    expect(write).toHaveBeenCalledOnce()
    expect(capture.acknowledgeSaved).toHaveBeenCalledTimes(2)
  })

  it('reserves one operation execution before its writer reenters', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const operation = persistence.beginSave()
    let reentrantExecution!: Promise<unknown>
    const write = vi.fn()
    const destination = designDestination('/designs/original.canopi', () => {
      write()
      reentrantExecution = operation.execute(destination)
    })

    const execution = operation.execute(destination)
    await execution
    await reentrantExecution

    expect(reentrantExecution).toBe(execution)
    expect(write).toHaveBeenCalledOnce()
  })

  it('rejects synchronous same-operation reentry with a typed busy error', () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const operation = persistence.beginBrowserDraft()
    let reentrantError: unknown
    const destination = draftDestination(() => {
      try {
        operation.executeImmediately(destination)
      } catch (error) {
        reentrantError = error
      }
      return undefined
    })

    expect(operation.executeImmediately(destination)).toMatchObject({
      status: 'applied',
    })
    expect(reentrantError).toBeInstanceOf(DesignPersistenceBusyError)
    expect(operation.executeImmediately(destination)).toMatchObject({
      status: 'applied',
    })
  })

  it('exports a browser download without acknowledging the Design home', async () => {
    const operationStore = createDesignSessionStore({
      file: makeDesign('Garden Plan'),
      name: 'Garden Plan',
    })
    markDesignSessionDirtyForTest(operationStore)
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const downloads: string[] = []
    const destination = prepareDesignWriteDestination({
      resource: 'browser-download:1',
      blocksReplacement: false,
      write(content) {
        downloads.push(content.name)
      },
    })

    const settlement = await persistence.beginBrowserDownload().execute(destination)

    expect(settlement.status).toBe('applied')
    expect(downloads).toEqual(['Garden Plan'])
    expect(operationStore.isDesignDirty()).toBe(true)
  })

  it('executes browser draft storage synchronously without exposing captured content', () => {
    const operationStore = createDesignSessionStore({
      file: makeDesign('Garden Plan'),
      name: 'Garden Plan',
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const drafts: string[] = []
    const destination = prepareSynchronousDesignWriteDestination({
      resource: 'browser-app-data:drafts',
      write(content) {
        drafts.push(content.name)
        return undefined
      },
    })

    const settlement = persistence.beginBrowserDraft().executeImmediately(destination)

    expect(settlement.status).toBe('applied')
    expect(drafts).toEqual(['Garden Plan'])
  })

  it('acknowledges only the captured revisions and preserves later Design edits', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const { session } = checkpointSession()
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(session)
    markDesignSessionDirtyForTest(operationStore)
    const operation = persistence.beginSave()

    editDesignSessionForTest(operationStore, (design) => ({
      ...design,
      description: 'edit made during I/O',
    }))
    const settlement = await operation.execute(
      designDestination('/designs/original.canopi'),
    )

    expect(settlement.status).toBe('applied')
    expect(settlement.content.description).toBeNull()
    expect(operationStore.readCurrentDesign()?.description).toBe('edit made during I/O')
    expect(operationStore.isDesignDirty()).toBe(true)
  })

  it('does not discard a requested snapshot when its exact Scene checkpoint later diverges', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    let checkpointCurrent = true
    vi.mocked(capture.session.captureForPersistence).mockImplementation((metadata, document) => ({
      content: { ...document, name: metadata.name },
      isCurrent: () => checkpointCurrent,
      acknowledgeSaved: () => capture.acknowledgeSaved(),
    }))
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    const operation = persistence.beginSnapshotSave()
    checkpointCurrent = false
    const write = vi.fn()

    await expect(operation.execute(downloadDestination(write)))
      .resolves.toMatchObject({ status: 'applied' })
    expect(write).toHaveBeenCalledOnce()
    expect(capture.acknowledgeSaved).toHaveBeenCalledOnce()
  })

  it('makes a completion inert after Design replacement', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const operation = persistence.beginSaveAs()

    operationStore.replaceCurrentDesignState(makeDesign('Replacement'), null, 'Replacement')
    operationStore.resetDirtyBaselines()

    await expect(operation.execute(designDestination('/designs/original.canopi')))
      .resolves.toMatchObject({ status: 'stale' })
    expect(operationStore.readDesignPath()).toBeNull()
    expect(operationStore.readDesignName()).toBe('Replacement')
    expect(operationStore.isDesignDirty()).toBe(false)
  })

  it('rejects an empty Save As destination before acknowledging captured state', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    markDesignSessionDirtyForTest(operationStore)
    const operation = persistence.beginSaveAs()

    const write = vi.fn()
    await expect(operation.execute(designDestination('', write)))
      .rejects.toThrow('destination path')
    expect(write).not.toHaveBeenCalled()
    expect(capture.acknowledgeSaved).not.toHaveBeenCalled()
    expect(operationStore.readDesignPath()).toBeNull()
    expect(operationStore.isDesignDirty()).toBe(true)
  })

  it('returns stale when saved-baseline publication reentrantly replaces the Design', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    markDesignSessionDirtyForTest(operationStore)
    const operation = persistence.beginSave()
    let replaceWhenClean = false
    const dispose = effect(() => {
      const dirty = operationStore.designDirty.value
      if (dirty || !replaceWhenClean) return
      replaceWhenClean = false
      operationStore.replaceCurrentDesignState(makeDesign('Replacement'), null, 'Replacement')
      operationStore.resetDirtyBaselines()
    })

    replaceWhenClean = true
    const settlement = await operation.execute(
      designDestination('/designs/original.canopi'),
    )
    dispose()

    expect(settlement.status).toBe('stale')
    expect(operationStore.readDesignName()).toBe('Replacement')
    expect(operationStore.readDesignPath()).toBeNull()
  })

  it('finishes an irreversible settlement when clean publication issues a newer save', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    markDesignSessionDirtyForTest(operationStore)
    const older = persistence.beginSaveAs()
    let newer: ReturnType<typeof persistence.beginSaveAs> | null = null
    let issueWhenClean = false
    const dispose = effect(() => {
      const dirty = operationStore.designDirty.value
      if (dirty || !issueWhenClean) return
      issueWhenClean = false
      newer = persistence.beginSaveAs()
    })

    issueWhenClean = true
    await expect(older.execute(designDestination('/designs/older.canopi')))
      .resolves.toMatchObject({ status: 'applied' })
    expect(operationStore.readDesignPath()).toBe('/designs/older.canopi')
    expect(newer).not.toBeNull()
    await expect(newer!.execute(designDestination('/designs/newer.canopi')))
      .resolves.toMatchObject({ status: 'applied' })
    expect(operationStore.readDesignPath()).toBe('/designs/newer.canopi')
    dispose()
  })

  it('orders overlapping Save As destinations by issue order, not completion order', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const first = persistence.beginSaveAs()
    const second = persistence.beginSaveAs()

    await expect(second.execute(designDestination('/designs/second.canopi')))
      .resolves.toMatchObject({ status: 'applied' })
    await expect(first.execute(designDestination('/designs/first.canopi')))
      .resolves.toMatchObject({ status: 'stale' })
    expect(operationStore.readDesignPath()).toBe('/designs/second.canopi')
  })

  it('does not let an old-path Save supersede a pending Save As', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const oldPathSave = persistence.beginSave()
    const saveAs = persistence.beginSaveAs()

    await expect(saveAs.execute(designDestination('/designs/new.canopi')))
      .resolves.toMatchObject({ status: 'applied' })
    await expect(oldPathSave.execute(designDestination('/designs/original.canopi')))
      .resolves.toMatchObject({ status: 'stale' })
    expect(operationStore.readDesignPath()).toBe('/designs/new.canopi')
  })

  it('rejects a captured canvas checkpoint after detach and reattach', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const first = checkpointSession()
    const second = checkpointSession()
    persistence.attachCanvas(first.session)
    const operation = persistence.beginSnapshotSave()

    persistence.detachCanvas(first.session)
    persistence.attachCanvas(second.session)

    await expect(operation.execute(downloadDestination()))
      .resolves.toMatchObject({ status: 'stale' })
    expect(first.acknowledgeSaved).not.toHaveBeenCalled()
  })

  it('rejects a second Canvas attachment until the current lease is released', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const first = checkpointSession()
    const second = checkpointSession()
    persistence.attachCanvas(first.session)

    expect(() => persistence.attachCanvas(second.session)).toThrow('Canvas persistence lease')

    const capturedNames: string[] = []
    await persistence.beginSnapshotSave().execute(downloadDestination((content) => {
      capturedNames.push(content.name)
    }))
    expect(capturedNames).toEqual(['Original'])
    expect(first.session.captureForPersistence).toHaveBeenCalledOnce()
    expect(second.session.captureForPersistence).not.toHaveBeenCalled()
  })

  it('rejects handoff from a stale Canvas without displacing the current lease', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const first = checkpointSession()
    const second = checkpointSession()
    persistence.attachCanvas(first.session)
    persistence.detachCanvas(first.session)
    persistence.attachCanvas(second.session)

    expect(() => persistence.settleCanvasHandoff(first.session)).toThrow('Canvas persistence lease')

    const capturedNames: string[] = []
    await persistence.beginSnapshotSave().execute(downloadDestination((content) => {
      capturedNames.push(content.name)
    }))
    expect(capturedNames).toEqual(['Original'])
    expect(second.session.captureForPersistence).toHaveBeenCalledOnce()
  })

  it('finishes Canvas acknowledgement before a reentrantly issued save takes over', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    const older = persistence.beginSaveAs()
    let newer!: ReturnType<typeof persistence.beginSaveAs>
    capture.acknowledgeSaved.mockImplementationOnce(() => {
      newer = persistence.beginSaveAs()
      return 'applied'
    })

    await expect(older.execute(designDestination('/designs/older.canopi')))
      .resolves.toMatchObject({ status: 'applied' })
    expect(operationStore.readDesignPath()).toBe('/designs/older.canopi')
    await expect(newer.execute(designDestination('/designs/newer.canopi')))
      .resolves.toMatchObject({ status: 'applied' })
    expect(operationStore.readDesignPath()).toBe('/designs/newer.canopi')
  })

  it('retries a started settlement after acknowledgement issues a newer save and throws', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    const older = persistence.beginSaveAs()
    let newer: ReturnType<typeof persistence.beginSaveAs> | null = null
    capture.acknowledgeSaved
      .mockImplementationOnce(() => {
        newer = persistence.beginSaveAs()
        throw new Error('clean publication failed after issuing newer save')
      })
      .mockReturnValue('applied')

    const write = vi.fn()
    const settlement = await older.execute(
      designDestination('/designs/older.canopi', write),
    )

    expect(settlement.status).toBe('applied')
    expect(operationStore.readDesignPath()).toBe('/designs/older.canopi')
    expect(capture.acknowledgeSaved).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledOnce()
    expect(newer).not.toBeNull()
    await expect(newer!.execute(designDestination('/designs/newer.canopi')))
      .resolves.toMatchObject({ status: 'applied' })
    expect(operationStore.readDesignPath()).toBe('/designs/newer.canopi')
  })

  it('retries every Save As settlement phase without repeating external I/O', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    capture.acknowledgeSaved
      .mockImplementationOnce(() => {
        throw new Error('Canvas clean publication failed')
      })
      .mockReturnValue('applied')
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    markDesignSessionDirtyForTest(operationStore)
    const operation = persistence.beginSaveAs()
    let failStorePublication = false
    let failPathPublication = false
    const disposeStoreEffect = effect(() => {
      const dirty = operationStore.designDirty.value
      if (dirty || !failStorePublication) return
      failStorePublication = false
      throw new Error('Design baseline publication failed')
    })
    const disposePathEffect = effect(() => {
      const path = operationStore.designPath.value
      if (!path || !failPathPublication) return
      failPathPublication = false
      throw new Error('Save As path publication failed')
    })

    failStorePublication = true
    failPathPublication = true
    const write = vi.fn()
    const settlement = await operation.execute(
      designDestination('/designs/retried.canopi', write),
    )

    expect(settlement.status).toBe('applied')
    expect(operationStore.readDesignPath()).toBe('/designs/retried.canopi')
    expect(operationStore.isDesignDirty()).toBe(false)
    expect(capture.acknowledgeSaved).toHaveBeenCalledTimes(4)
    expect(write).toHaveBeenCalledOnce()
    disposeStoreEffect()
    disposePathEffect()
  })

  it('reports every bounded exact-settlement failure in attempt order', async () => {
    const causes = Array.from({ length: 4 }, (_, index) =>
      new Error(`settlement failure ${index + 1}`))
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    capture.acknowledgeSaved.mockImplementation(() => {
      throw causes[capture.acknowledgeSaved.mock.calls.length - 1]
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    const write = vi.fn()

    let settlementError: unknown
    try {
      await persistence.beginSnapshotSave().execute(downloadDestination(write))
    } catch (error) {
      settlementError = error
    }

    expect(capture.acknowledgeSaved).toHaveBeenCalledTimes(4)
    expect(write).toHaveBeenCalledOnce()
    expect(settlementError).toBeInstanceOf(DesignPersistenceSettlementError)
    expect(settlementError).toMatchObject({ errors: causes })
  })

  it('reserves save issue order before Canvas composition can reenter persistence', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    let nested: ReturnType<ReturnType<typeof createDesignSessionPersistence>['beginSaveAs']> | null = null
    let nestedIssued = false
    const capture = checkpointSession((_metadata, design) => {
      if (!nestedIssued) {
        nestedIssued = true
        nested = persistence.beginSaveAs()
      }
      return design
    })
    const persistence: ReturnType<typeof createDesignSessionPersistence> = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)

    const outer = persistence.beginSaveAs()

    expect(nested).not.toBeNull()
    await expect(nested!.execute(designDestination('/designs/nested.canopi')))
      .resolves.toMatchObject({ status: 'applied' })
    await expect(outer.execute(designDestination('/designs/outer.canopi')))
      .resolves.toMatchObject({ status: 'stale' })
    expect(operationStore.readDesignPath()).toBe('/designs/nested.canopi')
  })

  it('defensively owns the exact Canvas-composed snapshot', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capturedPlant = { id: 'captured-plant' } as CanopiFile['plants'][number]
    const capture = checkpointSession((metadata, design) => ({
      ...design,
      name: metadata.name,
      plants: [capturedPlant],
    }))
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)

    const writerCopies: CanopiFile[] = []
    const settlement = await persistence.beginSnapshotSave().execute(
      downloadDestination((content) => {
        writerCopies.push(content)
        content.plants.length = 0
      }),
    )

    expect(writerCopies[0]?.plants).toEqual([])
    expect(settlement.content.plants).toEqual([capturedPlant])
    expect(capture.session.captureForPersistence).toHaveBeenCalledWith(
      { name: 'Original' },
      expect.objectContaining({ name: 'Original' }),
    )
  })

  it('settles idempotently without acknowledging Canvas twice', async () => {
    const original = {
      ...makeDesign('Original'),
      plants: [{ id: 'captured-plant' } as CanopiFile['plants'][number]],
    }
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    markDesignSessionDirtyForTest(operationStore)
    const operation = persistence.beginSnapshotSave()
    const write = vi.fn()
    const destination = downloadDestination(write)

    const firstExecution = operation.execute(destination)
    const secondExecution = operation.execute(destination)

    expect(secondExecution).toBe(firstExecution)
    const first = await firstExecution
    first.content.plants.length = 0
    const second = await secondExecution

    expect(second).toBe(first)
    expect(second.content.plants).toHaveLength(1)
    expect(write).toHaveBeenCalledOnce()
    expect(capture.acknowledgeSaved).toHaveBeenCalledTimes(1)
    expect(operationStore.isDesignDirty()).toBe(false)
  })

  it('cleans a store-authoritative Canvas baseline while attachment is still hydrating', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    vi.mocked(capture.session.hasLoadedDocument).mockReturnValue(false)
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    operationStore.markCanvasDetachedDirty(true)
    const operation = persistence.beginSnapshotSave()

    await expect(operation.execute(downloadDestination()))
      .resolves.toMatchObject({ status: 'applied' })
    expect(capture.session.captureForPersistence).not.toHaveBeenCalled()
    expect(operationStore.isDesignDirty()).toBe(false)
  })

  it('makes an unloaded Canvas capture stale when hydration admits a later Scene edit', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    let loaded = false
    vi.mocked(capture.session.hasLoadedDocument).mockImplementation(() => loaded)
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    operationStore.markCanvasDetachedDirty(true)
    const operation = persistence.beginSnapshotSave()

    loaded = true
    operationStore.setCanvasClean(false)

    await expect(operation.execute(downloadDestination()))
      .resolves.toMatchObject({ status: 'stale' })
    expect(operationStore.isDesignDirty()).toBe(true)
  })

  it('makes a detached capture stale when a newer canvas handoff replaces its snapshot', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const operation = persistence.beginSave()

    operationStore.replaceCurrentDesignSnapshot({
      ...original,
      plants: [{ id: 'newer-handoff' } as CanopiFile['plants'][number]],
    })

    await expect(operation.execute(designDestination('/designs/original.canopi')))
      .resolves.toMatchObject({ status: 'stale' })
  })

  it('invalidates detached captures before publishing a newer handoff snapshot', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({
      file: original,
      path: '/designs/original.canopi',
      name: original.name,
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const operation = persistence.beginSave()
    let settleDuringPublication = false
    const settlement: { current: ReturnType<typeof operation.execute> | null } = { current: null }
    const dispose = effect(() => {
      void operationStore.currentDesign.value
      if (!settleDuringPublication) return
      settleDuringPublication = false
      settlement.current = operation.execute(
        designDestination('/designs/original.canopi'),
      )
    })

    settleDuringPublication = true
    operationStore.replaceCurrentDesignSnapshot({
      ...original,
      plants: [{ id: 'newer-handoff' } as CanopiFile['plants'][number]],
    })
    dispose()

    await expect(settlement.current).resolves.toMatchObject({ status: 'stale' })
  })

  it('keeps a Design dirty when its Browser Draft write fails', () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    markDesignSessionDirtyForTest(operationStore)
    const persistence = createDesignSessionPersistence({ store: operationStore })
    const operation = persistence.beginBrowserDraft()

    expect(() => operation.executeImmediately(draftDestination(() => {
      throw new Error('storage unavailable')
    }))).toThrow('storage unavailable')

    expect(operationStore.isDesignDirty()).toBe(true)
  })

  it('captures handoff and diagnostic content without advancing a baseline', () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    markDesignSessionDirtyForTest(operationStore)

    expect(persistence.settleCanvasHandoff(capture.session)?.name).toBe('Original')
    expect(persistence.captureObservation(capture.session)?.name).toBe('Original')

    expect(operationStore.isDesignDirty()).toBe(true)
    expect(capture.acknowledgeSaved).not.toHaveBeenCalled()
  })

  it('rejects diagnostic observation through a foreign or detached Canvas identity', () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const attached = checkpointSession()
    const foreign = checkpointSession()
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(attached.session)

    expect(() => persistence.captureObservation(foreign.session))
      .toThrow('Canvas persistence lease')
    expect(() => persistence.captureObservation(null))
      .toThrow('Canvas persistence lease')
    expect(foreign.session.captureForPersistence).not.toHaveBeenCalled()
  })

  it('recaptures a handoff instead of overwriting a Design edit made during Canvas composition', () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    let editDuringFirstCapture = true
    const capture = checkpointSession((metadata, document) => {
      if (editDuringFirstCapture) {
        editDuringFirstCapture = false
        editDesignSessionForTest(operationStore, (current) => ({
          ...current,
          description: 'Design edit made during Canvas composition',
        }))
      }
      return { ...document, name: metadata.name }
    })
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)

    persistence.settleCanvasHandoff(capture.session)

    expect(capture.session.captureForPersistence).toHaveBeenCalledTimes(2)
    expect(operationStore.readCurrentDesign()?.description).toBe(
      'Design edit made during Canvas composition',
    )
  })

  it('invalidates a replacement guard when its exact Canvas checkpoint diverges', () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    let canvasCheckpointCurrent = true
    const capture = checkpointSession()
    vi.mocked(capture.session.captureForPersistence).mockImplementation((metadata, document) => ({
      content: { ...document, name: metadata.name },
      isCurrent: () => canvasCheckpointCurrent,
      acknowledgeSaved: () => 'applied' as const,
    }))
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    const guard = persistence.beginReplacementGuard().guard

    canvasCheckpointCurrent = false

    expect(guard?.isCurrent()).toBe(false)
  })

  it('retries Canvas acknowledgement publication before consuming success', async () => {
    const original = makeDesign('Original')
    const operationStore = createDesignSessionStore({ file: original, name: original.name })
    const capture = checkpointSession()
    capture.acknowledgeSaved
      .mockImplementationOnce(() => {
        throw new Error('clean publication failed')
      })
      .mockImplementationOnce(() => 'applied')
    const persistence = createDesignSessionPersistence({ store: operationStore })
    persistence.attachCanvas(capture.session)
    const operation = persistence.beginSnapshotSave()
    const write = vi.fn()

    await expect(operation.execute(downloadDestination(write)))
      .resolves.toMatchObject({ status: 'applied' })
    expect(write).toHaveBeenCalledOnce()
    expect(capture.acknowledgeSaved).toHaveBeenCalledTimes(2)
  })
})
