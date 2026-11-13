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

/** What a reader connection saw: one entry per versionchange, and whether it closed there. */
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

/**
 * Opens `name` without a version and aborts the upgrade if the engine offers one from version 0, so no database is
 * created; an existing store opens, is described and is closed at once (open-read-close).
 */
export async function openAndAbortAtZero(name: string): Promise<ExistenceRead> {
  return await new Promise<ExistenceRead>((resolve, reject) => {
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
      const read: ExistenceRead = { found: true, version: db.version, stores: [...db.objectStoreNames].sort() }
      db.close()
      resolve(read)
    }
  })
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

interface ProbeState {
  reader?: IDBDatabase
  readerEvents: { oldVersion: number, newVersion: number | null, closed: boolean }[]
  held?: { end: (how: 'commit' | 'abort') => Promise<string> }
  read?: { settled: boolean, value: unknown }
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

/** Starts openAndAbortAtZero's read of `name` without awaiting it (it may wait behind another page's upgrade). */
export function startPendingRead(name: string): void {
  const host = window as unknown as { __canopiIdb?: ProbeState }
  const state = host.__canopiIdb ??= { readerEvents: [] }
  const read = { settled: false, value: null as unknown }
  state.read = read
  const request = indexedDB.open(name)
  let aborted = false
  request.onupgradeneeded = (event) => {
    if (event.oldVersion !== 0) return
    aborted = true
    request.transaction!.abort()
  }
  request.onerror = (event) => {
    event.preventDefault()
    read.value = aborted ? { found: false, error: request.error?.name ?? 'none' } : { failed: request.error?.name ?? 'none' }
    read.settled = true
  }
  request.onsuccess = () => {
    const db = request.result
    read.value = { found: true, version: db.version, stores: [...db.objectStoreNames].sort() }
    db.close()
    read.settled = true
  }
}

/** The started read's answer, or 'pending' if it has not settled within `waitMs`. */
export async function pendingRead(waitMs: number): Promise<unknown> {
  const state = (window as unknown as { __canopiIdb?: ProbeState }).__canopiIdb
  if (!state?.read) throw new Error('no started read')
  const read = state.read
  const deadline = Date.now() + waitMs
  while (!read.settled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  return read.settled ? read.value : 'pending'
}

/**
 * Opens a reader connection to `name` and keeps it open; each versionchange is recorded and, with
 * `closeOnVersionChange`, closes it there (the Q40 contract). Resets the recorded events.
 */
export async function openReaderConnection(
  { name, closeOnVersionChange }: { name: string, closeOnVersionChange: boolean },
): Promise<ExistenceRead> {
  const host = window as unknown as { __canopiIdb?: ProbeState }
  const state = host.__canopiIdb ??= { readerEvents: [] }
  state.readerEvents = []
  return await new Promise<ExistenceRead>((resolve, reject) => {
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
      state.reader = db
      db.onversionchange = (event) => {
        if (closeOnVersionChange) db.close()
        state.readerEvents.push({ oldVersion: event.oldVersion, newVersion: event.newVersion, closed: closeOnVersionChange })
      }
      resolve({ found: true, version: db.version, stores: [...db.objectStoreNames].sort() })
    }
  })
}

/** The reader connection's recorded versionchange events. */
export function readerEvents(): ReaderEvent[] {
  return (window as unknown as { __canopiIdb?: ProbeState }).__canopiIdb?.readerEvents ?? []
}

/** A later page opens `name` at `version` (a 2.1 upgrade); 'pending' if it has not succeeded within `waitMs`. */
export async function upgradeOutcome({ name, version, waitMs }: { name: string, version: number, waitMs: number }): Promise<ChangeOutcome> {
  return await new Promise<ChangeOutcome>((resolve) => {
    let blocked = false
    const request = indexedDB.open(name, version)
    const timer = setTimeout(() => resolve({ blocked, outcome: 'pending' }), waitMs)
    request.onblocked = () => { blocked = true }
    request.onerror = (event) => { event.preventDefault(); clearTimeout(timer); resolve({ blocked, outcome: `error ${request.error?.name}` }) }
    request.onsuccess = () => { request.result.close(); clearTimeout(timer); resolve({ blocked, outcome: 'upgraded' }) }
  })
}

/** A later page deletes `name`; 'pending' if it has not succeeded within `waitMs`. */
export async function deleteOutcome({ name, waitMs }: { name: string, waitMs: number }): Promise<ChangeOutcome> {
  return await new Promise<ChangeOutcome>((resolve) => {
    let blocked = false
    const request = indexedDB.deleteDatabase(name)
    const timer = setTimeout(() => resolve({ blocked, outcome: 'pending' }), waitMs)
    request.onblocked = () => { blocked = true }
    request.onerror = (event) => { event.preventDefault(); clearTimeout(timer); resolve({ blocked, outcome: `error ${request.error?.name}` }) }
    request.onsuccess = () => { clearTimeout(timer); resolve({ blocked, outcome: 'deleted' }) }
  })
}
