// The read half of 2.1's Web Draft store (Step 2.0.4 R3, canopi-f47t.52.272; contracts §11 "Web Drafts move to
// IndexedDB"; design check F7, A18, A19; 2.1-Q40, Q322): listed read-only from the frozen dump's record fields, the
// old-key ids hidden, no database created, each read opening and closing, and a version change closing at once. The
// IndexedDB here is a small fake that keeps the engine behaviours e2e/canvas/indexeddb-reader-probe.spec.ts pins in
// Chromium, WebKit and Firefox; reader-release-web-stores.spec.ts runs the reader itself in those engines.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDraftRecordsReader, type DraftRecordsReader } from './draft-records.browser'

interface FrozenDraftStore {
  readonly database: string
  readonly version: number
  readonly stores: Readonly<Record<string, readonly Record<string, unknown>[]>>
}

const FROZEN = JSON.parse(readFileSync(new URL('../../../../spec/web/frozen/drafts.json', import.meta.url), 'utf8')) as FrozenDraftStore

interface FakeDatabase {
  version: number
  readonly stores: Map<string, Map<string, unknown>>
}

interface Connection {
  closed: boolean
  onversionchange: ((event: { oldVersion: number, newVersion: number | null }) => void) | null
}

/** An IndexedDB with the behaviours the reader relies on; every open, transaction mode and connection is recorded. */
class FakeIndexedDb {
  readonly databases = new Map<string, FakeDatabase>()
  readonly connections: Connection[] = []
  readonly modes: string[] = []
  readonly opens: string[] = []
  /** Opens never answer, as one queued behind another page's upgrade. */
  hold = false
  /** Opens fail with this error; `no error` fails one whose request holds none. */
  failOpen: Error | 'no error' | null = null
  /** Open error events the reader left unhandled (no `preventDefault`), which the engine would report to the page. */
  unpreventedOpenErrors = 0
  /**
   * Read transactions fail: `request` as a request error does (the error event while `tx.error` is still null, then
   * the abort with it), `abort` as an engine abort does (the abort alone).
   */
  failRead: { readonly as: 'request' | 'abort', readonly error: DOMException | null } | null = null
  /** Runs while a read transaction is still open. */
  duringRead: (() => void) | null = null
  /** Runs as a connection is asked for a transaction, before it checks that it is open. */
  beforeTransaction: (() => void) | null = null
  /** Read transactions never complete, as one another page keeps busy. */
  stallReads = false
  private readonly held: (() => void)[] = []

  constructor(readonly withDatabases = true) {}

  seed(dump: FrozenDraftStore): void {
    const keys: Record<string, string> = { drafts: 'id', meta: 'key' }
    this.databases.set(dump.database, {
      version: dump.version,
      stores: new Map(Object.entries(dump.stores).map(([name, records]) => [
        name,
        new Map(records.map((record) => [String(record[keys[name] ?? 'id']), structuredClone(record)])),
      ])),
    })
  }

  /** Another page changes the version (null: deletes the database) while connections are open. */
  versionChange(newVersion: number | null): void {
    const db = this.databases.get(FROZEN.database)
    for (const connection of this.connections) {
      if (!connection.closed) connection.onversionchange?.({ oldVersion: db?.version ?? 0, newVersion })
    }
  }

  releaseHeld(): void {
    for (const answer of this.held.splice(0)) answer()
  }

  factory(): Parameters<typeof createDraftRecordsReader>[0]['factory'] {
    const open = (name: string, version?: number) => this.open(name, version)
    const list = async () => [...this.databases].map(([name, db]) => ({ name, version: db.version }))
    return (this.withDatabases ? { open, databases: list } : { open })
  }

  private open(name: string, version?: number): IDBOpenDBRequest {
    this.opens.push(version === undefined ? name : `${name}@${version}`)
    const request: Record<string, unknown> & { onsuccess?: () => void, onerror?: (event: unknown) => void, onupgradeneeded?: (event: unknown) => void } = {}
    const answer = () => {
      if (this.failOpen) {
        request.error = this.failOpen === 'no error' ? null : this.failOpen
        this.fireOpenError(request)
        return
      }
      const existing = this.databases.get(name)
      if (!existing) {
        let aborted = false
        request.transaction = { abort: () => { aborted = true } }
        request.onupgradeneeded?.({ oldVersion: 0, newVersion: version ?? 1 })
        if (aborted) {
          request.error = new DOMException('The upgrade was aborted', 'AbortError')
          this.fireOpenError(request)
          return
        }
        throw new Error('the reader let an open create a database')
      }
      request.result = this.connect(existing)
      request.onsuccess?.()
    }
    queueMicrotask(() => (this.hold ? this.held.push(answer) : answer()))
    return request as unknown as IDBOpenDBRequest
  }

  private fireOpenError(request: { onerror?: (event: unknown) => void }): void {
    let prevented = false
    request.onerror?.({ preventDefault: () => { prevented = true } })
    if (!prevented) this.unpreventedOpenErrors += 1
  }

  private connect(db: FakeDatabase): IDBDatabase {
    const connection: Connection & Record<string, unknown> = {
      closed: false,
      onversionchange: null,
      version: db.version,
      objectStoreNames: { contains: (store: string) => db.stores.has(store) },
      close: () => { connection.closed = true },
      transaction: (names: string | string[], mode: string) => {
        this.beforeTransaction?.()
        if (connection.closed) throw new DOMException('The connection is closed', 'InvalidStateError')
        this.modes.push(mode)
        return this.transaction(db, [names].flat())
      },
    }
    this.connections.push(connection)
    return connection as unknown as IDBDatabase
  }

  private transaction(db: FakeDatabase, names: readonly string[]): IDBTransaction {
    const tx: Record<string, unknown> & { oncomplete?: () => void, onerror?: () => void, onabort?: () => void } = { error: null }
    const requests: (() => void)[] = []
    const request = (read: () => unknown) => {
      const pending: Record<string, unknown> = {}
      requests.push(() => { pending.result = read() })
      return pending
    }
    tx.objectStore = (name: string) => {
      if (!names.includes(name)) throw new DOMException(`${name} is not in this transaction`, 'NotFoundError')
      const store = db.stores.get(name)!
      return {
        getAll: () => request(() => structuredClone([...store.values()])),
        get: (key: string) => request(() => structuredClone(store.get(key))),
      }
    }
    queueMicrotask(() => {
      const failRead = this.failRead
      if (failRead) {
        if (failRead.as === 'request') tx.onerror?.()
        tx.error = failRead.error
        tx.onabort?.()
        return
      }
      for (const run of requests) run()
      this.duringRead?.()
      if (!this.stallReads) queueMicrotask(() => tx.oncomplete?.())
    })
    return tx as unknown as IDBTransaction
  }
}

function reader(idb: FakeIndexedDb, overrides: Partial<Parameters<typeof createDraftRecordsReader>[0]> = {}) {
  const versionChanges: number[] = []
  const reports: unknown[] = []
  const records: DraftRecordsReader = createDraftRecordsReader({
    factory: idb.factory(),
    onVersionChange: () => versionChanges.push(1),
    report: (error) => reports.push(error),
    ...overrides,
  })
  return { records, versionChanges, reports }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the 2.1 Draft store read half', () => {
  it('reads the frozen database 2b writes, by its name, at the version 2.1 left', async () => {
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records } = reader(idb)
    expect((await records.list()).drafts).not.toHaveLength(0)
    expect(idb.opens).toEqual([FROZEN.database])
    expect(FROZEN.version, 'the container version after the v3 localStorage keys (2.1-M486)').toBe(4)
  })

  it('R3 canopi-f47t.52.272: lists 2.1 Drafts from their record fields, newest first, and hides every copied id and every id 2.1 holds', async () => {
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records, reports } = reader(idb)

    const listing = await records.list()

    expect(listing.drafts).toEqual([
      { id: 'draft-hedge', name: 'Hedge in 2.1', updatedAt: '2026-12-05T00:00:00.000Z' },
      { id: 'draft-orchard', name: 'Orchard in 2.1', updatedAt: '2026-12-03T00:00:00.000Z' },
    ])
    // draft-hedge was never copied, yet 2.1 holds its id: an old-key Draft under it is hidden too.
    expect([...listing.hiddenIds].sort()).toEqual(['draft-hedge', 'draft-moved-only', 'draft-orchard'])
    expect(listing.complete).toBe(true)
    expect(reports).toEqual([])
  })

  it('R3 canopi-f47t.52.272: offers no write, opens only readonly transactions and leaves no connection open', async () => {
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records } = reader(idb)

    expect(Object.keys(records).sort()).toEqual(['content', 'list'])
    await records.list()
    await records.content('draft-orchard')

    expect(idb.modes).toEqual(['readonly', 'readonly'])
    expect(idb.connections).toHaveLength(2)
    expect(idb.connections.every((connection) => connection.closed)).toBe(true)
  })

  it('R3 canopi-f47t.52.272: on an origin with no Draft store, databases() answers and nothing is opened or created', async () => {
    const idb = new FakeIndexedDb()
    const { records, reports } = reader(idb)

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [], complete: true })
    expect(await records.content('draft-orchard')).toBeNull()
    expect(idb.opens).toEqual([])
    expect(idb.databases.size).toBe(0)
    expect(reports).toEqual([])
  })

  it('R3 canopi-f47t.52.272: without databases(), the open without a version aborts at version 0 and creates no database', async () => {
    const idb = new FakeIndexedDb(false)
    const { records, reports } = reader(idb)

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [], complete: true })
    expect(idb.opens).toEqual([FROZEN.database])
    expect(idb.databases.size).toBe(0)
    expect(reports).toEqual([])
  })

  it('R3 canopi-f47t.52.272: without databases(), an existing store is found by the open alone', async () => {
    const idb = new FakeIndexedDb(false)
    idb.seed(FROZEN)
    const { records } = reader(idb)

    expect((await records.list()).drafts.map((draft) => draft.id)).toEqual(['draft-hedge', 'draft-orchard'])
  })

  it.each([
    ['an upgrade', 5],
    ['a delete, with no new version', null],
  ] as const)('R3 canopi-f47t.52.272: a versionchange mid-read (%s) closes the connection at once, tells the page and the read still settles', async (_, newVersion) => {
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records, versionChanges, reports } = reader(idb)
    idb.duringRead = () => idb.versionChange(newVersion)

    const listing = await records.list()

    expect(versionChanges).toHaveLength(1)
    expect(idb.connections.every((connection) => connection.closed)).toBe(true)
    expect(listing.drafts).toHaveLength(2)
    expect(reports).toEqual([])
  })

  it('R3 canopi-f47t.52.272: a versionchange before the read starts closes too, and the listing settles empty with a report', async () => {
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records, versionChanges, reports } = reader(idb)
    idb.beforeTransaction = () => idb.versionChange(null)

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [], complete: false })
    expect(versionChanges).toHaveLength(1)
    expect(reports).toHaveLength(1)
    expect(idb.connections.every((connection) => connection.closed)).toBe(true)
  })

  it('R3 canopi-f47t.52.272: a read stuck behind another page settles empty after its bound with a report, and closes its late connection', async () => {
    vi.useFakeTimers()
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    idb.hold = true
    const { records, reports } = reader(idb, { timeoutMs: 50 })

    const listing = records.list()
    await vi.advanceTimersByTimeAsync(50)

    expect(await listing).toEqual({ drafts: [], hiddenIds: [], complete: false })
    expect(reports).toHaveLength(1)
    expect((reports[0] as Error).message, 'the report names the store and the bound').toBe('Reading canopi-drafts took longer than 50 ms')
    vi.useRealTimers()
    idb.releaseHeld()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(idb.connections).toHaveLength(1)
    expect(idb.connections[0]!.closed).toBe(true)
  })

  it('R3 canopi-f47t.52.272: an open that fails lists nothing and is reported', async () => {
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    idb.failOpen = new DOMException('Unknown', 'UnknownError')
    const { records, reports } = reader(idb)

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [], complete: false })
    expect(reports).toEqual([idb.failOpen])
  })

  it('R3 canopi-f47t.52.272: a re-list that fails or runs late after a good listing keeps that listing, so a copied id stays hidden', async () => {
    vi.useFakeTimers()
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records, reports } = reader(idb, { timeoutMs: 50 })
    const good = await records.list()
    expect(good.hiddenIds).toContain('draft-moved-only')
    expect(good.complete).toBe(true)
    const kept = { ...good, complete: false }

    // A 2.1 upgrade closes the connection before the read: the listing is the last good one, not an empty store.
    idb.beforeTransaction = () => idb.versionChange(5)
    expect(await records.list()).toEqual(kept)
    idb.beforeTransaction = null

    // An open queued behind another page past the bound.
    idb.hold = true
    const late = records.list()
    await vi.advanceTimersByTimeAsync(50)
    expect(await late).toEqual(kept)
    idb.hold = false
    idb.releaseHeld()

    idb.failOpen = new DOMException('Unknown', 'UnknownError')
    expect(await records.list()).toEqual(kept)
    expect(reports).toHaveLength(3)

    // A read that succeeds replaces it, an empty store included.
    idb.failOpen = null
    idb.databases.clear()
    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [], complete: true })
  })

  it('R3 canopi-f47t.52.272: with no IndexedDB in the page, lists nothing', async () => {
    const { records, reports } = reader(new FakeIndexedDb(), { factory: undefined })

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [], complete: true })
    expect(reports).toEqual([])
  })

  it('R3 canopi-f47t.52.272: gives a Draft’s Design as 2.1 saved it, and null once 2.1 deleted it after the list', async () => {
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records, reports } = reader(idb)
    const saved = FROZEN.stores.drafts!.find((record) => record.id === 'draft-orchard')!.content

    expect(await records.content('draft-orchard')).toBe(saved)
    idb.databases.get(FROZEN.database)!.stores.get('drafts')!.delete('draft-orchard')
    expect(await records.content('draft-orchard')).toBeNull()
    // A deleted Draft is no failed read: nothing is reported.
    expect(reports).toEqual([])
  })

  it('R3 canopi-f47t.52.272: a Draft read that fails, aborts or runs late gives null with a report, so the open says so', async () => {
    vi.useFakeTimers()
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records, reports } = reader(idb, { timeoutMs: 50 })

    idb.failOpen = new DOMException('Unknown', 'UnknownError')
    expect(await records.content('draft-orchard'), 'an open that fails').toBeNull()
    idb.failOpen = null

    idb.hold = true
    const late = records.content('draft-orchard')
    await vi.advanceTimersByTimeAsync(50)
    expect(await late, 'an open queued past the bound').toBeNull()
    expect(reports).toHaveLength(2)
    vi.useRealTimers()
    idb.hold = false
    idb.releaseHeld()
  })

  it('R3 canopi-f47t.52.272: a Draft read a version change closed gives "closed" with no report, so the open says nothing beside the Reload notice (2.1-Q40, Q337)', async () => {
    vi.useFakeTimers()
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records, versionChanges, reports } = reader(idb, { timeoutMs: 50 })

    idb.beforeTransaction = () => idb.versionChange(5)
    expect(await records.content('draft-orchard'), 'closed before the read').toBe('closed')
    idb.beforeTransaction = null

    // Closed mid-read, the read then runs past its bound (another page keeps it busy).
    idb.stallReads = true
    idb.duringRead = () => idb.versionChange(5)
    const stalled = records.content('draft-orchard')
    await vi.advanceTimersByTimeAsync(50)
    expect(await stalled, 'closed mid-read, then late').toBe('closed')

    expect(versionChanges).toHaveLength(2)
    expect(reports).toEqual([])
  })

  it('R3 canopi-f47t.52.272: a record whose fields do not read is listed under defaults, still hidden by id; one with no id is not listed', async () => {
    const idb = new FakeIndexedDb()
    idb.seed({
      ...FROZEN,
      stores: { drafts: [{ id: 'draft-odd', name: 7, updated_at: null, content: 1 }, { id: '' }], meta: [{ key: 'move', copiedIds: 'none' }] },
    })
    const { records } = reader(idb)

    const listing = await records.list()

    expect(listing.drafts).toEqual([{ id: 'draft-odd', name: '', updatedAt: '' }])
    expect(listing.hiddenIds).toEqual(['draft-odd'])
    expect(await records.content('draft-odd')).toBeNull()
  })

  it('canopi-sr7m: databases() listing only other databases opens nothing, so the store is not looked for by an open', async () => {
    const idb = new FakeIndexedDb()
    idb.databases.set('another-app', { version: 1, stores: new Map() })
    const { records } = reader(idb)

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [], complete: true })
    expect(idb.opens).toEqual([])
  })

  it('canopi-sr7m: an open error, the version-0 abort or a failure, is handled by the reader and never left to reach the page', async () => {
    const absent = new FakeIndexedDb(false)
    await reader(absent).records.list()
    expect(absent.unpreventedOpenErrors, 'the version-0 abort').toBe(0)

    const failing = new FakeIndexedDb()
    failing.seed(FROZEN)
    failing.failOpen = new DOMException('Unknown', 'UnknownError')
    await reader(failing).records.list()
    expect(failing.unpreventedOpenErrors, 'a failed open').toBe(0)
  })

  it('canopi-sr7m: an open that fails with no error of its own is reported as the store failing to open', async () => {
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    idb.failOpen = 'no error'
    const { records, reports } = reader(idb)

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [], complete: false })
    expect(reports.map((error) => (error as Error).message)).toEqual(['Opening canopi-drafts failed'])
  })

  it('canopi-sr7m: a store with no meta store lists its Drafts and hides the ids it holds', async () => {
    const idb = new FakeIndexedDb()
    idb.seed({ ...FROZEN, stores: { drafts: FROZEN.stores.drafts! } })
    const { records, reports } = reader(idb)

    const listing = await records.list()

    expect(listing.drafts.map((draft) => draft.id)).toEqual(['draft-hedge', 'draft-orchard'])
    expect(listing.hiddenIds).toEqual(['draft-hedge', 'draft-orchard'])
    expect(listing.complete).toBe(true)
    expect(reports).toEqual([])
  })

  /**
   * V8's sort reads only whether the comparator answers below zero; SpiderMonkey's and JavaScriptCore's merge sorts read
   * whether it answers above zero. This stable insertion sort does the latter, so the order holds in every engine the
   * Web Edition runs in.
   */
  function sortReadingPositiveAnswers<T>(this: T[], compare?: (a: T, b: T) => number): T[] {
    for (let i = 1; i < this.length; i += 1) {
      for (let j = i; j > 0 && compare!(this[j - 1]!, this[j]!) > 0; j -= 1) [this[j - 1], this[j]] = [this[j]!, this[j - 1]!]
    }
    return this
  }

  it.each([
    ['the engine’s sort', false],
    ['a sort that reads only the comparator’s answers above zero', true],
  ] as const)('canopi-sr7m: many Drafts list newest first, and Drafts saved at the same instant keep the store order by id (%s)', async (_, positiveOnly) => {
    // getAll gives the records in key order; the instants are shuffled and repeat, as a user with many Drafts has.
    const instants = Array.from({ length: 12 }, (_, day) => `2026-12-${String(day + 10).padStart(2, '0')}T00:00:00.000Z`)
    const records = Array.from({ length: 120 }, (_, n) => ({
      id: `draft-${String(n).padStart(3, '0')}`,
      name: `Draft ${n}`,
      updated_at: instants[(n * 7) % instants.length]!,
      content: '{}',
    }))
    const expected = [...records]
      .sort((a, b) => (a.updated_at === b.updated_at ? (a.id < b.id ? -1 : 1) : a.updated_at < b.updated_at ? 1 : -1))
      .map((record) => ({ id: record.id, name: record.name, updatedAt: record.updated_at }))
    const idb = new FakeIndexedDb()
    idb.seed({ ...FROZEN, stores: { drafts: records } })
    const { records: drafts } = reader(idb)

    const sort = positiveOnly ? vi.spyOn(Array.prototype, 'sort').mockImplementation(sortReadingPositiveAnswers) : null
    try {
      expect((await drafts.list()).drafts).toEqual(expected)
    } finally {
      sort?.mockRestore()
    }
  })

  it('canopi-sr7m: a move record whose copied ids hold a non-id hides only the ids', async () => {
    const idb = new FakeIndexedDb()
    idb.seed({ ...FROZEN, stores: { drafts: [], meta: [{ key: 'move', copiedIds: ['draft-moved-only', 7, null, { id: 'x' }] }] } })
    const { records } = reader(idb)

    expect((await records.list()).hiddenIds).toEqual(['draft-moved-only'])
  })

  const readError = new DOMException('The read failed', 'UnknownError')
  const closedError = new DOMException('The connection was closed', 'AbortError')
  it.each([
    // The error event comes while tx.error is still null; the abort that follows carries the error.
    ['a request error, then the abort', 'request', readError, 'Reading canopi-drafts failed'],
    ['an engine abort with its error', 'abort', closedError, closedError],
    ['an abort with no error', 'abort', null, 'Reading canopi-drafts was aborted'],
  ] as const)('canopi-sr7m: a read transaction that fails (%s) settles at once, reported with what failed', async (_, as, error, reported) => {
    vi.useFakeTimers()
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records, reports } = reader(idb, { timeoutMs: 50 })

    idb.failRead = { as, error }
    // Settled before any bound passes: the failure itself ends the read.
    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [], complete: false })
    expect(await records.content('draft-orchard')).toBeNull()
    expect(reports).toHaveLength(2)
    for (const report of reports) {
      if (typeof reported === 'string') {
        expect(report).toBeInstanceOf(Error)
        expect((report as Error).message).toBe(reported)
      } else {
        expect(report).toBe(reported)
      }
    }
    expect(idb.connections.every((connection) => connection.closed)).toBe(true)
  })

  it('canopi-sr7m: a read that ends in time leaves no timer behind', async () => {
    vi.useFakeTimers()
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records } = reader(idb, { timeoutMs: 50 })

    await records.list()
    await records.content('draft-orchard')

    expect(vi.getTimerCount()).toBe(0)
  })
})
