// @vitest-environment jsdom
import { h, render } from 'preact'
import { describe, expect, it, vi } from 'vitest'
import { createTestDesignCore } from '../../__tests__/support/design-wire'
import { seedLegacyDraft } from '../../__tests__/support/legacy-draft-fixture'

vi.mock('../../platform/design-core', () => ({
  createDesignCore: () => createTestDesignCore(),
}))
import { getLiveSessionCore } from '../../app/document-session/live-core'
import { answerSaveProblem, saveProblem } from '../../app/document-session/save-problem'
import { designSessionStore } from '../../app/document-session/store'
import { notices, resetNoticesForTests } from '../../failures/notices'
import { editionPorts, hasEditionPorts, installEditionPorts } from '../../platform/edition-ports'
import { browserAppDataStore, DRAFTS_STORAGE_KEY } from '../../web/browser-app-data'
import { bootWebEdition } from './boot'
import { browserReleaseWatch } from './browser-release-watch'
import { createBrowserSpeciesCatalogRuntime } from './species-catalog-runtime'
import { createWebAppCatalog, createWebShellShortcutSource } from './WebApp'
import { installWebProblemReport, WebRootBoundary } from './WebRoot'

function makeMemoryIdbHomeStore() {
  const records = new Map<string, { bytes: number[]; version: number; updatedAt: string }>()
  let failWrites = false
  return {
    setFailWrites(v: boolean) { failWrites = v },
    open: vi.fn().mockResolvedValue({ kind: 'ready' as const }),
    read: vi.fn(async (key: string) => {
      const rec = records.get(key)
      return rec ? { kind: 'present' as const, bytes: rec.bytes, version: String(rec.version) } : { kind: 'absent' as const }
    }),
    write: vi.fn(async (key: string, bytes: Uint8Array) => {
      if (failWrites) {
        return {
          kind: 'failed' as const,
          failure: { code: { kind: 'io' as const, io: 'other' as const }, user_may_retry: true, op: 'web.draft.write', operation: null, detail: null },
        }
      }
      const nextVer = (records.get(key)?.version ?? 0) + 1
      records.set(key, { bytes: Array.from(bytes), version: nextVer, updatedAt: '2026-12-01T00:00:00.000Z' })
      return { kind: 'written' as const, version: String(nextVer) }
    }),
    listDrafts: vi.fn(async () => [...records.entries()].map(([id, r]) => ({ id, bytes: new Uint8Array(r.bytes), updatedAt: r.updatedAt }))),
    deleteDraft: vi.fn(async (id: string) => { records.delete(id); return { ok: true as const } }),
    syncLegacyStorage: vi.fn().mockResolvedValue(undefined),
    onVersionChange: vi.fn(() => () => {}),
    closeForPageHide: vi.fn(),
    reopenAfterPageShow: vi.fn().mockResolvedValue(undefined),
    markPending: vi.fn(),
    clearPending: vi.fn(),
    takePendingMarkers: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
  }
}

describe('bootWebEdition (canopi-f47t.52.71)', () => {
  it('installs Web edition ports and cleanly disposes all bindings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const idbMod = await import('../../platform/design-home.browser')
    const memStore = makeMemoryIdbHomeStore()
    vi.spyOn(idbMod, 'createBrowserDesignHomeStore').mockReturnValue(memStore as never)

    const dispose = bootWebEdition()
    expect(hasEditionPorts()).toBe(true)
    const ports = editionPorts()
    expect(ports.capabilities).toBeDefined()
    expect(ports.manifest?.panels.length).toBeGreaterThan(0)
    expect(ports.problemReport).toBeDefined()
    for (const reader of Object.values(ports.problemReport.sections)) {
      if (typeof reader === 'function') expect(reader()).toBeDefined()
    }
    expect(await ports.problemReport.currentDesign()).toBeNull()

    const core = getLiveSessionCore()!
    expect(core).not.toBeNull()
    const created = await core.createNew()
    expect(created.status).toBe('opened')
    expect(await ports.problemReport.currentDesign()).not.toBeNull()
    core.document('rename', () => ({ name: 'WebBooted' }))
    // Unload with pending IndexedDB write starts async flush and sets browser unload prompt.
    const flushSpy = vi.spyOn(core, 'flushNow')
    const beforeUnloadDirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(beforeUnloadDirty)
    expect(beforeUnloadDirty.defaultPrevented).toBe(true)
    expect(flushSpy).toHaveBeenCalledWith({ force: true })
    flushSpy.mockRestore()
    await core.flushNow({ force: true })
    const beforeUnloadClean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(beforeUnloadClean)
    expect(beforeUnloadClean.defaultPrevented).toBe(false)
    await core.close('close')

    // Failed flush asks SaveProblemDialog instead of hanging.
    await core.createNew()
    memStore.setFailWrites(true)
    core.document('rename', () => ({ name: 'WebWriteBlocked' }))
    const closing = core.close('close')
    await vi.waitFor(() => {
      expect(saveProblem.value).toEqual({ kind: 'flush-failed', purpose: 'close', conflict: false })
    })
    answerSaveProblem('discard')
    expect(await closing).toBe('closed')
    memStore.setFailWrites(false)

    const uninstallReport = installWebProblemReport()
    uninstallReport()

    const host = document.createElement('div')
    document.body.appendChild(host)
    const reloadForRelease = vi.fn().mockRejectedValue(new Error('reload boom'))
    const Boom = () => { throw new Error('render boom') }
    render(h(WebRootBoundary, { session: { reloadForRelease }, children: h(Boom, null) }), host)
    const reloadBtn = Array.from(host.querySelectorAll('button')).find((b) => /reload/i.test(b.textContent ?? ''))
    reloadBtn?.click()
    await Promise.resolve()
    render(null, host)
    host.remove()

    const mockReader = {
      search: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      loadDynamicFilterOptions: vi.fn().mockResolvedValue([]),
      getFilterOptions: vi.fn().mockResolvedValue({}),
      getSupportedFilterFields: vi.fn().mockResolvedValue([]),
      getSpeciesDetail: vi.fn().mockResolvedValue(null),
      listSpeciesByCanonicalNames: vi.fn().mockResolvedValue([
        { canonical_name: 'Malus domestica', common_name: 'Apple', habit: 'Tree' },
      ]),
      dispose: vi.fn().mockResolvedValue(undefined),
    }
    const runtime = createBrowserSpeciesCatalogRuntime({ reader: mockReader as never })
    expect(await runtime.workbench.resolveCommonNames(['Malus domestica'], 'en')).toEqual({ 'Malus domestica': 'Apple' })
    expect(await runtime.workbench.resolveHabits(['Malus domestica'])).toEqual({ 'Malus domestica': 'Tree' })
    await runtime.dispose()
    await runtime.dispose()
    expect(mockReader.dispose).toHaveBeenCalledTimes(1)

    const catalog = createWebAppCatalog()
    const shortcuts = createWebShellShortcutSource(catalog)
    expect(shortcuts.readState().hasDesign).toBe(false)
    const restore = installEditionPorts(ports)
    expect(editionPorts()).toBe(ports)
    restore()
    dispose()
    dispose()
    expect(hasEditionPorts()).toBe(false)
    expect(() => editionPorts()).toThrow(/not installed/)
    vi.restoreAllMocks()
  })

  it('canopi-f47t.52.50: wires BrowserDesignHomeStore lifecycle, pending markers, notices, pagehide/pageshow, and storage events', async () => {
    resetNoticesForTests()
    const idbMod = await import('../../platform/design-home.browser')
    const captured: { opts?: Parameters<typeof idbMod.createBrowserDesignHomeStore>[0] } = {}
    const draftBytes = new TextEncoder().encode(JSON.stringify({
      version: 10,
      name: 'IDB Orchard',
      description: null,
      plant_species_colors: {},
      plant_species_symbols: {},
      layers: [],
      plants: [],
      zones: [],
      annotations: [],
      created_at: '2026-12-01T00:00:00.000Z',
      updated_at: '2026-12-01T00:00:00.000Z',
    }))
    const fakeStore = {
      open: vi.fn().mockResolvedValue({ kind: 'ready' }),
      read: vi.fn().mockResolvedValue({ kind: 'present', bytes: draftBytes, version: '1' }),
      write: vi.fn().mockResolvedValue({ kind: 'written', version: '2' }),
      deleteDraft: vi.fn().mockResolvedValue({ ok: true }),
      listDrafts: vi.fn().mockResolvedValue([{ id: 'draft-idb-1', bytes: draftBytes, updatedAt: '2026-12-01T00:00:00.000Z' }]),
      syncLegacyStorage: vi.fn().mockResolvedValue(undefined),
      onVersionChange: vi.fn(() => () => {}),
      closeForPageHide: vi.fn(),
      reopenAfterPageShow: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn(),
      clearPending: vi.fn(),
      takePendingMarkers: vi.fn().mockReturnValue(['draft-idb-1']),
      dispose: vi.fn(),
    }
    const storeChangedSpy = vi.spyOn(browserReleaseWatch, 'storeChanged').mockImplementation(() => {})
    vi.spyOn(idbMod, 'createBrowserDesignHomeStore').mockImplementation((opts) => {
      captured.opts = opts
      return fakeStore
    })

    const dispose = bootWebEdition()
    await vi.waitFor(() => {
      expect(fakeStore.listDrafts).toHaveBeenCalled()
    })
    // Assert pending-write marker surfaced the warning notice naming the Draft.
    expect(notices.value.some((n) => n.key === 'web.pending-write' && n.params?.name === 'IDB Orchard')).toBe(true)

    expect(captured.opts).toBeDefined()
    captured.opts?.onBlocked?.()
    expect(notices.value.some((n) => n.key === 'web.draft-store-blocked')).toBe(true)
    captured.opts?.onVersionChange?.()
    captured.opts?.onNewerStore?.()
    expect(storeChangedSpy).toHaveBeenCalledTimes(2)
    captured.opts?.onOlderTabCopy?.({ legacyId: 'old', copyId: 'older-tab-old', name: 'Old Orchard' })
    expect(notices.value.some((n) => n.key === 'web.older-tab-copy' && n.params?.name === 'Old Orchard')).toBe(true)
    captured.opts?.onMigrationFailed?.(new Error('move failed'))

    window.dispatchEvent(new Event('pagehide'))
    expect(fakeStore.closeForPageHide).toHaveBeenCalledOnce()
    // R2-6: pagehide notes the reload tab id; pageshow(persisted) clears it so a duplicated tab cannot steal markers.
    expect(sessionStorage.getItem('canopi:web-drafts:reload-tab-id')).not.toBeNull()
    const pageShow = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(pageShow, 'persisted', { value: true })
    window.dispatchEvent(pageShow)
    expect(fakeStore.reopenAfterPageShow).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem('canopi:web-drafts:reload-tab-id')).toBeNull()
    const pageShowNotPersisted = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(pageShowNotPersisted, 'persisted', { value: false })
    window.dispatchEvent(pageShowNotPersisted)
    expect(fakeStore.reopenAfterPageShow).toHaveBeenCalledOnce()
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key' }))
    expect(fakeStore.syncLegacyStorage).not.toHaveBeenCalled()
    window.dispatchEvent(new StorageEvent('storage', { key: DRAFTS_STORAGE_KEY }))
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    expect(fakeStore.syncLegacyStorage).toHaveBeenCalledTimes(2)

    const { listWebDraftsAsync, downloadWebDraft } = await import('./web-session')
    const listed = await listWebDraftsAsync()
    expect(listed.editable.map((d) => d.id)).toContain('draft-idb-1')
    expect(listed.readOnly).toEqual([])
    const core = getLiveSessionCore()!
    core.document('rename', () => ({ name: 'IDB Renamed' }))
    await vi.waitFor(() => {
      expect(fakeStore.markPending).toHaveBeenCalled()
    })
    // R2-6: beforeunload does not note reload-tab-id (only pagehide does).
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    expect(sessionStorage.getItem('canopi:web-drafts:reload-tab-id')).toBeNull()
    // R2-8: returning from bfcache with a dirty Draft retries flushNow after reopen.
    const flushOnRestore = vi.spyOn(core, 'flushNow')
    const pageShowDirty = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(pageShowDirty, 'persisted', { value: true })
    window.dispatchEvent(pageShowDirty)
    await vi.waitFor(() => {
      expect(flushOnRestore).toHaveBeenCalledWith({ force: true })
    })
    flushOnRestore.mockRestore()
    await core.close('close')
    expect(fakeStore.clearPending).toHaveBeenCalled()
    await downloadWebDraft('draft-idb-1')
    expect(fakeStore.read).toHaveBeenCalledWith('draft-idb-1')
    // R2-2: when IndexedDB is working, Download a copy never falls back to stale 2.0 localStorage.
    seedLegacyDraft({
      id: 'draft-missing',
      name: 'Stale 2.0',
      now: '2026-10-01T00:00:00.000Z',
      raw: { version: 10, name: 'Stale 2.0' },
    })
    fakeStore.read.mockResolvedValueOnce({ kind: 'absent' })
    await expect(downloadWebDraft('draft-missing')).rejects.toThrow('Draft not found')
    localStorage.removeItem(DRAFTS_STORAGE_KEY)
    fakeStore.listDrafts.mockResolvedValueOnce([{ id: 'draft-corrupt', bytes: new TextEncoder().encode('{bad'), updatedAt: '' }])
    expect((await listWebDraftsAsync()).editable).toEqual([{ id: 'draft-corrupt', name: 'Untitled', updatedAt: '' }])

    fakeStore.read.mockResolvedValueOnce({ kind: 'unreadable', reason: 'draft_unreadable' })
    resetNoticesForTests()
    const { openWebDraft: openIdbDraft } = await import('./web-session')
    expect(await openIdbDraft('draft-idb-1')).toBe(false)
    expect(notices.value.some((n) => n.key === 'web.open-failure')).toBe(true)
    expect(core.currentDesign.peek()).toBeNull()

    dispose()
    expect(fakeStore.dispose).toHaveBeenCalledOnce()
    vi.restoreAllMocks()
  })

  it('R3 canopi-f47t.52.272: a 2.1 Draft whose read a version change closed opens nothing and says no open failure, as the Reload notice tells the user (2.1-Q40, Q337)', async () => {
    resetNoticesForTests()
    const idbMod = await import('../../platform/design-home.browser')
    const fakeStore = {
      open: vi.fn().mockResolvedValue({ kind: 'ready' }),
      read: vi.fn().mockResolvedValue({ kind: 'unreadable', reason: 'draft_store_newer' }),
      write: vi.fn().mockResolvedValue({ kind: 'written', version: '1' }),
      deleteDraft: vi.fn().mockResolvedValue({ ok: true }),
      listDrafts: vi.fn().mockResolvedValue([]),
      syncLegacyStorage: vi.fn().mockResolvedValue(undefined),
      onVersionChange: vi.fn(() => () => {}),
      closeForPageHide: vi.fn(),
      reopenAfterPageShow: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn(),
      clearPending: vi.fn(),
      takePendingMarkers: vi.fn().mockReturnValue([]),
      dispose: vi.fn(),
    }
    vi.spyOn(idbMod, 'createBrowserDesignHomeStore').mockReturnValue(fakeStore)
    const dispose = bootWebEdition()
    const { openWebDraft } = await import('./web-session')
    try {
      await vi.waitFor(() => expect(fakeStore.open).toHaveBeenCalled())
      resetNoticesForTests()
      expect(await openWebDraft('draft-newer-1')).toBe(false)
      expect(notices.value.some((n) => n.key === 'web.open-failure')).toBe(false)
      expect(getLiveSessionCore()!.currentDesign.peek()).toBeNull()
    } finally {
      dispose()
      vi.restoreAllMocks()
    }
  })

  it('canopi-2b6q (2.1-Q334, B4): real bootWebEdition with failing indexedDB.open lists 2.0 Drafts read-only, opens read-only with notice, handles deleted 2.0 Drafts, and never writes', async () => {
    localStorage.clear()
    sessionStorage.clear()
    resetNoticesForTests()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    seedLegacyDraft({
      id: 'legacy-1',
      name: 'Old Garden',
      now: '2026-10-01T00:00:00.000Z',
      raw: {
        version: 10,
        name: 'Old Garden',
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
        budget_currency: 'USD',
        views: [],
        stories: [],
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
      },
    })
    const legacyRecord = localStorage.getItem(DRAFTS_STORAGE_KEY)

    const prevIdb = globalThis.indexedDB
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open() {
          throw new DOMException('IndexedDB disabled in private mode', 'SecurityError')
        },
      },
    })

    const dispose = bootWebEdition()
    const {
      deleteWebDraft,
      isWebStorageUnchecked,
      listWebDraftsAsync,
      openWebDraft,
      webLaunching,
    } = await import('./web-session')
    try {
      await vi.waitFor(() => expect(webLaunching.value).toBe(false))
      expect(isWebStorageUnchecked()).toBe(true)
      // Should-fix #3: launch with nothing opened does not prematurely raise the "Opened read-only" notice.
      expect(notices.value.some((n) => n.key === 'web.storage-unchecked')).toBe(false)

      const listing = await listWebDraftsAsync()
      expect(listing.editable).toEqual([])
      expect(listing.readOnly.map((d) => d.id)).toEqual(['legacy-1'])
      expect((await deleteWebDraft('legacy-1')).ok).toBe(false)

      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
      expect(await openWebDraft('legacy-1')).toBe(true)
      expect(notices.value.some((n) => n.key === 'web.storage-unchecked')).toBe(true)
      expect(designSessionStore.sessionKind.value).toEqual({ kind: 'read-only', origin: 'storage-unchecked' })
      // In-memory edit on a read-only storage-unchecked Draft must never write to localStorage (2.1-M21).
      getLiveSessionCore()!.document('rename', () => ({ name: 'Should Not Persist' }))
      await getLiveSessionCore()!.flushNow({ force: true })
      expect(setItemSpy).not.toHaveBeenCalledWith(DRAFTS_STORAGE_KEY, expect.anything())
      expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBe(legacyRecord)
      expect(browserAppDataStore.listDrafts()).toHaveLength(1)

      // Restored Q334 behaviour: a 2.0 Draft another tab deleted after listing opens nothing, says so, and leaves the list.
      await getLiveSessionCore()!.close('close')
      localStorage.removeItem(DRAFTS_STORAGE_KEY)
      resetNoticesForTests()
      expect(await openWebDraft('legacy-1')).toBe(false)
      expect(notices.value.some((n) => n.key === 'web.open-failure')).toBe(true)
      expect((await listWebDraftsAsync()).readOnly).toEqual([])
    } finally {
      dispose()
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: prevIdb })
      vi.restoreAllMocks()
    }
  })
})
