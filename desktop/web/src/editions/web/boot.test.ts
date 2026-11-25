// @vitest-environment jsdom
import { h, render } from 'preact'
import { describe, expect, it, vi } from 'vitest'
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
    expect(ports.problemReport.currentDesign()).toBeNull()

    const core = getLiveSessionCore()!
    expect(core).not.toBeNull()
    const created = await core.createNew()
    expect(created.status).toBe('opened')
    expect(ports.problemReport.currentDesign()).not.toBeNull()
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
})
