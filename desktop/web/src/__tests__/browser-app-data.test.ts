import { afterEach, describe, expect, it } from 'vitest'
import {
  BrowserDraftChangedError,
  createBrowserAppDataStore,
  type BrowserStorageAdapter,
} from '../web/browser-app-data'
import { resetStoreHealthForTests, storeStatus } from '../failures/health'
import { StoreRefusedError, StoreUnreadableError } from '../failures/store-read'
import { installHealthNotices } from '../failures/health-notices'
import { notices, resetNoticesForTests } from '../failures/notices'
import { t } from '../i18n'
import type { CanopiFile } from '../types/design'

/** Canopi 2.0's records. */
const KEYS = {
  drafts: 'canopi:web-app-data:v3:drafts',
  settings: 'canopi:web-app-data:v3:settings',
  species: 'canopi:web-app-data:v3:species',
  stamps: 'canopi:web-app-data:v3:saved-object-stamps',
} as const
/** Every key Web Edition 1.x writes (v1.2.0 browser-app-data.ts); 2.0 only checks they exist. */
const V1_KEY = 'canopi:web-app-data:v1'
const EARLIER_KEYS = {
  drafts: 'canopi:web-app-data:v2:drafts',
  settings: 'canopi:web-app-data:v2:settings',
  species: 'canopi:web-app-data:v2:species',
  stamps: 'canopi:web-app-data:v2:saved-object-stamps',
  authority: 'canopi:web-app-data:v2:authority',
  migrationProgress: 'canopi:web-app-data:v2:migration-progress',
  authorityReservation: 'canopi:web-app-data:v2:authority-reservation',
} as const
const ALL_EARLIER_KEYS: readonly string[] = [V1_KEY, ...Object.values(EARLIER_KEYS)]

describe('browser app data store', () => {
  // Store health and notices are module state: a damaged record set aside in one test must not reach the next one's
  // notices, whatever order the seed lane runs them in (canopi-f47t.52.36).
  afterEach(() => {
    resetStoreHealthForTests()
    resetNoticesForTests()
  })

  it('persists Browser Drafts as local convenience state without notebook fields', () => {
    const storage = memoryStorage()
    const store = createBrowserAppDataStore({ storage })
    const file = makeDesign({ name: 'Terrace Draft' })

    const saved = store.saveDraft({ file, now: '2026-07-04T12:00:00.000Z' })

    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error('draft should save')
    expect(saved.value).toEqual({
      id: 'draft-terrace-draft',
      name: 'Terrace Draft',
      updatedAt: '2026-07-04T12:00:00.000Z',
    })
    expect(store.listDrafts()).toEqual([saved.value])
    expect(store.loadDraft(saved.value.id)).toEqual({ ...file, extra: {} })
    expect(saved.value).not.toHaveProperty('path')
    expect(saved.value).not.toHaveProperty('sectionId')
    expect([...storage.values.keys()]).toEqual([KEYS.drafts])
  })

  it('refuses a Draft write another tab overtook, and writes a Draft another tab deleted again rather than lose the edit', () => {
    const store = createBrowserAppDataStore({ storage: memoryStorage() })
    store.saveDraft({ id: 'draft-x', file: makeDesign({ name: 'X' }), now: '2026-07-04T12:00:00.000Z' })
    store.saveDraft({ id: 'draft-y', file: makeDesign({ name: 'Y' }), now: '2026-07-04T12:01:00.000Z' })

    const overtaken = store.saveDraft({
      id: 'draft-y',
      file: makeDesign({ name: 'Y', description: 'edited' }),
      now: '2026-07-04T12:06:00.000Z',
      expectedUpdatedAt: '2026-07-04T11:00:00.000Z',
    })
    expect(!overtaken.ok && overtaken.error).toBeInstanceOf(BrowserDraftChangedError)

    store.deleteDraft('draft-x')
    const edit = store.saveDraft({
      id: 'draft-x',
      file: makeDesign({ name: 'X', description: 'edited' }),
      now: '2026-07-04T13:01:00.000Z',
      expectedUpdatedAt: '2026-07-04T12:00:00.000Z',
    })
    expect(edit.ok).toBe(true)
    expect(store.listDrafts().map((draft) => draft.id)).toEqual(['draft-x', 'draft-y'])
  })

  it('stores Draft files in .canopi wire form, keeping unknown fields at the root', () => {
    const storage = memoryStorage()
    const store = createBrowserAppDataStore({ storage })
    const file = { ...makeDesign({ name: 'Wire Draft' }), extra: { future_top_level: { keep: true } } }

    const saved = store.saveDraft({ file, now: '2026-07-04T12:00:00.000Z' })
    if (!saved.ok) throw new Error('draft should save')

    const stored = JSON.parse(storage.values.get(KEYS.drafts)!) as { draftFiles: Record<string, Record<string, unknown>> }
    const wire = stored.draftFiles[saved.value.id]!
    expect(wire).not.toHaveProperty('extra')
    expect(wire.future_top_level).toEqual({ keep: true })
    expect(store.loadDraft(saved.value.id)?.extra).toEqual({ future_top_level: { keep: true } })
  })

  it('persists browser settings, Species app data, and Saved Object Stamps', () => {
    const storage = memoryStorage()
    const store = createBrowserAppDataStore({ storage })

    expect(store.saveSettings({ locale: 'fr', theme: 'dark' }).ok).toBe(true)
    expect(store.loadSettings()).toEqual({ locale: 'fr', theme: 'dark' })

    expect(store.setFavoriteSpecies(['Malus domestica', 'Quercus robur']).ok).toBe(true)
    expect(store.listFavoriteSpecies()).toEqual(['Malus domestica', 'Quercus robur'])

    expect(store.recordRecentlyViewedSpecies('Malus domestica', 3).ok).toBe(true)
    expect(store.recordRecentlyViewedSpecies('Prunus persica', 3).ok).toBe(true)
    expect(store.recordRecentlyViewedSpecies('Malus domestica', 3).ok).toBe(true)
    expect(store.listRecentlyViewedSpecies()).toEqual(['Malus domestica', 'Prunus persica'])

    expect(store.saveSavedObjectStamps([
      { id: 'stamp-1', name: 'Patio guild', payload: { objects: 2 } },
    ]).ok).toBe(true)
    expect(store.listSavedObjectStamps()).toEqual([
      { id: 'stamp-1', name: 'Patio guild', payload: { objects: 2 } },
    ])
    expect([...storage.values.keys()].sort()).toEqual([
      KEYS.settings,
      KEYS.species,
      KEYS.stamps,
    ].sort())
  })

  describe('data from before Canopi 2.0', () => {
    const NOW = '2026-10-02T12:00:00.000Z'
    const NOTICE_MARKER = 'canopi:web-app-data:before-2.0-kept-in-place-notice'

    /**
     * localStorage as Web Edition 1.0.1 to 1.2.0 leaves it once it moved the
     * v1 document into its partitions: four version-2 records, the committed
     * authority tombstone, and no v1 key (v1.2.0 browser-app-data.ts and
     * browser-partition-storage.ts). Its Drafts are in-memory files at
     * version 6 with a root `extra`.
     */
    function seedReleasedWebEdition(storage: MemoryStorage): Map<string, string> {
      storage.values.set(EARLIER_KEYS.drafts, JSON.stringify({
        version: 2,
        drafts: [{ id: 'draft-orchard', name: 'Orchard', updatedAt: '2026-07-04T12:00:00.000Z' }],
        draftFiles: {
          'draft-orchard': { ...makeDesign({ name: 'Orchard' }), version: 6, extra: {}, spatial_frame: null },
        },
      }))
      storage.values.set(EARLIER_KEYS.settings, JSON.stringify({
        version: 2,
        settings: { locale: 'de', theme: 'dark' },
      }))
      storage.values.set(EARLIER_KEYS.species, JSON.stringify({
        version: 2,
        favoriteSpecies: ['Malus domestica'],
        recentlyViewedSpecies: ['Pyrus communis'],
      }))
      storage.values.set(EARLIER_KEYS.stamps, JSON.stringify({
        version: 2,
        savedObjectStamps: [{ id: 'stamp-1', name: 'Guild', payload: { objects: 2 } }],
      }))
      storage.values.set(EARLIER_KEYS.authority, JSON.stringify({ version: 2, authority: 'v2' }))
      return new Map(storage.values)
    }

    /** A 1.x browser whose move out of v1 stopped half way (the quota ran out). */
    function seedInterruptedMove(storage: MemoryStorage): Map<string, string> {
      storage.values.set(V1_KEY, JSON.stringify({
        drafts: [{ id: 'draft-1', name: 'Draft', updatedAt: '2026-07-04T12:00:00.000Z' }],
        draftFiles: { 'draft-1': { ...makeDesign({ name: 'Draft' }), version: 6 } },
        settings: { locale: 'fr' },
        favoriteSpecies: [],
        recentlyViewedSpecies: [],
        savedObjectStamps: [],
      }))
      storage.values.set(EARLIER_KEYS.settings, JSON.stringify({ version: 2, settings: { locale: 'fr' } }))
      storage.values.set(EARLIER_KEYS.migrationProgress, JSON.stringify({ version: 2, state: 'migrating', partitions: '0100' }))
      storage.values.set(EARLIER_KEYS.authorityReservation, JSON.stringify({ version: 2, reserves: 'v2-authority-tombstone' }))
      return new Map(storage.values)
    }

    function earlierEntries(storage: MemoryStorage): Map<string, string> {
      return new Map([...storage.values].filter(([key]) => ALL_EARLIER_KEYS.includes(key)))
    }

    it.each([
      ['a released 1.x Web Edition', seedReleasedWebEdition],
      ['a 1.x move out of v1 left half way', seedInterruptedMove],
      ['the 1.x document alone', (storage: MemoryStorage) => {
        storage.values.set(V1_KEY, JSON.stringify({ drafts: [], draftFiles: {}, settings: { locale: 'fr' } }))
        return new Map(storage.values)
      }],
    ] as const)('tells once about %s, starts fresh, and never reads, writes or deletes a 1.x key', (_name, seed) => {
      const storage = memoryStorage()
      const before = seed(storage)
      const store = createBrowserAppDataStore({ storage })

      expect(store.takeEarlierDataNotice(NOW)).toBe(true)
      expect(storage.writes).toEqual([NOTICE_MARKER])
      expect(store.takeEarlierDataNotice('2026-10-03T12:00:00.000Z')).toBe(false)

      storage.reads.length = 0
      expect(store.listDrafts()).toEqual([])
      expect(store.loadSettings()).toBeNull()
      expect(store.listFavoriteSpecies()).toEqual([])
      expect(store.listRecentlyViewedSpecies()).toEqual([])
      expect(store.listSavedObjectStamps()).toEqual([])
      expect(store.saveDraft({ file: makeDesign({ name: 'Orchard' }), now: NOW }).ok).toBe(true)
      expect(store.saveSettings({ locale: 'fr' }).ok).toBe(true)
      expect(store.setFavoriteSpecies(['Quercus robur']).ok).toBe(true)
      expect(store.saveSavedObjectStamps([]).ok).toBe(true)
      expect(store.listDrafts().map((draft) => draft.id)).toEqual(['draft-orchard'])

      expect(earlierEntries(storage)).toEqual(before)
      expect(storage.reads.filter((key) => ALL_EARLIER_KEYS.includes(key))).toEqual([])
      expect(storage.writes.filter((key) => ALL_EARLIER_KEYS.includes(key))).toEqual([])
      expect(storage.removals.filter((key) => ALL_EARLIER_KEYS.includes(key))).toEqual([])
    })

    it('says nothing in a browser that only 2.0 has used', () => {
      const storage = memoryStorage()
      seedPartitions(storage)
      const store = createBrowserAppDataStore({ storage })

      expect(store.takeEarlierDataNotice(NOW)).toBe(false)
      expect(storage.writes).toEqual([])
      expect(store.listDrafts().map((draft) => draft.id)).toEqual(['draft-1'])
    })

    it('clears its marker once the 1.x data is gone, so 1.x data found later is told again', () => {
      const storage = memoryStorage()
      seedReleasedWebEdition(storage)
      const store = createBrowserAppDataStore({ storage })
      expect(store.takeEarlierDataNotice(NOW)).toBe(true)

      for (const key of ALL_EARLIER_KEYS) storage.values.delete(key)
      expect(store.takeEarlierDataNotice(NOW)).toBe(false)
      expect(storage.values.has(NOTICE_MARKER)).toBe(false)
    })

    // Probe P-D2 (release close, stream D): Chromium and WebKit throw a
    // QuotaExceededError DOMException for every write at the quota, the notice
    // marker included, and leave existing keys as they were.
    it('tells again and leaves the 1.x data untouched while the browser is full', () => {
      const storage = memoryStorage()
      const before = seedReleasedWebEdition(storage)
      storage.rejectWrite = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      const store = createBrowserAppDataStore({ storage })

      expect(store.takeEarlierDataNotice(NOW)).toBe(true)
      expect(store.takeEarlierDataNotice('2026-10-03T12:00:00.000Z')).toBe(true)
      expect(storage.values).toEqual(before)
    })

    it('does not claim earlier data was found when browser storage cannot be read', () => {
      const storage = memoryStorage()
      seedReleasedWebEdition(storage)
      for (const key of ALL_EARLIER_KEYS) storage.forbiddenReadKeys.add(key)
      const store = createBrowserAppDataStore({ storage })

      expect(store.takeEarlierDataNotice(NOW)).toBe(false)
      expect(storage.writes).toEqual([])
    })
  })

  it('saves Settings without reading or serializing the Draft partition', () => {
    const storage = memoryStorage()
    storage.values.set(KEYS.drafts, JSON.stringify({
      version: 3,
      drafts: [{ id: 'large', name: 'Large', updatedAt: '2026-07-04T12:00:00.000Z' }],
      draftFiles: { large: makeDesign({ name: 'x'.repeat(10_000) }) },
    }))
    storage.forbiddenReadKeys.add(KEYS.drafts)
    storage.maxWriteLength = 200
    const store = createBrowserAppDataStore({ storage })

    const result = store.saveSettings({ locale: 'fr', theme: 'dark' })

    expect(result).toEqual({ ok: true, value: { locale: 'fr', theme: 'dark' } })
    expect(storage.reads).not.toContain(KEYS.drafts)
    expect(storage.writes).toEqual([KEYS.settings])
  })

  it('reopens app data without reparsing an already-published Draft partition', () => {
    const storage = memoryStorage()
    const firstStore = createBrowserAppDataStore({ storage })
    expect(firstStore.saveDraft({
      file: makeDesign({ name: 'x'.repeat(10_000) }),
      now: '2026-07-04T12:00:00.000Z',
    }).ok).toBe(true)
    storage.reads.length = 0
    storage.forbiddenReadKeys.add(KEYS.drafts)
    const reopened = createBrowserAppDataStore({ storage })

    expect(reopened.loadSettings()).toBeNull()
    expect(reopened.saveSettings({ locale: 'fr' }).ok).toBe(true)
    expect(storage.reads).not.toContain(KEYS.drafts)
  })

  it.each([
    ['drafts', KEYS.drafts],
    ['settings', KEYS.settings],
    ['species', KEYS.species],
    ['stamps', KEYS.stamps],
  ] as const)('isolates a corrupt %s partition', (_name, corruptKey) => {
    const storage = memoryStorage()
    seedPartitions(storage)
    storage.values.set(corruptKey, '{not-json')
    const store = createBrowserAppDataStore({ storage })

    expect(store.listDrafts().map((draft) => draft.id)).toEqual(
      corruptKey === KEYS.drafts ? [] : ['draft-1'],
    )
    if (corruptKey === KEYS.settings) {
      // 2.1-Q67: an unreadable settings record is refused, never read as defaults a later save would write over.
      expect(() => store.loadSettings()).toThrow(StoreUnreadableError)
      expect(storage.values.get(KEYS.settings)).toBe('{not-json')
    } else {
      expect(store.loadSettings()).toEqual({ locale: 'fr' })
    }
    expect(store.listFavoriteSpecies()).toEqual(
      corruptKey === KEYS.species ? [] : ['Malus domestica'],
    )
    expect(store.listRecentlyViewedSpecies()).toEqual(
      corruptKey === KEYS.species ? [] : ['Pyrus communis'],
    )
    expect(store.listSavedObjectStamps()).toEqual(
      corruptKey === KEYS.stamps
        ? []
        : [{ id: 'stamp-1', name: 'Guild', payload: { objects: 2 } }],
    )
  })

  it('reports storage failures without replacing existing readable app data', () => {
    const storage = memoryStorage()
    const store = createBrowserAppDataStore({ storage })
    const saved = store.saveDraft({ file: makeDesign({ name: 'Safe Draft' }), now: '2026-07-04T12:00:00.000Z' })
    if (!saved.ok) throw new Error('initial save should pass')
    storage.failWrites = true

    const failed = store.saveDraft({ file: makeDesign({ name: 'Broken Draft' }), now: '2026-07-04T13:00:00.000Z' })

    expect(failed.ok).toBe(false)
    expect(store.listDrafts()).toEqual([saved.value])
    expect(store.loadDraft(saved.value.id)?.name).toBe('Safe Draft')
  })

  it('keeps the stored bytes of Drafts it cannot open when another Draft is saved or deleted', () => {
    const storage = memoryStorage()
    // A Draft a newer Canopi wrote, and a damaged one: this Canopi refuses
    // them but must not erase them.
    const olderDraft = { ...makeDesign({ name: 'Orchard' }), version: 99 }
    const damagedDraft = { ...makeDesign({ name: 'Pond' }), plants: 'not-an-array' }
    const olderSummary = { id: 'orchard', name: 'Orchard', updatedAt: '2026-07-04T12:00:00.000Z' }
    const damagedSummary = { id: 'pond', name: 'Pond', updatedAt: '2026-07-04T11:00:00.000Z' }
    storage.values.set(KEYS.drafts, JSON.stringify({
      version: 3,
      drafts: [olderSummary, damagedSummary],
      draftFiles: { orchard: olderDraft, pond: damagedDraft },
    }))
    const store = createBrowserAppDataStore({ storage })
    expect(store.listDrafts()).toEqual([])

    const saved = store.saveDraft({ id: 'new', file: makeDesign({ name: 'New' }), now: '2026-07-05T12:00:00.000Z' })
    expect(saved.ok).toBe(true)
    expect(store.deleteDraft('new').ok).toBe(true)
    expect(store.saveDraft({ id: 'next', file: makeDesign({ name: 'Next' }), now: '2026-07-05T13:00:00.000Z' }).ok).toBe(true)

    const stored = JSON.parse(storage.values.get(KEYS.drafts)!) as {
      drafts: unknown[]
      draftFiles: Record<string, unknown>
    }
    expect(stored.draftFiles.orchard).toEqual(olderDraft)
    expect(stored.draftFiles.pond).toEqual(damagedDraft)
    expect(stored.draftFiles).not.toHaveProperty('new')
    expect(stored.drafts).toEqual(expect.arrayContaining([olderSummary, damagedSummary]))
    expect(store.listDrafts().map((draft) => draft.id)).toEqual(['next'])
  })

  it('isolates corrupted Drafts without discarding unrelated browser app data', () => {
    const storage = memoryStorage()
    seedPartitions(storage)
    storage.values.set(KEYS.drafts, JSON.stringify({
      version: 3,
      drafts: [
        { id: 'valid', name: 'Valid', updatedAt: '2026-07-04T12:00:00.000Z' },
        { id: 'corrupt', name: 'Corrupt', updatedAt: '2026-07-04T13:00:00.000Z' },
        { id: 'missing', name: 'Missing', updatedAt: '2026-07-04T14:00:00.000Z' },
      ],
      draftFiles: {
        valid: makeDesign({ name: 'Valid' }),
        corrupt: { ...makeDesign({ name: 'Corrupt' }), plants: 'not-an-array' },
      },
    }))
    storage.values.set(KEYS.settings, JSON.stringify({
      version: 3,
      settings: { locale: 'fr', theme: 'dark' },
    }))
    const store = createBrowserAppDataStore({ storage })

    expect(store.listDrafts().map((draft) => draft.id)).toEqual(['valid'])
    expect(store.loadDraft('valid')?.name).toBe('Valid')
    expect(store.loadDraft('corrupt')).toBeNull()
    expect(store.loadDraft('missing')).toBeNull()
    expect(store.loadSettings()).toEqual({ locale: 'fr', theme: 'dark' })
    expect(store.listFavoriteSpecies()).toEqual(['Malus domestica'])
    expect(store.listRecentlyViewedSpecies()).toEqual(['Pyrus communis'])
    expect(store.listSavedObjectStamps()).toEqual([
      { id: 'stamp-1', name: 'Guild', payload: { objects: 2 } },
    ])
  })

  describe('a damaged Drafts or species lists record (2.1-Q287, 2.1-M438)', () => {
    const NOW = '2026-11-07T10:00:00.000Z'

    it.each([
      ['web_drafts', KEYS.drafts, 'Drafts'],
      ['web_species_lists', KEYS.species, 'favorites and recently viewed plants'],
    ] as const)('[canopi-f47t.52.36] a damaged %s record moves aside under its own key, named once, before reading as empty', (store, key, named) => {
      const dispose = installHealthNotices({ report: null, update: null })
      const storage = memoryStorage()
      seedPartitions(storage)
      storage.values.set(key, '{"version":3,"drafts":')
      const data = createBrowserAppDataStore({ storage, now: () => NOW })

      expect(data.listDrafts().map((draft) => draft.id)).toEqual(key === KEYS.drafts ? [] : ['draft-1'])
      expect(data.listFavoriteSpecies()).toEqual(key === KEYS.species ? [] : ['Malus domestica'])
      // Read again: the record is already aside, so it is named once.
      data.listDrafts()
      data.listRecentlyViewedSpecies()

      const aside = `${key}:damaged-${NOW}`
      expect(storage.values.get(aside)).toBe('{"version":3,"drafts":')
      expect(storage.values.has(key)).toBe(false)
      expect(storeStatus(store)).toEqual({ kind: 'set_aside_damaged', file: aside })
      const told = notices.value.filter((notice) => notice.key.startsWith(`health:${store}`))
      expect(told).toHaveLength(1)
      expect(t(told[0]!.message, told[0]!.params)).toContain(named)
      // The store works again: a new write lands under the store's key, the set-aside record kept.
      expect(key === KEYS.drafts
        ? data.saveDraft({ file: makeDesign({ name: 'Fresh' }), now: NOW }).ok
        : data.setFavoriteSpecies(['Malus domestica']).ok).toBe(true)
      expect(storage.values.get(aside)).toBe('{"version":3,"drafts":')
      dispose()
    })

    it('[canopi-f47t.52.36] a damaged record that cannot be moved aside (quota) is kept and its store refuses writes for the session, told once', () => {
      const dispose = installHealthNotices({ report: null, update: null })
      const storage = memoryStorage()
      storage.values.set(KEYS.drafts, 'not json')
      storage.rejectWrite = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      const data = createBrowserAppDataStore({ storage, now: () => NOW })

      expect(data.listDrafts()).toEqual([])
      storage.rejectWrite = null
      const refused = data.saveDraft({ file: makeDesign({ name: 'Lost?' }), now: NOW })
      expect(refused.ok).toBe(false)
      if (refused.ok) throw new Error('the write should be refused')
      expect(refused.error).toBeInstanceOf(StoreRefusedError)
      expect(data.deleteDraft('anything').ok).toBe(false)

      expect(storage.values.get(KEYS.drafts)).toBe('not json')
      expect(storeStatus('web_drafts')).toEqual({ kind: 'unavailable', code: { kind: 'io', io: 'no_space' } })
      expect(notices.value.map((notice) => notice.message)).toEqual(['health.writesRefused.webDrafts'])
      // Other stores still write.
      expect(data.setFavoriteSpecies(['Malus domestica']).ok).toBe(true)
      dispose()
    })

    it('[canopi-f47t.52.36] a species lists record a newer Canopi wrote is kept untouched and refuses writes', () => {
      const storage = memoryStorage()
      const newer = JSON.stringify({ version: 4, favourites: ['Malus domestica'] })
      storage.values.set(KEYS.species, newer)
      const data = createBrowserAppDataStore({ storage, now: () => NOW })

      expect(data.listFavoriteSpecies()).toEqual([])
      expect(data.setFavoriteSpecies(['Pyrus communis']).ok).toBe(false)
      expect(storage.values.get(KEYS.species)).toBe(newer)
      expect(storeStatus('web_species_lists')).toEqual({ kind: 'refused_newer' })
    })
  })
})

interface MemoryStorage extends BrowserStorageAdapter {
  failWrites: boolean
  forbiddenReadKeys: Set<string>
  maxWriteLength: number | null
  /** Every write throws what this returns, as a full browser storage does. */
  rejectWrite: (() => unknown) | null
  reads: string[]
  writes: string[]
  removals: string[]
  values: Map<string, string>
}

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>()
  return {
    failWrites: false,
    forbiddenReadKeys: new Set(),
    maxWriteLength: null,
    rejectWrite: null,
    reads: [],
    writes: [],
    removals: [],
    values,
    getItem(key) {
      this.reads.push(key)
      if (this.forbiddenReadKeys.has(key)) throw new Error(`forbidden read: ${key}`)
      return values.get(key) ?? null
    },
    setItem(key, value) {
      this.writes.push(key)
      if (this.rejectWrite) throw this.rejectWrite()
      if (this.failWrites || (this.maxWriteLength !== null && value.length > this.maxWriteLength)) {
        throw new Error('storage unavailable')
      }
      values.set(key, value)
    },
    removeItem(key) {
      this.removals.push(key)
      values.delete(key)
    },
  }
}

function seedPartitions(storage: MemoryStorage): void {
  storage.values.set(KEYS.drafts, JSON.stringify({
    version: 3,
    drafts: [{ id: 'draft-1', name: 'Draft', updatedAt: '2026-07-04T12:00:00.000Z' }],
    draftFiles: { 'draft-1': makeDesign({ name: 'Draft' }) },
  }))
  storage.values.set(KEYS.settings, JSON.stringify({
    version: 3,
    settings: { locale: 'fr' },
  }))
  storage.values.set(KEYS.species, JSON.stringify({
    version: 3,
    favoriteSpecies: ['Malus domestica'],
    recentlyViewedSpecies: ['Pyrus communis'],
  }))
  storage.values.set(KEYS.stamps, JSON.stringify({
    version: 3,
    savedObjectStamps: [{ id: 'stamp-1', name: 'Guild', payload: { objects: 2 } }],
  }))
}

function makeDesign(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'Draft',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    plant_species_codes: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
    ...overrides,
  }
}
