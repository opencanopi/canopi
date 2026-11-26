// @vitest-environment jsdom
/**
 * Unit tests for Web Edition's atomic integer-CAS DesignHomeStore over `browserAppDataStore`
 * (`editions/web/session-ports.ts`, 2.1-M526, ADR 0024, ADR 0025).
 */
import { describe, expect, it, vi } from 'vitest'
import { flattenDocumentForJson as encodeCanopiDesign } from '../../app/contracts/document'
import type { DraftId } from '../../platform/design-home'
import type { CanopiFile } from '../../types/design'
import {
  createBrowserAppDataStore,
  DRAFTS_STORAGE_KEY,
  type BrowserStorageAdapter,
} from '../../web/browser-app-data'
import {
  browserAppLifecyclePort,
  browserFileAccessPort,
  createBrowserSessionHomeStore,
} from './session-ports'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface MemoryStorage extends BrowserStorageAdapter {
  readonly values: Map<string, string>
  writeError: Error | null
}

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>()
  return {
    values,
    writeError: null,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (this.writeError !== null) throw this.writeError
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

function makeFile(name: string, description: string | null = null): CanopiFile {
  return {
    version: 9,
    name,
    description,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: '2026-07-04T12:00:00.000Z',
    updated_at: '2026-07-04T12:00:00.000Z',
    extra: {},
  }
}

function encodeFile(file: CanopiFile): Uint8Array {
  return encoder.encode(JSON.stringify(encodeCanopiDesign(file)))
}

describe('createBrowserSessionHomeStore', () => {
  it('performs monotonic updatedAt CAS writes and reads wire-encoded versions accurately', async () => {
    const storage = memoryStorage()
    const appDataStore = createBrowserAppDataStore({ storage })
    let tick = 0
    const home = createBrowserSessionHomeStore(
      appDataStore,
      () => new Date(Date.UTC(2026, 6, 4, 12, 0, tick++)),
    )

    expect(await home.read('draft-orchard')).toEqual({ kind: 'absent' })

    const first = await home.write('draft-orchard', encodeFile(makeFile('Orchard', 'v1')), null)
    expect(first).toEqual({ kind: 'written', version: '2026-07-04T12:00:00.000Z' })

    const read1 = await home.read('draft-orchard')
    expect(read1.kind).toBe('present')
    if (read1.kind === 'present') {
      expect(read1.version).toBe('2026-07-04T12:00:00.000Z')
      expect((JSON.parse(decoder.decode(new Uint8Array(read1.bytes))) as CanopiFile).description).toBe('v1')
    }

    const second = await home.write('draft-orchard', encodeFile(makeFile('Orchard', 'v2')), '2026-07-04T12:00:00.000Z')
    expect(second).toEqual({ kind: 'written', version: '2026-07-04T12:00:01.000Z' })

    const read2 = await home.read('draft-orchard')
    expect(read2.kind).toBe('present')
    if (read2.kind === 'present') {
      expect(read2.version).toBe('2026-07-04T12:00:01.000Z')
      expect((JSON.parse(decoder.decode(new Uint8Array(read2.bytes))) as CanopiFile).description).toBe('v2')
    }
  })

  it('refuses a stale CAS write with conflict and reports the current version (even within the same ms)', async () => {
    const storage = memoryStorage()
    const fixedClock = () => new Date(Date.UTC(2026, 6, 4, 12, 0, 0))
    const tabA = createBrowserSessionHomeStore(createBrowserAppDataStore({ storage }), fixedClock)
    const tabB = createBrowserSessionHomeStore(createBrowserAppDataStore({ storage }), fixedClock)

    const w1 = await tabA.write('draft-shared', encodeFile(makeFile('Shared', 'initial')), null)
    expect(w1).toEqual({ kind: 'written', version: '2026-07-04T12:00:00.000Z' })

    // Tab B advances the draft by +1ms monotonically even when clock returns the same ms.
    const w2 = await tabB.write('draft-shared', encodeFile(makeFile('Shared', 'from tab B')), '2026-07-04T12:00:00.000Z')
    expect(w2).toEqual({ kind: 'written', version: '2026-07-04T12:00:00.001Z' })

    // Tab A tries to write with stale version: refused with conflict reporting current.
    const stale = await tabA.write('draft-shared', encodeFile(makeFile('Shared', 'from tab A')), '2026-07-04T12:00:00.000Z')
    expect(stale).toEqual({ kind: 'conflict', current: '2026-07-04T12:00:00.001Z' })

    // Tab B's data remains intact.
    const readAfterConflict = await tabA.read('draft-shared')
    expect(readAfterConflict.kind).toBe('present')
    if (readAfterConflict.kind === 'present') {
      expect(readAfterConflict.version).toBe('2026-07-04T12:00:00.001Z')
      expect((JSON.parse(decoder.decode(new Uint8Array(readAfterConflict.bytes))) as CanopiFile).description).toBe('from tab B')
    }

    // Resolving with the current version succeeds and advances to +2ms.
    const resolved = await tabA.write('draft-shared', encodeFile(makeFile('Shared', 'resolved by tab A')), '2026-07-04T12:00:00.001Z')
    expect(resolved).toEqual({ kind: 'written', version: '2026-07-04T12:00:00.002Z' })
  })

  it('returns quota_refused on QuotaExceededError and NS_ERROR_DOM_QUOTA_REACHED', async () => {
    const storage = memoryStorage()
    const home = createBrowserSessionHomeStore(createBrowserAppDataStore({ storage }))

    storage.writeError = new DOMException('quota exceeded', 'QuotaExceededError')
    expect(await home.write('draft-q1', encodeFile(makeFile('Q1')), null)).toEqual({ kind: 'quota_refused' })

    storage.writeError = Object.assign(new Error('quota reached'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' })
    expect(await home.write('draft-q2', encodeFile(makeFile('Q2')), null)).toEqual({ kind: 'quota_refused' })

    storage.writeError = new Error('generic storage failure')
    const failed = await home.write('draft-q3', encodeFile(makeFile('Q3')), null)
    expect(failed.kind).toBe('failed')
    if (failed.kind === 'failed') {
      expect(failed.failure.op).toBe('web.draft.write')
      expect(failed.failure.user_may_retry).toBe(true)
    }

    // Invalid JSON bytes fail without retrying.
    storage.writeError = null
    const invalid = await home.write('draft-bad', encoder.encode('not-json'), null)
    expect(invalid.kind).toBe('failed')
    if (invalid.kind === 'failed') {
      expect(invalid.failure.code).toEqual({ kind: 'invalid' })
      expect(invalid.failure.user_may_retry).toBe(false)
    }
  })

  it('supports 2.0.3 drafts without changing their v3 stored record shape (ADR 0026)', async () => {
    const storage = memoryStorage()
    const legacyFile = makeFile('Legacy 2.0.3', 'before revision')
    storage.values.set(
      DRAFTS_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        drafts: [{ id: 'draft-legacy', name: 'Legacy 2.0.3', updatedAt: '2026-06-01T00:00:00.000Z' }],
        draftFiles: { 'draft-legacy': encodeCanopiDesign(legacyFile) },
      }),
    )

    const home = createBrowserSessionHomeStore(
      createBrowserAppDataStore({ storage }),
      () => new Date('2026-06-02T00:00:00.000Z'),
    )
    const read = await home.read('draft-legacy')
    expect(read.kind).toBe('present')
    if (read.kind === 'present') {
      expect(read.version).toBe('2026-06-01T00:00:00.000Z')
    }

    // Mismatched expected version is rejected with conflict reporting current updatedAt.
    expect(await home.write('draft-legacy', encodeFile(makeFile('Legacy 2.0.3', 'wrong')), '2026-05-01T00:00:00.000Z')).toEqual({
      kind: 'conflict',
      current: '2026-06-01T00:00:00.000Z',
    })

    // Writing with matching updatedAt succeeds without adding any new field to the v3 summary.
    expect(await home.write('draft-legacy', encodeFile(makeFile('Legacy 2.0.3', 'upgraded')), '2026-06-01T00:00:00.000Z')).toEqual({
      kind: 'written',
      version: '2026-06-02T00:00:00.000Z',
    })
    const storedRaw = JSON.parse(storage.values.get(DRAFTS_STORAGE_KEY)!) as { drafts: Array<Record<string, unknown>> }
    expect(Object.keys(storedRaw.drafts[0]!).sort()).toEqual(['id', 'name', 'updatedAt'])
  })

  it('lists and deletes drafts and surfaces storage errors on delete', async () => {
    const storage = memoryStorage()
    const home = createBrowserSessionHomeStore(createBrowserAppDataStore({ storage }))

    await home.write('draft-a', encodeFile(makeFile('Alpha')), null)
    await home.write('draft-b', encodeFile(makeFile('Beta')), null)

    const listed = await home.listDrafts()
    expect(listed.map((d) => d.id)).toEqual(['draft-b', 'draft-a'])
    expect(listed[0]?.bytes).not.toBeNull()

    expect(await home.deleteDraft('draft-a' as DraftId)).toEqual({ ok: true })
    expect(await home.read('draft-a')).toEqual({ kind: 'absent' })
    expect((await home.listDrafts()).map((d) => d.id)).toEqual(['draft-b'])

    storage.writeError = new Error('delete blocked')
    const delFail = await home.deleteDraft('draft-b' as DraftId)
    expect(delFail.ok).toBe(false)
    if (!delFail.ok) {
      expect(delFail.failure.op).toBe('web.draft.delete')
    }
  })

  it('notifies onVersionChange only for drafts storage key or storage clear, and unsubscribes cleanly', () => {
    const storage = memoryStorage()
    const home = createBrowserSessionHomeStore(createBrowserAppDataStore({ storage }))
    const cb = vi.fn()
    const unsubscribe = home.onVersionChange(cb)

    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key' }))
    expect(cb).not.toHaveBeenCalled()

    window.dispatchEvent(new StorageEvent('storage', { key: DRAFTS_STORAGE_KEY }))
    expect(cb).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    expect(cb).toHaveBeenCalledTimes(2)

    unsubscribe()
    window.dispatchEvent(new StorageEvent('storage', { key: DRAFTS_STORAGE_KEY }))
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('#588 B2 + N6: flushDraftSync aliases expected version for subsequent async write and returns false without throwing on invalid input', async () => {
    const storage = memoryStorage()
    const home = createBrowserSessionHomeStore(createBrowserAppDataStore({ storage }))
    const initial = await home.write('draft-sync', encodeFile(makeFile('V1')), null)
    expect(initial.kind).toBe('written')
    const v1 = initial.kind === 'written' ? initial.version : null

    // Synchronous flush advances storage version while aliasing v1 -> v2 for the tab's next async write.
    expect(home.flushDraftSync('draft-sync', makeFile('V2'), v1)).toBe(true)
    const nextAsync = await home.write('draft-sync', encodeFile(makeFile('V3')), v1)
    expect(nextAsync.kind).toBe('written')

    // Invalid payload (fails decodeCanopiDesign) returns false without throwing so beforeunload can preventDefault().
    expect(home.flushDraftSync('draft-sync', { version: 9, name: 123 } as never, v1)).toBe(false)
  })

  it('browserFileAccessPort and browserAppLifecyclePort forward browser lifecycle events cleanly', async () => {
    expect(await browserFileAccessPort.pickOpen('canopi')).toEqual({ kind: 'cancelled' })
    expect(await browserFileAccessPort.pickHomeTarget('Orchard')).toEqual({ kind: 'cancelled' })

    const events: string[] = []
    const unsub = browserAppLifecyclePort.subscribe((event) => events.push(event.kind))
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pageshow'))
    expect(events).toEqual(['hidden', 'shown', 'hidden', 'shown'])
    unsub()
  })
})
