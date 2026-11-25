// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeCanopiDesign } from '../app/contracts/canopi-design-wire'
import { decodeCanopiDesign } from '../app/contracts/design-ingestion'
import { DEFAULT_BUDGET_CURRENCY } from '../app/contracts/document'
import {
  designSaveStatus,
  newDesignAction,
  openDesignDraft,
} from '../app/document-session/actions'
import type { ScenePort } from '../app/document-session/core/scene-half'
import {
  createJsonSessionCodec,
  createSessionCore,
  installLiveSessionCore,
  type SessionCore,
} from '../app/document-session/live-core'
import { registerDesignOpenFailurePresenter } from '../app/document-session/open-failure'
import { designSessionStore } from '../app/document-session/store'
import { withNewDesignDisplay } from '../app/settings/new-design-defaults'
import { newDesignDefaults } from '../app/settings/state'
import { readPlantDisplayOptions } from '../app/design-edit/plant-display'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import { NEW_DESIGN_LAYER_DEFAULTS } from '../generated/new-design-defaults'
import type { AppLifecyclePort, LifecycleEvent } from '../platform/app-lifecycle'
import type { SceneCommand } from '../canvas/runtime/scene-commands'
import type { CanopiFile } from '../types/design'
import {
  browserAppDataStore,
  createBrowserAppDataStore,
  type BrowserStorageAdapter,
} from '../web/browser-app-data'
import * as browserTextFiles from '../web/browser-text-files'
import {
  browserFileAccessPort,
  createBrowserSessionHomeStore,
} from '../editions/web/session-ports'
import {
  createWebShellCommands,
  currentWebDesignText,
  deleteWebDraft,
  downloadWebDraft,
  openWebCanopiFile,
  openWebDraft,
  reloadWebForRelease,
  setDesignName,
} from '../editions/web/web-session'
import { editDesignSessionForTest } from './support/design-session-edit'
import { makeTestDesign } from './support/session-core-fixture'

const CONTINUOUS_SAVE_DELAY_MS = 1500
const NOW = new Date('2026-07-04T12:00:00.000Z')

interface MemoryStorage extends BrowserStorageAdapter {
  failWrites: boolean
  readonly values: Map<string, string>
}

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>()
  return {
    values,
    failWrites: false,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError')
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

function createFakeLifecycle(): AppLifecyclePort & { emit(event: LifecycleEvent): void } {
  const listeners = new Set<(event: LifecycleEvent) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(event) {
      for (const listener of listeners) listener(event)
    },
  }
}

function makeNewCanopiFile(name = 'Untitled'): CanopiFile {
  return makeTestDesign({
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    layers: NEW_DESIGN_LAYER_DEFAULTS.map((layer) => ({ ...layer })),
    budget_currency: DEFAULT_BUDGET_CURRENCY,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  })
}

function makeFile(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    ...makeNewCanopiFile('Orchard'),
    ...overrides,
  }
}

function plantAt(position: { lon: number; lat: number }): CanopiFile['plants'][number] {
  return {
    id: 'plant-at',
    locked: false,
    canonical_name: 'Malus domestica',
    common_name: null,
    color: null,
    position,
    rotation: null,
    scale: null,
    notes: null,
    planted_date: null,
    quantity: 1,
  }
}

function makeScenePort(initial: Partial<CanopiFile> = {}) {
  const state = {
    plant_species_colors: initial.plant_species_colors ?? {},
    layers: initial.layers ?? [],
    plants: initial.plants ?? [],
    zones: initial.zones ?? [],
    annotations: initial.annotations ?? [],
    measurement_guides: initial.measurement_guides ?? [],
    groups: initial.groups ?? [],
  }
  return {
    state,
    load: vi.fn<ScenePort['load']>((file) => {
      state.plant_species_colors = { ...file.plant_species_colors }
      state.layers = [...file.layers]
      state.plants = [...file.plants]
      state.zones = file.zones.map((z) => ({ ...z, points: [...z.points] }))
      state.annotations = [...file.annotations]
      state.measurement_guides = [...(file.measurement_guides ?? [])]
      state.groups = file.groups.map((g) => ({ ...g, members: [...g.members] }))
    }),
    serialize: vi.fn<ScenePort['serialize']>(() => ({ ...state })),
    replay: vi.fn<ScenePort['replay']>(),
  } satisfies ScenePort & { state: typeof state }
}

const disposers: Array<() => void> = []

function setupSession(options: {
  storage?: MemoryStorage
  flushDelayMs?: number
  applyDefaults?: boolean
} = {}) {
  let tick = 0
  const storage = options.storage ?? memoryStorage()
  const appDataStore = createBrowserAppDataStore({ storage })
  const designHome = createBrowserSessionHomeStore(
    appDataStore,
    () => new Date(NOW.getTime() + (tick++) * 1000),
  )
  const lifecycle = createFakeLifecycle()
  const core: SessionCore = createSessionCore({
    designHome,
    fileAccess: browserFileAccessPort,
    lifecycle,
    codec: createJsonSessionCodec(),
    settings: {
      readLastOpenHome: async () => null,
      writeLastOpenHome: async () => {},
      ...(options.applyDefaults ? { applyNewDesignDefaults: withNewDesignDisplay } : {}),
    },
    newDesignFactory: () => makeNewCanopiFile('Untitled'),
    flushDelayMs: options.flushDelayMs ?? CONTINUOUS_SAVE_DELAY_MS,
  })
  const dispose = installLiveSessionCore(core)
  disposers.push(dispose)
  return { storage, appDataStore, designHome, lifecycle, core, dispose }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  newDesignDefaults.value = { satellite: false, symbolScale: 1, labels: 'names' }
})

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
  registerDesignOpenFailurePresenter(null)
  localStorage.clear()
  sessionStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Web Edition SessionCore + createBrowserSessionHomeStore lifecycle', () => {
  it('starts a new browser Design with the Settings › New Designs defaults', async () => {
    newDesignDefaults.value = { satellite: false, symbolScale: 1.5, labels: 'none' }
    setupSession({ applyDefaults: true })

    await newDesignAction()

    const display = readPlantDisplayOptions(designSessionStore.readCurrentDesign())
    expect(display.symbolScale).toBe(1.5)
    expect(display.labels).toBe('none')
  })

  it('creates fresh canonical layer records for each browser New Design', async () => {
    const { core } = setupSession()
    await core.createNew()
    const first = designSessionStore.readCurrentDesign()!
    expect(first.version).toBe(CURRENT_CANOPI_FILE_VERSION)
    expect(first.layers.map((layer) => layer.name)).toEqual(NEW_DESIGN_LAYER_DEFAULTS.map((layer) => layer.name))

    await core.createNew()
    const second = designSessionStore.readCurrentDesign()!
    expect(second.layers).toEqual(first.layers)
    expect(second.layers).not.toBe(first.layers)
  })

  it('composes a new browser Design as the current version through draft and download', async () => {
    const { appDataStore, core } = setupSession()
    const downloadSpy = vi.spyOn(browserTextFiles, 'downloadBrowserTextFile').mockImplementation(() => undefined)

    await core.createNew()
    const draftId = core.currentDesign.peek()!.home.key
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'Composed in web' }))
    await expect(core.flushNow()).resolves.toBe(true)

    const saved = appDataStore.loadDraft(draftId)
    expect(saved?.version).toBe(CURRENT_CANOPI_FILE_VERSION)
    expect(saved?.description).toBe('Composed in web')

    await createWebShellCommands().downloadCanopi()
    expect(downloadSpy).toHaveBeenCalledOnce()
    const [fileName, text] = downloadSpy.mock.calls[0]!
    expect(fileName).toBe('Untitled.canopi')
    const decoded = decodeCanopiDesign(JSON.parse(text))
    expect(decoded.version).toBe(CURRENT_CANOPI_FILE_VERSION)
    expect(decoded.description).toBe('Composed in web')
  })

  it('opens a .canopi file as a browser Design and preserves future fields', async () => {
    setupSession()
    const incoming = {
      ...encodeCanopiDesign(makeFile({ name: 'Meadow', plants: [plantAt({ lon: 2.35, lat: 48.85 })] })),
      future_custom_field: { kept: true },
    }
    vi.spyOn(browserTextFiles, 'pickBrowserTextFile').mockResolvedValue({
      fileName: 'meadow.canopi',
      text: JSON.stringify(incoming),
    })

    await expect(openWebCanopiFile()).resolves.toBe(true)
    const opened = designSessionStore.readCurrentDesign()
    expect(opened?.name).toBe('Meadow')
    expect(opened?.plants[0]?.position).toEqual({ lon: 2.35, lat: 48.85 })
    expect(opened?.extra).toEqual({ future_custom_field: { kept: true } })
  })

  it('rejects a malformed or preview (v7) selected Design before replacing the active session', async () => {
    const { core } = setupSession()
    const presentFailure = vi.fn()
    registerDesignOpenFailurePresenter(presentFailure)

    await core.createNew()
    setDesignName('Active Design')

    // Malformed JSON
    vi.spyOn(browserTextFiles, 'pickBrowserTextFile').mockResolvedValueOnce({
      fileName: 'broken.canopi',
      text: '{not valid json',
    })
    await expect(openWebCanopiFile()).resolves.toBe(false)
    expect(designSessionStore.readDesignName()).toBe('Active Design')
    expect(presentFailure).toHaveBeenCalledTimes(1)

    // Preview v7 file
    vi.spyOn(browserTextFiles, 'pickBrowserTextFile').mockResolvedValueOnce({
      fileName: 'preview.canopi',
      text: JSON.stringify({ ...encodeCanopiDesign(makeFile({ name: 'Preview' })), version: 7 }),
    })
    await expect(openWebCanopiFile()).resolves.toBe(false)
    expect(designSessionStore.readDesignName()).toBe('Active Design')
    expect(presentFailure).toHaveBeenCalledTimes(2)
  })

  it('resolves browser Open .canopi as a no-op when the picker is cancelled', async () => {
    const { core } = setupSession()
    await core.createNew()
    setDesignName('Stays Open')
    vi.spyOn(browserTextFiles, 'pickBrowserTextFile').mockResolvedValue(null)

    await expect(openWebCanopiFile()).resolves.toBe(false)
    expect(designSessionStore.readDesignName()).toBe('Stays Open')
  })

  it('opens fetched static templates through SessionCore bytes source', async () => {
    const { core } = setupSession()
    const templateFile = makeFile({ name: 'Syntropic Alley' })
    const bytes = new TextEncoder().encode(JSON.stringify(encodeCanopiDesign(templateFile)))
    const opened = await core.openFrom({ kind: 'bytes', name: 'Syntropic Alley', bytes })
    expect(opened.status).toBe('opened')
    expect(designSessionStore.readDesignName()).toBe('Syntropic Alley')
  })

  it('downloads the current Design without acknowledging dirty status', async () => {
    const { core } = setupSession()
    const downloadSpy = vi.spyOn(browserTextFiles, 'downloadBrowserTextFile').mockImplementation(() => undefined)
    await core.createNew()
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'Unsaved edit' }))
    expect(core.dirty.value).toBe(true)

    await createWebShellCommands().downloadCanopi()
    expect(downloadSpy).toHaveBeenCalledOnce()
    expect(downloadSpy.mock.calls[0]![1]).toContain('Unsaved edit')
    expect(core.dirty.value).toBe(true)
  })

  it('continuously saves Browser Drafts after the delay and flushes when hidden', async () => {
    vi.useFakeTimers()
    const { appDataStore, designHome, lifecycle, core } = setupSession({ flushDelayMs: CONTINUOUS_SAVE_DELAY_MS })
    let onWritten: (() => void) | null = null
    const origWrite = designHome.write.bind(designHome)
    vi.spyOn(designHome, 'write').mockImplementation(async (...args) => {
      const res = await origWrite(...args)
      onWritten?.()
      return res
    })
    const nextWrite = () => new Promise<void>((resolve) => { onWritten = resolve })

    await core.createNew()
    const draftId = core.currentDesign.peek()!.home.key
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'debounced' }))
    expect(appDataStore.loadDraft(draftId)).toBeNull()

    const firstWrite = nextWrite()
    await vi.advanceTimersByTimeAsync(CONTINUOUS_SAVE_DELAY_MS + 10)
    await firstWrite
    expect(appDataStore.loadDraft(draftId)?.description).toBe('debounced')
    expect(designSaveStatus.value).toBe('draft')

    const hideWrite = nextWrite()
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'flushed on hide' }))
    lifecycle.emit({ kind: 'hidden' })
    await hideWrite
    expect(appDataStore.loadDraft(draftId)?.description).toBe('flushed on hide')
  })

  it('writes the current Design before a replacement and asks only when that write fails', async () => {
    const { storage, appDataStore, core } = setupSession()
    await core.createNew()
    const firstId = core.currentDesign.peek()!.home.key
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'saved before replace' }))

    // When storage works, createNew flushes automatically without asking.
    await core.createNew()
    expect(appDataStore.loadDraft(firstId)?.description).toBe('saved before replace')

    // When storage fails, createNew enters closing/replacing question state.
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'cannot flush' }))
    storage.failWrites = true
    const replacing = core.createNew()
    await vi.waitFor(() => expect(core.state.value.kind).toBe('closing'))
    const state = core.state.value
    if (state.kind === 'closing') {
      expect(state.question?.kind).toBe('flush-failed-before-open')
      core.answer(state.question!.id, 'cancel')
    }
    await expect(replacing).resolves.toEqual({ status: 'cancelled' })
    expect(designSessionStore.readCurrentDesign()?.description).toBe('cannot flush')
  })

  it('reverts to the baseline opened and writes it back to the same Draft', async () => {
    const { appDataStore, core } = setupSession()
    appDataStore.saveDraft({ id: 'draft-revert', file: makeFile({ name: 'Orchard', description: 'original' }), now: NOW.toISOString() })

    await openDesignDraft('draft-revert', { presentFailure: false })
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'edited' }))
    await core.flushNow()
    expect(appDataStore.loadDraft('draft-revert')?.description).toBe('edited')

    await expect(core.revert()).resolves.toBe('reverted')
    expect(designSessionStore.readCurrentDesign()?.description).toBe('original')
    await core.flushNow()
    expect(appDataStore.loadDraft('draft-revert')?.description).toBe('original')
  })

  it('pauses on atomic integer CAS conflict when another browser tab changed the open Draft, and resolves cleanly', async () => {
    const storage = memoryStorage()
    const otherTabStore = createBrowserAppDataStore({ storage })
    otherTabStore.saveDraft({ id: 'draft-shared', file: makeFile({ name: 'Shared', description: 'v1' }), now: NOW.toISOString() })

    const { core } = setupSession({ storage })
    await openDesignDraft('draft-shared', { presentFailure: false })

    // Another tab updates the same Draft at a newer timestamp.
    otherTabStore.saveDraft({
      id: 'draft-shared',
      file: makeFile({ name: 'Shared', description: 'from other tab' }),
      now: new Date(NOW.getTime() + 1000).toISOString(),
    })

    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'from this tab' }))
    await expect(core.flushNow()).resolves.toBe(false)
    expect(designSaveStatus.value).toBe('conflict')
    // The other tab's Draft was NOT overwritten.
    expect(otherTabStore.loadDraft('draft-shared')?.description).toBe('from other tab')

    // Resolving with keep-mine writes this tab's version at the latest revision.
    await expect(core.resolveConflict('keep-mine')).resolves.toBe('resolved')
    expect(otherTabStore.loadDraft('draft-shared')?.description).toBe('from this tab')
    expect(designSaveStatus.value).toBe('draft')
  })

  it('deletes a Draft other than the open one, and refuses to delete the open Draft', async () => {
    const { appDataStore } = setupSession()
    appDataStore.saveDraft({ id: 'draft-a', file: makeFile({ name: 'Alpha' }), now: NOW.toISOString() })
    appDataStore.saveDraft({ id: 'draft-b', file: makeFile({ name: 'Beta' }), now: NOW.toISOString() })

    await expect(openWebDraft('draft-a')).resolves.toBe(true)
    expect((await deleteWebDraft('draft-a')).ok).toBe(false)
    expect(appDataStore.loadDraft('draft-a')).not.toBeNull()

    expect((await deleteWebDraft('draft-b')).ok).toBe(true)
    expect(appDataStore.loadDraft('draft-b')).toBeNull()
  })

  it('keeps separate Browser Drafts for different Designs with the same name and renames without leaving stale rows', async () => {
    const { appDataStore, core } = setupSession()
    await core.createNew()
    setDesignName('Same Name')
    await core.flushNow()
    const id1 = core.currentDesign.peek()!.home.key

    await core.createNew()
    setDesignName('Same Name')
    await core.flushNow()
    const id2 = core.currentDesign.peek()!.home.key

    expect(id1).not.toBe(id2)
    expect(appDataStore.listDrafts().map((d) => d.id).sort()).toEqual([id1, id2].sort())

    // Renaming the active Draft updates its row in place without duplicating it.
    setDesignName('Renamed Design')
    await core.flushNow()
    expect(appDataStore.listDrafts()).toHaveLength(2)
    expect(appDataStore.listDrafts().find((d) => d.id === id2)?.name).toBe('Renamed Design')
  })

  it('keeps the active Design intact when Browser Draft storage fails', async () => {
    const { storage, core } = setupSession()
    await core.createNew()
    editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'in memory' }))
    storage.failWrites = true

    await expect(core.flushNow()).resolves.toBe(false)
    expect(designSessionStore.readCurrentDesign()?.description).toBe('in memory')
    expect(core.currentDesign.value?.save.kind).toBe('quota')
  })

  it('serializes attached ScenePort state into Browser Drafts, snapshots on detach, and preserves current Design on load failure', async () => {
    const { appDataStore, core } = setupSession()
    const scene = makeScenePort()
    core.attachScene(scene)

    await core.createNew()
    const draftId = core.currentDesign.peek()!.home.key
    const addedPlant = plantAt({ lon: 1.5, lat: 47.2 })
    scene.state.plants = [addedPlant]
    core.recordSceneEdit('add-plant', { type: 'test-add-plant' } as unknown as SceneCommand)
    await core.flushNow()

    expect(appDataStore.loadDraft(draftId)?.plants).toEqual([expect.objectContaining(addedPlant)])

    // Detaching snapshots scene fields so currentWebDesignText still includes them.
    core.detachScene()
    expect(currentWebDesignText()).toContain('Malus domestica')

    // Re-attaching a scene whose load throws during replacement keeps the current Design intact.
    const failingScene = makeScenePort()
    core.attachScene(failingScene)
    failingScene.load.mockImplementationOnce(() => { throw new Error('scene hydrate boom') })
    const replacementBytes = new TextEncoder().encode(JSON.stringify(makeFile({ name: 'Replacement' })))
    const res = await core.openFrom({ kind: 'bytes', name: 'replacement.canopi', bytes: replacementBytes })
    expect(res.status).toBe('refused')
    expect(designSessionStore.readDesignName()).toBe('Untitled')
  })
})

describe('Web Draft download parity (2.1-Q193, canopi-eon8.15)', () => {
  it('Download a copy of a Draft and of the same Design open give one file name and one encoding', async () => {
    const file = makeFile({ name: 'Hazel: Walk/1', description: 'parity check' })
    browserAppDataStore.saveDraft({ id: 'draft-parity', file, now: NOW.toISOString() })

    const downloadSpy = vi.spyOn(browserTextFiles, 'downloadBrowserTextFile').mockImplementation(() => undefined)
    await downloadWebDraft('draft-parity')

    const core = createSessionCore({
      designHome: createBrowserSessionHomeStore(browserAppDataStore, () => NOW),
      fileAccess: browserFileAccessPort,
      lifecycle: createFakeLifecycle(),
      codec: createJsonSessionCodec(),
      settings: { readLastOpenHome: async () => null, writeLastOpenHome: async () => {} },
      newDesignFactory: () => makeNewCanopiFile('Untitled'),
    })
    const dispose = installLiveSessionCore(core)
    disposers.push(dispose)

    await openDesignDraft('draft-parity', { presentFailure: false })
    await createWebShellCommands().downloadCanopi()

    expect(downloadSpy).toHaveBeenCalledTimes(2)
    expect(downloadSpy.mock.calls[0]![0]).toBe(downloadSpy.mock.calls[1]![0])
    expect(downloadSpy.mock.calls[0]![1]).toBe(downloadSpy.mock.calls[1]![1])
  })
})

describe('browser tab close after a failed Draft write (2.1-Q22)', () => {
  it('WEB-03: closing the tab after a failed Draft write prompts until saved or discarded', async () => {
    const { storage, core } = setupSession()
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!core.pendingWrite.peek()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    const dispatchClose = () => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))

    try {
      expect(dispatchClose(), 'no Design: nothing to lose').toBe(false)

      await core.createNew()
      editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'pending edit' }))
      expect(dispatchClose(), 'unflushed edit prompts before unload').toBe(true)

      await expect(core.flushNow()).resolves.toBe(true)
      expect(dispatchClose(), 'after flush succeeds, unload does not prompt').toBe(false)

      editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'not written' }))
      storage.failWrites = true
      await expect(core.flushNow()).resolves.toBe(false)
      expect(dispatchClose(), 'failed write keeps unload guard armed').toBe(true)

      storage.failWrites = false
      await expect(core.flushNow()).resolves.toBe(true)
      expect(dispatchClose(), 'a later write succeeds and disarms it').toBe(false)

      editDesignSessionForTest(designSessionStore, (design) => ({ ...design, description: 'given up' }))
      storage.failWrites = true
      const reloading = reloadWebForRelease(vi.fn())
      await vi.waitFor(() => expect(core.state.value.kind).toBe('closing'))
      const q = core.state.value
      if (q.kind === 'closing') core.answer(q.question!.id, 'discard')
      await expect(reloading).resolves.toBe(true)
      expect(dispatchClose(), 'after Reload without saving the unload asks nothing more').toBe(false)
    } finally {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  })
})
