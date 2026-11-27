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
/** How long one read waits before the launch goes on without it (design check A18). */
const DRAFT_READ_TIMEOUT_MS = 3000

/** A 2.1 Draft as the list shows it: its record fields, never its Design. */
interface DraftRecordSummary {
  readonly id: string
  readonly name: string
  /** An ISO 8601 instant; empty when the record holds none. */
  readonly updatedAt: string
}

interface DraftStoreListing {
  /** The 2.1 Drafts whose record fields read, newest first. */
  readonly drafts: readonly DraftRecordSummary[]
  /**
   * The ids the 2.0 Drafts key hides from its list, restore and last-updated read: the move's `copiedIds` and every id
   * the store holds, so an old-key Draft is never shown, opened or deleted under an id 2.1 keeps.
   */
  readonly hiddenIds: readonly string[]
  /** False when this read failed or ran late, and the Drafts and ids are the last good listing's (empty before one). */
  readonly complete: boolean
}

/** @testonly The 2.0.5 reader-release read half; by its type it offers no write (cross-release tests). */
export interface DraftRecordsReaderTestFixture {
  /** The 2.1 Drafts and the ids they hide; never rejects: a failed or late read is reported and gives the last good listing, incomplete. */
  list(): Promise<DraftStoreListing>
  /**
   * The Design of one 2.1 Draft as 2.1 saved it (`.canopi` text); never rejects: null when the store no longer holds
   * it, or when the read fails or runs late, which is reported; `closed` when a version change closed it first.
   */
  content(id: string): Promise<string | null | 'closed'>
}

/** What the reader needs of `indexedDB`: `open` without a version, and `databases()` where the engine has it. */
type DraftStoreFactory = Pick<IDBFactory, 'open'> & { readonly databases?: () => Promise<readonly IDBDatabaseInfo[]> }

interface DraftRecordsReaderOptions {
  /** The page's `indexedDB` by default; undefined where the engine offers none (then the store is absent). */
  readonly factory?: DraftStoreFactory | undefined
  /** A version change reached an open connection, which is already closed. */
  readonly onVersionChange: () => void
  /** A listing that failed or ran late. */
  readonly report: (error: unknown) => void
  readonly timeoutMs?: number
}

const NO_DRAFTS: DraftStoreListing = { drafts: [], hiddenIds: [], complete: true }

/** @testonly Creates the 2.0.5 reader-release IndexedDB reader (used by cross-release compatibility tests). */
export function createDraftRecordsReaderForTests({
  factory = globalThis.indexedDB,
  onVersionChange,
  report,
  timeoutMs = DRAFT_READ_TIMEOUT_MS,
}: DraftRecordsReaderOptions): DraftRecordsReaderTestFixture {
  let lastListing = NO_DRAFTS
  /**
   * Runs `read` on an open connection to an existing store, then closes it; `absent` when there is none. `seen.closed`
   * turns true once a version change closed the connection.
   */
  async function withStore<T>(read: (db: IDBDatabase) => Promise<T>, absent: T, seen = { closed: false }): Promise<T> {
    if (!factory || await listedAbsent(factory)) return absent
    const db = await openExisting(factory)
    if (!db) return absent
    db.onversionchange = () => {
      seen.closed = true
      db.close()
      onVersionChange()
    }
    try {
      return db.objectStoreNames.contains(DRAFTS_STORE) ? await read(db) : absent
    } finally {
      db.close()
    }
  }

  return {
    async list() {
      try {
        lastListing = await bounded(withStore(readListing, NO_DRAFTS), timeoutMs)
        return lastListing
      } catch (error) {
        report(error)
        return { ...lastListing, complete: false }
      }
    },
    async content(id) {
      const seen = { closed: false }
      try {
        return await bounded(withStore(async (db) => {
          const tx = db.transaction(DRAFTS_STORE, 'readonly')
          const [record] = await readIdbRequests(tx, [tx.objectStore(DRAFTS_STORE).get(id)], DRAFT_DATABASE)
          return isPlainRecord(record) && typeof record.content === 'string' ? record.content : null
        }, null, seen), timeoutMs)
      } catch (error) {
        // A version change closed it: the page offers Reload, which is all the user needs to hear (2.1-Q40, Q337).
        if (seen.closed) return 'closed'
        // The open then says it could not open the Draft and the rows re-list, as for one 2.1 deleted (design check).
        report(error)
        return null
      }
    },
  }
}

/** True when `databases()` answers without the store; false where it lists it or the engine has none. */
async function listedAbsent(factory: DraftStoreFactory): Promise<boolean> {
  if (typeof factory.databases !== 'function') return false
  const infos = await factory.databases()
  return !infos.some((info) => info.name === DRAFT_DATABASE)
}

/** Opens the store without a version; null, and nothing created, when the open had to upgrade from version 0. */
function openExisting(factory: DraftStoreFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DRAFT_DATABASE)
    let aborted = false
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) return
      aborted = true
      request.transaction?.abort()
    }
    request.onerror = (event) => {
      event.preventDefault()
      if (aborted) resolve(null)
      else reject(request.error ?? new Error(`Opening ${DRAFT_DATABASE} failed`))
    }
    request.onsuccess = () => resolve(request.result)
  })
}

async function readListing(db: IDBDatabase): Promise<DraftStoreListing> {
  const withMeta = db.objectStoreNames.contains(META_STORE)
  const tx = db.transaction(withMeta ? [DRAFTS_STORE, META_STORE] : [DRAFTS_STORE], 'readonly')
  const [records, move] = await readIdbRequests(tx, [
    tx.objectStore(DRAFTS_STORE).getAll(),
    ...(withMeta ? [tx.objectStore(META_STORE).get(MOVE_RECORD_KEY)] : []),
  ], DRAFT_DATABASE)
  const all = Array.isArray(records) ? records : []
  const drafts = all.map(summaryOf).filter((draft): draft is DraftRecordSummary => draft !== null)
  drafts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  const held = drafts.map((draft) => draft.id)
  const copied = isPlainRecord(move) && Array.isArray(move.copiedIds)
    ? move.copiedIds.filter((id): id is string => typeof id === 'string')
    : []
  return { drafts, hiddenIds: [...new Set([...copied, ...held])], complete: true }
}

/** A record's list fields; null when it names no id (it is still hidden by id when it has one). */
function summaryOf(record: unknown): DraftRecordSummary | null {
  if (!isPlainRecord(record) || typeof record.id !== 'string' || record.id === '') return null
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : '',
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : '',
  }
}

/** `read`, or a rejection once `ms` pass; the read itself runs on and closes its connection when it ends. */
function bounded<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Reading ${DRAFT_DATABASE} took longer than ${ms} ms`)), ms)
  })
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}

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
  /** Per-tab owner id for pending-write markers (survives reload when sourced from sessionStorage). */
  readonly tabId?: string
  /** Age in ms after which another tab's pending-write marker is treated as stale/crashed. */
  readonly stalePendingMs?: number
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
  takePendingMarkers(): readonly string[]
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
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
  const floor = requireStoreFloor('web_drafts')
  const versionListeners = new Set<() => void>()

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

  const runSyncLegacyOnce = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = options.legacyStorage?.getItem(LEGACY_DRAFTS_KEY)
      if (!raw) return
      const conn = await openDb()
      if (!conn) return
      const sourceHash = await sha256Hex(raw)
      const existingMove = await readMoveMetaRecord(conn, moveStores)
      if (existingMove?.state === 'live' && existingMove.sourceHash === sourceHash) return
      const entries = parseLegacyDraftsEnvelope(raw)
      if (entries.length === 0) return
      const prepared = await prepareLegacyDrafts(entries, options.designCore, now().toISOString())
      try {
        if (existingMove?.state === 'live') {
          const committed = await runOlderTabLegacyCopy({
            conn, stores: moveStores, prepared, sourceHash, expectedRev: existingMove.rev, appVersion, onOlderTabCopy: options.onOlderTabCopy,
          })
          if (committed) return
        } else {
          const swapped = await runInitialLegacyMove({
            conn, stores: moveStores, prepared, sourceHash, appVersion,
            legacyStorage: options.legacyStorage, designCore: options.designCore, onMigrationFailed: options.onMigrationFailed,
          })
          if (swapped) return
          const after = await readMoveMetaRecord(conn, moveStores)
          if (after?.state !== 'live') return
        }
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
        clearPendingWrite(options.legacyStorage, tabId, id, now().getTime())
        return { ok: true }
      } catch {
        // Failed or aborted IndexedDB delete transaction maps to retryable I/O failure.
        return { ok: false, failure: writeFailure('web.draft.delete', true) }
      }
    },
    syncLegacyStorage,
    markPending: (id: string) => markPendingWrite(options.legacyStorage, tabId, id, now().getTime()),
    clearPending: (id: string) => clearPendingWrite(options.legacyStorage, tabId, id, now().getTime()),
    takePendingMarkers: () => takePendingWrites(options.legacyStorage, tabId, now().getTime(), stalePendingMs),
    closeForPageHide: () => {
      pageHidden = true
      closeConnection()
    },
    async reopenAfterPageShow(): Promise<void> {
      pageHidden = false
      await openDb()
    },
    onVersionChange(cb: () => void): () => void {
      versionListeners.add(cb)
      return () => { versionListeners.delete(cb) }
    },
    dispose(): void {
      disposed = true
      versionListeners.clear()
      closeConnection()
    },
  }
}
