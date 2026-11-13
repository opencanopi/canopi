// @vitest-environment jsdom
// The session controller's 2.1 Draft guards (Step 2.0.4 R3, canopi-f47t.52.272; 2.1-Q321, Q322, Q323; design check F7,
// A18): an old-key Draft under an id 2.1 holds or copied is never listed, opened, downloaded or deleted, launch
// restores nothing while 2.1 Drafts exist, the reader's uninstall clears them, and a listed Draft gone by the time it
// opens opens nothing and says so.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesignSessionStore } from '../app/document-session/store'
import { notices, resetNoticesForTests } from '../failures/notices'
import type { CanopiFile } from '../types/design'
import type { BrowserAppDataStore, BrowserDraftSummary } from './browser-app-data'
import { createBrowserDesignSessionController, type BrowserDesignFileAdapter } from './browser-design-session'

const OLD_KEY: readonly BrowserDraftSummary[] = [
  { id: 'orchard', name: 'Orchard as 2.0 left it', updatedAt: '2026-10-05T00:00:00.000Z' },
  { id: 'hedge', name: 'Hedge', updatedAt: '2026-10-02T00:00:00.000Z' },
]
const NEWER: BrowserDraftSummary = { id: 'orchard', name: 'Orchard in 2.1', updatedAt: '2026-12-03T00:00:00.000Z' }

/** The old key's Drafts, by summary; a loaded Draft is a stand-in file named for its row. */
function oldKeyStore(): BrowserAppDataStore & { readonly ids: () => string[] } {
  const drafts = new Map(OLD_KEY.map((draft) => [draft.id, draft]))
  return {
    ids: () => [...drafts.keys()],
    listDrafts: () => [...drafts.values()],
    loadDraft: vi.fn((id: string) => (drafts.has(id) ? ({ name: drafts.get(id)!.name } as CanopiFile) : null)),
    deleteDraft: vi.fn((id: string) => {
      drafts.delete(id)
      return { ok: true as const, value: null }
    }),
    takeReloadHome: () => null,
  } as unknown as BrowserAppDataStore & { readonly ids: () => string[] }
}

interface Listing { drafts: readonly BrowserDraftSummary[], hiddenIds: readonly string[], complete?: boolean }

function setup(given: Listing) {
  const listing = { complete: true, ...given }
  const appDataStore = oldKeyStore()
  const fileAdapter: BrowserDesignFileAdapter = { openCanopiFile: vi.fn(async () => null), downloadCanopiFile: vi.fn(async () => undefined) }
  const controller = createBrowserDesignSessionController({ store: createDesignSessionStore(), appDataStore, fileAdapter })
  const records = { list: vi.fn(async (): Promise<Required<Listing>> => listing), content: vi.fn(async () => null) }
  const uninstall = controller.installNewerDrafts(records)
  return { appDataStore, controller, fileAdapter, records, uninstall }
}

const openFailureShown = () => notices.value.some((notice) => notice.key === 'web.open-failure')

beforeEach(() => resetNoticesForTests())

describe('the session controller with 2.1 Drafts listed', () => {
  it('R3 canopi-f47t.52.272: refuses to delete or download an old-key Draft under a hidden id, and hides it from the list', async () => {
    const { appDataStore, controller, fileAdapter } = setup({ drafts: [NEWER], hiddenIds: ['orchard'] })
    await controller.listNewerDrafts()

    expect(controller.listDrafts().map((draft) => draft.id)).toEqual(['hedge'])
    expect((await controller.deleteDraft('orchard')).ok, 'the 2.0 delete never reaches an id 2.1 keeps (F7)').toBe(false)
    expect(appDataStore.ids()).toContain('orchard')
    // The 2.1 Draft is gone from the store meanwhile: the download refuses rather than handing the old-key copy.
    await expect(controller.downloadDraft('orchard')).rejects.toThrow()
    expect(fileAdapter.downloadCanopiFile).not.toHaveBeenCalled()
    expect((await controller.deleteDraft('hedge')).ok).toBe(true)
  })

  it('R3 canopi-f47t.52.272: a copied id 2.1 no longer holds is still hidden: never downloaded, deleted or restored', async () => {
    const { appDataStore, controller, fileAdapter } = setup({ drafts: [], hiddenIds: ['orchard'] })

    expect(await controller.launch(), 'the newest visible Draft reopens').toBe(true)
    expect(appDataStore.loadDraft).toHaveBeenCalledWith('hedge')
    expect(appDataStore.loadDraft).not.toHaveBeenCalledWith('orchard')
    await expect(controller.downloadDraft('orchard')).rejects.toThrow()
    expect(fileAdapter.downloadCanopiFile).not.toHaveBeenCalled()
    expect((await controller.deleteDraft('orchard')).ok).toBe(false)
  })

  it('R3 canopi-f47t.52.272: launch restores nothing while 2.1 holds a Draft, and lists it', async () => {
    const { appDataStore, controller } = setup({ drafts: [NEWER], hiddenIds: ['orchard'] })

    expect(await controller.launch()).toBe(false)
    expect(appDataStore.loadDraft).not.toHaveBeenCalled()
    expect(controller.listedNewerDrafts()).toEqual([NEWER])
    expect(controller.launching.value).toBe(false)
  })

  it('R3 canopi-f47t.52.272: the reader’s uninstall stops the listing', async () => {
    const { controller, records, uninstall } = setup({ drafts: [NEWER], hiddenIds: ['orchard'] })
    await controller.listNewerDrafts()
    uninstall()

    expect(controller.listedNewerDrafts()).toEqual([])
    expect(await controller.listNewerDrafts()).toEqual([])
    expect(records.list).toHaveBeenCalledTimes(1)
    expect(controller.listDrafts().map((draft) => draft.id)).toEqual(['orchard', 'hedge'])
  })

  it('R3 canopi-f47t.52.272: opening an old-key Draft under a hidden id opens nothing and says so', async () => {
    const { appDataStore, controller } = setup({ drafts: [], hiddenIds: ['orchard'] })
    await controller.listNewerDrafts()

    expect(await controller.openDraft('orchard'), 'the old-key copy of an id 2.1 copied never opens (2.1-Q322)').toBe(false)
    expect(appDataStore.loadDraft).not.toHaveBeenCalledWith('orchard')
    expect(openFailureShown()).toBe(true)
  })

  it('R3 canopi-f47t.52.272: an old-key Draft deleted after the list opens nothing and says so', async () => {
    const { appDataStore, controller } = setup({ drafts: [], hiddenIds: [] })
    await controller.listNewerDrafts()
    appDataStore.deleteDraft('hedge')

    expect(await controller.openDraft('hedge')).toBe(false)
    expect(openFailureShown()).toBe(true)
  })

  it('R3 canopi-f47t.52.272: a 2.1 Draft 2.1 deleted after the list opens nothing and says so', async () => {
    const { controller, records } = setup({ drafts: [NEWER], hiddenIds: ['orchard'] })
    await controller.listNewerDrafts()

    expect(await controller.openDraft('orchard')).toBe(false)
    expect(records.content).toHaveBeenCalledWith('orchard')
    expect(openFailureShown()).toBe(true)
  })

  it('R3 canopi-f47t.52.272: a launch whose 2.1 listing fails or runs late restores nothing, so a copied old-key Draft never opens', async () => {
    // 2.1's store exists but its read failed or ran past the bound: the reader gives its last good listing, empty at launch.
    const { appDataStore, controller, records } = setup({ drafts: [], hiddenIds: [], complete: false })

    expect(await controller.launch(), 'an incomplete listing shows the start screen').toBe(false)
    expect(appDataStore.loadDraft).not.toHaveBeenCalled()
    expect(controller.launching.value).toBe(false)

    // Until one listing completes, an old-key row may be a copy 2.1 keeps: open and delete re-list first, then refuse.
    expect(await controller.openDraft('orchard')).toBe(false)
    expect(appDataStore.loadDraft).not.toHaveBeenCalled()
    expect(openFailureShown()).toBe(true)
    expect((await controller.deleteDraft('hedge')).ok).toBe(false)
    expect(appDataStore.ids()).toEqual(['orchard', 'hedge'])
    expect(records.list).toHaveBeenCalledTimes(3)

    // A re-list that completes: orchard turns out to be 2.1's copy and stays refused, hedge opens and deletes.
    records.list.mockResolvedValue({ drafts: [], hiddenIds: ['orchard'], complete: true })
    expect(await controller.openDraft('orchard')).toBe(false)
    expect(appDataStore.loadDraft).not.toHaveBeenCalledWith('orchard')
    expect(await controller.openDraft('hedge')).toBe(true)
    // Once one listing completed, a later failed read keeps its hidden ids and lets the rest through without a re-list.
    records.list.mockResolvedValue({ drafts: [], hiddenIds: ['orchard'], complete: false })
    expect((await controller.deleteDraft('orchard')).ok).toBe(false)
    expect(records.list).toHaveBeenCalledTimes(4)
  })

  it('R3 canopi-f47t.52.272: a launch whose 2.1 listing completes empty restores the newest Draft', async () => {
    const { appDataStore, controller } = setup({ drafts: [], hiddenIds: [] })

    expect(await controller.launch()).toBe(true)
    expect(appDataStore.loadDraft).toHaveBeenCalledWith('orchard')
  })
})
