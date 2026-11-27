/**
 * platform/design-home-move-safety.browser.test.ts: Regression tests for #826 and #848 Opus R1
 * blockers B1, B2, B3 and should-fix items SF1-SF5 (canopi-f47t.52.50, 2.1-M157, 2.1-M527).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserStorage } from './browser-record'
import type { DesignCore } from './design-core'
import { createBrowserDesignHomeStore } from './design-home.browser'
import {
  LEGACY_DRAFTS_KEY,
  type DraftMoveMetaRecord,
  type StoredDraftRecord,
} from './draft-records-move'

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

function makeMemoryStorage(): BrowserStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
  }
}

function makeFakeDesignCore(): Pick<DesignCore, 'decode' | 'encode'> {
  return {
    async decode(bytes) {
      const parsed = JSON.parse(dec.decode(bytes)) as Record<string, unknown>
      if (parsed.version === 9) return { ok: { design: { ...parsed, version: 10 }, report: { kind: 'clean' } } as never }
      if (parsed.version === 10) return { ok: { design: parsed, report: { kind: 'clean' } } as never }
      return { err: { kind: 'unsupported_version' } as never }
    },
    async encode(design) {
      return { ok: enc.encode(JSON.stringify(design)) }
    },
  }
}

function v10Bytes(name: string): Uint8Array {
  return enc.encode(JSON.stringify({ version: 10, name, updated_at: '2026-12-01T00:00:00.000Z', plants: [] }))
}

function legacyPayload(drafts: readonly { id: string; name: string; version?: number }[]): string {
  return JSON.stringify({
    version: 3,
    drafts: drafts.map((d) => ({ id: d.id, name: d.name, updatedAt: '2026-10-01T00:00:00.000Z' })),
    draftFiles: Object.fromEntries(drafts.map((d) => [d.id, { version: d.version ?? 9, name: d.name, plants: [] }])),
  })
}

class MiniFakeIdb {
  readonly stores = new Map<string, Map<string, unknown>>([
    ['drafts', new Map()],
    ['meta', new Map()],
  ])
  corruptReadBackId: string | null = null
  openCount = 0
  closedCount = 0
  blockOpen = false
  lateOpenMs: number | null = null
  onReadBack: (() => void) | null = null

  factory(): IDBFactory {
    return {
      open: (_name: string) => {
        this.openCount += 1
        const req = {
          result: null as unknown,
          error: null as DOMException | null,
          onupgradeneeded: null as ((ev: { oldVersion: number }) => void) | null,
          onblocked: null as (() => void) | null,
          onsuccess: null as (() => void) | null,
          onerror: null as ((ev: { preventDefault(): void }) => void) | null,
        }
        const deliverOpen = () => {
          const db = {
            objectStoreNames: { contains: (n: string) => this.stores.has(n) },
            onversionchange: null as (() => void) | null,
            close: () => { this.closedCount += 1 },
            transaction: (names: string | string[], mode: IDBTransactionMode) => {
              const storeList = Array.isArray(names) ? names : [names]
              const tx = {
                mode,
                error: null as DOMException | null,
                oncomplete: null as (() => void) | null,
                onerror: null as (() => void) | null,
                onabort: null as (() => void) | null,
                objectStore: (storeName: string) => {
                  const map = this.stores.get(storeName)!
                  return {
                    get(key: string) {
                      const r = { result: undefined as unknown, onsuccess: null as (() => void) | null }
                      queueMicrotask(() => {
                        const raw = map.get(key)
                        r.result = raw ? structuredClone(raw) : undefined
                        r.onsuccess?.()
                      })
                      return r
                    },
                    getAll: () => {
                      const r = { result: [] as unknown[], onsuccess: null as (() => void) | null }
                      queueMicrotask(() => {
                        if (storeName === 'drafts' && mode === 'readonly') this.onReadBack?.()
                        r.result = [...map.values()].map((v) => {
                          const clone = structuredClone(v) as Record<string, unknown>
                          if (storeName === 'drafts' && mode === 'readonly' && clone.id === this.corruptReadBackId) {
                            return { ...clone, content: '{"corrupted":true}' }
                          }
                          return clone
                        })
                        r.onsuccess?.()
                      })
                      return r
                    },
                    put(val: Record<string, unknown>) {
                      const k = String(val.id ?? val.key)
                      map.set(k, structuredClone(val))
                      return { onsuccess: null }
                    },
                    delete(key: string) {
                      map.delete(key)
                      return { onsuccess: null }
                    },
                  }
                },
              }
              void storeList
              setTimeout(() => { tx.oncomplete?.() }, 0)
              return tx
            },
          }
          req.result = db
          req.onsuccess?.()
        }
        queueMicrotask(() => {
          if (this.blockOpen) {
            req.onblocked?.()
            if (this.lateOpenMs !== null) setTimeout(deliverOpen, this.lateOpenMs)
            return
          }
          deliverOpen()
        })
        return req as unknown as IDBOpenDBRequest
      },
    } as unknown as IDBFactory
  }
}

describe('platform/design-home.browser move & tab safety (#826 & #848 B1-B3, SF1-SF5)', () => {
  it('canopi-f47t.52.50 (B1): a held Draft whose read-back fails stays copied on rerun and is never promoted live', async () => {
    const idb = new MiniFakeIdb()
    idb.corruptReadBackId = 'draft-x'
    const storage = makeMemoryStorage()
    storage.setItem(LEGACY_DRAFTS_KEY, legacyPayload([{ id: 'draft-x', name: 'Orchard' }]))
    const failures: unknown[] = []
    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      legacyStorage: storage,
      designCore: makeFakeDesignCore(),
      onMigrationFailed: (e) => failures.push(e),
    })

    await store.open()
    expect(failures).toHaveLength(1)
    expect((idb.stores.get('meta')!.get('move') as DraftMoveMetaRecord).state).toBe('copied')

    // Rerun while read-back is STILL corrupt: held id MUST be re-verified and MUST NOT go live!
    await store.syncLegacyStorage()
    expect(failures).toHaveLength(2)
    expect((idb.stores.get('meta')!.get('move') as DraftMoveMetaRecord).state).toBe('copied')

    // Once read-back succeeds, rerun promotes live.
    idb.corruptReadBackId = null
    await store.syncLegacyStorage()
    expect((idb.stores.get('meta')!.get('move') as DraftMoveMetaRecord).state).toBe('live')
    store.dispose()
  })

  it('canopi-f47t.52.50 (B2): preserves 2.0 edits across staging/swap, bumps version on re-stage, and routes 2.0 edits on version>=2 rows to older-tab copies at go-live', async () => {
    const idb = new MiniFakeIdb()
    const storage = makeMemoryStorage()
    storage.setItem(LEGACY_DRAFTS_KEY, legacyPayload([
      { id: 'draft-untouched', name: 'Untouched v1' },
      { id: 'draft-edited', name: 'Initial' },
    ]))
    const copies: Array<{ legacyId: string; copyId: string; name: string }> = []
    // Simulate a 2.0 edit landing between staging and swap: `rawNow` check aborts swap (state stays copied).
    let mutatedBetweenStageAndSwap = false
    idb.onReadBack = () => {
      if (mutatedBetweenStageAndSwap) return
      mutatedBetweenStageAndSwap = true
      storage.setItem(LEGACY_DRAFTS_KEY, legacyPayload([
        { id: 'draft-untouched', name: 'Untouched v2 from 2.0' },
        { id: 'draft-edited', name: 'Initial' },
      ]))
    }
    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      legacyStorage: storage,
      designCore: makeFakeDesignCore(),
      onOlderTabCopy: (c) => copies.push(c),
    })
    await store.open()
    expect((idb.stores.get('meta')!.get('move') as DraftMoveMetaRecord).state).toBe('copied')

    // User edits draft-edited in 2.1 while state is still `copied` (version reaches 2), and 2.0 also edits it.
    expect(await store.write('draft-edited', v10Bytes('2.1 Edit While Copied'), '1')).toEqual({ kind: 'written', version: '2' })
    storage.setItem(LEGACY_DRAFTS_KEY, legacyPayload([
      { id: 'draft-untouched', name: 'Untouched v2 from 2.0' },
      { id: 'draft-edited', name: '2.0 Edit While Copied' },
    ]))

    await store.syncLegacyStorage()
    expect((idb.stores.get('meta')!.get('move') as DraftMoveMetaRecord).state).toBe('live')

    // Re-staged untouched row got 2.0's new content AND bumped version to 2 (so a stale "1" write conflicts).
    const untouched = idb.stores.get('drafts')!.get('draft-untouched') as StoredDraftRecord
    expect((JSON.parse(untouched.content) as { name: string }).name).toBe('Untouched v2 from 2.0')
    expect(untouched.version).toBe(2)
    expect(await store.write('draft-untouched', v10Bytes('Stale Session'), '1')).toEqual({ kind: 'conflict', current: '2' })

    // Version >= 2 row kept its 2.1 edit AND immediately routed 2.0's concurrent edit to an older-tab copy with notice.
    const edited = idb.stores.get('drafts')!.get('draft-edited') as StoredDraftRecord
    expect((JSON.parse(edited.content) as { name: string }).name).toBe('2.1 Edit While Copied')
    expect(copies).toHaveLength(1)
    expect(copies[0]!.legacyId).toBe('draft-edited')
    const olderCopy = idb.stores.get('drafts')!.get(copies[0]!.copyId) as StoredDraftRecord
    expect((JSON.parse(olderCopy.content) as { name: string }).name).toBe('2.0 Edit While Copied')
    store.dispose()
  })

  it('canopi-f47t.52.50 (B3, 2.1-M527): rotates to a fresh older-tab-* copy when the tracked copy has 2.1 edits so neither 2.1 nor 2.0 edits are lost', async () => {
    const idb = new MiniFakeIdb()
    const storage = makeMemoryStorage()
    storage.setItem(LEGACY_DRAFTS_KEY, legacyPayload([{ id: 'draft-x', name: 'Initial' }]))
    const copies: Array<{ legacyId: string; copyId: string; name: string }> = []
    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      legacyStorage: storage,
      designCore: makeFakeDesignCore(),
      onOlderTabCopy: (c) => copies.push(c),
    })
    await store.open()

    // 2.0 tab edits draft-x -> creates older-tab-draft-x (version 1).
    storage.setItem(LEGACY_DRAFTS_KEY, legacyPayload([{ id: 'draft-x', name: '2.0 Edit 1' }]))
    await store.syncLegacyStorage()
    expect(copies).toHaveLength(1)
    const firstCopyId = copies[0]!.copyId

    // User opens that older-tab copy in 2.1 and saves their own edit (version 2).
    expect(await store.write(firstCopyId, v10Bytes('User 2.1 Edit on Copy'), '1')).toEqual({ kind: 'written', version: '2' })

    // 2.0 tab edits draft-x AGAIN -> firstCopyId stays intact as an ordinary 2.1 Draft;
    // a fresh older-tab-* record receives the new 2.0 content and raises the notice.
    const secondLegacyRaw = legacyPayload([{ id: 'draft-x', name: '2.0 Edit 2' }])
    storage.setItem(LEGACY_DRAFTS_KEY, secondLegacyRaw)
    await store.syncLegacyStorage()
    expect(copies).toHaveLength(2)
    const secondCopyId = copies[1]!.copyId
    expect(secondCopyId).not.toBe(firstCopyId)
    expect(/^[a-z0-9-]{1,64}$/.test(secondCopyId)).toBe(true)

    const firstAfter = idb.stores.get('drafts')!.get(firstCopyId) as StoredDraftRecord
    const secondAfter = idb.stores.get('drafts')!.get(secondCopyId) as StoredDraftRecord
    expect((JSON.parse(firstAfter.content) as { name: string }).name).toBe('User 2.1 Edit on Copy')
    expect((JSON.parse(secondAfter.content) as { name: string }).name).toBe('2.0 Edit 2')
    expect(storage.getItem(LEGACY_DRAFTS_KEY)).toBe(secondLegacyRaw)
    store.dispose()
  })

  it('canopi-f47t.52.50 (SF1, SF2, SF3): heartbeat keeps live markers fresh past stale window, reloadTabId recovers reload without duplicate-tab collision, and pagehide blocks reopen', async () => {
    vi.useFakeTimers()
    try {
      const idb = new MiniFakeIdb()
      const storage = makeMemoryStorage()
      let clock = 1_000_000
      const tabA = createBrowserDesignHomeStore({
        factory: idb.factory(),
        legacyStorage: storage,
        tabId: 'tab-a',
        now: () => new Date(clock),
        stalePendingMs: 60_000,
        heartbeatMs: 20_000,
      })
      const tabB = createBrowserDesignHomeStore({
        factory: idb.factory(),
        legacyStorage: storage,
        tabId: 'tab-b',
        now: () => new Date(clock),
        stalePendingMs: 60_000,
        heartbeatMs: 20_000,
      })

      const openP = tabA.open()
      await vi.runOnlyPendingTimersAsync()
      await openP
      tabA.markPending('draft-a')

      // SF2: write() itself does not clear the pending marker (SessionCore clears only when rev === ackRev).
      const writeP = tabA.write('draft-a', v10Bytes('A1'), null)
      await vi.runOnlyPendingTimersAsync()
      expect(await writeP).toEqual({ kind: 'written', version: '1' })

      // SF1 heartbeat: advance 75s with heartbeat firing every 20s -> Tab B STILL must NOT steal Tab A's live marker!
      for (let step = 0; step < 4; step += 1) {
        clock += 20_000
        await vi.advanceTimersByTimeAsync(20_000)
      }
      expect(tabB.takePendingMarkers()).toEqual([])

      // Reloading Tab A passes `reloadTabId: 'tab-a'` on a fresh `tab-a-reloaded` page load and recovers immediately.
      const tabAReloaded = createBrowserDesignHomeStore({
        factory: idb.factory(),
        legacyStorage: storage,
        tabId: 'tab-a-reloaded',
        now: () => new Date(clock),
        stalePendingMs: 60_000,
      })
      expect(tabAReloaded.takePendingMarkers('tab-a')).toEqual(['draft-a'])
      tabAReloaded.dispose()

      // If Tab A crashes (disposed without clearing) and 60s elapse, Tab B takes the stale marker.
      tabA.markPending('draft-crashed')
      tabA.dispose()
      clock += 65_000
      expect(tabB.takePendingMarkers()).toEqual(['draft-crashed'])

      // SF3: closeForPageHide blocks reopen until reopenAfterPageShow.
      const openB = tabB.open()
      await vi.runOnlyPendingTimersAsync()
      await openB
      const opensBefore = idb.openCount
      tabB.closeForPageHide()
      expect(await tabB.read('draft-a')).toEqual({ kind: 'unreadable', reason: 'storage_unavailable' })
      expect(idb.openCount).toBe(opensBefore)
      const reopenP = tabB.reopenAfterPageShow()
      await vi.runOnlyPendingTimersAsync()
      await reopenP
      const readP = tabB.read('draft-a')
      await vi.runOnlyPendingTimersAsync()
      expect((await readP).kind).toBe('present')

      tabB.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('canopi-f47t.52.50 (SF3, Nit 3): blocked openDb times out to unavailable and closes a late onsuccess connection', async () => {
    const idb = new MiniFakeIdb()
    idb.blockOpen = true
    idb.lateOpenMs = 40
    let blocked = 0
    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      openTimeoutMs: 15,
      onBlocked: () => { blocked += 1 },
    })
    expect(await store.open()).toEqual({ kind: 'unavailable', reason: 'storage_unavailable' })
    expect(blocked).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(idb.closedCount, 'late onsuccess after timeout closes its connection').toBe(1)
    store.dispose()
  })

  it('canopi-f47t.52.50 (SF5): opens and reads the frozen spec/web/frozen/drafts.json fixture without re-copying', async () => {
    const fixturePath = fileURLToPath(new URL('../../../../spec/web/frozen/drafts.json', import.meta.url))
    const frozen = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      readonly stores: { readonly drafts: readonly StoredDraftRecord[]; readonly meta: readonly DraftMoveMetaRecord[] }
    }
    const idb = new MiniFakeIdb()
    for (const row of frozen.stores.drafts) idb.stores.get('drafts')!.set(row.id, structuredClone(row))
    for (const meta of frozen.stores.meta) idb.stores.get('meta')!.set(meta.key, structuredClone(meta))

    const copies: unknown[] = []
    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      designCore: makeFakeDesignCore(),
      onOlderTabCopy: (c) => copies.push(c),
    })
    expect(await store.open()).toEqual({ kind: 'ready' })
    const listed = await store.listDrafts()
    expect(listed.map((d) => d.id)).toEqual(['draft-hedge', 'older-tab-draft-orchard', 'draft-orchard'])
    expect(copies).toEqual([])
    store.dispose()
  })
})
