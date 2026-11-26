// @vitest-environment jsdom
import { h, render } from 'preact'
import { describe, expect, it, vi } from 'vitest'
import { createTestDesignCore } from '../../__tests__/support/design-wire'

vi.mock('../../platform/design-core', () => ({
  createDesignCore: () => createTestDesignCore(),
}))
import { getLiveSessionCore } from '../../app/document-session/live-core'
import { answerSaveProblem, saveProblem } from '../../app/document-session/save-problem'
import { editionPorts, hasEditionPorts, installEditionPorts } from '../../platform/edition-ports'
import { bootWebEdition } from './boot'
import { createBrowserSpeciesCatalogRuntime } from './species-catalog-runtime'
import { createWebAppCatalog, createWebShellShortcutSource } from './WebApp'
import { installWebProblemReport, WebRootBoundary } from './WebRoot'

describe('bootWebEdition (canopi-f47t.52.71)', () => {
  it('installs Web edition ports and cleanly disposes all bindings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
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
    const beforeUnloadClean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(beforeUnloadClean)
    expect(beforeUnloadClean.defaultPrevented).toBe(false)
    await core.close('close')

    // B3 + WEB-03: Web registers the edition-neutral question bridge so a failed flush asks SaveProblemDialog instead of hanging,
    // and beforeunload prompts only when the synchronous Draft flush fails.
    await core.createNew()
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    core.document('rename', () => ({ name: 'WebQuotaBlocked' }))
    const beforeUnloadBlocked = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(beforeUnloadBlocked)
    expect(beforeUnloadBlocked.defaultPrevented).toBe(true)

    // B2: if snapshot() throws during beforeunload (e.g. SceneEditBusyError), beforeunload still calls preventDefault().
    const snapshotSpy = vi.spyOn(core, 'snapshot').mockImplementationOnce(() => {
      throw new Error('SceneEditBusyError')
    })
    const beforeUnloadThrown = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(beforeUnloadThrown)
    expect(beforeUnloadThrown.defaultPrevented).toBe(true)
    snapshotSpy.mockRestore()

    const closing = core.close('close')
    await vi.waitFor(() => {
      expect(saveProblem.value).toEqual({ kind: 'flush-failed', purpose: 'close', conflict: false })
    })
    answerSaveProblem('discard')
    expect(await closing).toBe('closed')
    setItemSpy.mockRestore()

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
    // Second dispose is a safe no-op.
    dispose()
    expect(hasEditionPorts()).toBe(false)
    expect(() => editionPorts()).toThrow(/not installed/)
    vi.restoreAllMocks()
  })

  it('canopi-f47t.52.50: wires BrowserDesignHomeStore lifecycle, pending markers, pagehide/pageshow, and storage events when IndexedDB is available', async () => {
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
      delete: vi.fn().mockResolvedValue({ kind: 'deleted' }),
      listDrafts: vi.fn().mockResolvedValue([{ id: 'draft-idb-1', bytes: draftBytes, version: '1' }]),
      syncLegacyStorage: vi.fn().mockResolvedValue(undefined),
      onVersionChange: vi.fn(() => () => {}),
      closeForPageHide: vi.fn(),
      reopenAfterPageShow: vi.fn().mockResolvedValue(undefined),
      markPending: vi.fn(),
      clearPending: vi.fn(),
      takePendingMarkers: vi.fn().mockReturnValue(['draft-idb-1', 'draft-unmatched']),
      dispose: vi.fn(),
    }
    vi.spyOn(idbMod, 'isIndexedDbAvailable').mockReturnValue(true)
    vi.spyOn(idbMod, 'createBrowserDesignHomeStore').mockImplementation((opts) => {
      captured.opts = opts
      return fakeStore as never
    })

    const dispose = bootWebEdition()
    await vi.waitFor(() => {
      expect(fakeStore.listDrafts).toHaveBeenCalled()
    })
    expect(captured.opts).toBeDefined()
    captured.opts?.onBlocked?.()
    captured.opts?.onVersionChange?.()
    captured.opts?.onNewerStore?.()
    captured.opts?.onOlderTabCopy?.({ legacyId: 'old', copyId: 'older-tab-old', name: 'Old' })
    captured.opts?.onMigrationFailed?.(new Error('move failed'))

    window.dispatchEvent(new Event('pagehide'))
    expect(fakeStore.closeForPageHide).toHaveBeenCalledOnce()
    const pageShow = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(pageShow, 'persisted', { value: true })
    window.dispatchEvent(pageShow)
    expect(fakeStore.reopenAfterPageShow).toHaveBeenCalledOnce()
    const pageShowNotPersisted = new Event('pageshow') as PageTransitionEvent
    Object.defineProperty(pageShowNotPersisted, 'persisted', { value: false })
    window.dispatchEvent(pageShowNotPersisted)
    expect(fakeStore.reopenAfterPageShow).toHaveBeenCalledOnce()
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key' }))
    expect(fakeStore.syncLegacyStorage).not.toHaveBeenCalled()
    window.dispatchEvent(new StorageEvent('storage', { key: 'canopi:web-app-data:v3:drafts' }))
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    expect(fakeStore.syncLegacyStorage).toHaveBeenCalledTimes(2)

    const { listWebDraftsAsync, downloadWebDraft } = await import('./web-session')
    const listed = await listWebDraftsAsync()
    expect(listed.map((d) => d.id)).toContain('draft-idb-1')
    // Exercise dirty->clean pending-write marker hooks and downloadWebDraft over IDB.
    const core = getLiveSessionCore()!
    core.document('rename', () => ({ name: 'IDB Renamed' }))
    await vi.waitFor(() => {
      expect(fakeStore.markPending).toHaveBeenCalled()
    })
    await core.close('close')
    expect(fakeStore.clearPending).toHaveBeenCalled()
    await downloadWebDraft('draft-idb-1')
    expect(fakeStore.read).toHaveBeenCalledWith('draft-idb-1')
    // Missing/unreadable draft in downloadWebDraft and malformed bytes in listWebDraftsAsync.
    fakeStore.read.mockResolvedValueOnce({ kind: 'absent' })
    await expect(downloadWebDraft('draft-missing')).rejects.toThrow('Draft not found')
    fakeStore.listDrafts.mockResolvedValueOnce([{ id: 'draft-corrupt', bytes: new TextEncoder().encode('{bad'), version: '1' }])
    expect(await listWebDraftsAsync()).toEqual([{ id: 'draft-corrupt', name: 'Untitled', updatedAt: undefined }])

    dispose()
    expect(fakeStore.dispose).toHaveBeenCalledOnce()

    // Also cover open() returning 'newer' and open() rejecting cleanly.
    fakeStore.open.mockResolvedValueOnce({ kind: 'newer' })
    const dispose2 = bootWebEdition()
    await vi.waitFor(() => { expect(fakeStore.open).toHaveBeenCalledTimes(2) })
    dispose2()
    fakeStore.open.mockRejectedValueOnce(new Error('open boom'))
    const dispose3 = bootWebEdition()
    await vi.waitFor(() => { expect(fakeStore.open).toHaveBeenCalledTimes(3) })
    dispose3()
    vi.restoreAllMocks()
  })
})
