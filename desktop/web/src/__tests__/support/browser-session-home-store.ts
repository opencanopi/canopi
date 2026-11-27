/**
 * __tests__/support/browser-session-home-store.ts: Synchronous localStorage-backed DesignHomeStore
 * test harness for Web session unit tests (production Web Edition uses IndexedDB
 * `platform/design-home.browser.ts`, 2.1-M21 / 2.1-M526).
 */
import {
  flattenDocumentForJson,
  parseCanopiJsonText,
} from '../../app/contracts/document'
import { createJsonSessionCodec } from '../../app/document-session/live-core'
import type {
  DeleteDraftResult,
  DesignHomeStore,
  DesignHomeWriteResult,
  DraftId,
  DraftRecord,
  HomeRead,
  HomeVersion,
} from '../../platform/design-home'
import {
  browserAppDataStore,
  DRAFTS_STORAGE_KEY,
  type BrowserAppDataStore,
  type BrowserStorageAdapter,
} from '../../web/browser-app-data'
import { deleteLegacyDraft, seedLegacyDraft } from './legacy-draft-fixture'

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

function parseIsoUtcMs(iso: string): number {
  const m = ISO_UTC_PATTERN.exec(iso)
  if (!m) return Number.NaN
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms)
}

function nextMonotonicTimestamp(now: Date, previous: HomeVersion | null): string {
  const candidateMs = now.getTime()
  const prevMs = previous ? parseIsoUtcMs(previous) : Number.NaN
  if (Number.isFinite(prevMs) && candidateMs <= prevMs) {
    const bumped = new Date()
    bumped.setTime(prevMs + 1)
    return bumped.toISOString()
  }
  return now.toISOString()
}

export interface BrowserSessionHomeStore extends DesignHomeStore {
  flushDraftSync(key: string, file: Parameters<typeof flattenDocumentForJson>[0], expected: HomeVersion | null): boolean
}

export function createBrowserSessionHomeStore(
  appDataStore: BrowserAppDataStore = browserAppDataStore,
  now: () => Date = () => new Date(),
): BrowserSessionHomeStore {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const syncAliases = new Map<string, { readonly from: HomeVersion | null; readonly to: HomeVersion }>()

  const readUpdatedAt = (key: string): HomeVersion | null => {
    const summary = appDataStore.listDrafts().find((draft) => draft.id === key)
    return summary ? summary.updatedAt : null
  }

  const admitWrite = createJsonSessionCodec({ designCore: undefined as never }).admitWrite!

  const storageBridge: BrowserStorageAdapter = {
    getItem: (k) => appDataStore.readRecord((s) => s.getItem(k)),
    setItem: (k, v) => {
      const res = appDataStore.writeRecord((s) => s.setItem(k, v))
      if (!res.ok) throw res.error
    },
    removeItem: (k) => {
      const res = appDataStore.writeRecord((s) => s.removeItem(k))
      if (!res.ok) throw res.error
    },
  }

  return {
    flushDraftSync(key: string, file: Parameters<typeof flattenDocumentForJson>[0], expected: HomeVersion | null): boolean {
      try {
        const alias = syncAliases.get(key)
        const effectiveExpected = alias && alias.from === expected ? alias.to : expected
        if (admitWrite(file as Parameters<typeof admitWrite>[0]) !== null) return false
        const wire = flattenDocumentForJson(file)
        const result = seedLegacyDraft({
          id: key,
          raw: wire,
          name: file.name,
          now: nextMonotonicTimestamp(now(), effectiveExpected),
          expectedUpdatedAt: effectiveExpected,
          storage: storageBridge,
        })
        if (!result.ok) return false
        syncAliases.set(key, { from: expected, to: result.value.updatedAt })
        return true
      } catch {
        // Invalid or unserializable Draft cannot flush synchronously.
        return false
      }
    },
    async read(key: string): Promise<HomeRead> {
      const raw = appDataStore.loadRawDraft(key)
      if (!raw) return { kind: 'absent' }
      const bytes = Array.from(encoder.encode(JSON.stringify(raw)))
      const version = readUpdatedAt(key) ?? ''
      return { kind: 'present', bytes, version }
    },
    async write(key: string, bytes: Uint8Array, expected: HomeVersion | null): Promise<DesignHomeWriteResult> {
      let raw: Record<string, unknown>
      let name: string
      try {
        const parsed = parseCanopiJsonText(decoder.decode(bytes))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { name?: unknown }).name !== 'string') {
          return {
            kind: 'failed',
            failure: { code: { kind: 'invalid' }, user_may_retry: false, op: 'web.draft.write', operation: null, detail: null },
          }
        }
        raw = parsed as Record<string, unknown>
        name = raw.name as string
      } catch {
        // Invalid JSON bytes cannot be written to browser draft storage.
        return {
          kind: 'failed',
          failure: { code: { kind: 'invalid' }, user_may_retry: false, op: 'web.draft.write', operation: null, detail: null },
        }
      }
      const alias = syncAliases.get(key)
      const effectiveExpected = alias && alias.from === expected ? alias.to : expected
      const result = seedLegacyDraft({
        id: key,
        raw,
        name,
        now: nextMonotonicTimestamp(now(), effectiveExpected),
        expectedUpdatedAt: effectiveExpected,
        storage: storageBridge,
      })
      if (result.ok) {
        syncAliases.delete(key)
        return { kind: 'written', version: result.value.updatedAt }
      }
      if (result.error instanceof Error && result.error.name === 'BrowserDraftChangedError') {
        return { kind: 'conflict', current: readUpdatedAt(key) }
      }
      if (isQuotaError(result.error)) {
        return { kind: 'quota_refused' }
      }
      return {
        kind: 'failed',
        failure: { code: { kind: 'io', io: 'other' }, user_may_retry: true, op: 'web.draft.write', operation: null, detail: null },
      }
    },
    async listDrafts(): Promise<readonly DraftRecord[]> {
      return appDataStore.listDrafts().map((draft) => {
        const raw = appDataStore.loadRawDraft(draft.id)
        return {
          id: draft.id as DraftId,
          updatedAt: draft.updatedAt,
          bytes: raw ? encoder.encode(JSON.stringify(raw)) : null,
        }
      })
    },
    async deleteDraft(id: DraftId): Promise<DeleteDraftResult> {
      const result = deleteLegacyDraft(id, storageBridge)
      return result.ok
        ? { ok: true }
        : {
            ok: false,
            failure: { code: { kind: 'io', io: 'other' }, user_may_retry: true, op: 'web.draft.delete', operation: null, detail: null },
          }
    },
    onVersionChange(cb: () => void): () => void {
      if (typeof window === 'undefined') return () => {}
      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === DRAFTS_STORAGE_KEY) cb()
      }
      window.addEventListener('storage', onStorage)
      return () => { window.removeEventListener('storage', onStorage) }
    },
  }
}
