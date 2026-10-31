import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  return {
    canvasSession: null as any,
    saveDesign: vi.fn(),
    saveDesignDraft: vi.fn(),
    deleteDesignDraft: vi.fn(),
    requestSaveDecision: vi.fn(),
    selectDesignSavePath: vi.fn(),
    openDesignDialog: vi.fn(),
    loadDesign: vi.fn(),
    newDesign: vi.fn(),
    message: vi.fn(),
    presentOpenFailure: vi.fn(),
  }
})

vi.mock('../canvas/session', async (importOriginal) => {
  const actual = await importOriginal<typeof CanvasSessionModule>()
  return {
    ...actual,
    getCurrentCanvasSession() {
      return mocks.canvasSession
    },
    getCurrentCanvasDocumentSurface() {
      return mocks.canvasSession
    },
  }
})

vi.mock('../ipc/design', async () => {
  const { prepareDesignWriteDestination } = await import(
    '../app/document-session/write-admission'
  )
  return {
    selectDesignSavePath: mocks.selectDesignSavePath,
    prepareDesignWrite: (
      path: string,
      _expectedFingerprint: string | null,
      onWritten: (fingerprint: string) => void,
    ) => prepareDesignWriteDestination({
      resource: `native-design:${path}`,
      destinationPath: path,
      write: (content) => mocks.saveDesign(path, content).then(() => onWritten('fp-written')),
    }),
    prepareDraftWrite: (id: string) => prepareDesignWriteDestination({
      resource: `native-draft:${id}`,
      write: (content) => mocks.saveDesignDraft(id, content),
    }),
    deleteDesignDraft: mocks.deleteDesignDraft,
    openDesignDialog: mocks.openDesignDialog,
    loadDesign: mocks.loadDesign,
    newDesign: mocks.newDesign,
  }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: mocks.message,
}))

vi.mock('../app/document-session/save-problem', () => ({
  requestSaveProblemDecision: mocks.requestSaveDecision,
}))

vi.mock('../app/document-session/open-failure', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenFailureModule>()
  return {
    ...actual,
    presentDesignOpenFailure: (error: unknown) => mocks.presentOpenFailure(actual.designOpenFailureNoticeOf(error)),
  }
})

import { currentCanvasTool, currentCanvasSelection } from '../canvas/session-state'
import {
  designSessionFixture,
  currentDesign,
  designName,
  designPath,
  pendingDesignPath,
  resetDirtyBaselines,
} from './support/design-session-state'
import {
  consumeQueuedDocumentLoad,
  newDesignAction,
  openDesign,
  openDesignFromPath,
  revertDesign,
  saveCurrentDesign,
} from '../app/document-session/actions'
import {
  designContinuousSave,
  resetDesignSessionStateForTests,
} from '../app/document-session/transition'
import type { CanopiFile } from '../types/design'
import { newDesignDefaults } from '../app/settings/state'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import type * as CanvasSessionModule from '../canvas/session'
import type * as OpenFailureModule from '../app/document-session/open-failure'

function makeFile(name: string): CanopiFile {
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
    created_at: '2026-03-29T00:00:00.000Z',
    updated_at: '2026-03-29T00:00:00.000Z',
    extra: {},
  }
}

function loaded(file: CanopiFile, fingerprint = 'fp-loaded') {
  return { file, fingerprint }
}

function makeEngine() {
  return {
    loadDocument: vi.fn(),
    replaceDocument: vi.fn(),
    showCanvasChrome: vi.fn(),
  }
}

function makeSession() {
  let loaded = false
  const engine = makeEngine()
  const acknowledgeSaved = vi.fn(() => 'applied' as const)
  engine.loadDocument.mockImplementation(() => {
    loaded = true
  })
  engine.replaceDocument.mockImplementation((
    _file: CanopiFile,
    _token: unknown,
    finalizeReplacement: () => void,
  ) => {
    loaded = true
    finalizeReplacement()
    return { callerFinalizerInvoked: true }
  })
  return {
    engine,
    loadDocument: engine.loadDocument,
    replaceDocument: engine.replaceDocument,
    showCanvasChrome: engine.showCanvasChrome,
    hideCanvasChrome: vi.fn(),
    zoomToFit: vi.fn(),
    hasLoadedDocument: vi.fn(() => loaded),
    captureForPersistence: vi.fn((metadata: { name: string }, doc: CanopiFile) => ({
      content: { ...doc, name: metadata.name },
      isCurrent: () => true,
      acknowledgeSaved,
    })),
    acknowledgeSaved,
    resize: vi.fn(),
    destroy: vi.fn(),
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetDesignSessionStateForTests()
  mocks.canvasSession = makeSession()
  mocks.saveDesign.mockReset()
  mocks.saveDesign.mockResolvedValue(undefined)
  mocks.saveDesignDraft.mockReset()
  mocks.saveDesignDraft.mockResolvedValue(undefined)
  mocks.deleteDesignDraft.mockReset()
  mocks.deleteDesignDraft.mockResolvedValue(undefined)
  mocks.requestSaveDecision.mockReset()
  mocks.requestSaveDecision.mockResolvedValue('cancel')
  mocks.selectDesignSavePath.mockReset()
  mocks.selectDesignSavePath.mockResolvedValue('/designs/current.canopi')
  mocks.openDesignDialog.mockReset()
  mocks.loadDesign.mockReset()
  mocks.newDesign.mockReset()
  mocks.message.mockReset()
  mocks.presentOpenFailure.mockReset()

  designSessionFixture.file = makeFile('Current')
  designSessionFixture.name = 'Current'
  designSessionFixture.path = '/designs/current.canopi'
  designSessionFixture.pendingDesignPath = null
  resetDirtyBaselines()
  designSessionFixture.nonCanvasRevision = 0
  designSessionFixture.detachedCanvasDirty = false
  designContinuousSave.beginSession({ draftId: null, fingerprint: 'fp-current', writePending: false })

  currentCanvasTool.value = 'rectangle'
  currentCanvasSelection.value = new Set(['selected-1'])
})

describe('document replacement actions', () => {
  it('writes a dirty Design to its file home, then replaces it without asking', async () => {
    designSessionFixture.nonCanvasRevision = 1
    mocks.loadDesign.mockResolvedValue(loaded(makeFile('Next')))

    await openDesignFromPath('/designs/next.canopi')

    expect(mocks.requestSaveDecision).not.toHaveBeenCalled()
    expect(mocks.saveDesign).toHaveBeenCalledWith(
      '/designs/current.canopi',
      expect.objectContaining({ name: 'Current' }),
    )
    expect(mocks.loadDesign).toHaveBeenCalledWith('/designs/next.canopi')
    expect(mocks.canvasSession.replaceDocument).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Next', extra: {} }),
      expect.any(Object),
      expect.any(Function),
    )
    expect(currentDesign.value?.name).toBe('Next')
    expect(designName.value).toBe('Next')
    expect(designPath.value).toBe('/designs/next.canopi')
    expect(designContinuousSave.readHome()).toEqual({
      kind: 'file',
      path: '/designs/next.canopi',
      fingerprint: 'fp-loaded',
    })
    expect(mocks.canvasSession.showCanvasChrome).toHaveBeenCalled()
    expect(mocks.canvasSession.zoomToFit).toHaveBeenCalled()
  })

  it('keeps the current Design when its write fails and the user cancels', async () => {
    designSessionFixture.nonCanvasRevision = 1
    mocks.saveDesign.mockRejectedValue(new Error('disk full'))
    mocks.requestSaveDecision.mockResolvedValue('cancel')
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await openDesignFromPath('/designs/next.canopi')
    logError.mockRestore()

    expect(mocks.requestSaveDecision).toHaveBeenCalledWith({
      kind: 'flush-failed',
      purpose: 'replace',
      conflict: false,
    })
    expect(mocks.loadDesign).not.toHaveBeenCalled()
    expect(currentDesign.value?.name).toBe('Current')
    expect(designPath.value).toBe('/designs/current.canopi')
  })

  it('acknowledges the Canvas baseline when writing before replacement', async () => {
    mocks.canvasSession.loadDocument(makeFile('Current'))
    designSessionFixture.nonCanvasRevision = 1
    mocks.loadDesign.mockResolvedValue(loaded(makeFile('Next')))

    await openDesignFromPath('/designs/next.canopi')

    expect(mocks.saveDesign).toHaveBeenCalledWith(
      '/designs/current.canopi',
      expect.objectContaining({ name: 'Current' }),
    )
    expect(mocks.canvasSession.acknowledgeSaved).toHaveBeenCalled()
    expect(currentDesign.value?.name).toBe('Next')
    expect(mocks.canvasSession.zoomToFit).toHaveBeenCalled()
  })

  it('discards unwritable changes only when the user chooses to', async () => {
    designSessionFixture.nonCanvasRevision = 1
    mocks.saveDesign.mockRejectedValue(new Error('disk full'))
    mocks.requestSaveDecision
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('discard')
    mocks.loadDesign.mockResolvedValue(loaded(makeFile('Next')))
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await openDesignFromPath('/designs/next.canopi')
    logError.mockRestore()

    expect(mocks.saveDesign).toHaveBeenCalledTimes(2)
    expect(mocks.requestSaveDecision).toHaveBeenCalledTimes(2)
    expect(currentDesign.value?.name).toBe('Next')
  })

  it('propagates load failures without replacing the document', async () => {
    mocks.loadDesign.mockRejectedValue(new Error('Disk read failed'))

    await expect(openDesignFromPath('/designs/bad.canopi')).rejects.toThrow('Disk read failed')

    expect(mocks.canvasSession.replaceDocument).not.toHaveBeenCalled()
    expect(currentDesign.value?.name).toBe('Current')
  })

  it('cancels queued loads before they apply to a fresh engine', async () => {
    const queued = deferred<ReturnType<typeof loaded>>()
    designSessionFixture.pendingDesignPath = '/designs/queued.canopi'
    mocks.loadDesign.mockReturnValue(queued.promise)

    const cancel = consumeQueuedDocumentLoad(mocks.canvasSession)
    cancel()
    queued.resolve(loaded(makeFile('Queued')))
    await flushMicrotasks()

    expect(mocks.canvasSession.replaceDocument).not.toHaveBeenCalled()
    expect(currentDesign.value?.name).toBe('Current')
  })

  it('surfaces queued-load failures and keeps the pending path for retry', async () => {
    const queued = deferred<ReturnType<typeof loaded>>()
    designSessionFixture.pendingDesignPath = '/designs/broken.canopi'
    mocks.loadDesign.mockReturnValue(queued.promise)

    consumeQueuedDocumentLoad(mocks.canvasSession)
    queued.reject(new Error('Disk read failed'))
    await flushMicrotasks()

    expect(mocks.canvasSession.replaceDocument).not.toHaveBeenCalled()
    expect(pendingDesignPath.value).toBe('/designs/broken.canopi')
    expect(mocks.presentOpenFailure).toHaveBeenCalledTimes(1)
    expect(mocks.presentOpenFailure.mock.calls[0]?.[0]).toEqual({
      tone: 'error',
      title: 'Can’t open this Design',
      message: 'Can’t read this file',
    })
  })

  it('applies a known path while the canvas session is detached', async () => {
    mocks.canvasSession = null
    mocks.loadDesign.mockResolvedValue(loaded(makeFile('Next')))

    await openDesignFromPath('/designs/next.canopi')

    expect(mocks.message).not.toHaveBeenCalled()
    expect(mocks.loadDesign).toHaveBeenCalledWith('/designs/next.canopi')
    expect(currentDesign.value?.name).toBe('Next')
    expect(designName.value).toBe('Next')
    expect(designPath.value).toBe('/designs/next.canopi')
    expect(pendingDesignPath.value).toBe(null)
  })

  it('writes the detached Design to its home before replacement', async () => {
    mocks.canvasSession = null
    designSessionFixture.nonCanvasRevision = 1
    mocks.loadDesign.mockResolvedValue(loaded(makeFile('Next')))

    await openDesignFromPath('/designs/next.canopi')

    expect(mocks.saveDesign).toHaveBeenCalledWith(
      '/designs/current.canopi',
      expect.objectContaining({ name: 'Current' }),
    )
    expect(mocks.loadDesign).toHaveBeenCalledWith('/designs/next.canopi')
    expect(currentDesign.value?.name).toBe('Next')
  })

  it('queues a known path when neither document state nor canvas session is ready', async () => {
    mocks.canvasSession = null
    designSessionFixture.file = null
    designSessionFixture.path = null

    await openDesignFromPath('/designs/next.canopi')

    expect(mocks.message).not.toHaveBeenCalled()
    expect(mocks.loadDesign).not.toHaveBeenCalled()
    expect(pendingDesignPath.value).toBe('/designs/next.canopi')
  })

  it('does not ask anything when no document is open', async () => {
    designSessionFixture.file = null
    designSessionFixture.path = null
    designSessionFixture.nonCanvasRevision = 1
    designSessionFixture.detachedCanvasDirty = true
    mocks.loadDesign.mockResolvedValue(loaded(makeFile('Next')))

    await openDesignFromPath('/designs/next.canopi')

    expect(mocks.requestSaveDecision).not.toHaveBeenCalled()
    expect(mocks.loadDesign).toHaveBeenCalledWith('/designs/next.canopi')
    expect(currentDesign.value).toEqual(expect.objectContaining({ name: 'Next' }))
  })

  it('opens from the file dialog while the canvas session is detached', async () => {
    mocks.canvasSession = null
    mocks.openDesignDialog.mockResolvedValue({
      design: loaded(makeFile('Dialog Pick'), 'fp-dialog'),
      path: '/designs/dialog.canopi',
    })

    await openDesign()

    expect(mocks.openDesignDialog).toHaveBeenCalledTimes(1)
    expect(currentDesign.value?.name).toBe('Dialog Pick')
    expect(designName.value).toBe('Dialog Pick')
    expect(designPath.value).toBe('/designs/dialog.canopi')
  })

  it('creates a new design while the canvas session is detached', async () => {
    mocks.canvasSession = null
    mocks.newDesign.mockResolvedValue(makeFile('Untitled'))

    await newDesignAction()

    expect(mocks.newDesign).toHaveBeenCalledTimes(1)
    expect(currentDesign.value?.name).toBe('Untitled')
    expect(designName.value).toBe('Untitled')
    expect(designPath.value).toBe(null)
    expect(designContinuousSave.readHome()).toMatchObject({ kind: 'draft' })
    expect(designContinuousSave.status.value).toBe('draft')
  })

  it('starts a new Design with the Settings › New Designs defaults and never touches an opened one', async () => {
    mocks.canvasSession = null
    mocks.newDesign.mockResolvedValue(makeFile('Untitled'))
    newDesignDefaults.value = { satellite: true, symbolScale: 1.5, labels: 'codes' }
    mapLayers.value = createDefaultMapLayers()
    try {
      await newDesignAction()

      expect(currentDesign.value?.extra?.plant_display).toMatchObject({ symbol_scale: 1.5, labels: 'codes' })
      expect(mapLayers.value.satellite.visible).toBe(true)

      // Opening a Design keeps its own display and the background.
      mapLayers.value = createDefaultMapLayers()
      mocks.loadDesign.mockResolvedValue(loaded(makeFile('Kept')))
      await openDesignFromPath('/designs/kept.canopi')
      expect(currentDesign.value?.name).toBe('Kept')
      expect(currentDesign.value?.extra?.plant_display).toBeUndefined()
      expect(mapLayers.value.satellite.visible).toBe(false)
    } finally {
      newDesignDefaults.value = { satellite: false, symbolScale: 1, labels: 'names' }
      mapLayers.value = createDefaultMapLayers()
    }
  })

  it('saves the canonical document snapshot to its file when no canvas session is mounted', async () => {
    mocks.canvasSession = null
    designSessionFixture.name = 'Detached'
    designSessionFixture.nonCanvasRevision = 1

    await expect(saveCurrentDesign()).resolves.toBe(true)

    expect(mocks.saveDesign).toHaveBeenCalledWith(
      '/designs/current.canopi',
      expect.objectContaining({ name: 'Detached' }),
    )
    expect(designName.value).toBe('Detached')
    expect(designContinuousSave.readHome()).toMatchObject({ fingerprint: 'fp-written' })
  })

  it('saves a draft home with Save As, then forgets the draft', async () => {
    mocks.canvasSession = null
    mocks.newDesign.mockResolvedValue(makeFile('Untitled'))
    await newDesignAction()
    designSessionFixture.nonCanvasRevision = 1
    await designContinuousSave.flush()
    const draftHome = designContinuousSave.readHome()
    expect(draftHome).toMatchObject({ kind: 'draft' })
    expect(mocks.saveDesignDraft).toHaveBeenCalledTimes(1)
    mocks.selectDesignSavePath.mockResolvedValue('/designs/saved.canopi')

    await expect(saveCurrentDesign()).resolves.toBe(true)

    expect(mocks.saveDesign).toHaveBeenCalledWith(
      '/designs/saved.canopi',
      expect.objectContaining({ name: 'Untitled' }),
    )
    expect(designPath.value).toBe('/designs/saved.canopi')
    expect(designContinuousSave.readHome()).toEqual({
      kind: 'file',
      path: '/designs/saved.canopi',
      fingerprint: 'fp-written',
    })
    expect(mocks.deleteDesignDraft).toHaveBeenCalledWith(
      draftHome?.kind === 'draft' ? draftHome.id : null,
    )
  })

  it('reverts to the version opened and writes it back to the file', async () => {
    mocks.canvasSession = null
    mocks.loadDesign.mockResolvedValue(loaded({ ...makeFile('Opened'), description: 'as opened' }))
    await openDesignFromPath('/designs/opened.canopi')
    expect(designContinuousSave.revertAvailable.value).toBe(false)
    const { editDesignSessionForTest } = await import('./support/design-session-edit')
    const { designSessionStore } = await import('../app/document-session/store')
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'edited' }))
    expect(designContinuousSave.revertAvailable.value).toBe(true)
    mocks.requestSaveDecision.mockResolvedValueOnce('revert')

    await revertDesign()
    await designContinuousSave.flush()

    expect(currentDesign.value?.description).toBe('as opened')
    expect(designPath.value).toBe('/designs/opened.canopi')
    expect(mocks.saveDesign).toHaveBeenLastCalledWith(
      '/designs/opened.canopi',
      expect.objectContaining({ description: 'as opened' }),
    )
    expect(designContinuousSave.revertAvailable.value).toBe(false)
  })

})
