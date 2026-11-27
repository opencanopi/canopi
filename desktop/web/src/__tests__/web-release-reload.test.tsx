// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs'
import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { requestSaveProblemDecision } from '../app/document-session/save-problem'
import { answerSaveProblem, saveProblem } from '../app/document-session/save-problem'
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore, type SessionCore } from '../app/document-session/live-core'
import { designSessionStore } from '../app/document-session/store'
import { navigateTo, sidePanel } from '../app/shell/state'
import { locale } from '../app/settings/state'
import { SaveProblemDialog } from '../components/shared/SaveProblemDialog'
import { t } from '../i18n'
import type { DraftId } from '../platform/design-home'
import type { CanopiFile } from '../types/design'
import { browserAppDataStore, createBrowserAppDataStore, type BrowserStorageAdapter } from '../web/browser-app-data'
import { seedLegacyDraft } from './support/legacy-draft-fixture'
import { BrowserAppShell } from '../editions/web/BrowserAppShell'
import { browserAppLifecyclePort, browserFileAccessPort } from '../editions/web/session-ports'
import { createBrowserSessionHomeStore } from './support/browser-session-home-store'
import { reloadWebForRelease } from '../editions/web/web-session'
import { installReleaseNotice, presentBrowserGeoJsonNotice, raiseEarlierDataNotice } from '../web/browser-notices'
import { raiseNotice, resetNoticesForTests } from '../failures/notices'
import { editDesignSessionForTest } from './support/design-session-edit'
import { createTestDesignCore, encodeCanopiDesign } from './support/design-wire'
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
    version: 10, name, description, plant_species_colors: {}, plant_species_symbols: {}, layers: [], plants: [],
    zones: [], annotations: [], measurement_guides: [], groups: [], consortiums: [], timeline: [], budget: [],
    budget_currency: 'EUR', views: [], stories: [], created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', extra: {},
  }
}

const disposers: Array<() => void> = []

/** One browser tab: its own SessionCore over the shared localStorage and sessionStorage. */
function tab(storage: MemoryStorage, session: MemoryStorage = memoryStorage()) {
  let tick = 0
  const appDataStore = createBrowserAppDataStore({ storage, session })
  const designHome = createBrowserSessionHomeStore(appDataStore, () => new Date(Date.UTC(2026, 6, 4, 12, 0, tick++)))
  const core: SessionCore = createSessionCore({
    designHome,
    fileAccess: browserFileAccessPort,
    lifecycle: browserAppLifecyclePort,
    codec: createJsonSessionCodec({ designCore: createTestDesignCore() }),
    settings: {
      readLastOpenHome: async () => null,
      writeLastOpenHome: async () => {},
    },
    newDesignFactory: () => design('Untitled'),
  })
  const dispose = installLiveSessionCore(core)
  disposers.push(dispose)
  const reload = vi.fn()
  return { appDataStore, core, reload, dispose }
}

describe('Reload for a waiting release (2.1-Q83, Q188, Q189)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.()
    localStorage.clear()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('reloads at once when no Design is open', async () => {
    const run = tab(memoryStorage())
    await expect(reloadWebForRelease(run.reload)).resolves.toBe(true)
    expect(run.reload).toHaveBeenCalledOnce()
    expect(run.core.state.value.kind).toBe('idle')
  })

  it('writes pending changes before it reloads', async () => {
    const storage = memoryStorage()
    const run = tab(storage)
    await run.core.createNew()
    const draftId = run.core.currentDesign.peek()!.home.key
    editDesignSessionForTest(designSessionStore, (file) => ({ ...file, description: 'planted before the deploy' }))
    let written: string | null | undefined
    run.reload.mockImplementation(() => {
      // When the page reloads, the latest edit is already in the Draft.
      written = run.appDataStore.loadRawDraft(draftId)?.description as string | null | undefined
    })
    await expect(reloadWebForRelease(run.reload)).resolves.toBe(true)
    expect(run.reload).toHaveBeenCalledOnce()
    expect(written).toBe('planted before the deploy')
  })

  it('Q83: Reload saves first, surfaces a reload question on write failure, and supports cancel, retry, and discard', async () => {
    const storage = memoryStorage()
    const run = tab(storage)
    await run.core.createNew()
    const draftId = run.core.currentDesign.peek()!.home.key
    editDesignSessionForTest(designSessionStore, (file) => ({ ...file, description: 'unwritable' }))
    storage.failWrites = true

    // Cancel keeps the tab open with the unwritten edit.
    const cancelReload = reloadWebForRelease(run.reload)
    await vi.waitFor(() => expect(run.core.state.value.kind).toBe('closing'))
    const q1 = run.core.state.value
    expect(q1.kind).toBe('closing')
    if (q1.kind === 'closing') {
      expect(q1.question?.kind).toBe('flush-failed-before-close')
      expect(q1.question?.purpose).toBe('reload')
      run.core.answer(q1.question!.id, 'cancel')
    }
    await expect(cancelReload).resolves.toBe(false)
    expect(run.reload).not.toHaveBeenCalled()
    expect(designSessionStore.readCurrentDesign()?.description).toBe('unwritable')

    // Retry once the browser has room writes the Draft, then reloads.
    const retryReload = reloadWebForRelease(run.reload)
    await vi.waitFor(() => expect(run.core.state.value.kind).toBe('closing'))
    storage.failWrites = false
    const q2 = run.core.state.value
    if (q2.kind === 'closing') {
      run.core.answer(q2.question!.id, 'retry')
    }
    await expect(retryReload).resolves.toBe(true)
    expect(run.reload).toHaveBeenCalledOnce()
    expect(run.appDataStore.loadRawDraft(draftId)?.description).toBe('unwritable')

    // Reload without saving (discard) reloads with the write still failing.
    const again = tab(storage)
    await again.core.createNew()
    storage.failWrites = true
    editDesignSessionForTest(designSessionStore, (file) => ({ ...file, description: 'lost on purpose' }))
    const discardReload = reloadWebForRelease(again.reload)
    await vi.waitFor(() => expect(again.core.state.value.kind).toBe('closing'))
    const q3 = again.core.state.value
    if (q3.kind === 'closing') {
      again.core.answer(q3.question!.id, 'discard')
    }
    await expect(discardReload).resolves.toBe(true)
    expect(again.reload).toHaveBeenCalledOnce()
  })

  it('Reload over a Draft another tab changed pauses on conflict instead of overwriting the other tab', async () => {
    const storage = memoryStorage()
    const other = createBrowserAppDataStore({ storage, session: memoryStorage() })
    seedLegacyDraft({ id: 'draft-shared', raw: encodeCanopiDesign(design('Shared')), name: 'Shared', now: '2026-07-04T11:00:00.000Z', storage })
    const run = tab(storage)
    const opened = await run.core.openFrom({ kind: 'draft', id: 'draft-shared' as DraftId })
    expect(opened.status).toBe('opened')

    // Another tab updates the same Draft.
    seedLegacyDraft({ id: 'draft-shared', raw: encodeCanopiDesign(design('Shared', 'other tab')), name: 'Shared', now: '2026-07-04T13:00:00.000Z', storage })
    editDesignSessionForTest(designSessionStore, (file) => ({ ...file, description: 'this tab' }))

    const reloading = reloadWebForRelease(run.reload)
    await vi.waitFor(() => expect(run.core.state.value.kind).toBe('closing'))
    const q = run.core.state.value
    expect(q.kind).toBe('closing')
    if (q.kind === 'closing') {
      expect(q.current?.save.kind).toBe('conflict')
      run.core.answer(q.question!.id, 'cancel')
    }
    await expect(reloading).resolves.toBe(false)
    expect(run.reload).not.toHaveBeenCalled()
    expect(other.loadRawDraft('draft-shared')?.description).toBe('other tab')
  })

  it('Q189: Reload notes the open Draft id in sessionStorage and reopens it once', async () => {
    const storage = memoryStorage()
    seedLegacyDraft({ id: 'draft-orchard', raw: encodeCanopiDesign(design('Orchard')), name: 'Orchard', now: '2026-07-04T10:00:00.000Z', storage })
    seedLegacyDraft({ id: 'draft-hedge', raw: encodeCanopiDesign(design('Hedge')), name: 'Hedge', now: '2026-07-04T11:00:00.000Z', storage })

    const before = tab(storage)
    const openRes = await before.core.openFrom({ kind: 'draft', id: 'draft-orchard' as DraftId })
    expect(openRes.status).toBe('opened')
    expect(designSessionStore.readDesignName()).toBe('Orchard')

    await expect(reloadWebForRelease(before.reload)).resolves.toBe(true)
    expect(before.reload).toHaveBeenCalledOnce()
    // The tab record lives in sessionStorage (one-shot), never localStorage.
    expect(Array.from(storage.values.keys()).some((key) => key.includes('reload'))).toBe(false)
    const noted = browserAppDataStore.takeReloadHome()
    expect(noted).toEqual({ draft: 'draft-orchard' })
    expect(browserAppDataStore.takeReloadHome(), 'the record is one-shot').toBeNull()

    // Reopening the noted draft after reload restores the tab's own Design.
    const after = tab(storage)
    const reopened = await after.core.openFrom({ kind: 'draft', id: noted!.draft as DraftId })
    expect(reopened.status).toBe('opened')
    expect(designSessionStore.readDesignName()).toBe('Orchard')
  })

  it('Q189: a reload record naming a Draft that is gone refuses to open and leaves the start screen empty', async () => {
    const storage = memoryStorage()
    seedLegacyDraft({ id: 'draft-hedge', raw: encodeCanopiDesign(design('Hedge')), name: 'Hedge', now: '2026-07-04T11:00:00.000Z', storage })
    browserAppDataStore.noteReloadHome('draft-deleted')

    const noted = browserAppDataStore.takeReloadHome()
    expect(noted).toEqual({ draft: 'draft-deleted' })
    const after = tab(storage)
    const res = await after.core.openFrom({ kind: 'draft', id: noted!.draft as DraftId })
    expect(res.status).toBe('refused')
    expect(designSessionStore.hasCurrentDesign()).toBe(false)
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
    sidePanel.value = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  let uninstall: (() => void) | null = null
  afterEach(() => {
    uninstall?.()
    uninstall = null
    resetNoticesForTests()
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

  function Shell() {
    return <BrowserAppShell commandProjection={projection()} />
  }

  /** A release waiting as the watch says, through the real notice; `reload` resolves false when its save is cancelled. */
  function offer({ waiting = true, designOpen = true, reload = async () => false }: {
    waiting?: boolean, designOpen?: boolean, reload?: () => Promise<boolean>,
  } = {}) {
    const state = { waiting: signal<object | null>(waiting ? { version: 'next' } : null), designOpen: signal(designOpen) }
    const dismiss = vi.fn(() => { state.waiting.value = null })
    const reloadSpy = vi.fn(reload)
    uninstall = installReleaseNotice({
      waiting: state.waiting,
      designOpen: () => state.designOpen.value,
      reload: reloadSpy,
      dismiss,
      onError: () => undefined,
    })
    return { ...state, dismiss, reload: reloadSpy }
  }

  /** The one notice row, whichever notice it shows. */
  function row(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-notice-row]')
  }

  function shown(): string | undefined {
    return row()?.dataset.noticeKey
  }

  function reloadButton(): HTMLButtonElement {
    return [...row()!.querySelectorAll<HTMLButtonElement>('button')].find((button) => !button.hasAttribute('aria-label'))!
  }

  function dismissButton(): HTMLButtonElement {
    return row()!.querySelector<HTMLButtonElement>(`[aria-label="${t('notice.dismiss')}"]`)!
  }

  /** Each ResizeObserver with what it watches, fired by hand. */
  function stubResizeObservers(): { callback: () => void, targets: Element[] }[] {
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
    return observers
  }

  it('shows title, message, Reload and Dismiss politely, and Saving… while it saves', async () => {
    let cancelSave: (reloaded: boolean) => void = () => undefined
    const release = offer({ reload: () => new Promise<boolean>((resolve) => { cancelSave = resolve }) })
    await act(async () => { render(<Shell />, container) })
    const notice = row()!
    expect(shown()).toBe('web.release')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain(t('webRelease.title'))
    expect(notice.textContent).toContain(t('webRelease.message'))
    const reload = reloadButton()
    expect(reload.textContent).toBe(t('notice.reload'))
    expect(t('webRelease.title')).toBe('New version')
    expect(t('notice.reload')).toBe('Reload')
    await act(async () => { reload.click() })
    expect(release.reload).toHaveBeenCalledOnce()
    expect(reload.textContent).toBe(t('saveStatus.saving'))
    expect(reload.disabled).toBe(true)
    await act(async () => { reload.click() })
    expect(release.reload, 'a second click while saving is ignored').toHaveBeenCalledOnce()
    // The user cancels the save problem: Reload is offered again.
    await act(async () => { cancelSave(false) })
    expect(reloadButton().textContent).toBe(t('notice.reload'))
    await act(async () => { dismissButton().click() })
    expect(release.dismiss).toHaveBeenCalledOnce()
    expect(row()).toBeNull()
  })

  // canopi-eon8.15 (S4): with no Design open, as on the welcome screen, there is nothing to save first, so the notice
  // makes no such promise beside the Drafts warning.
  it('canopi-eon8.15: with no Design open the notice does not say a Design is saved first', async () => {
    const release = offer({ designOpen: false })
    await act(async () => { render(<Shell />, container) })
    expect(row()!.textContent).toContain(t('webRelease.messageNoDesign'))
    expect(row()!.textContent).not.toContain(t('webRelease.message'))
    expect(t('webRelease.messageNoDesign')).toBe('Canopi was updated. Reload to use it.')

    await act(async () => { release.designOpen.value = true })
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
    let cancelSave: (reloaded: boolean) => void = () => undefined
    const release = offer({ reload: () => new Promise<boolean>((resolve) => { cancelSave = resolve }) })
    await act(async () => { render(<Shell />, container) })
    await act(async () => { reloadButton().click() })
    const dismiss = dismissButton()
    expect(dismiss.disabled).toBe(true)
    await act(async () => { dismiss.click() })
    expect(release.dismiss).not.toHaveBeenCalled()
    // A cancelled save puts the choice back.
    await act(async () => { cancelSave(false) })
    expect(dismiss.disabled).toBe(false)
    await act(async () => { dismiss.click() })
    expect(release.dismiss).toHaveBeenCalledOnce()
  })

  it('C2-3: the title bar growing moves the Reload notice in place, keeping its focus and its live region', async () => {
    // Each observer with what it watches: a moved row resizes nothing, so only the title bar's observer fires.
    const observers = stubResizeObservers()
    try {
      offer()
      await act(async () => { render(<Shell />, container) })
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
      const reload = reloadButton()
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
    const release = offer({ waiting: false })
    await act(async () => { render(<Shell />, container) })
    await act(async () => { raiseEarlierDataNotice() })
    await act(async () => { release.waiting.value = { version: 'next' } })
    expect(container.querySelectorAll('[data-notice-row]'), 'one row').toHaveLength(1)
    expect(row()?.textContent).toContain(t('health.localDataNotOpened'))

    await act(async () => { dismissButton().click() })
    expect(shown(), 'the waiting release shows').toBe('web.release')
  })

  it('canopi-f47t.52.36: the Reload notice leaves the row once no release waits, and leaving the shell never dismisses the release', async () => {
    const release = offer()
    await act(async () => { render(<Shell />, container) })
    expect(shown()).toBe('web.release')
    await act(async () => { release.waiting.value = null })
    expect(row()).toBeNull()
    await act(async () => { release.waiting.value = { version: 'next' } })
    expect(shown()).toBe('web.release')
    await act(async () => { uninstall?.(); uninstall = null })
    expect(row()).toBeNull()
    expect(release.dismiss, 'the watch keeps the release for the next shell').not.toHaveBeenCalled()
  })

  it('2.1-M182 (R2-3): an information notice from the user\'s own import shows over the Reload notice, which returns after it', async () => {
    const release = offer()
    await act(async () => { render(<Shell />, container) })
    await act(async () => { presentBrowserGeoJsonNotice({ tone: 'info', title: 'geojson.importTitle', message: 'geojson.importNothing' }) })
    expect(container.querySelectorAll('[data-notice-row]'), 'one row').toHaveLength(1)
    expect(shown(), 'the import\'s notice takes the row').toBe('web.geojson')
    expect(row()?.textContent).toContain(t('geojson.importNothing'))
    await act(async () => { dismissButton().click() })
    expect(release.dismiss).not.toHaveBeenCalled()
    expect(shown(), 'the Reload notice returns').toBe('web.release')
  })

  it('2.1-M182 (C2-2): an error from the user\'s own action shows over the Reload notice, which returns once it is dismissed', async () => {
    const release = offer()
    await act(async () => { render(<Shell />, container) })
    expect(shown()).toBe('web.release')
    await act(async () => { presentBrowserGeoJsonNotice({ tone: 'error', title: 'geojson.importTitle', message: 'geojson.readFailed' }) })
    expect(container.querySelectorAll('[data-notice-row]'), 'one row').toHaveLength(1)
    expect(shown(), 'the error takes the row').toBe('web.geojson')
    expect(row()?.querySelector('[role="alert"]')).not.toBeNull()
    expect(row()?.textContent).toContain(t('geojson.readFailed'))

    await act(async () => { dismissButton().click() })
    expect(release.dismiss, 'dismissing the error leaves the release waiting').not.toHaveBeenCalled()
    expect(shown(), 'the Reload notice returns').toBe('web.release')
  })

  it('[canopi-f47t.52.36] a notice raised on the one notice row shows in the Web shell, after its own row (2.1-Q290)', async () => {
    await act(async () => { render(<Shell />, container) })
    await act(async () => { raiseEarlierDataNotice() })
    await act(async () => { raiseNotice({ key: 'failure.busy', message: 'failure.busy', tone: 'error' }) })
    expect(container.querySelectorAll('[data-notice-row]'), 'one notice at a time').toHaveLength(1)
    expect(shown()).toBe('web.earlier-data')
    await act(async () => { dismissButton().click() })
    expect(row()?.textContent).toContain(t('failure.busy'))
  })

  it('[canopi-f47t.52.36] the one notice row in the Web shell sits below the title bar like the shell\'s other notices, clear of the phone sheet', async () => {
    const observers = stubResizeObservers()
    try {
      await act(async () => { render(<Shell />, container) })
      const bar = container.querySelector<HTMLElement>('[data-workspace-title-bar]')!
      Object.defineProperty(bar, 'offsetTop', { configurable: true, value: 8 })
      Object.defineProperty(bar, 'offsetHeight', { configurable: true, value: 44 })
      await act(async () => {
        for (const observer of observers) if (observer.targets.includes(bar)) observer.callback()
      })
      const host = container.querySelector<HTMLElement>('[data-testid="browser-app-shell"]')!
      const reserved = vi.spyOn(host.style, 'setProperty')
      await act(async () => { raiseNotice({ key: 'failure.busy', message: 'failure.busy', tone: 'error' }) })
      const notice = container.querySelector<HTMLElement>('[data-notice-row]')!
      expect(notice.style.top).toBe('calc(52px + var(--space-2))')
      expect(reserved.mock.calls.some(([name]) => name === '--chrome-rail-top'), 'the rails start below the row').toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
