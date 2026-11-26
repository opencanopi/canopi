// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUDGET_CURRENCY } from '../../app/contracts/document'
import { getLiveSessionCore } from '../../app/document-session/live-core'
import { notices, resetNoticesForTests } from '../../failures/notices'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import { NEW_DESIGN_LAYER_DEFAULTS } from '../../generated/new-design-defaults'
import type { CanopiFile } from '../../types/design'
import { browserAppDataStore, type BrowserDraftSummary } from '../../web/browser-app-data'
import { browserDraftPersistence } from '../../web/browser-draft-persistence'
import type { BrowserNewerDraftRecords } from '../../web/browser-newer-drafts'
import type * as BrowserTextFiles from '../../web/browser-text-files'

interface Listing {
  readonly drafts: readonly BrowserDraftSummary[]
  readonly hiddenIds: readonly string[]
  readonly complete: boolean
}

const mockReaderHolder: {
  records: {
    list: ReturnType<typeof vi.fn<() => Promise<Listing>>>
    content: ReturnType<typeof vi.fn<(id: string) => Promise<string | null | 'closed'>>>
  }
} = {
  records: {
    list: vi.fn(async (): Promise<Listing> => ({ drafts: [], hiddenIds: [], complete: true })),
    content: vi.fn(async (): Promise<string | null | 'closed'> => null),
  },
}

const downloadSpy = vi.fn()

import { createTestDesignCore } from '../../__tests__/support/design-wire'

vi.mock('../../platform/design-core', () => ({
  createDesignCore: () => createTestDesignCore(),
}))

vi.mock('../../platform/draft-records.browser', () => ({
  createDraftRecordsReader: () => mockReaderHolder.records as BrowserNewerDraftRecords,
}))

vi.mock('../../web/browser-text-files', async (importOriginal) => {
  const actual = await importOriginal<typeof BrowserTextFiles>()
  return { ...actual, downloadBrowserTextFile: (...args: unknown[]) => downloadSpy(...args) }
})

import { bootWebEdition } from './boot'
import {
  deleteWebDraft,
  downloadWebDraft,
  installWebNewerDrafts,
  isWebDraftListingComplete,
  listedNewerWebDrafts,
  listWebDrafts,
  openWebDraft,
  relistNewerWebDrafts,
  webLaunching,
} from './web-session'

const NEWER: BrowserDraftSummary = { id: 'orchard', name: 'Orchard in 2.1', updatedAt: '2026-12-03T00:00:00.000Z' }

function makeDesign(name: string): CanopiFile {
  const now = '2026-10-01T00:00:00.000Z'
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: NEW_DESIGN_LAYER_DEFAULTS.map((l) => ({ ...l })),
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: DEFAULT_BUDGET_CURRENCY,
    views: [],
    stories: [],
    created_at: now,
    updated_at: now,
    extra: {},
  }
}

function seedTwoLegacyDrafts(): void {
  browserAppDataStore.saveDraft({ id: 'hedge', file: makeDesign('Hedge'), now: '2026-10-01T00:00:00.000Z' })
  browserAppDataStore.saveDraft({ id: 'orchard', file: makeDesign('Orchard as 2.0 left it'), now: '2026-10-02T00:00:00.000Z' })
}

const openFailureShown = () => notices.value.some((notice) => notice.key === 'web.open-failure')

let disposeBoot: (() => void) | null = null

async function bootWith(listing: Partial<Listing> = {}, seedLegacy = true): Promise<typeof mockReaderHolder.records> {
  const full: Listing = { drafts: [], hiddenIds: [], complete: true, ...listing }
  mockReaderHolder.records = {
    list: vi.fn(async (): Promise<Listing> => full),
    content: vi.fn(async (): Promise<string | null | 'closed'> => null),
  }
  if (seedLegacy) seedTwoLegacyDrafts()
  disposeBoot = bootWebEdition()
  await vi.waitFor(() => expect(webLaunching.value).toBe(false))
  return mockReaderHolder.records
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetNoticesForTests()
  downloadSpy.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  disposeBoot?.()
  disposeBoot = null
  delete (globalThis.navigator as { storage?: unknown }).storage
  vi.restoreAllMocks()
})

describe('Web Edition with 2.1 Drafts listed (R3 canopi-f47t.52.272)', () => {
  it('R3 canopi-f47t.52.272: refuses to delete or download an old-key Draft under a hidden id, and hides it from the list', async () => {
    await bootWith({ drafts: [NEWER], hiddenIds: ['orchard'] })

    expect(listWebDrafts().map((draft) => draft.id)).toEqual(['hedge'])
    expect((await deleteWebDraft('orchard')).ok, 'the 2.0 delete never reaches an id 2.1 keeps (F7)').toBe(false)
    expect(browserAppDataStore.listDrafts().map((d) => d.id)).toContain('orchard')
    await expect(downloadWebDraft('orchard')).rejects.toThrow()
    expect(downloadSpy).not.toHaveBeenCalled()
    expect((await deleteWebDraft('hedge')).ok).toBe(true)
  })

  it('R3 canopi-f47t.52.272: a copied id 2.1 no longer holds is still hidden: never downloaded, deleted or restored', async () => {
    await bootWith({ drafts: [], hiddenIds: ['orchard'] })

    expect(getLiveSessionCore()?.currentDesign.peek()?.home).toEqual({ kind: 'draft', key: 'hedge', version: expect.any(String) })
    await expect(downloadWebDraft('orchard')).rejects.toThrow()
    expect(downloadSpy).not.toHaveBeenCalled()
    expect((await deleteWebDraft('orchard')).ok).toBe(false)
  })

  it('R3 canopi-f47t.52.272: launch restores nothing while 2.1 holds a Draft, and lists it', async () => {
    await bootWith({ drafts: [NEWER], hiddenIds: ['orchard'] })

    expect(getLiveSessionCore()?.currentDesign.peek()).toBeNull()
    expect(listedNewerWebDrafts()).toEqual([NEWER])
    expect(webLaunching.value).toBe(false)
  })

  it('R3 canopi-f47t.52.272: the reader’s uninstall stops the listing', async () => {
    const records = await bootWith({ drafts: [NEWER], hiddenIds: ['orchard'] })
    const uninstall = installWebNewerDrafts(records)
    await relistNewerWebDrafts()
    const callsBefore = records.list.mock.calls.length
    uninstall()

    expect(listedNewerWebDrafts()).toEqual([])
    expect((await relistNewerWebDrafts()).drafts).toEqual([])
    expect(records.list).toHaveBeenCalledTimes(callsBefore)
    expect(listWebDrafts().map((draft) => draft.id)).toEqual(['orchard', 'hedge'])
  })

  it('R3 canopi-f47t.52.272: opening an old-key Draft under a hidden id opens nothing and says so', async () => {
    await bootWith({ drafts: [], hiddenIds: ['orchard'] })
    await getLiveSessionCore()?.close('close')

    expect(await openWebDraft('orchard'), 'the old-key copy of an id 2.1 copied never opens (2.1-Q322)').toBe(false)
    expect(getLiveSessionCore()?.currentDesign.peek()).toBeNull()
    expect(openFailureShown()).toBe(true)
  })

  it('R3 canopi-f47t.52.272: an old-key Draft deleted after the list opens nothing and says so', async () => {
    await bootWith({ drafts: [NEWER], hiddenIds: ['orchard'] })
    browserAppDataStore.deleteDraft('hedge')

    expect(await openWebDraft('hedge')).toBe(false)
    expect(openFailureShown()).toBe(true)
  })

  it('R3 canopi-f47t.52.272: a 2.1 Draft 2.1 deleted after the list opens nothing and says so', async () => {
    const records = await bootWith({ drafts: [NEWER], hiddenIds: ['orchard'] })

    expect(await openWebDraft('orchard')).toBe(false)
    expect(records.content).toHaveBeenCalledWith('orchard')
    expect(openFailureShown()).toBe(true)
  })

  it('R3 canopi-f47t.52.272: a 2.1 Draft whose read a version change closed opens nothing and says no open failure, as the Reload notice tells the user (2.1-Q40, Q337)', async () => {
    const records = await bootWith({ drafts: [NEWER], hiddenIds: ['orchard'] })
    records.content.mockResolvedValue('closed')

    expect(await openWebDraft('orchard')).toBe(false)
    expect(openFailureShown()).toBe(false)
    await downloadWebDraft('orchard')
    expect(downloadSpy, 'nor does its download write anything').not.toHaveBeenCalled()
  })

  it('R3 canopi-f47t.52.272: a launch whose 2.1 listing fails or runs late restores nothing and lists without a second read', async () => {
    const records = await bootWith({ drafts: [], hiddenIds: [], complete: false })

    expect(getLiveSessionCore()?.currentDesign.peek()).toBeNull()
    expect(webLaunching.value).toBe(false)
    expect(records.list).toHaveBeenCalledTimes(1)
  })

  it('R3 canopi-f47t.52.272: while the 2.1 listing cannot be read, old-key Drafts are never deleted and sticky hidden ids survive a later failed read', async () => {
    const records = await bootWith({ drafts: [], hiddenIds: [], complete: false })
    expect(isWebDraftListingComplete()).toBe(false)
    expect((await deleteWebDraft('hedge')).ok, 'Delete stays off while 2.1 listing is incomplete').toBe(false)
    expect(browserAppDataStore.listDrafts().map((d) => d.id)).toEqual(['orchard', 'hedge'])

    // A re-list that completes: orchard turns out to be 2.1's copy and stays refused, hedge opens editable.
    records.list.mockResolvedValue({ drafts: [], hiddenIds: ['orchard'], complete: true })
    expect(await openWebDraft('orchard')).toBe(false)
    expect(openFailureShown()).toBe(true)
    expect(await openWebDraft('hedge')).toBe(true)
    expect(isWebDraftListingComplete()).toBe(true)
    // Once one listing completed, a later failed read keeps its hidden ids without a re-list.
    records.list.mockResolvedValue({ drafts: [], hiddenIds: ['orchard'], complete: false })
    const calls = records.list.mock.calls.length
    expect((await deleteWebDraft('orchard')).ok).toBe(false)
    expect(records.list).toHaveBeenCalledTimes(calls)
  })

  it('R3 canopi-f47t.52.272: a Draft opened while its delete waited on the 2.1 listing is not deleted', async () => {
    const records = await bootWith({ drafts: [], hiddenIds: [], complete: false })
    let finish!: (listing: Listing) => void
    records.list.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const deleting = deleteWebDraft('hedge')
    records.list.mockResolvedValue({ drafts: [], hiddenIds: [], complete: true })
    expect(await openWebDraft('hedge')).toBe(true)
    finish({ drafts: [], hiddenIds: [], complete: true })

    expect((await deleting).ok).toBe(false)
    expect(browserAppDataStore.listDrafts().map((d) => d.id)).toContain('hedge')
  })

  it('R3 canopi-f47t.52.272: a launch whose 2.1 listing completes empty restores the newest Draft', async () => {
    await bootWith({ drafts: [], hiddenIds: [] })

    expect(getLiveSessionCore()?.currentDesign.peek()?.home).toEqual({ kind: 'draft', key: 'orchard', version: expect.any(String) })
  })

  it('R3 canopi-f47t.52.272: an origin with only 2.1 Drafts warns when storage is not kept', async () => {
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => false) }
    Object.defineProperty(globalThis.navigator, 'storage', { configurable: true, value: storage })
    let finishList!: (listing: Listing) => void
    mockReaderHolder.records = {
      list: vi.fn(() => new Promise<Listing>((resolve) => { finishList = resolve })),
      content: vi.fn(async () => null),
    }
    disposeBoot = bootWebEdition()
    finishList({ drafts: [NEWER], hiddenIds: [], complete: true })
    await vi.waitFor(() => expect(browserDraftPersistence.view.value.state).toBe('not-kept'))

    expect(browserDraftPersistence.view.value.notice, 'the amber warning, not the first-visit reason').toBe('warning')
    expect(browserDraftPersistence.view.value.warn).toBe(true)
  })

  it('R3 canopi-f47t.52.272: a launch whose 2.1 listing never completed warns as if Drafts were kept', async () => {
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => false) }
    Object.defineProperty(globalThis.navigator, 'storage', { configurable: true, value: storage })
    await bootWith({ drafts: [], hiddenIds: [], complete: false }, false)
    await vi.waitFor(() => expect(browserDraftPersistence.view.value.state).toBe('not-kept'))

    expect(browserDraftPersistence.view.value.notice, 'the amber warning, not the first-visit reason').toBe('warning')
  })
})
