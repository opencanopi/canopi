/**
 * platform/__fixtures__/draft-records-reader-v205.ts: Test fixture preserving the 2.0.5
 * reader-release IndexedDB reader so cross-release tests verify 2.0.5 reads 2.1's `canopi-drafts`
 * v4 store without leaving dead 2.0.5 reader code in production `draft-records.browser.ts`.
 */
import { isPlainRecord, readIdbRequests } from '../draft-records-move'

const DRAFT_DATABASE = 'canopi-drafts'
const DRAFTS_STORE = 'drafts'
const META_STORE = 'meta'
const MOVE_RECORD_KEY = 'move'
const DRAFT_READ_TIMEOUT_MS = 3000

interface DraftRecordSummary {
  readonly id: string
  readonly name: string
  readonly updatedAt: string
}

interface DraftStoreListing {
  readonly drafts: readonly DraftRecordSummary[]
  readonly hiddenIds: readonly string[]
  readonly complete: boolean
}

export interface DraftRecordsReader {
  list(): Promise<DraftStoreListing>
  content(id: string): Promise<string | null | 'closed'>
}

type DraftStoreFactory = Pick<IDBFactory, 'open'> & { readonly databases?: () => Promise<readonly IDBDatabaseInfo[]> }

interface DraftRecordsReaderOptions {
  readonly factory?: DraftStoreFactory | undefined
  readonly onVersionChange: () => void
  readonly report: (error: unknown) => void
  readonly timeoutMs?: number
}

const NO_DRAFTS: DraftStoreListing = { drafts: [], hiddenIds: [], complete: true }

export function createDraftRecordsReader({
  factory = globalThis.indexedDB,
  onVersionChange,
  report,
  timeoutMs = DRAFT_READ_TIMEOUT_MS,
}: DraftRecordsReaderOptions): DraftRecordsReader {
  let lastListing = NO_DRAFTS
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
        if (seen.closed) return 'closed'
        report(error)
        return null
      }
    },
  }
}

async function listedAbsent(factory: DraftStoreFactory): Promise<boolean> {
  if (typeof factory.databases !== 'function') return false
  const infos = await factory.databases()
  return !infos.some((info) => info.name === DRAFT_DATABASE)
}

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

function summaryOf(record: unknown): DraftRecordSummary | null {
  if (!isPlainRecord(record) || typeof record.id !== 'string' || record.id === '') return null
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : '',
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : '',
  }
}

function bounded<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Reading ${DRAFT_DATABASE} took longer than ${ms} ms`)), ms)
  })
  return Promise.race([read, late]).finally(() => clearTimeout(timer))
}
