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
  /** Opens fail with this error. */
  failOpen: Error | null = null
  /** Runs while a read transaction is still open. */
  duringRead: (() => void) | null = null
  /** Runs as a connection is asked for a transaction, before it checks that it is open. */
  beforeTransaction: (() => void) | null = null
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
        request.error = this.failOpen
        request.onerror?.({ preventDefault() {} })
        return
      }
      const existing = this.databases.get(name)
      if (!existing) {
        let aborted = false
        request.transaction = { abort: () => { aborted = true } }
        request.onupgradeneeded?.({ oldVersion: 0, newVersion: version ?? 1 })
        if (aborted) {
          request.error = new DOMException('The upgrade was aborted', 'AbortError')
          request.onerror?.({ preventDefault() {} })
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
    const tx: Record<string, unknown> & { oncomplete?: () => void } = {}
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
      for (const run of requests) run()
      this.duringRead?.()
      queueMicrotask(() => tx.oncomplete?.())
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

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [] })
    expect(await records.content('draft-orchard')).toBeNull()
    expect(idb.opens).toEqual([])
    expect(idb.databases.size).toBe(0)
    expect(reports).toEqual([])
  })

  it('R3 canopi-f47t.52.272: without databases(), the open without a version aborts at version 0 and creates no database', async () => {
    const idb = new FakeIndexedDb(false)
    const { records, reports } = reader(idb)

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [] })
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

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [] })
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

    expect(await listing).toEqual({ drafts: [], hiddenIds: [] })
    expect(reports).toHaveLength(1)
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

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [] })
    expect(reports).toEqual([idb.failOpen])
  })

  it('R3 canopi-f47t.52.272: a re-list that fails or runs late after a good listing keeps that listing, so a copied id stays hidden', async () => {
    vi.useFakeTimers()
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records, reports } = reader(idb, { timeoutMs: 50 })
    const good = await records.list()
    expect(good.hiddenIds).toContain('draft-moved-only')

    // A 2.1 upgrade closes the connection before the read: the listing is the last good one, not an empty store.
    idb.beforeTransaction = () => idb.versionChange(5)
    expect(await records.list()).toEqual(good)
    idb.beforeTransaction = null

    // An open queued behind another page past the bound.
    idb.hold = true
    const late = records.list()
    await vi.advanceTimersByTimeAsync(50)
    expect(await late).toEqual(good)
    idb.hold = false
    idb.releaseHeld()

    idb.failOpen = new DOMException('Unknown', 'UnknownError')
    expect(await records.list()).toEqual(good)
    expect(reports).toHaveLength(3)

    // A read that succeeds replaces it, an empty store included.
    idb.failOpen = null
    idb.databases.clear()
    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [] })
  })

  it('R3 canopi-f47t.52.272: with no IndexedDB in the page, lists nothing', async () => {
    const { records, reports } = reader(new FakeIndexedDb(), { factory: undefined })

    expect(await records.list()).toEqual({ drafts: [], hiddenIds: [] })
    expect(reports).toEqual([])
  })

  it('R3 canopi-f47t.52.272: gives a Draft’s Design as 2.1 saved it, and null once 2.1 deleted it after the list', async () => {
    const idb = new FakeIndexedDb()
    idb.seed(FROZEN)
    const { records } = reader(idb)
    const saved = FROZEN.stores.drafts!.find((record) => record.id === 'draft-orchard')!.content

    expect(await records.content('draft-orchard')).toBe(saved)
    idb.databases.get(FROZEN.database)!.stores.get('drafts')!.delete('draft-orchard')
    expect(await records.content('draft-orchard')).toBeNull()
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
})
