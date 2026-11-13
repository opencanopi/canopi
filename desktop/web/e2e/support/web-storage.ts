// The Web stores' IndexedDB vocabulary for browser checks (Step 2.0.4 R3, canopi-f47t.52.272): the 2.1 Draft store's
// frozen shape (contracts §11 "Web Drafts move to IndexedDB") and the page functions that seed, read and disturb it as a
// reader and a 2.1 tab do. e2e/canvas/indexeddb-reader-probe.spec.ts holds each engine to the behaviours the reader
// release builds on (2.1-Q40, 2.1-M486, design check A18 and A19); R4's rollback harness seeds and dumps through it.
// Every page function is self-contained (it reaches nothing outside its body), so `page.evaluate` and a WebDriver
// `execute/async` can both send its source; state that outlives one call lives on `window.__canopiIdb`.
//
// The reader's existence read, as the probe pins it: databases() where the engine has it (a fast path: it never
// creates a database, and lists a 2.1 database only once its upgrade commits), and always an open without a version
// whose upgrade is aborted at oldVersion 0. An engine without databases() runs the open alone. The open stays even
// after databases() named the store: 2.1's first upgrade may still abort under it, and the abort keeps that open from
// creating version 1.

/** The 2.1 Draft store's database (contracts §11). */
export const DRAFT_DATABASE = 'canopi-drafts'
/** Its IndexedDB version: the container version after the v3 `localStorage` keys (2.1-M486). */
export const DRAFT_DATABASE_VERSION = 4

/** A record of the `drafts` object store (key `id`); no Blob, Date or ArrayBuffer, so a fixture round-trips JSON. */
export interface DraftRecord {
  readonly id: string
  /** The app version string that wrote it. */
  readonly canopi_version: string
  /** The `HomeVersion`. */
  readonly version: number
  readonly name: string
  /** An ISO 8601 instant. */
  readonly updated_at: string
  /** The Design as `.canopi` text. */
  readonly content: string
}

/** What an open without a version found: nothing (its upgrade from 0 aborted, so nothing was made) or the store. */
export type ExistenceRead =
  | { readonly found: false, readonly error: string }
  | { readonly found: true, readonly version: number, readonly stores: readonly string[] }

export interface ExistenceReadOptions {
  readonly name: string
  /**
   * What becomes of a connection once the store is described: closed at once (the default, open-read-close), or kept
   * as a reader connection that closes on versionchange (the Q40 contract) or, for the probe's control, never closes.
   */
  readonly connection?: 'close' | 'close-on-versionchange' | 'keep-open'
  /** Start the read and answer 'started' at once (it may wait behind another page's upgrade); pendingRead answers it. */
  readonly deferred?: boolean
}

/** What a kept reader connection saw: one entry per versionchange, and whether it closed there. */
export interface ReaderEvent {
  readonly oldVersion: number
  readonly newVersion: number | null
  readonly closed: boolean
}

/** A later page's version change: whether a blocked event fired, and how it ended within the wait. */
export interface ChangeOutcome {
  readonly blocked: boolean
  readonly outcome: string
}

interface ProbeState {
  readerEvents: ReaderEvent[]
  held?: { end: (how: 'commit' | 'abort') => Promise<string> }
  read?: Promise<ExistenceRead>
}

/**
 * Opens `name` without a version and aborts the upgrade if the engine offers one from version 0, so no database is
 * created; an existing store is described, and its connection closed or kept as `connection` says (a kept one resets
 * the recorded versionchange events).
 */
export async function existenceRead({ name, connection = 'close', deferred = false }: ExistenceReadOptions): Promise<ExistenceRead | 'started'> {
  const host = window as unknown as { __canopiIdb?: ProbeState }
  const state = host.__canopiIdb ??= { readerEvents: [] }
  if (connection !== 'close') state.readerEvents = []
  const read = new Promise<ExistenceRead>((resolve, reject) => {
    const request = indexedDB.open(name)
    let aborted = false
    request.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) return
      aborted = true
      request.transaction!.abort()
    }
    request.onerror = (event) => {
      event.preventDefault()
      if (aborted) resolve({ found: false, error: request.error?.name ?? 'none' })
      else reject(new Error(`open ${name} failed: ${request.error?.name}`))
    }
    request.onsuccess = () => {
      const db = request.result
      resolve({ found: true, version: db.version, stores: [...db.objectStoreNames].sort() })
      if (connection === 'close') {
        db.close()
        return
      }
      db.onversionchange = (event) => {
        const closes = connection === 'close-on-versionchange'
        if (closes) db.close()
        state.readerEvents.push({ oldVersion: event.oldVersion, newVersion: event.newVersion, closed: closes })
      }
    }
  })
  if (!deferred) return await read
  state.read = read
  return 'started'
}

/** The deferred read's answer, or 'pending' if it has not settled within `waitMs`. */
export async function pendingRead(waitMs: number): Promise<ExistenceRead | 'pending'> {
  const read = (window as unknown as { __canopiIdb?: ProbeState }).__canopiIdb?.read
  if (!read) throw new Error('no deferred read')
  return await Promise.race([read, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), waitMs))])
}

/** The kept reader connection's recorded versionchange events. */
export function readerEvents(): ReaderEvent[] {
  return (window as unknown as { __canopiIdb?: ProbeState }).__canopiIdb?.readerEvents ?? []
}

/**
 * The versions databases() lists under `name`: null when the engine has no databases(), 'pending' when it has not
 * answered within `waitMs` (default 5 s).
 */
export async function databaseVersions({ name, waitMs = 5000 }: { name: string, waitMs?: number }): Promise<number[] | null | 'pending'> {
  const factory = indexedDB as IDBFactory & { databases?: IDBFactory['databases'] }
  if (typeof factory.databases !== 'function') return null
  const listed = factory.databases().then((infos) => infos.filter((info) => info.name === name).map((info) => info.version ?? -1))
  return await Promise.race([listed, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), waitMs))])
}

/** Removes databases() from the page, as an engine without it (Firefox before 126) has none; an init script. */
export function removeDatabases(): void {
  delete (IDBFactory.prototype as Partial<IDBFactory>).databases
}

/** Writes the 2.1 Draft store as 2.1 leaves it: stores `drafts` (key `id`) and `meta` (key `key`, the move record). */
export async function createDraftStore(
  { name, version, records, copiedIds }: { name: string, version: number, records: readonly DraftRecord[], copiedIds: readonly string[] },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts', { keyPath: 'id' })
      request.result.createObjectStore('meta', { keyPath: 'key' })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['drafts', 'meta'], 'readwrite')
      for (const record of records) tx.objectStore('drafts').put(record)
      tx.objectStore('meta').put({ key: 'move', state: 'copied', sourceHash: 'seeded', rev: 1, copiedIds })
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/** Every record of every store of `name` and its version, or null when there is none; creates nothing. */
export async function draftStoreDump(name: string): Promise<Record<string, unknown> | null> {
  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onupgradeneeded = (event) => { if (event.oldVersion === 0) request.transaction!.abort() }
    request.onerror = (event) => { event.preventDefault(); resolve(null) }
    request.onsuccess = () => {
      const db = request.result
      const names = [...db.objectStoreNames].sort()
      const out: Record<string, unknown> = { version: db.version }
      if (names.length === 0) { db.close(); resolve(out); return }
      const tx = db.transaction(names, 'readonly')
      for (const store of names) {
        const all = tx.objectStore(store).getAll()
        all.onsuccess = () => { out[store] = all.result }
      }
      tx.oncomplete = () => { db.close(); resolve(out) }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/**
 * The 2.1 page's first upgrade to `version`, held open (its versionchange transaction kept busy) until heldUpgradeEnd;
 * resolves once the upgrade has created the Draft store's object stores.
 */
export async function startHeldUpgrade({ name, version }: { name: string, version: number }): Promise<void> {
  const host = window as unknown as { __canopiIdb?: ProbeState }
  const state = host.__canopiIdb ??= { readerEvents: [] }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, version)
    let release: 'commit' | 'abort' | null = null
    let ended: (outcome: string) => void = () => undefined
    const end = new Promise<string>((resolveEnd) => { ended = resolveEnd })
    request.onupgradeneeded = () => {
      const tx = request.transaction!
      const drafts = request.result.createObjectStore('drafts', { keyPath: 'id' })
      request.result.createObjectStore('meta', { keyPath: 'key' })
      // A chain of reads keeps the transaction from committing until release is set.
      const keepBusy = (): void => {
        if (release === 'abort') { tx.abort(); return }
        if (release === 'commit') return
        drafts.get('held').onsuccess = keepBusy
      }
      keepBusy()
      state.held = { end: (how) => { release = how; return end } }
      resolve()
    }
    request.onsuccess = () => { request.result.close(); ended('committed') }
    request.onerror = (event) => {
      event.preventDefault()
      if (state.held) ended(request.error?.name ?? 'none')
      else reject(new Error(`open ${name} failed: ${request.error?.name}`))
    }
  })
}

/** Lets the held upgrade commit or aborts it; resolves with 'committed' or the open's error name. */
export async function heldUpgradeEnd(how: 'commit' | 'abort'): Promise<string> {
  const state = (window as unknown as { __canopiIdb?: ProbeState }).__canopiIdb
  if (!state?.held) throw new Error('no held upgrade')
  return await state.held.end(how)
}

/**
 * A later page changes `name`'s version: opens it at `to` (a 2.1 upgrade) or deletes it; 'pending' if that has not
 * succeeded within `waitMs`.
 */
export async function versionChangeOutcome({ name, to, waitMs }: { name: string, to: number | 'delete', waitMs: number }): Promise<ChangeOutcome> {
  return await new Promise<ChangeOutcome>((resolve) => {
    let blocked = false
    const request = to === 'delete' ? indexedDB.deleteDatabase(name) : indexedDB.open(name, to)
    const timer = setTimeout(() => resolve({ blocked, outcome: 'pending' }), waitMs)
    request.onblocked = () => { blocked = true }
    request.onerror = (event) => { event.preventDefault(); clearTimeout(timer); resolve({ blocked, outcome: `error ${request.error?.name}` }) }
    request.onsuccess = () => {
      if (to !== 'delete') request.result.close()
      clearTimeout(timer)
      resolve({ blocked, outcome: to === 'delete' ? 'deleted' : 'upgraded' })
    }
  })
}
