/**
 * platform/draft-records.browser.ts: the read half of 2.1's Web Draft store, at its target owner (Step 2.0.4 R3,
 * canopi-f47t.52.272; contracts §11 "Web Drafts move to IndexedDB"; design check F7, F8, A18, A19; 2.1-Q40, Q321,
 * Q322, M486), over the frozen form spec/web/frozen/drafts.json. Invariant: it exposes no put or delete, opens only
 * `readonly` transactions, creates no database and holds no connection between reads.
 *
 * - Existence: `indexedDB.databases()` where the engine has it (it creates nothing, and lists 2.1's database only once
 *   its first upgrade commits); then, and always where it is missing, an open without a version whose upgrade is
 *   aborted at oldVersion 0, so an origin without the store keeps none (e2e/canvas/indexeddb-reader-probe.spec.ts).
 * - Open, read, close: each read opens its own connection and closes it once its transaction ends. A `versionchange`
 *   while it is open (2.1's upgrade, or a delete with no new version) closes it at once, so 2.1 is never blocked, and
 *   tells the page, which offers the one Reload notice (2.1-Q40).
 * - Bounded: a read waits at most `timeoutMs` (an open can queue behind another page's upgrade); a connection that opens
 *   later is closed once its read ends.
 * - A listing that fails or runs late is reported and settles on the last good listing, empty only before one (design
 *   check A18), so a re-list never unhides an old-key Draft the session already hides (2.1-Q322, F7). A Draft read
 *   that fails or runs late is reported and gives null, so its open fails visibly and re-lists like a deleted one.
 * Listing reads record fields only; a Design is decoded only when it is opened, by the format core (DR10).
 */

/** The 2.1 Draft store's database (spec/web/frozen/drafts.json, at version 4: 2.1-M486). The reader opens it without
 * a version, so it names none; 2b's writer exports the frozen names it needs. */
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
}

/** The read half; by its type it offers no write. */
export interface DraftRecordsReader {
  /** The 2.1 Drafts and the ids they hide; never rejects: a failed or late read is reported and gives the last good listing. */
  list(): Promise<DraftStoreListing>
  /**
   * The Design of one 2.1 Draft as 2.1 saved it (`.canopi` text); never rejects: null when the store no longer holds
   * it, or when the read fails or runs late, which is reported.
   */
  content(id: string): Promise<string | null>
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

const NO_DRAFTS: DraftStoreListing = { drafts: [], hiddenIds: [] }

export function createDraftRecordsReader({
  factory = globalThis.indexedDB,
  onVersionChange,
  report,
  timeoutMs = DRAFT_READ_TIMEOUT_MS,
}: DraftRecordsReaderOptions): DraftRecordsReader {
  let lastListing = NO_DRAFTS
  /** Runs `read` on an open connection to an existing store, then closes it; `absent` when there is none. */
  async function withStore<T>(read: (db: IDBDatabase) => Promise<T>, absent: T): Promise<T> {
    if (!factory || await listedAbsent(factory)) return absent
    const db = await openExisting(factory)
    if (!db) return absent
    db.onversionchange = () => {
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
      } catch (error) {
        report(error)
      }
      return lastListing
    },
    async content(id) {
      try {
        return await bounded(withStore(async (db) => {
          const tx = db.transaction(DRAFTS_STORE, 'readonly')
          const [record] = await readAll(tx, [tx.objectStore(DRAFTS_STORE).get(id)])
          return isRecord(record) && typeof record.content === 'string' ? record.content : null
        }, null), timeoutMs)
      } catch (error) {
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
  const [records, move] = await readAll(tx, [
    tx.objectStore(DRAFTS_STORE).getAll(),
    ...(withMeta ? [tx.objectStore(META_STORE).get(MOVE_RECORD_KEY)] : []),
  ])
  const all = Array.isArray(records) ? records : []
  const drafts = all.map(summaryOf).filter((draft): draft is DraftRecordSummary => draft !== null)
  drafts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  const held = drafts.map((draft) => draft.id)
  const copied = isRecord(move) && Array.isArray(move.copiedIds)
    ? move.copiedIds.filter((id): id is string => typeof id === 'string')
    : []
  return { drafts, hiddenIds: [...new Set([...copied, ...held])] }
}

/** The results of `requests`, once their transaction completes; rejects with its error or abort. */
function readAll(tx: IDBTransaction, requests: readonly IDBRequest[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(requests.map((request) => request.result as unknown))
    tx.onerror = () => reject(tx.error ?? new Error(`Reading ${DRAFT_DATABASE} failed`))
    tx.onabort = () => reject(tx.error ?? new Error(`Reading ${DRAFT_DATABASE} was aborted`))
  })
}

/** A record's list fields; null when it names no id (it is still hidden by id when it has one). */
function summaryOf(record: unknown): DraftRecordSummary | null {
  if (!isRecord(record) || typeof record.id !== 'string' || record.id === '') return null
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : '',
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : '',
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `read`, or a rejection once `ms` pass; the read itself runs on and closes its connection when it ends. */
function bounded<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Reading ${DRAFT_DATABASE} took longer than ${ms} ms`)), ms)
  })
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}
