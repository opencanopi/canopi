/**
 * platform/draft-records.browser.ts: Owner of raw `indexedDB` (indexeddb-only-in-adapters, ADR 0026) and of the
 * read half of 2.1's Web Draft store, at its target owner (Step 2.0.4 R3, canopi-f47t.52.272; contracts §11 "Web
 * Drafts move to IndexedDB"; design check F7, F8, A18, A19; 2.1-Q40, Q321, Q322, M486), over the frozen form
 * spec/web/frozen/drafts.json. Invariant: it exposes no put or delete, opens only
 * `readonly` transactions, creates no database and holds no connection between reads.
 *
 * - Existence: `indexedDB.databases()` where the engine has it (it creates nothing; Chromium on disk lists 2.1's
 *   database while its first upgrade runs, the others once it commits); then, and always where it is missing, an
 *   open without a version, which waits for that upgrade and whose own upgrade is aborted at oldVersion 0, so an
 *   origin without the store keeps no store (WebKitGTK still lists the name at version 0, read as absent;
 *   e2e/canvas/indexeddb-reader-probe.spec.ts).
 * - Open, read, close: each read opens its own connection and closes it once its transaction ends. A `versionchange`
 *   while it is open (2.1's upgrade, or a delete with no new version) closes it at once, so 2.1 is never blocked, and
 *   tells the page, which offers the one Reload notice (2.1-Q40).
 * - Bounded: a read waits at most `timeoutMs` (an open can queue behind another page's upgrade); a connection that opens
 *   later is closed once its read ends.
 * - Complete or not: a listing says whether it read the store. One that fails or runs late is reported and settles on
 *   the last good listing, empty only before one, marked incomplete (design check A18), so a re-list never unhides an
 *   old-key Draft the session already hides, and the session restores, opens or deletes no old-key Draft until one
 *   listing completed (2.1-Q322, F7). An origin without the store lists complete and empty. A Draft read that fails
 *   or runs late is reported and gives null, so its open fails visibly and re-lists like a deleted one; one a
 *   version change closed gives `closed` unreported, as the Reload notice alone tells the user (2.1-Q337).
 * A listing loads each record whole (`getAll`) but keeps only its list fields; a Design is decoded only when it is
 * opened, by the format core (DR10).
 */

import type { BrowserStorage } from './browser-record'
import type { DesignCore } from './design-core'
import type { DeleteDraftResult, DesignHomeWriteResult, DraftId, DraftRecord, HomeRead, HomeVersion } from './design-home'
import { clearPendingWrite, DEFAULT_STALE_PENDING_MS, markPendingWrite, takePendingWrites } from './draft-pending-markers'
import {
  isPlainRecord, isQuotaDomError, LEGACY_DRAFTS_KEY, parseDraftWriteBytes, parseLegacyDraftsEnvelope,
  prepareLegacyDrafts, readIdbRequests, readMoveMetaRecord, runInitialLegacyMove, runOlderTabLegacyCopy,
  sha256Hex, type StoredDraftRecord,
} from './draft-records-move'
import { requireStoreFloor, runStoreChain } from './store-chain'

/** The 2.1 Draft store's database (spec/web/frozen/drafts.json, at version 4: 2.1-M486). */
const DRAFT_DATABASE = 'canopi-drafts'
/** The object store of Draft records, keyed by `id`. */
const DRAFTS_STORE = 'drafts'
/** The object store keyed by `key` that holds the move record. */
const META_STORE = 'meta'
/** The move record's key; its `copiedIds` name the old-key Drafts the 2.1 move copied (2.1-Q322, M157). */
const MOVE_RECORD_KEY = 'move'

/** What the store needs of `indexedDB`: `open`. */
type DraftStoreFactory = Pick<IDBFactory, 'open'> & { readonly databases?: () => Promise<readonly IDBDatabaseInfo[]> }

export type DraftStoreOpenOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'newer' }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface DraftRecordsStoreOptions {
  /** Injected IDBFactory for the fault suite (Q47); defaults to `globalThis.indexedDB`. */
  readonly factory?: DraftStoreFactory | undefined
  /** Injected BrowserStorage for reading the 2.0 v3 key and pending-write markers (never touches raw localStorage here). */
  readonly legacyStorage?: BrowserStorage | undefined
  /** Format core used to canonicalise and verify 2.0 Drafts during the staged move. */
  readonly designCore?: Pick<DesignCore, 'decode' | 'encode'> | undefined
  /** App version stamped into each written record's `canopi_version`. */
  readonly appVersion?: string
  readonly now?: () => Date
  /** Q40: another tab upgraded or deleted `canopi-drafts` while this connection was open. */
  readonly onVersionChange?: () => void
  /** Upgrade is blocked by another open Canopi tab (`draft_store_blocked`). */
  readonly onBlocked?: () => void
  /** Database version is newer than this build supports (`draft_store_newer`). */
  readonly onNewerStore?: () => void
  /** A 2.0 tab wrote after the move; reported once per created/updated older-tab copy. */
  readonly onOlderTabCopy?: (copy: { readonly legacyId: string; readonly copyId: string; readonly name: string }) => void
  /** Staged move verification failed; reported and retried on next open. */
  readonly onMigrationFailed?: (error: unknown) => void
  /** Per-tab owner id for pending-write markers (minted per page load in memory). */
  readonly tabId?: string
  /** Age in ms after which another tab's pending-write marker is treated as stale/crashed. */
  readonly stalePendingMs?: number
  /** Heartbeat interval in ms while this tab has active pending-write markers (defaults to stalePendingMs / 3). */
  readonly heartbeatMs?: number
  /** Bound in ms for `open()` so a blocked upgrade does not stall launch indefinitely. */
  readonly openTimeoutMs?: number
}

export interface DraftRecordsStore {
  open(): Promise<DraftStoreOpenOutcome>
  read(id: string): Promise<HomeRead>
  write(id: string, bytes: Uint8Array, expected: HomeVersion | null): Promise<DesignHomeWriteResult>
  list(): Promise<readonly DraftRecord[]>
  delete(id: DraftId): Promise<DeleteDraftResult>
  syncLegacyStorage(): Promise<void>
  markPending(id: string): void
  clearPending(id: string): void
  takePendingMarkers(reloadTabId?: string | null): readonly string[]
  closeForPageHide(): void
  reopenAfterPageShow(): Promise<void>
  onVersionChange(cb: () => void): () => void
  dispose(): void
}

const utf8Encoder = new TextEncoder()

function writeFailure(op: string, retryable: boolean, kind: 'io' | 'invalid' = 'io'): {
  readonly code: { readonly kind: 'io'; readonly io: 'other' } | { readonly kind: 'invalid' }
  readonly user_may_retry: boolean
  readonly op: string
  readonly operation: null
  readonly detail: null
} {
  return {
    code: kind === 'invalid' ? { kind: 'invalid' } : { kind: 'io', io: 'other' },
    user_may_retry: retryable,
    op,
    operation: null,
    detail: null,
  }
}

const DEFAULT_OPEN_TIMEOUT_MS = 5000
let fallbackTabCounter = 0

export function createDraftRecordsStore(options: DraftRecordsStoreOptions = {}): DraftRecordsStore {
  const factory = 'factory' in options ? options.factory : (globalThis.indexedDB as DraftStoreFactory | undefined)
  const appVersion = options.appVersion ?? '2.1.0'
  const now = options.now ?? (() => new Date())
  const tabId = options.tabId ?? `tab-${++fallbackTabCounter}`
  const stalePendingMs = options.stalePendingMs ?? DEFAULT_STALE_PENDING_MS
  const heartbeatMs = options.heartbeatMs ?? Math.max(1000, Math.floor(stalePendingMs / 3))
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
  const floor = requireStoreFloor('web_drafts')
  const versionListeners = new Set<() => void>()
  const activePendingIds = new Set<string>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  const stopPendingHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const syncPendingHeartbeat = (): void => {
    if (disposed || pageHidden || activePendingIds.size === 0 || !options.legacyStorage) {
      stopPendingHeartbeat()
      return
    }
    if (heartbeatTimer !== null) return
    heartbeatTimer = setInterval(() => {
      if (disposed || pageHidden || activePendingIds.size === 0) {
        stopPendingHeartbeat()
        return
      }
      const ts = now().getTime()
      for (const id of activePendingIds) markPendingWrite(options.legacyStorage, tabId, id, ts)
    }, heartbeatMs)
  }

  let db: IDBDatabase | null = null
  let opening: Promise<IDBDatabase | null> | null = null
  let storeState: 'closed' | 'ready' | 'newer' | 'unavailable' = 'closed'
  let pageHidden = false
  let syncInFlight: Promise<void> | null = null
  let syncQueued = false
  let disposed = false

  const notifyVersionChange = (): void => {
    options.onVersionChange?.()
    for (const cb of versionListeners) cb()
  }

  const closeConnection = (): void => {
    if (!db) return
    const active = db
    db = null
    active.onversionchange = null
    try { active.close() } catch { /* Connection may already be closed by the engine. */ }
  }

  const openDb = async (): Promise<IDBDatabase | null> => {
    if (disposed || pageHidden || storeState === 'newer') return null
    if (db) return db
    if (opening) return opening
    if (!factory) {
      storeState = 'unavailable'
      return null
    }
    opening = new Promise<IDBDatabase | null>((resolve) => {
      let settled = false
      let request: IDBOpenDBRequest
      try {
        request = factory.open(DRAFT_DATABASE, floor.current)
      } catch {
        // SecurityError or restricted storage environment: report store unavailable.
        storeState = 'unavailable'
        resolve(null)
        return
      }
      const timer = setTimeout(() => {
        if (settled) return
        storeState = 'unavailable'
        finish(null)
      }, openTimeoutMs)
      const finish = (value: IDBDatabase | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      request.onblocked = () => { options.onBlocked?.() }
      request.onupgradeneeded = (event) => {
        const upgradeDb = request.result
        const oldVersion = event.oldVersion === 0 ? null : event.oldVersion
        const chain = runStoreChain(floor, oldVersion, upgradeDb, [])
        if (chain.kind === 'absent') {
          if (!upgradeDb.objectStoreNames.contains(DRAFTS_STORE)) {
            upgradeDb.createObjectStore(DRAFTS_STORE, { keyPath: 'id' })
          }
          if (!upgradeDb.objectStoreNames.contains(META_STORE)) {
            upgradeDb.createObjectStore(META_STORE, { keyPath: 'key' })
          }
          return
        }
        if (chain.kind === 'before_floor' || chain.kind === 'refused_newer') {
          request.transaction?.abort()
        }
      }
      request.onerror = (event) => {
        event.preventDefault()
        if (request.error?.name === 'VersionError') {
          storeState = 'newer'
          options.onNewerStore?.()
        } else {
          storeState = 'unavailable'
        }
        finish(null)
      }
      request.onsuccess = () => {
        const opened = request.result
        if (disposed || pageHidden || settled) {
          opened.close()
          finish(null)
          return
        }
        opened.onversionchange = () => {
          closeConnection()
          notifyVersionChange()
        }
        db = opened
        storeState = 'ready'
        finish(opened)
      }
    }).finally(() => { opening = null })
    return opening
  }

  const moveStores = { draftsStore: DRAFTS_STORE, metaStore: META_STORE, moveKey: MOVE_RECORD_KEY } as const

  const runSyncLegacyAttempt = async (): Promise<'done' | 'retry'> => {
    const raw = options.legacyStorage?.getItem(LEGACY_DRAFTS_KEY)
    if (!raw) return 'done'
    const conn = await openDb()
    if (!conn) return 'done'
    const sourceHash = await sha256Hex(raw)
    const existingMove = await readMoveMetaRecord(conn, moveStores)
    if (existingMove?.state === 'live' && existingMove.sourceHash === sourceHash) return 'done'
    const entries = parseLegacyDraftsEnvelope(raw)
    if (entries.length === 0) return 'done'
    const prepared = await prepareLegacyDrafts(entries, options.designCore, now().toISOString())
    if (existingMove?.state === 'live') {
      const committed = await runOlderTabLegacyCopy({
        conn, stores: moveStores, prepared, sourceHash, expectedRev: existingMove.rev, appVersion, onOlderTabCopy: options.onOlderTabCopy,
      })
      return committed ? 'done' : 'retry'
    }
    const swapped = await runInitialLegacyMove({
      conn, stores: moveStores, prepared, sourceHash, appVersion,
      legacyStorage: options.legacyStorage, designCore: options.designCore,
      onOlderTabCopy: options.onOlderTabCopy, onMigrationFailed: options.onMigrationFailed,
    })
    if (swapped) return 'done'
    const after = await readMoveMetaRecord(conn, moveStores)
    return after?.state === 'live' ? 'retry' : 'done'
  }

  const runSyncLegacyOnce = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if ((await runSyncLegacyAttempt()) === 'done') return
      } catch (error) {
        options.onMigrationFailed?.(error)
        return
      }
    }
  }

  const syncLegacyStorage = async (): Promise<void> => {
    if (syncInFlight) {
      syncQueued = true
      await syncInFlight
      return
    }
    syncInFlight = (async () => {
      do {
        syncQueued = false
        await runSyncLegacyOnce()
      } while (syncQueued && !disposed)
    })().finally(() => { syncInFlight = null })
    await syncInFlight
  }

  return {
    async open(): Promise<DraftStoreOpenOutcome> {
      const conn = await openDb()
      if (storeState === 'newer') return { kind: 'newer' }
      if (!conn) return { kind: 'unavailable', reason: 'storage_unavailable' }
      await syncLegacyStorage()
      return { kind: 'ready' }
    },
    async read(id: string): Promise<HomeRead> {
      const conn = await openDb()
      if (!conn) return { kind: 'unreadable', reason: storeState === 'newer' ? 'draft_store_newer' : 'storage_unavailable' }
      try {
        const tx = conn.transaction(DRAFTS_STORE, 'readonly')
        const [raw] = await readIdbRequests(tx, [tx.objectStore(DRAFTS_STORE).get(id)], DRAFT_DATABASE)
        if (raw === undefined) return { kind: 'absent' }
        if (!isPlainRecord(raw) || typeof raw.content !== 'string' || typeof raw.version !== 'number') {
          return { kind: 'unreadable', reason: 'draft_unreadable' }
        }
        return { kind: 'present', bytes: Array.from(utf8Encoder.encode(raw.content)), version: String(raw.version) }
      } catch {
        // Unreadable or aborted IndexedDB read transaction maps to draft_unreadable.
        return { kind: 'unreadable', reason: 'draft_unreadable' }
      }
    },
    async write(id: string, bytes: Uint8Array, expected: HomeVersion | null): Promise<DesignHomeWriteResult> {
      if (storeState === 'newer') {
        return { kind: 'failed', failure: writeFailure('web.draft.write', false) }
      }
      const parsed = parseDraftWriteBytes(bytes, now().toISOString())
      if (!parsed.ok || id.length === 0) {
        return { kind: 'failed', failure: writeFailure('web.draft.write', false, 'invalid') }
      }
      const conn = await openDb()
      if (!conn) {
        const retryable = (storeState as string) !== 'newer'
        return { kind: 'failed', failure: writeFailure('web.draft.write', retryable) }
      }
      try {
        const outcome = await new Promise<DesignHomeWriteResult>((resolve, reject) => {
          const tx = conn.transaction(DRAFTS_STORE, 'readwrite')
          const store = tx.objectStore(DRAFTS_STORE)
          let result: DesignHomeWriteResult | null = null
          const getReq = store.get(id)
          getReq.onsuccess = () => {
            const existing = isPlainRecord(getReq.result) && typeof getReq.result.version === 'number'
              ? (getReq.result as unknown as StoredDraftRecord)
              : null
            if (existing && expected !== String(existing.version)) {
              result = { kind: 'conflict', current: String(existing.version) }
              return
            }
            const nextVersion = existing ? existing.version + 1 : 1
            const nextRecord: StoredDraftRecord = {
              id,
              canopi_version: appVersion,
              version: nextVersion,
              name: parsed.name,
              updated_at: parsed.updatedAt,
              content: parsed.content,
            }
            store.put(nextRecord)
            result = { kind: 'written', version: String(nextVersion) }
          }
          tx.oncomplete = () => resolve(result ?? { kind: 'failed', failure: writeFailure('web.draft.write', true) })
          tx.onerror = () => reject(tx.error ?? new Error('Draft write failed'))
          tx.onabort = () => reject(tx.error ?? new Error('Draft write aborted'))
        })
        return outcome
      } catch (error) {
        if (isQuotaDomError(error)) return { kind: 'quota_refused' }
        return { kind: 'failed', failure: writeFailure('web.draft.write', true) }
      }
    },
    async list(): Promise<readonly DraftRecord[]> {
      const conn = await openDb()
      if (!conn) return []
      const tx = conn.transaction(DRAFTS_STORE, 'readonly')
      const [rows] = await readIdbRequests(tx, [tx.objectStore(DRAFTS_STORE).getAll()], DRAFT_DATABASE)
      const records: DraftRecord[] = []
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!isPlainRecord(row) || typeof row.id !== 'string' || row.id.length === 0) continue
        const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : ''
        const bytes = typeof row.content === 'string' ? utf8Encoder.encode(row.content) : null
        records.push({
          id: row.id as DraftId,
          updatedAt,
          bytes,
          ...(bytes === null ? { unreadableReason: 'draft_unreadable' } : {}),
        })
      }
      records.sort((a, b) => (
        a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.updatedAt < b.updatedAt ? 1 : -1
      ))
      return records
    },
    async delete(id: DraftId): Promise<DeleteDraftResult> {
      if (storeState === 'newer') return { ok: false, failure: writeFailure('web.draft.delete', false) }
      const conn = await openDb()
      if (!conn) return { ok: false, failure: writeFailure('web.draft.delete', true) }
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = conn.transaction(DRAFTS_STORE, 'readwrite')
          tx.objectStore(DRAFTS_STORE).delete(id)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error ?? new Error('Draft delete failed'))
          tx.onabort = () => reject(tx.error ?? new Error('Draft delete aborted'))
        })
        activePendingIds.delete(id)
        syncPendingHeartbeat()
        clearPendingWrite(options.legacyStorage, tabId, id, now().getTime())
        return { ok: true }
      } catch {
        // Failed or aborted IndexedDB delete transaction maps to retryable I/O failure.
        return { ok: false, failure: writeFailure('web.draft.delete', true) }
      }
    },
    syncLegacyStorage,
    markPending: (id: string) => {
      activePendingIds.add(id)
      markPendingWrite(options.legacyStorage, tabId, id, now().getTime())
      syncPendingHeartbeat()
    },
    clearPending: (id: string) => {
      activePendingIds.delete(id)
      clearPendingWrite(options.legacyStorage, tabId, id, now().getTime())
      syncPendingHeartbeat()
    },
    takePendingMarkers: (reloadTabId?: string | null) =>
      takePendingWrites(options.legacyStorage, tabId, now().getTime(), stalePendingMs, reloadTabId),
    closeForPageHide: () => {
      pageHidden = true
      stopPendingHeartbeat()
      closeConnection()
    },
    async reopenAfterPageShow(): Promise<void> {
      pageHidden = false
      syncPendingHeartbeat()
      const conn = await openDb()
      if (conn) await syncLegacyStorage()
    },
    onVersionChange(cb: () => void): () => void {
      versionListeners.add(cb)
      return () => { versionListeners.delete(cb) }
    },
    dispose(): void {
      disposed = true
      activePendingIds.clear()
      stopPendingHeartbeat()
      versionListeners.clear()
      closeConnection()
    },
  }
}
