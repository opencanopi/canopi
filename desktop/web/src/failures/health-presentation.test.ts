// One message per store status and its one notice (contracts §2 and §11, design check F3): every StoreOpenStatus kind
// and StoreNotice has one rule, silent or a key that exists; the notice row tells each store's state once, through the
// real health model, presentation and notice queue (2.1-Q285, Q287, Q295, Q296).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreId, StoreNotice, StoreOpenStatus } from '../generated/contracts'
import en from '../i18n/en.json'
import { t } from '../i18n'
import { applyHealthSnapshot, dismissStoreNotice, plantCatalogCause, resetStoreHealthForTests, storeHealth, storeStatus, writeStoreHealth } from './health'
import { installHealthNotices } from './health-notices'
import { noticeForStore } from './health-presentation'
import { dismissNotice, notices, resetNoticesForTests } from './notices'
import { reportFailure, resetFailureNoticesForTests } from './report'
import { readFailureCode, StoreRefusedError } from './store-read'
import { createBrowserAppDataStore } from '../web/browser-app-data'
import { createReducedSpeciesCatalogAdapters, type ReducedSpeciesCatalogReader } from '../web/reduced-species-catalog'

type Kind = StoreOpenStatus['kind']

const STORES: readonly StoreId[] = ['plant_catalog', 'user_db', 'settings', 'library_catalogue', 'web_drafts', 'web_species_lists']
const NOTICES: readonly StoreNotice[] = ['moved_aside_pre_2_0', 'fields_reset', 'write_failed']

// One example per kind; a kind the union adds is a type error here until it has its example and its rule.
const EXAMPLES: { readonly [K in Kind]: readonly Extract<StoreOpenStatus, { kind: K }>[] } = {
  opening: [{ kind: 'opening' }],
  migrating: [{ kind: 'migrating' }],
  ready: [{ kind: 'ready' }],
  recovered: [{ kind: 'recovered', items: 3, generated: 1 }],
  newer_read_only: [{ kind: 'newer_read_only' }],
  refused_newer: [{ kind: 'refused_newer' }],
  set_aside_damaged: [{ kind: 'set_aside_damaged', file: 'user.db.corrupt-1' }],
  unavailable: [
    { kind: 'unavailable', code: { kind: 'plant_db_unavailable', cause: 'missing' } },
    { kind: 'unavailable', code: { kind: 'plant_db_unavailable', cause: 'open_failed' } },
    { kind: 'unavailable', code: { kind: 'library_read_only', reason: 'unavailable' } },
    { kind: 'unavailable', code: { kind: 'io', io: 'permission_denied' } },
    { kind: 'unavailable', code: { kind: 'internal' } },
  ],
}

const SILENT_ON_THE_ROW: readonly Kind[] = ['opening', 'migrating', 'ready', 'recovered']

function hasKey(key: string): boolean {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en)
  return typeof value === 'string'
}

const NO_ACTIONS = { report: null, update: null }
const EVERY_ACTION = { retry: { run: () => {}, running: () => false }, report: () => {}, update: () => {}, dismissNotice: () => {} }

/** The row notice one store's status alone raises, if any. */
function statusNotice(store: StoreId, status: StoreOpenStatus) {
  return noticeForStore(store, { status, notice: null }, EVERY_ACTION)[0] ?? null
}

afterEach(() => {
  resetStoreHealthForTests()
  resetNoticesForTests()
  resetFailureNoticesForTests()
})

describe('store health presentation', () => {
  it('[canopi-f47t.52.36] every_health_status_has_one_message', () => {
    for (const [kind, statuses] of Object.entries(EXAMPLES) as [Kind, readonly StoreOpenStatus[]][]) {
      for (const status of statuses) {
        for (const store of STORES) {
          const message = statusNotice(store, status)
          if (SILENT_ON_THE_ROW.includes(kind)) {
            expect(message, `${store} ${kind} is told where the store is used, never on the row`).toBeNull()
          } else {
            expect(message, `${store} ${kind}`).not.toBeNull()
            expect(hasKey(message!.message), `${store} ${kind}: ${message!.message} exists in en.json`).toBe(true)
          }
        }
      }
    }
    for (const notice of NOTICES) {
      const [told] = noticeForStore('user_db', { status: { kind: 'opening' }, notice }, EVERY_ACTION)
      expect(hasKey(told!.message), notice).toBe(true)
    }
    // The newer-read-only wording (2.1-Q296, named per store by 2.1-Q319), first shown by R2 and R3, offers Update.
    expect(statusNotice('user_db', { kind: 'newer_read_only' })).toMatchObject({ message: 'health.newerReadOnlyStore.userDb', action: { label: 'health.update' } })
    // A store with no named sentence keeps the plain one.
    expect(t('health.newerReadOnly')).toBe('This data was saved by a newer Canopi. You can view it, but changes won’t be saved. Update Canopi to edit.')
  })

  it('canopi-f47t.52.271: each store read as newer-read-only raises its own notice, naming the store (2.1-Q319)', () => {
    const dispose = installHealthNotices({ report: null, update: () => {} })
    const named: readonly (readonly [StoreId, string])[] = [
      ['user_db', 'Your favorites, saved stamps and recent Designs were saved by a newer Canopi. You can view them, but changes won’t be saved. Update Canopi to edit them.'],
      ['settings', 'Your settings were saved by a newer Canopi. Changes apply until you close Canopi but won’t be saved. Update Canopi to keep them.'],
      ['library_catalogue', 'The Data library was saved by a newer Canopi. Its items are listed, but changes won’t be saved. Update Canopi to use them.'],
      ['web_species_lists', 'Your favorites and recently viewed plants were saved by a newer Canopi. You can view them, but changes won’t be saved. Update Canopi to edit them.'],
    ]
    for (const [store] of named) writeStoreHealth(store, { status: { kind: 'newer_read_only' }, notice: null })
    // Read again (a reload's snapshot): still one notice per store.
    for (const [store] of named) writeStoreHealth(store, { status: { kind: 'newer_read_only' }, notice: null })
    expect(notices.value.map((notice) => t(notice.message))).toEqual(named.map(([, text]) => text))
    expect(notices.value.every((notice) => notice.tone === 'warning' && notice.action?.label === 'health.update')).toBe(true)
    // A store that never reads so keeps the plain sentence.
    expect(statusNotice('web_drafts', { kind: 'newer_read_only' })?.message).toBe('health.newerReadOnly')
    dispose()
  })

  it('canopi-f47t.52.272: a write a read-only store refuses settles store_read_only and raises no second notice (2.1-M487)', async () => {
    const dispose = installHealthNotices(NO_ACTIONS)
    const values = new Map([['canopi:web-app-data:v3:species', JSON.stringify({ version: 4, favourites: ['Malus domestica'] })]])
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
    const appDataStore = createBrowserAppDataStore({ storage, now: () => '2026-11-12T09:00:00.000Z' })
    const adapters = createReducedSpeciesCatalogAdapters({ appDataStore, reader: {} as ReducedSpeciesCatalogReader })

    const favourite = adapters.toggleFavorite('Pyrus communis')
    await expect(favourite).rejects.toBeInstanceOf(StoreRefusedError)
    const refused = await favourite.catch((error: unknown) => error)
    const viewed = await adapters.recordRecentlyViewed('Pyrus communis').catch((error: unknown) => error)
    for (const error of [refused, viewed]) {
      expect(readFailureCode(error)).toEqual({ kind: 'store_read_only', store: 'web_species_lists' })
      reportFailure(error, { shown: 'notice', code: readFailureCode(error), source: 'plant-browser' })
    }
    // The store's own notice is the only one; the refused writes are recorded silently.
    expect(notices.value.map((notice) => notice.key)).toEqual(['health:web_species_lists:status:{"kind":"refused_newer"}'])
    expect(values.get('canopi:web-app-data:v3:species')).toBe(JSON.stringify({ version: 4, favourites: ['Malus domestica'] }))
    dispose()
  })

  it('[canopi-f47t.52.41] NAT-02 notice: a set-aside user DB shows one notice', () => {
    const report = vi.fn()
    const dispose = installHealthNotices({ report, update: null })
    // The host names the file; a path that slipped through still shows its file name only (2.1-Q285).
    applyHealthSnapshot({ user_db: { status: { kind: 'set_aside_damaged', file: '/home/ana/.local/share/canopi/user.db.corrupt-2' }, notice: null } })
    applyHealthSnapshot({ plant_catalog: { status: { kind: 'ready' }, notice: null } })

    const told = notices.value.filter((notice) => notice.key.startsWith('health:user_db'))
    expect(told).toHaveLength(1)
    const [notice] = told
    expect(t(notice!.message, notice!.params)).toBe(
      'Canopi’s saved data was damaged and has been set aside as user.db.corrupt-2. Your Designs are not affected.',
    )
    expect(notice!.action?.label).toBe('boundary.reportProblem')
    notice!.action!.run()
    expect(report).toHaveBeenCalledTimes(1)

    // Dismissed, it is not told again this session.
    dismissNotice(notice!.id)
    applyHealthSnapshot({ settings: { status: { kind: 'ready' }, notice: null } })
    expect(notices.value.filter((other) => other.key.startsWith('health:user_db'))).toHaveLength(0)
    dispose()
  })

  it('[canopi-f47t.52.36] a damaged Web browser record is told once, naming its store, as on Desktop (2.1-Q287)', () => {
    const dispose = installHealthNotices(NO_ACTIONS)
    writeStoreHealth('web_species_lists', { status: { kind: 'set_aside_damaged', file: 'canopi:web-app-data:v3:species:damaged' }, notice: null })
    writeStoreHealth('web_species_lists', { status: { kind: 'set_aside_damaged', file: 'canopi:web-app-data:v3:species:damaged' }, notice: null })
    const told = notices.value.filter((notice) => notice.key.startsWith('health:web_species_lists'))
    expect(told).toHaveLength(1)
    expect(t(told[0]!.message, told[0]!.params)).toContain('favorites and recently viewed plants')
    expect(t(told[0]!.message, told[0]!.params)).toContain('canopi:web-app-data:v3:species:damaged')
    // No problem report on this edition yet: no dead button.
    expect(told[0]!.action).toBeUndefined()
    dispose()
  })

  it('[canopi-f47t.52.40] settings unavailable offers Try again and Report a problem, and leaves the row once read (2.1-Q295)', () => {
    const retry = vi.fn(async () => true)
    const report = vi.fn()
    const dispose = installHealthNotices({ report, update: null, retry: { settings: retry } })
    writeStoreHealth('settings', { status: { kind: 'unavailable', code: { kind: 'internal' } }, notice: null })
    const [notice] = notices.value
    expect(t(notice!.message)).toBe(
      'Your settings couldn’t be read. Canopi is using defaults and won’t change your saved settings this session.',
    )
    expect([notice!.action?.label, notice!.secondaryAction?.label]).toEqual(['boundary.tryAgain', 'boundary.reportProblem'])
    notice!.action!.run()
    notice!.secondaryAction!.run()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(1)

    writeStoreHealth('settings', { status: { kind: 'ready' }, notice: null })
    expect(notices.value).toHaveLength(0)
    dispose()
  })

  it('[canopi-f47t.52.36] a store notice\'s Report a problem opens the report from that store, carrying its code', () => {
    const report = vi.fn()
    const dispose = installHealthNotices({ report, update: null })
    writeStoreHealth('web_drafts', { status: { kind: 'unavailable', code: { kind: 'io', io: 'permission_denied' } }, notice: null })
    writeStoreHealth('user_db', { status: { kind: 'set_aside_damaged', file: 'user.db.corrupt-3' }, notice: null })
    for (const notice of notices.value) notice.action!.run()
    expect(report.mock.calls).toEqual([
      [{ source: 'health.web_drafts', code: { kind: 'io', io: 'permission_denied' }, operation: null, detail: 'web_drafts: unavailable' }],
      [{ source: 'health.user_db', code: null, operation: null, detail: 'user_db: set_aside_damaged' }],
    ])
    dispose()
  })

  it('canopi-f47t.52.36: a store whose failure code changes under the same kind replaces its notice, and Report names the new code', () => {
    // Same kind, new code: notice replaced.
    const report = vi.fn()
    const dispose = installHealthNotices({ report, update: null, retry: { settings: async () => true } })
    writeStoreHealth('settings', { status: { kind: 'unavailable', code: { kind: 'internal' } }, notice: null })
    writeStoreHealth('settings', { status: { kind: 'unavailable', code: { kind: 'io', io: 'permission_denied' } }, notice: null })
    expect(notices.value).toHaveLength(1)
    notices.value[0]!.secondaryAction!.run()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ source: 'health.settings', code: { kind: 'io', io: 'permission_denied' } }))

    // A second set-aside under a new name is told, even after the first was dismissed.
    writeStoreHealth('web_drafts', { status: { kind: 'set_aside_damaged', file: 'canopi:drafts:damaged-1' }, notice: null })
    const first = notices.value.find((notice) => notice.key.startsWith('health:web_drafts'))!
    dismissNotice(first.id)
    writeStoreHealth('web_drafts', { status: { kind: 'set_aside_damaged', file: 'canopi:drafts:damaged-2' }, notice: null })
    const told = notices.value.filter((notice) => notice.key.startsWith('health:web_drafts'))
    expect(told.map((notice) => notice.params?.file)).toEqual(['canopi:drafts:damaged-2'])
    dispose()
  })

  it('[canopi-f47t.52.36] a one-time store notice is cleared in the model when dismissed; the status stays', () => {
    const dispose = installHealthNotices(NO_ACTIONS)
    applyHealthSnapshot({ user_db: { status: { kind: 'ready' }, notice: 'moved_aside_pre_2_0' } })
    const [notice] = notices.value
    expect(notice!.title).toBe('health.localDataNotOpenedTitle')
    dismissNotice(notice!.id)
    expect(storeHealth.value.user_db?.notice).toBeNull()
    expect(storeStatus('user_db')).toEqual({ kind: 'ready' })
    dismissStoreNotice('user_db')
    expect(notices.value).toHaveLength(0)
    dispose()
  })

  it('[canopi-f47t.52.36] a store nothing reported is opening, never ready; the plant catalog cause reads its code', () => {
    expect(storeStatus('plant_catalog')).toEqual({ kind: 'opening' })
    expect(plantCatalogCause()).toBeNull()
    applyHealthSnapshot({ plant_catalog: { status: { kind: 'unavailable', code: { kind: 'plant_db_unavailable', cause: 'open_failed' } }, notice: null } })
    expect(plantCatalogCause()).toBe('open_failed')
  })
})
