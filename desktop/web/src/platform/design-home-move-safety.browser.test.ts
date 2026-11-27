/**
 * platform/design-home-move-safety.browser.test.ts: Regression tests for #826 Opus R1
 * blockers B1, B2, B3 and should-fix items #1-#4 (canopi-f47t.52.50, 2.1-M157, 2.1-M527).
 */
import { describe, expect, it } from 'vitest'
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
  blockOpen = false

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
        queueMicrotask(() => {
          if (this.blockOpen) {
            req.onblocked?.()
            return
          }
          const db = {
            objectStoreNames: { contains: (n: string) => this.stores.has(n) },
            onversionchange: null as (() => void) | null,
            close() {},
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
        })
        return req as unknown as IDBOpenDBRequest
      },
    } as unknown as IDBFactory
  }
}

describe('platform/design-home.browser move & tab safety (#826 B1-B3, SF1-SF4)', () => {
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

  it('canopi-f47t.52.50 (B2): a 2.0 edit made between staging and swap is preserved on rerun', async () => {
    const idb = new MiniFakeIdb()
    const storage = makeMemoryStorage()
    storage.setItem(LEGACY_DRAFTS_KEY, legacyPayload([{ id: 'draft-x', name: 'Version A' }]))
    // Simulate Run 1 staging Version A while swap was skipped (state stays copied).
    idb.corruptReadBackId = 'draft-x'
    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      legacyStorage: storage,
      designCore: makeFakeDesignCore(),
    })
    await store.open()
    expect((idb.stores.get('meta')!.get('move') as DraftMoveMetaRecord).state).toBe('copied')

    // Now the 2.0 tab edits draft-x to Version B before the swap completes.
    idb.corruptReadBackId = null
    storage.setItem(LEGACY_DRAFTS_KEY, legacyPayload([{ id: 'draft-x', name: 'Version B from 2.0' }]))
    await store.syncLegacyStorage()

    expect((idb.stores.get('meta')!.get('move') as DraftMoveMetaRecord).state).toBe('live')
    const rec = idb.stores.get('drafts')!.get('draft-x') as StoredDraftRecord
    expect((JSON.parse(rec.content) as { name: string }).name).toBe('Version B from 2.0')
    store.dispose()
  })

  it('canopi-f47t.52.50 (B3, 2.1-M527): keeps at most one older-tab copy per 2.0 id and never overwrites 2.1 edits to that copy', async () => {
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

    // 2.0 tab edits draft-x AGAIN -> must NOT overwrite firstCopyId AND must NOT mint a second copy;
    // the 2.0 localStorage key stays untouched (2.1-M21).
    const secondLegacyRaw = legacyPayload([{ id: 'draft-x', name: '2.0 Edit 2' }])
    storage.setItem(LEGACY_DRAFTS_KEY, secondLegacyRaw)
    await store.syncLegacyStorage()
    expect(copies).toHaveLength(1)
    expect([...idb.stores.get('drafts')!.keys()].filter((k) => k.startsWith('older-tab-'))).toEqual([firstCopyId])

    const firstAfter = idb.stores.get('drafts')!.get(firstCopyId) as StoredDraftRecord
    expect((JSON.parse(firstAfter.content) as { name: string }).name).toBe('User 2.1 Edit on Copy')
    expect(storage.getItem(LEGACY_DRAFTS_KEY)).toBe(secondLegacyRaw)
    store.dispose()
  })

  it('canopi-f47t.52.50 (SF1, SF2, SF3): per-tab pending markers isolate live peers, write() does not clear dirty markers, and pagehide blocks reopen until pageshow', async () => {
    const idb = new MiniFakeIdb()
    const storage = makeMemoryStorage()
    let clock = 1_000_000
    const tabA = createBrowserDesignHomeStore({
      factory: idb.factory(),
      legacyStorage: storage,
      tabId: 'tab-a',
      now: () => new Date(clock),
      stalePendingMs: 60_000,
    })
    const tabB = createBrowserDesignHomeStore({
      factory: idb.factory(),
      legacyStorage: storage,
      tabId: 'tab-b',
      now: () => new Date(clock),
      stalePendingMs: 60_000,
    })

    await tabA.open()
    tabA.markPending('draft-a')
    // SF2: write() itself does not clear the pending marker (SessionCore clears only when rev === ackRev).
    expect(await tabA.write('draft-a', v10Bytes('A1'), null)).toEqual({ kind: 'written', version: '1' })
    // SF1: Tab B starting while Tab A's marker is fresh does NOT steal Tab A's marker.
    expect(tabB.takePendingMarkers()).toEqual([])
    // Tab A reloading with the same tabId DOES recover its own marker immediately.
    expect(tabA.takePendingMarkers()).toEqual(['draft-a'])

    // If Tab A crashes and 60s elapse, Tab B takes the stale marker.
    tabA.markPending('draft-crashed')
    clock += 65_000
    expect(tabB.takePendingMarkers()).toEqual(['draft-crashed'])

    // SF3: closeForPageHide blocks reopen until reopenAfterPageShow.
    const opensBefore = idb.openCount
    tabA.closeForPageHide()
    expect(await tabA.read('draft-a')).toEqual({ kind: 'unreadable', reason: 'storage_unavailable' })
    expect(idb.openCount).toBe(opensBefore)
    await tabA.reopenAfterPageShow()
    expect((await tabA.read('draft-a')).kind).toBe('present')

    tabA.dispose()
    tabB.dispose()
  })

  it('canopi-f47t.52.50 (Nit 3): blocked openDb times out to unavailable instead of hanging launch', async () => {
    const idb = new MiniFakeIdb()
    idb.blockOpen = true
    let blocked = 0
    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      openTimeoutMs: 25,
      onBlocked: () => { blocked += 1 },
    })
    expect(await store.open()).toEqual({ kind: 'unavailable', reason: 'storage_unavailable' })
    expect(blocked).toBe(1)
    store.dispose()
  })
})
