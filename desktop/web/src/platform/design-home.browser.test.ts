// @vitest-environment jsdom
/**
 * Contract & fault-seam suite for Web Edition's IndexedDB Draft store
 * (`platform/design-home.browser.ts` + `platform/draft-records.browser.ts`, 2b-6,
 * canopi-f47t.52.50; contracts §4, §11; 2.1-Q40, Q47, Q165, Q322, M21, M157, M526, M527).
 */
import { describe, expect, it, vi } from 'vitest'
import type { BrowserStorage } from './browser-record'
import type { DesignCore } from './design-core'
import type { DraftId } from './design-home'
import { createBrowserDesignHomeStore } from './design-home.browser'
import { createDraftRecordsReaderForTests as createDraftRecordsReader } from './draft-records.browser'
import { LEGACY_DRAFTS_KEY, type DraftMoveMetaRecord, type StoredDraftRecord } from './draft-records-move'

const DRAFT_DATABASE = 'canopi-drafts'
const DRAFTS_STORE = 'drafts'
const META_STORE = 'meta'
const MOVE_RECORD_KEY = 'move'
const DRAFT_ID_PATTERN = /^[a-z0-9-]{1,64}$/

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

interface FakeDbData {
  version: number
  readonly stores: Map<string, Map<string, unknown>>
}

interface FakeConn {
  closed: boolean
  onversionchange: ((event: { oldVersion: number; newVersion: number | null }) => void) | null
}
type FakeOpenReq = Record<string, unknown> & {
  onsuccess?: () => void
  onerror?: (event: unknown) => void
  onupgradeneeded?: (event: { oldVersion: number; newVersion: number | null }) => void
  onblocked?: () => void
}

/** Full readwrite + upgrade + fault-injection FakeIndexedDb for Q40/Q47 Draft-store contract tests. */
class FaultableIndexedDb {
  readonly dbs = new Map<string, FakeDbData>()
  readonly connections: FakeConn[] = []
  failNextWrite: Error | null = null
  failNextDelete: Error | null = null
  fireBlockedOnOpen = false
  corruptReadBackId: string | null = null

  seedDatabase(version: number, drafts: readonly StoredDraftRecord[] = [], meta: readonly DraftMoveMetaRecord[] = []): void {
    const stores = new Map<string, Map<string, unknown>>()
    stores.set(DRAFTS_STORE, new Map(drafts.map((d) => [d.id, structuredClone(d)])))
    stores.set(META_STORE, new Map(meta.map((m) => [m.key, structuredClone(m)])))
    this.dbs.set(DRAFT_DATABASE, { version, stores })
  }

  triggerVersionChange(newVersion: number | null): void {
    const cur = this.dbs.get(DRAFT_DATABASE)?.version ?? 0
    for (const c of this.connections) {
      if (!c.closed) c.onversionchange?.({ oldVersion: cur, newVersion })
    }
  }

  factory() {
    return {
      open: (name: string, version?: number) => this.open(name, version),
      databases: async () => [...this.dbs].map(([name, db]) => ({ name, version: db.version })),
    }
  }

  private open(name: string, version?: number): IDBOpenDBRequest {
    const req: FakeOpenReq = {}
    queueMicrotask(() => this.runOpenRequest(req, name, version))
    return req as unknown as IDBOpenDBRequest
  }

  private runOpenRequest(req: FakeOpenReq, name: string, version: number | undefined): void {
    if (this.fireBlockedOnOpen) { this.fireBlockedOnOpen = false; req.onblocked?.() }
    const existing = this.dbs.get(name)
    if (existing && version !== undefined && version < existing.version) {
      this.failRequest(req, 'The requested version is less than the existing version.', 'VersionError'); return
    }
    if (!existing && version === undefined && this.runUpgradeAbortable(req, 0, 1)) {
      this.failRequest(req, 'Aborted', 'AbortError'); return
    }
    const targetVersion = version ?? existing?.version ?? 1
    let dbData = existing
    if (!dbData || targetVersion > dbData.version) {
      const upgraded = this.upgradeDatabase(req, name, dbData, targetVersion)
      if (!upgraded) return
      dbData = upgraded
    }
    req.result = this.connect(dbData, false)
    req.onsuccess?.()
  }

  private failRequest(req: FakeOpenReq, msg: string, domName: string): void {
    req.error = new DOMException(msg, domName)
    req.onerror?.({ preventDefault: () => {} })
  }

  private runUpgradeAbortable(req: FakeOpenReq, oldVersion: number, newVersion: number): boolean {
    let aborted = false
    req.transaction = { abort: () => { aborted = true } }
    req.onupgradeneeded?.({ oldVersion, newVersion })
    return aborted
  }

  private upgradeDatabase(req: FakeOpenReq, name: string, existing: FakeDbData | undefined, targetVersion: number): FakeDbData | null {
    const nextDb: FakeDbData = { version: targetVersion, stores: existing ? existing.stores : new Map() }
    req.result = this.connect(nextDb, true)
    if (this.runUpgradeAbortable(req, existing?.version ?? 0, targetVersion)) {
      this.failRequest(req, 'Upgrade aborted', 'AbortError'); return null
    }
    this.dbs.set(name, nextDb)
    return nextDb
  }

  private connect(dbData: FakeDbData, forUpgrade: boolean): IDBDatabase {
    const conn: FakeConn & Record<string, unknown> = {
      closed: false,
      onversionchange: null,
      version: dbData.version,
      objectStoreNames: { contains: (s: string) => dbData.stores.has(s) },
      createObjectStore: (s: string) => {
        if (!dbData.stores.has(s)) dbData.stores.set(s, new Map())
        return {}
      },
      close: () => { conn.closed = true },
      transaction: (names: string | string[], mode: string) => {
        if (conn.closed) throw new DOMException('Connection closed', 'InvalidStateError')
        return this.transaction(dbData, [names].flat(), mode)
      },
    }
    if (!forUpgrade) this.connections.push(conn)
    return conn as unknown as IDBDatabase
  }

  private transaction(dbData: FakeDbData, names: readonly string[], mode: string): IDBTransaction {
    const tx: Record<string, unknown> & { oncomplete?: () => void; onerror?: () => void; onabort?: () => void } = { error: null }
    const snapshot = mode === 'readwrite'
      ? new Map(names.map((n) => [n, new Map([...(dbData.stores.get(n) ?? new Map())].map(([k, v]) => [k, structuredClone(v)]))]))
      : null
    const ops: Array<() => void> = []
    let failed: Error | null = null

    const enqueue = (fn: () => unknown) => {
      const req: Record<string, unknown> & { onsuccess?: () => void } = {}
      ops.push(() => {
        req.result = fn()
        req.onsuccess?.()
      })
      return req
    }

    tx.objectStore = (storeName: string) => {
      const store = dbData.stores.get(storeName)!
      const keyProp = storeName === META_STORE ? 'key' : 'id'
      return {
        get: (key: string) => enqueue(() => {
          const val = structuredClone(store.get(key))
          if (this.corruptReadBackId && storeName === DRAFTS_STORE && key === this.corruptReadBackId && val && typeof val === 'object') {
            return { ...val, content: '{"corrupted":true}' }
          }
          return val
        }),
        getAll: () => enqueue(() => {
          const all = structuredClone([...store.values()])
          if (this.corruptReadBackId && storeName === DRAFTS_STORE) {
            return all.map((r) => (
              r && typeof r === 'object' && (r as { id?: string }).id === this.corruptReadBackId
                ? { ...r, content: '{"corrupted":true}' }
                : r
            ))
          }
          return all
        }),
        put: (record: Record<string, unknown>) => enqueue(() => {
          if (this.failNextWrite) {
            failed = this.failNextWrite
            this.failNextWrite = null
            return undefined
          }
          store.set(String(record[keyProp]), structuredClone(record))
          return record[keyProp]
        }),
        delete: (key: string) => enqueue(() => {
          if (this.failNextDelete) {
            failed = this.failNextDelete
            this.failNextDelete = null
            return undefined
          }
          store.delete(key)
          return undefined
        }),
      }
    }

    queueMicrotask(() => {
      while (ops.length > 0 && !failed) {
        const next = ops.shift()!
        next()
      }
      if (failed) {
        if (snapshot) {
          for (const [n, map] of snapshot) dbData.stores.set(n, map)
        }
        tx.error = failed
        tx.onabort?.()
        return
      }
      queueMicrotask(() => tx.oncomplete?.())
    })
    return tx as unknown as IDBTransaction
  }
}

function makeMemoryStorage(): BrowserStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
  }
}

function makeFakeDesignCore(): Pick<DesignCore, 'decode' | 'encode'> {
  return {
    async decode(bytes) {
      const parsed = JSON.parse(dec.decode(bytes)) as Record<string, unknown>
      if (parsed.corrupt) {
        return { err: { kind: 'invalid_document', message: 'corrupt', field_path: '$' } }
      }
      const migratedFrom = parsed.version === 9 ? 9 : null
      return {
        ok: {
          design: { ...parsed, version: 10 } as never,
          migrated_from: migratedFrom,
        },
      }
    },
    async encode(design) {
      return { ok: enc.encode(JSON.stringify(design)) }
    },
  }
}

function v10Bytes(name: string, updatedAt = '2026-12-01T00:00:00.000Z', extra: Record<string, unknown> = {}): Uint8Array {
  return enc.encode(JSON.stringify({ version: 10, name, updated_at: updatedAt, plants: [], zones: [], ...extra }))
}

describe('platform/design-home.browser (2b-6 canopi-f47t.52.50)', () => {
  it('canopi-f47t.52.50: atomic integer-CAS write, conflict refusal, list order, delete, and v2.0.5 reader compatibility (2.1-M526, M527)', async () => {
    const idb = new FaultableIndexedDb()
    const storage = makeMemoryStorage()
    const store = createBrowserDesignHomeStore({ factory: idb.factory(), legacyStorage: storage, appVersion: '2.1.0' })

    expect(await store.open()).toEqual({ kind: 'ready' })
    expect(idb.dbs.get(DRAFT_DATABASE)?.version).toBe(4)

    expect(await store.read('draft-orchard')).toEqual({ kind: 'absent' })
    const w1 = await store.write('draft-orchard', v10Bytes('Orchard', '2026-12-01T00:00:00.000Z'), null)
    expect(w1).toEqual({ kind: 'written', version: '1' })

    const w2 = await store.write('draft-orchard', v10Bytes('Orchard v2', '2026-12-02T00:00:00.000Z'), '1')
    expect(w2).toEqual({ kind: 'written', version: '2' })

    // Stale CAS token refused without overwriting version 2.
    const stale = await store.write('draft-orchard', v10Bytes('Stale', '2026-12-03T00:00:00.000Z'), '1')
    expect(stale).toEqual({ kind: 'conflict', current: '2' })

    const read = await store.read('draft-orchard')
    expect(read.kind).toBe('present')
    if (read.kind === 'present') {
      expect(read.version).toBe('2')
      expect((JSON.parse(dec.decode(new Uint8Array(read.bytes))) as { name: string }).name).toBe('Orchard v2')
    }

    await store.write('draft-hedge', v10Bytes('Hedge', '2026-12-05T00:00:00.000Z'), null)
    const listed = await store.listDrafts()
    expect(listed.map((d) => d.id)).toEqual(['draft-hedge', 'draft-orchard'])

    // Invariant 2.1-M527: every record is pure JSON, v10 content, valid id, readable by v2.0.5 reader.
    const rawRecords = [...idb.dbs.get(DRAFT_DATABASE)!.stores.get(DRAFTS_STORE)!.values()] as StoredDraftRecord[]
    for (const rec of rawRecords) {
      expect(DRAFT_ID_PATTERN.test(rec.id)).toBe(true)
      expect(rec.canopi_version).toBe('2.1.0')
      expect(Number.isInteger(rec.version)).toBe(true)
      expect((JSON.parse(rec.content) as { version: number }).version).toBe(10)
    }
    const v205Reader = createDraftRecordsReader({
      factory: idb.factory(),
      onVersionChange: () => {},
      report: () => {},
    })
    const v205Listing = await v205Reader.list()
    expect(v205Listing.complete).toBe(true)
    expect(v205Listing.drafts.map((d) => d.id)).toEqual(['draft-hedge', 'draft-orchard'])

    expect(await store.deleteDraft('draft-orchard' as DraftId)).toEqual({ ok: true })
    expect(await store.read('draft-orchard')).toEqual({ kind: 'absent' })
    store.dispose()
  })

  it('canopi-f47t.52.50: Q47 fault injection (QuotaExceededError, NS_ERROR_DOM_QUOTA_REACHED, abort, invalid bytes) keeps last acknowledged revision intact', async () => {
    const idb = new FaultableIndexedDb()
    const store = createBrowserDesignHomeStore({ factory: idb.factory() })
    await store.open()

    expect(await store.write('draft-q', v10Bytes('Good'), null)).toEqual({ kind: 'written', version: '1' })

    idb.failNextWrite = new DOMException('quota', 'QuotaExceededError')
    expect(await store.write('draft-q', v10Bytes('Too big'), '1')).toEqual({ kind: 'quota_refused' })

    idb.failNextWrite = Object.assign(new Error('quota'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' })
    expect(await store.write('draft-q', v10Bytes('Too big 2'), '1')).toEqual({ kind: 'quota_refused' })

    idb.failNextWrite = new DOMException('aborted', 'AbortError')
    const aborted = await store.write('draft-q', v10Bytes('Aborted'), '1')
    expect(aborted.kind).toBe('failed')

    // Invalid JSON or pre-v10 payload is refused before touching IDB.
    expect((await store.write('draft-q', enc.encode('not-json'), '1')).kind).toBe('failed')
    expect((await store.write('draft-q', enc.encode(JSON.stringify({ version: 9, name: 'V9' })), '1')).kind).toBe('failed')

    // Last acknowledged revision remains intact.
    const after = await store.read('draft-q')
    expect(after.kind).toBe('present')
    if (after.kind === 'present') {
      expect(after.version).toBe('1')
      expect((JSON.parse(dec.decode(new Uint8Array(after.bytes))) as { name: string }).name).toBe('Good')
    }

    idb.failNextDelete = new DOMException('delete failed', 'AbortError')
    expect((await store.deleteDraft('draft-q' as DraftId)).ok).toBe(false)
    store.dispose()
  })

  it('canopi-f47t.52.50: staged verified 2.0 localStorage move migrates v9 to v10, keeps refused Drafts, leaves 2.0 key untouched (2.1-M21), and handles post-move 2.0 tab writes', async () => {
    const idb = new FaultableIndexedDb()
    const storage = makeMemoryStorage()
    const designCore = makeFakeDesignCore()
    const legacySnapshot = JSON.stringify({
      version: 3,
      drafts: [
        { id: 'draft-v9', name: 'Legacy Orchard', updatedAt: '2026-10-01T00:00:00.000Z' },
        { id: 'draft-refused', name: 'Refused Draft', updatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      draftFiles: {
        'draft-v9': { version: 9, name: 'Legacy Orchard', plants: [] },
        'draft-refused': { version: 99, name: 'Refused Draft', corrupt: true },
      },
    })
    storage.setItem(LEGACY_DRAFTS_KEY, legacySnapshot)

    const olderTabCopies: Array<{ legacyId: string; copyId: string; name: string }> = []
    const migrationFailures: unknown[] = []
    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      legacyStorage: storage,
      designCore,
      onOlderTabCopy: (c) => olderTabCopies.push(c),
      onMigrationFailed: (e) => migrationFailures.push(e),
    })

    expect(await store.open()).toEqual({ kind: 'ready' })
    expect(migrationFailures).toEqual([])
    // 2.1-M21: old localStorage key stays byte-identical!
    expect(storage.getItem(LEGACY_DRAFTS_KEY)).toBe(legacySnapshot)

    const meta = idb.dbs.get(DRAFT_DATABASE)!.stores.get(META_STORE)!.get(MOVE_RECORD_KEY) as DraftMoveMetaRecord
    expect(meta.state).toBe('live')
    expect([...meta.copiedIds].sort()).toEqual(['draft-refused', 'draft-v9'])

    // v9 migrated to canonical v10; refused Draft kept verbatim.
    const movedV9 = await store.read('draft-v9')
    expect(movedV9.kind).toBe('present')
    if (movedV9.kind === 'present') {
      expect((JSON.parse(dec.decode(new Uint8Array(movedV9.bytes))) as { version: number }).version).toBe(10)
    }
    const movedRefused = await store.read('draft-refused')
    expect(movedRefused.kind).toBe('present')

    // User edits draft-v9 in 2.1.
    expect(await store.write('draft-v9', v10Bytes('Edited in 2.1'), '1')).toEqual({ kind: 'written', version: '2' })

    // A 2.0 tab writes to localStorage after the move, rewriting BOTH drafts (only draft-v9 changed in 2.0).
    storage.setItem(LEGACY_DRAFTS_KEY, JSON.stringify({
      version: 3,
      drafts: [
        { id: 'draft-v9', name: 'Edited in 2.0 Tab', updatedAt: '2026-10-05T00:00:00.000Z' },
        { id: 'draft-refused', name: 'Refused Draft', updatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      draftFiles: {
        'draft-v9': { version: 9, name: 'Edited in 2.0 Tab', plants: [] },
        'draft-refused': { version: 99, name: 'Refused Draft', corrupt: true },
      },
    }))
    await store.syncLegacyStorage()

    // 2.1's edited record is untouched; exactly ONE older-tab copy created for draft-v9; draft-refused skipped.
    expect(olderTabCopies).toHaveLength(1)
    expect(olderTabCopies[0]?.legacyId).toBe('draft-v9')
    expect(DRAFT_ID_PATTERN.test(olderTabCopies[0]!.copyId)).toBe(true)

    const originalAfter = await store.read('draft-v9')
    expect(originalAfter.kind).toBe('present')
    if (originalAfter.kind === 'present') {
      expect((JSON.parse(dec.decode(new Uint8Array(originalAfter.bytes))) as { name: string }).name).toBe('Edited in 2.1')
    }
    const copyAfter = await store.read(olderTabCopies[0]!.copyId)
    expect(copyAfter.kind).toBe('present')
    if (copyAfter.kind === 'present') {
      expect((JSON.parse(dec.decode(new Uint8Array(copyAfter.bytes))) as { name: string }).name).toBe('Edited in 2.0 Tab')
    }

    // Re-syncing the same legacy snapshot is a no-op (no duplicate copy).
    await store.syncLegacyStorage()
    expect(olderTabCopies).toHaveLength(1)
    store.dispose()
  })

  it('canopi-f47t.52.50: move verification mismatch keeps state copied, reports failure, and retries on next open', async () => {
    const idb = new FaultableIndexedDb()
    idb.corruptReadBackId = 'draft-v9'
    const storage = makeMemoryStorage()
    storage.setItem(LEGACY_DRAFTS_KEY, JSON.stringify({
      version: 3,
      drafts: [{ id: 'draft-v9', name: 'Legacy', updatedAt: '2026-10-01T00:00:00.000Z' }],
      draftFiles: { 'draft-v9': { version: 9, name: 'Legacy', plants: [] } },
    }))
    const failures: unknown[] = []
    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      legacyStorage: storage,
      designCore: makeFakeDesignCore(),
      onMigrationFailed: (e) => failures.push(e),
    })

    await store.open()
    expect(failures).toHaveLength(1)
    const meta1 = idb.dbs.get(DRAFT_DATABASE)!.stores.get(META_STORE)!.get(MOVE_RECORD_KEY) as DraftMoveMetaRecord
    expect(meta1.state).toBe('copied')

    // Clear fault and re-open: verification succeeds and swaps live.
    idb.corruptReadBackId = null
    await store.syncLegacyStorage()
    const meta2 = idb.dbs.get(DRAFT_DATABASE)!.stores.get(META_STORE)!.get(MOVE_RECORD_KEY) as DraftMoveMetaRecord
    expect(meta2.state).toBe('live')
    store.dispose()
  })

  it('canopi-f47t.52.50: Q40 versionchange, blocked, draft_store_newer, pagehide/pageshow, and pending-write markers', async () => {
    const idb = new FaultableIndexedDb()
    idb.fireBlockedOnOpen = true
    const storage = makeMemoryStorage()
    const onVersionChange = vi.fn()
    const onBlocked = vi.fn()
    const sub = vi.fn()

    const store = createBrowserDesignHomeStore({
      factory: idb.factory(),
      legacyStorage: storage,
      onVersionChange,
      onBlocked,
    })
    const unsub = store.onVersionChange(sub)

    expect(await store.open()).toEqual({ kind: 'ready' })
    expect(onBlocked).toHaveBeenCalledOnce()

    // Pending-write marker set on dirty, cleared on committed write, and detected on reopen if uncommitted.
    store.markPending('draft-lost')
    store.markPending('draft-saved')
    expect(await store.write('draft-saved', v10Bytes('Saved'), null)).toEqual({ kind: 'written', version: '1' })
    // SF2: SessionCore clears the pending marker once all edits are acknowledged (rev === ackRev).
    store.clearPending('draft-saved')
    expect(store.takePendingMarkers()).toEqual(['draft-lost'])
    expect(store.takePendingMarkers()).toEqual([])

    // pagehide closes connection; pageshow(persisted) reopens transparently.
    store.closeForPageHide()
    expect(idb.connections.every((c) => c.closed)).toBe(true)
    await store.reopenAfterPageShow()
    expect(idb.connections.some((c) => !c.closed)).toBe(true)

    // Q40 versionchange closes connection immediately and notifies subscribers.
    idb.triggerVersionChange(5)
    expect(onVersionChange).toHaveBeenCalledOnce()
    expect(sub).toHaveBeenCalledOnce()
    expect(idb.connections.every((c) => c.closed)).toBe(true)
    unsub()
    store.dispose()

    // Newer database version (> 4) is refused with draft_store_newer and refuses writes.
    const newerIdb = new FaultableIndexedDb()
    newerIdb.seedDatabase(5)
    const onNewerStore = vi.fn()
    const olderBuild = createBrowserDesignHomeStore({ factory: newerIdb.factory(), onNewerStore })
    expect(await olderBuild.open()).toEqual({ kind: 'newer' })
    expect(onNewerStore).toHaveBeenCalledOnce()
    expect((await olderBuild.write('draft-x', v10Bytes('Blocked'), null)).kind).toBe('failed')
    expect(await olderBuild.read('draft-x')).toEqual({ kind: 'unreadable', reason: 'draft_store_newer' })
    olderBuild.dispose()

    // Unavailable IndexedDB returns storage_unavailable cleanly.
    const noIdb = createBrowserDesignHomeStore({ factory: undefined })
    expect(await noIdb.open()).toEqual({ kind: 'unavailable', reason: 'storage_unavailable' })
    expect(await noIdb.read('draft-x')).toEqual({ kind: 'unreadable', reason: 'storage_unavailable' })
    expect(await noIdb.listDrafts()).toEqual([])
    expect((await noIdb.write('draft-x', v10Bytes('NoIdb'), null)).kind).toBe('failed')
    expect((await noIdb.deleteDraft('draft-x' as DraftId)).ok).toBe(false)
    noIdb.dispose()
  })

  it('canopi-f47t.52.50: covers malformed bytes, invalid legacy envelopes, quota errors, and pending-write edge cases', async () => {
    const idb = new FaultableIndexedDb()
    const storage = makeMemoryStorage()
    storage.setItem(LEGACY_DRAFTS_KEY, '{not-json')
    const store = createBrowserDesignHomeStore({ factory: idb.factory(), legacyStorage: storage })
    expect(await store.open()).toEqual({ kind: 'ready' })

    // Invalid write payloads (non-JSON, non-record, missing name, version < 10) fail cleanly.
    expect((await store.write('d1', enc.encode('{bad'), null)).kind).toBe('failed')
    expect((await store.write('d1', enc.encode('[]'), null)).kind).toBe('failed')
    expect((await store.write('d1', enc.encode('{"version":10}'), null)).kind).toBe('failed')
    expect((await store.write('d1', enc.encode('{"version":9,"name":"Old"}'), null)).kind).toBe('failed')
    // Valid v10 without updated_at uses fallback timestamp; second create with null version returns conflict.
    expect(await store.write('d1', enc.encode('{"version":10,"name":"NoTime"}'), null)).toEqual({ kind: 'written', version: '1' })
    const createConflict = await store.write('d1', v10Bytes('Dup'), null)
    expect(createConflict.kind).toBe('conflict')
    // Non-existent read and delete.
    expect(await store.read('missing')).toEqual({ kind: 'absent' })
    expect(await store.deleteDraft('missing' as DraftId)).toEqual({ ok: true })
    // Firefox quota error name maps to quota failure.
    idb.failNextWrite = new DOMException('Quota', 'NS_ERROR_DOM_QUOTA_REACHED')
    expect((await store.write('d1', v10Bytes('Big'), '1')).kind).toBe('quota_refused')

    // Legacy envelope with non-object draftFiles, corrupt pending index, and empty id ignored.
    storage.setItem(LEGACY_DRAFTS_KEY, JSON.stringify({ version: 3, drafts: [null, { id: '' }], draftFiles: { '': {} } }))
    await store.syncLegacyStorage()
    storage.setItem('canopi:web-drafts:pending-ids', '{corrupt')
    expect(store.takePendingMarkers()).toEqual([])
    store.markPending(''); store.clearPending(''); store.markPending('a'); store.markPending('a'); store.markPending('b'); store.clearPending('a')
    expect(store.takePendingMarkers()).toEqual(['b'])
    store.dispose()
  })

  it('canopi-f47t.52.50: covers second older-tab update, pre-held IDB record during move, FNV fallback hash, and designCore errors', async () => {
    const idb = new FaultableIndexedDb()
    idb.seedDatabase(4, [{
      id: 'already-in-idb', canopi_version: '2.1.0', version: 2, name: 'Kept', updated_at: '2026-12-01T00:00:00.000Z',
      content: JSON.stringify({ version: 10, name: 'Kept', plants: [], zones: [] }),
    }])
    const storage = makeMemoryStorage()
    storage.setItem(LEGACY_DRAFTS_KEY, JSON.stringify({
      version: 3,
      drafts: [{ id: '!!!', name: 123, updatedAt: null }, { id: 'already-in-idb', name: 'Old', updatedAt: '' }],
      draftFiles: {
        '!!!': { version: 9, name: 'SymbolId', updated_at: '2026-10-01T00:00:00.000Z', plants: [] },
        'already-in-idb': { version: 9, name: 'Old', plants: [] },
        'throws-decode': { version: 9, name: 'ThrowDecode', throwDecode: true },
        'err-encode': { version: 9, name: 'ErrEncode', failEncode: true },
      },
    }))
    const flakyCore: Pick<DesignCore, 'decode' | 'encode'> = {
      async decode(bytes) {
        const parsed = JSON.parse(dec.decode(bytes)) as Record<string, unknown>
        if (parsed.throwDecode) throw new Error('boom')
        return { ok: { design: { ...parsed, version: 10 } as never, migrated_from: 9 } }
      },
      async encode(design) {
        if ((design as Record<string, unknown>).failEncode) return { err: { kind: 'invalid_document', message: 'encode err', field_path: '$' } }
        return { ok: enc.encode(JSON.stringify(design)) }
      },
    }
    const origCrypto = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
    try {
      const copies: Array<{ legacyId: string; copyId: string; name: string }> = []
      const store = createBrowserDesignHomeStore({ factory: idb.factory(), legacyStorage: storage, designCore: flakyCore, onOlderTabCopy: (c) => copies.push(c) })
      expect(await store.open()).toEqual({ kind: 'ready' })
      expect(await store.read('already-in-idb')).toMatchObject({ kind: 'present', version: '2' })
      const makeLegacy = (label: string) => JSON.stringify({ version: 3, drafts: [], draftFiles: { '!!!': { version: 9, name: label, plants: [] } } })
      storage.setItem(LEGACY_DRAFTS_KEY, makeLegacy('FirstOlderEdit'))
      await store.syncLegacyStorage()
      storage.setItem(LEGACY_DRAFTS_KEY, makeLegacy('SecondOlderEdit'))
      await store.syncLegacyStorage()
      await store.syncLegacyStorage()
      expect(copies).toHaveLength(2)
      expect(copies[0]!.copyId).toBe('older-tab-draft')
      expect(await store.read('older-tab-draft')).toMatchObject({ kind: 'present', version: '2' })
      store.dispose()
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: origCrypto, configurable: true })
    }
  })
})
