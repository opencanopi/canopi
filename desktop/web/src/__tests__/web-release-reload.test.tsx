// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs'
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveProblemChoice, requestSaveProblemDecision } from '../app/document-session/save-problem'
import { answerSaveProblem, saveProblem } from '../app/document-session/save-problem'
import { createDesignSessionStore } from '../app/document-session/store'
import { activePanel, navigateTo, sidePanel } from '../app/shell/state'
import { locale } from '../app/settings/state'
import { SaveProblemDialog } from '../components/shared/SaveProblemDialog'
import { t } from '../i18n'
import type { CanopiFile } from '../types/design'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../web/browser-app-data'
import { createBrowserDesignSessionController, type BrowserCanopiDownload } from '../web/browser-design-session'
import { BrowserAppShell } from '../web/BrowserAppShell'
import { dismissBrowserShellNotice, showBrowserShellNotice } from '../web/browser-shell-notice'
import { editDesignSessionForTest } from './support/design-session-edit'
import { projectBrowserShellForTest } from './support/browser-shell-projection'

// Reload for a waiting Web release (2.1-Q83, Q188, Q189, M179; Step 2.0.3 serving chunk 2): the session's
// flush-then-act loop with a `reload` purpose, the tab's own Design reopened after it, and the notice in the shell row.

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
    removeItem: (key) => { values.delete(key) },
  }
}

function design(name: string, description: string | null = null): CanopiFile {
  return {
    version: 9, name, description, plant_species_colors: {}, plant_species_symbols: {}, layers: [], plants: [],
    zones: [], annotations: [], measurement_guides: [], groups: [], consortiums: [], timeline: [], budget: [],
    budget_currency: 'EUR', views: [], stories: [], created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', extra: {},
  }
}

/** One browser tab: its own Design Session over the shared localStorage and its own sessionStorage. */
function tab(storage: MemoryStorage, session: MemoryStorage, decide?: (request: unknown) => Promise<SaveProblemChoice>) {
  let tick = 0
  const store = createDesignSessionStore()
  const appDataStore = createBrowserAppDataStore({ storage, session })
  const reload = vi.fn()
  const downloadCanopiFile = vi.fn<(download: BrowserCanopiDownload) => Promise<void>>(async () => undefined)
  const controller = createBrowserDesignSessionController({
    store,
    appDataStore,
    fileAdapter: { openCanopiFile: async () => null, downloadCanopiFile },
    now: () => new Date(Date.UTC(2026, 6, 4, 12, 0, tick++)),
    requestSaveDecision: decide as never,
    reload,
  })
  return { store, appDataStore, controller, reload, downloadCanopiFile }
}

describe('Reload for a waiting release (2.1-Q83, Q188, Q189)', () => {
  it('reloads at once when no Design is open', async () => {
    const decide = vi.fn()
    const run = tab(memoryStorage(), memoryStorage(), decide)
    await expect(run.controller.reloadForRelease()).resolves.toBe(true)
    expect(run.reload).toHaveBeenCalledOnce()
    expect(decide).not.toHaveBeenCalled()
    expect(run.appDataStore.takeReloadHome(), 'the tab record says it had no Design').toEqual({ draft: null })
  })

  it('writes pending changes before it reloads', async () => {
    const storage = memoryStorage()
    const run = tab(storage, memoryStorage())
    await run.controller.newDesign()
    editDesignSessionForTest(run.store, (file) => ({ ...file, description: 'planted before the deploy' }))
    let written: string | null | undefined
    run.reload.mockImplementation(() => {
      // When the page reloads, the latest edit is already in the Draft.
      const id = run.appDataStore.listDrafts()[0]?.id
      written = id === undefined ? undefined : run.appDataStore.loadDraft(id)?.description
    })
    await expect(run.controller.reloadForRelease()).resolves.toBe(true)
    expect(run.reload).toHaveBeenCalledOnce()
    expect(written).toBe('planted before the deploy')
  })

  it('Q83: Reload saves first, and a failed save offers Download a copy', async () => {
    const storage = memoryStorage()
    const answers: SaveProblemChoice[] = ['save-copy', 'cancel']
    const decide = vi.fn(async () => answers.shift() ?? 'cancel')
    const run = tab(storage, memoryStorage(), decide)
    await run.controller.newDesign()
    editDesignSessionForTest(run.store, (file) => ({ ...file, description: 'unwritable' }))
    storage.failWrites = true

    // Download a copy downloads, then returns to the dialog; Cancel keeps the tab as it is.
    await expect(run.controller.reloadForRelease()).resolves.toBe(false)
    expect(decide).toHaveBeenNthCalledWith(1, { kind: 'flush-failed', purpose: 'reload', conflict: false })
    expect(decide).toHaveBeenCalledTimes(2)
    expect(run.downloadCanopiFile).toHaveBeenCalledOnce()
    expect(run.downloadCanopiFile.mock.calls[0]![0].text).toContain('unwritable')
    expect(run.reload).not.toHaveBeenCalled()
    expect(run.store.readCurrentDesign()?.description).toBe('unwritable')

    // Retry once the browser has room writes the Draft, then reloads.
    answers.push('retry')
    decide.mockImplementationOnce(async () => {
      storage.failWrites = false
      return answers.shift()!
    })
    await expect(run.controller.reloadForRelease()).resolves.toBe(true)
    expect(run.reload).toHaveBeenCalledOnce()
    const draft = run.appDataStore.listDrafts()[0]!
    expect(run.appDataStore.loadDraft(draft.id)?.description).toBe('unwritable')

    // Reload without saving reloads with the write still failing.
    const again = tab(storage, memoryStorage(), async () => 'discard')
    await again.controller.newDesign()
    storage.failWrites = true
    editDesignSessionForTest(again.store, (file) => ({ ...file, description: 'lost on purpose' }))
    await expect(again.controller.reloadForRelease()).resolves.toBe(true)
    expect(again.reload).toHaveBeenCalledOnce()
  })

  it('a second Reload while the first is saving is the same Reload', async () => {
    const storage = memoryStorage()
    let answer!: (choice: SaveProblemChoice) => void
    const decide = vi.fn(() => new Promise<SaveProblemChoice>((resolve) => { answer = resolve }))
    const run = tab(storage, memoryStorage(), decide)
    await run.controller.newDesign()
    editDesignSessionForTest(run.store, (file) => ({ ...file, description: 'busy' }))
    storage.failWrites = true
    const first = run.controller.reloadForRelease()
    const second = run.controller.reloadForRelease()
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce())
    answer('discard')
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(run.reload).toHaveBeenCalledOnce()
  })

  it('Reload over a Draft another tab changed offers Download a copy', async () => {
    const storage = memoryStorage()
    const other = createBrowserAppDataStore({ storage, session: memoryStorage() })
    other.saveDraft({ id: 'draft-shared', file: design('Shared'), now: '2026-07-04T11:00:00.000Z' })
    const decide = vi.fn(async () => 'cancel' as const)
    const run = tab(storage, memoryStorage(), decide)
    expect(run.controller.restoreLatestDraft()).toBe(true)
    other.saveDraft({ id: 'draft-shared', file: design('Shared', 'other tab'), now: '2026-07-04T13:00:00.000Z' })
    editDesignSessionForTest(run.store, (file) => ({ ...file, description: 'this tab' }))

    await expect(run.controller.reloadForRelease()).resolves.toBe(false)
    expect(decide).toHaveBeenCalledWith({ kind: 'flush-failed', purpose: 'reload', conflict: true, where: 'another-tab' })
    expect(run.reload).not.toHaveBeenCalled()
    expect(other.loadDraft('draft-shared')?.description).toBe('other tab')
  })

  it('Q189: Reload reopens the Design this tab had open', async () => {
    const storage = memoryStorage()
    const session = memoryStorage()
    const seed = createBrowserAppDataStore({ storage, session: memoryStorage() })
    seed.saveDraft({ id: 'draft-orchard', file: design('Orchard'), now: '2026-07-04T10:00:00.000Z' })
    seed.saveDraft({ id: 'draft-hedge', file: design('Hedge'), now: '2026-07-04T11:00:00.000Z' })

    const before = tab(storage, session)
    await before.controller.openDraft('draft-orchard')
    expect(before.store.readDesignName()).toBe('Orchard')
    // Another tab writes a newer Draft meanwhile, so "the newest" would be the wrong Design.
    seed.saveDraft({ id: 'draft-hedge', file: design('Hedge', 'newer'), now: '2026-07-04T23:00:00.000Z' })
    await before.controller.reloadForRelease()
    expect(before.reload).toHaveBeenCalledOnce()
    expect(Array.from(session.values.values()).map((value) => JSON.parse(value)), 'the tab record names only the Draft id').toEqual([{ draft: 'draft-orchard' }])
    expect(Array.from(storage.values.keys()).some((key) => key.includes('reload')), 'nothing lands in localStorage').toBe(false)

    // The same tab after the reload: this tab's Design, once; a later launch reopens the newest as before.
    const after = tab(storage, session)
    expect(after.controller.restoreLatestDraft()).toBe(true)
    expect(after.store.readDesignName()).toBe('Orchard')
    expect(session.values.size, 'the record is one-shot').toBe(0)
    const later = tab(storage, session)
    expect(later.controller.restoreLatestDraft()).toBe(true)
    expect(later.store.readDesignName()).toBe('Hedge')
  })

  // C2-1: a reload never falls back to the newest Draft, which may be another tab's open Design.
  it('Q189: a tab record naming a Draft that is gone opens the start screen, never the newest Draft', () => {
    const storage = memoryStorage()
    const session = memoryStorage()
    const seed = createBrowserAppDataStore({ storage, session })
    seed.saveDraft({ id: 'draft-hedge', file: design('Hedge'), now: '2026-07-04T11:00:00.000Z' })
    seed.noteReloadHome('draft-deleted')
    const after = tab(storage, session)
    expect(after.controller.restoreLatestDraft()).toBe(false)
    expect(after.store.hasCurrentDesign()).toBe(false)
  })

  it('Q189 (C2-1): Reload from the start screen comes back to the start screen, not another tab\'s Draft', async () => {
    const storage = memoryStorage()
    const session = memoryStorage()
    const other = createBrowserAppDataStore({ storage, session: memoryStorage() })
    other.saveDraft({ id: 'draft-orchard', file: design('Orchard'), now: '2026-07-04T10:00:00.000Z' })
    const before = tab(storage, session)
    await expect(before.controller.reloadForRelease()).resolves.toBe(true)
    const after = tab(storage, session)
    expect(after.controller.restoreLatestDraft()).toBe(false)
    expect(after.store.hasCurrentDesign()).toBe(false)
    // The record is one-shot: a later launch reopens the newest Draft as before.
    const later = tab(storage, session)
    expect(later.controller.restoreLatestDraft()).toBe(true)
    expect(later.store.readDesignName()).toBe('Orchard')
  })

  it('Q189 (C2-1): Reload without saving a Design never written comes back to the start screen', async () => {
    const storage = memoryStorage()
    const session = memoryStorage()
    const other = createBrowserAppDataStore({ storage, session: memoryStorage() })
    other.saveDraft({ id: 'draft-orchard', file: design('Orchard'), now: '2026-07-04T10:00:00.000Z' })
    const before = tab(storage, session, async () => 'discard')
    await before.controller.newDesign()
    storage.failWrites = true
    editDesignSessionForTest(before.store, (file) => ({ ...file, description: 'never written' }))
    await expect(before.controller.reloadForRelease()).resolves.toBe(true)
    storage.failWrites = false
    const after = tab(storage, session)
    expect(after.controller.restoreLatestDraft()).toBe(false)
    expect(after.store.hasCurrentDesign()).toBe(false)
  })

  it('an unreadable session store never blocks the reload or the launch', async () => {
    const storage = memoryStorage()
    const broken: BrowserStorageAdapter = {
      getItem: () => { throw new DOMException('denied', 'SecurityError') },
      setItem: () => { throw new DOMException('denied', 'SecurityError') },
      removeItem: () => { throw new DOMException('denied', 'SecurityError') },
    }
    const run = tab(storage, broken as MemoryStorage)
    await run.controller.newDesign()
    editDesignSessionForTest(run.store, (file) => ({ ...file, description: 'saved before the reload' }))
    await expect(run.controller.reloadForRelease()).resolves.toBe(true)
    expect(run.reload).toHaveBeenCalledOnce()
    const after = tab(storage, broken as MemoryStorage)
    expect(after.controller.restoreLatestDraft()).toBe(true)
    expect(after.store.readCurrentDesign()?.description).toBe('saved before the reload')
  })
})

describe('the Reload save problem dialog (2.1-Q188)', () => {
  let container: HTMLDivElement
  beforeEach(() => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    answerSaveProblem('cancel')
    render(null, container)
    container.remove()
  })

  async function show(request: Parameters<typeof requestSaveProblemDecision>[0]) {
    const { requestSaveProblemDecision } = await import('../app/document-session/save-problem')
    void requestSaveProblemDecision(request)
    await act(async () => { render(<SaveProblemDialog />, container) })
  }

  function buttons(): { label: string | null, choice: string | undefined }[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-save-problem-choice]'))
      .map((button) => ({ label: button.textContent, choice: button.dataset.saveProblemChoice }))
  }

  it('a failed write offers Retry, Download a copy, Reload without saving and Cancel', async () => {
    await show({ kind: 'flush-failed', purpose: 'reload', conflict: false })
    expect(container.querySelector('#save-problem-message')?.textContent).toBe(t('saveProblem.flushFailedReloadMessage'))
    expect(buttons()).toEqual([
      { label: t('saveProblem.retry'), choice: 'retry' },
      { label: t('webShell.downloadCopy'), choice: 'save-copy' },
      { label: t('saveProblem.discardAndReload'), choice: 'discard' },
      { label: t('canvas.file.cancel'), choice: 'cancel' },
    ])
    expect(t('saveProblem.discardAndReload')).toBe('Reload without saving')
    expect(saveProblem.value).not.toBeNull()
  })

  it('a Draft another tab changed offers Download a copy, Reload without saving and Cancel', async () => {
    await show({ kind: 'flush-failed', purpose: 'reload', conflict: true, where: 'another-tab' })
    expect(container.querySelector('#save-problem-message')?.textContent).toBe(t('saveProblem.tabConflictReloadMessage'))
    expect(buttons().map((button) => button.choice)).toEqual(['save-copy', 'discard', 'cancel'])
  })
})

describe('the New version: Reload notice in the shell row (2.1-Q83, Q187, M179)', () => {
  let container: HTMLDivElement
  beforeEach(() => {
    locale.value = 'en'
    activePanel.value = 'canvas'
    sidePanel.value = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    dismissBrowserShellNotice()
    render(null, container)
    container.remove()
  })

  const projection = () => projectBrowserShellForTest({
    capabilities: {
      newDesign: () => undefined, openCanopi: () => undefined, downloadCanopi: () => undefined, revertDesign: () => undefined,
      importGeoJson: () => undefined, exportGeoJson: () => undefined, exportBudgetCsv: () => undefined,
      closeDesign: () => undefined, navigate: navigateTo,
    },
  })

  type ShellProps = Parameters<typeof BrowserAppShell>[0]
  function Shell({ release, designIdentity = null }: { release: ShellProps['release'], designIdentity?: ShellProps['designIdentity'] }) {
    return <BrowserAppShell commandProjection={projection()} release={release} designIdentity={designIdentity} />
  }

  function row(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-web-shell-notice]')
  }

  it('shows title, message, Reload and Dismiss politely, and Saving… while it saves', async () => {
    const onReload = vi.fn()
    const onDismiss = vi.fn()
    const reloading = signal(false)
    const Live = () => <Shell release={{ reloading: reloading.value, onReload, onDismiss }} designIdentity={{ name: 'Orchard', saveStatus: 'saved', saveFailureReason: null }} />
    await act(async () => { render(<Live />, container) })
    const notice = row()!
    expect(notice.dataset.release).toBe('')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain(t('webRelease.title'))
    expect(notice.textContent).toContain(t('webRelease.message'))
    const reload = notice.querySelector<HTMLButtonElement>('[data-release-reload]')!
    expect(reload.textContent).toBe(t('error.reload'))
    expect(t('webRelease.title')).toBe('New version')
    expect(t('error.reload')).toBe('Reload')
    await act(async () => { reload.click() })
    expect(onReload).toHaveBeenCalledOnce()
    await act(async () => { reloading.value = true })
    expect(reload.textContent).toBe(t('saveStatus.saving'))
    expect(reload.disabled).toBe(true)
    await act(async () => { reload.click() })
    expect(onReload, 'a second click while saving is ignored').toHaveBeenCalledOnce()
    await act(async () => { reloading.value = false })
    await act(async () => { notice.querySelector<HTMLButtonElement>(`[aria-label="${t('webShell.dismissNotice')}"]`)!.click() })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  // canopi-eon8.15 (S4): with no Design open, as on the welcome screen, there is nothing to save first, so the notice
  // makes no such promise beside the Drafts warning.
  it('canopi-eon8.15: with no Design open the notice does not say a Design is saved first', async () => {
    const release = { reloading: false, onReload: () => undefined, onDismiss: () => undefined }
    await act(async () => { render(<Shell release={release} />, container) })
    expect(row()!.textContent).toContain(t('webRelease.messageNoDesign'))
    expect(row()!.textContent).not.toContain(t('webRelease.message'))
    expect(t('webRelease.messageNoDesign')).toBe('Canopi was updated. Reload to use it.')

    const open = { name: 'Orchard', saveStatus: 'saved' as const, saveFailureReason: null }
    await act(async () => { render(<Shell release={release} designIdentity={open} />, container) })
    expect(row()!.textContent).toContain(t('webRelease.message'))
  })

  // canopi-eon8.15 (S6): one key per term, so Saving… and Reload read the same in the save status, the error page and
  // this notice in every locale.
  it('canopi-eon8.15: the notice reuses Saving… and Reload, with no webRelease copy of them in any locale', () => {
    const dir = 'src/i18n'
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const strings = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as { webRelease: Record<string, string> }
      expect(Object.keys(strings.webRelease), file).not.toContain('reload')
      expect(Object.keys(strings.webRelease), file).not.toContain('saving')
    }
  })

  it('C2-4: Dismiss is off while Reload saves, so no reload follows a Dismiss', async () => {
    const onDismiss = vi.fn()
    const reloading = signal(true)
    const Live = () => <Shell release={{ reloading: reloading.value, onReload: () => undefined, onDismiss }} />
    await act(async () => { render(<Live />, container) })
    const dismiss = row()!.querySelector<HTMLButtonElement>(`[aria-label="${t('webShell.dismissNotice')}"]`)!
    expect(dismiss.disabled).toBe(true)
    await act(async () => { dismiss.click() })
    expect(onDismiss).not.toHaveBeenCalled()
    // A cancelled save puts the choice back.
    await act(async () => { reloading.value = false })
    expect(dismiss.disabled).toBe(false)
    await act(async () => { dismiss.click() })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('C2-3: the title bar growing moves the Reload notice in place, keeping its focus and its live region', async () => {
    // Each observer with what it watches: a moved row resizes nothing, so only the title bar's observer fires.
    const observers: { callback: () => void, targets: Element[] }[] = []
    vi.stubGlobal('ResizeObserver', class {
      private readonly entry: { callback: () => void, targets: Element[] }
      constructor(callback: () => void) {
        this.entry = { callback, targets: [] }
        observers.push(this.entry)
      }
      observe(target: Element) { this.entry.targets.push(target) }
      disconnect() { this.entry.targets.length = 0 }
    })
    try {
      const Live = () => <Shell release={{ reloading: false, onReload: () => undefined, onDismiss: () => undefined }} />
      await act(async () => { render(<Live />, container) })
      const bar = container.querySelector<HTMLElement>('[data-workspace-title-bar]')!
      const place = async (height: number) => {
        Object.defineProperty(bar, 'offsetTop', { configurable: true, value: 8 })
        Object.defineProperty(bar, 'offsetHeight', { configurable: true, value: height })
        await act(async () => {
          for (const observer of observers) if (observer.targets.includes(bar)) observer.callback()
        })
      }
      await place(48)
      const notice = row()!
      const reload = notice.querySelector<HTMLButtonElement>('[data-release-reload]')!
      reload.focus()
      const host = notice.parentElement!
      const reserved = vi.spyOn(host.style, 'setProperty')

      // A narrow bar wraps the Design name over its status and grows.
      await place(70)
      expect(row(), 'the same notice row, not a new one').toBe(notice)
      expect(document.activeElement, 'Reload keeps the focus').toBe(reload)
      expect(notice.style.top).toBe('calc(78px + var(--space-2))')
      expect(reserved.mock.calls.some(([name]) => name === '--chrome-rail-top'), 'the rails move below the moved row').toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the launch\'s Earlier data notice keeps the row, and the Reload notice follows once it is dismissed (M182)', async () => {
    const release = signal<{ reloading: boolean, onReload: () => void, onDismiss: () => void } | null>(null)
    const Live = () => <Shell release={release.value} />
    await act(async () => { render(<Live />, container) })
    await act(async () => { showBrowserShellNotice({ tone: 'info', title: 'Earlier', message: 'kept in place' }) })
    await act(async () => { release.value = { reloading: false, onReload: () => undefined, onDismiss: () => { release.value = null } } })
    expect(container.querySelectorAll('[data-web-shell-notice]'), 'one row').toHaveLength(1)
    expect(row()?.textContent).toContain('kept in place')

    await act(async () => { row()!.querySelector<HTMLButtonElement>(`[aria-label="${t('webShell.dismissNotice')}"]`)!.click() })
    expect(row()?.dataset.release, 'the waiting release shows').toBe('')
  })

  it('2.1-M182 (R2-3): an information notice from the user\'s own import shows over the Reload notice, which returns after it', async () => {
    const onDismiss = vi.fn()
    const Live = () => <Shell release={{ reloading: false, onReload: () => undefined, onDismiss }} />
    await act(async () => { render(<Live />, container) })
    await act(async () => { showBrowserShellNotice({ tone: 'info', title: 'Nothing imported', message: 'no supported shapes' }) })
    expect(container.querySelectorAll('[data-web-shell-notice]'), 'one row').toHaveLength(1)
    expect(row()?.dataset.release, 'the import\'s notice takes the row').toBeUndefined()
    expect(row()?.textContent).toContain('no supported shapes')
    await act(async () => { row()!.querySelector<HTMLButtonElement>(`[aria-label="${t('webShell.dismissNotice')}"]`)!.click() })
    expect(onDismiss).not.toHaveBeenCalled()
    expect(row()?.dataset.release, 'the Reload notice returns').toBe('')
  })

  it('2.1-M182 (C2-2): an error from the user\'s own action shows over the Reload notice, which returns once it is dismissed', async () => {
    const onDismiss = vi.fn()
    const Live = () => <Shell release={{ reloading: false, onReload: () => undefined, onDismiss }} />
    await act(async () => { render(<Live />, container) })
    expect(row()?.dataset.release).toBe('')
    await act(async () => { showBrowserShellNotice({ tone: 'error', title: 'Couldn’t open', message: 'damaged file' }) })
    expect(container.querySelectorAll('[data-web-shell-notice]'), 'one row').toHaveLength(1)
    expect(row()?.dataset.release, 'the error takes the row').toBeUndefined()
    expect(row()?.getAttribute('role')).toBe('alert')
    expect(row()?.textContent).toContain('damaged file')

    await act(async () => { row()!.querySelector<HTMLButtonElement>(`[aria-label="${t('webShell.dismissNotice')}"]`)!.click() })
    expect(onDismiss, 'dismissing the error leaves the release waiting').not.toHaveBeenCalled()
    expect(row()?.dataset.release, 'the Reload notice returns').toBe('')
  })
})
