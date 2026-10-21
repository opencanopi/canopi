// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeCanopiDesign } from '../app/contracts/design-ingestion'
import { createDesignSessionStore } from '../app/document-session/store'
import { locale } from '../app/settings/state'
import { t } from '../i18n'
import type { CanopiFile } from '../types/design'
import { createBrowserAppDataStore } from '../web/browser-app-data'
import { createBrowserDesignSessionController, type BrowserCanopiDownload } from '../web/browser-design-session'
import type { BrowserDraftPersistenceView } from '../web/browser-draft-persistence'
import { browserShellNotice, dismissBrowserShellNotice } from '../web/browser-shell-notice'
import { WebWelcomeScreen } from '../web/WebWelcomeScreen'

// The Web welcome screen's persistence line and per-Draft Download a copy (2.1-Q82, Q190, Q193, Q194; rows L2, L5, L19).

let container: HTMLDivElement

beforeEach(() => {
  locale.value = 'en'
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  dismissBrowserShellNotice()
  render(null, container)
  container.remove()
})

function design(name: string): CanopiFile {
  return {
    version: 9, name, description: null, plant_species_colors: {}, plant_species_symbols: {}, layers: [], plants: [],
    zones: [], annotations: [], measurement_guides: [], groups: [], consortiums: [], timeline: [], budget: [],
    budget_currency: 'EUR', views: [], stories: [], created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', extra: {},
  }
}

function setup(view: BrowserDraftPersistenceView, { drafts = true }: { drafts?: boolean } = {}) {
  const values = new Map<string, string>()
  const appDataStore = createBrowserAppDataStore({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: (key) => { values.delete(key) },
    },
  })
  if (drafts) {
    appDataStore.saveDraft({ id: 'draft-orchard', file: design('Orchard'), now: '2026-01-01T00:00:00.000Z' })
    appDataStore.saveDraft({ id: 'draft-hedge', file: design('Hedge'), now: '2026-01-02T00:00:00.000Z' })
  }
  const downloadCanopiFile = vi.fn<(download: BrowserCanopiDownload) => Promise<void>>(async () => undefined)
  const store = createDesignSessionStore()
  const controller = createBrowserDesignSessionController({
    store,
    appDataStore,
    fileAdapter: { openCanopiFile: vi.fn(async () => null), downloadCanopiFile },
  })
  const persistence = signal(view)
  return { controller, store, persistence, downloadCanopiFile, appDataStore }
}

const notice = () => container.querySelector<HTMLElement>('[data-start-notice]')

describe('Web welcome screen and Draft persistence', () => {
  it('L2: shows the one-line reason before the ask, beside New Design and Open', async () => {
    const { controller, persistence } = setup({ state: 'not-kept', notice: 'reason', warn: false })
    await act(async () => { render(<WebWelcomeScreen controller={controller} persistence={persistence} />, container) })
    expect(notice()?.dataset.startNotice).toBe('info')
    expect(notice()?.textContent).toBe(t('webStorage.reason'))
    expect(notice()?.dataset.notice).toBe('draft-persistence-reason')
  })

  it('L13 (review F1): with unkept Drafts at launch shows the reason before the ask, in the warning tone', async () => {
    const { controller, persistence } = setup({ state: 'not-kept', notice: 'reason', warn: true })
    await act(async () => { render(<WebWelcomeScreen controller={controller} persistence={persistence} />, container) })
    expect(notice()?.dataset.startNotice).toBe('warning')
    expect(notice()?.textContent).toBe(t('webStorage.reason'))
    expect(notice()?.dataset.notice).toBe('draft-persistence-reason')
  })

  it('L5: after a refusal warns in amber and names Download a copy instead of the reason', async () => {
    const { controller, persistence } = setup({ state: 'not-kept', notice: 'reason', warn: false })
    await act(async () => { render(<WebWelcomeScreen controller={controller} persistence={persistence} />, container) })
    await act(async () => { persistence.value = { state: 'refused', notice: 'warning', warn: true } })
    expect(notice()?.dataset.startNotice).toBe('warning')
    expect(notice()?.textContent).toBe(t('webStorage.warning'))
    expect(notice()?.textContent).toContain('Download a copy')
    expect(container.textContent).not.toContain(t('webStorage.reason'))
  })

  it('F3: refused with no Drafts listed warns without pointing to a Draft menu that is not there', async () => {
    const { controller, persistence } = setup({ state: 'refused', notice: 'warning', warn: true }, { drafts: false })
    await act(async () => { render(<WebWelcomeScreen controller={controller} persistence={persistence} />, container) })
    expect(notice()?.dataset.startNotice).toBe('warning')
    expect(notice()?.textContent).toBe(t('webStorage.warningNoDrafts'))
    expect(notice()?.textContent).not.toContain(t('webShell.downloadCopy'))
  })

  it('L1: says nothing about persistence once the browser keeps Drafts, or while it is still checking', async () => {
    const { controller, persistence } = setup({ state: 'checking', notice: null, warn: false })
    await act(async () => { render(<WebWelcomeScreen controller={controller} persistence={persistence} />, container) })
    expect(notice()).toBeNull()
    await act(async () => { persistence.value = { state: 'kept', notice: null, warn: false } })
    expect(notice()).toBeNull()
  })

  it('L19 (Q193): offers Download a copy in each Draft row menu, which downloads that Draft without opening it', async () => {
    const { controller, store, persistence, downloadCanopiFile } = setup({ state: 'refused', notice: 'warning', warn: true })
    await act(async () => { render(<WebWelcomeScreen controller={controller} persistence={persistence} />, container) })
    // Two Drafts, newest first: the second row's menu downloads the second Draft (review F6).
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Actions for "]'))
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['Actions for Hedge', 'Actions for Orchard'])
    await act(async () => { rows[1]!.click() })
    const items = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    expect(items.map((item) => item.textContent)).toEqual(['Download a copy', 'Delete draft…'])
    await act(async () => { items[0]!.click() })
    expect(downloadCanopiFile).toHaveBeenCalledOnce()
    const download = downloadCanopiFile.mock.calls[0]![0]
    expect(download.fileName).toBe('Orchard.canopi')
    expect(decodeCanopiDesign(JSON.parse(download.text)).name).toBe('Orchard')
    expect(store.hasCurrentDesign()).toBe(false)
  })

  it('F4: a Draft gone from this browser fails its Download a copy with a visible notice and leaves the row list', async () => {
    const { controller, persistence, downloadCanopiFile, appDataStore } = setup({ state: 'refused', notice: 'warning', warn: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { render(<WebWelcomeScreen controller={controller} persistence={persistence} />, container) })
    // Another tab, or the browser, removed the Draft after the rows were listed.
    appDataStore.deleteDraft('draft-orchard')
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Actions for Orchard"]')!.click() })
    const download = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === t('webShell.downloadCopy'))!
    await act(async () => { download.click() })
    await act(async () => { await Promise.resolve() })
    expect(downloadCanopiFile).not.toHaveBeenCalled()
    expect(browserShellNotice.value).toEqual({
      tone: 'error',
      title: t('webStorage.downloadFailedTitle'),
      message: t('webStorage.downloadFailedMessage'),
    })
    expect(Array.from(container.querySelectorAll('button[aria-label^="Actions for "]')).map((row) => row.getAttribute('aria-label')))
      .toEqual(['Actions for Hedge'])
  })
})
