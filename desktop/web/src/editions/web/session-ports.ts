/**
 * Owner of Web's FileAccessPort, AppLifecyclePort, and real atomic-CAS DesignHomeStore over
 * `browserAppDataStore` (2.1-M526, #497 N4, `no-cancelled-literal`, ADR 0024, ADR 0025; contracts §4, §22).
 */
import {
  flattenDocumentForJson,
  isCurrentCanopiDocument,
  normalizeLoadedDocument,
  parseCanopiJsonText,
} from '../../app/contracts/document'
import type { AppLifecyclePort, LifecycleEvent } from '../../platform/app-lifecycle'
import type {
  DeleteDraftResult,
  DesignHomeStore,
  DesignHomeWriteResult,
  DraftId,
  DraftRecord,
  HomeRead,
  HomeVersion,
} from '../../platform/design-home'
import type { FileAccessPort, PickFileOutcome } from '../../platform/file-access'
import type { CanopiFile } from '../../types/design'
import {
  browserAppDataStore,
  BrowserDraftChangedError,
  DRAFTS_STORAGE_KEY,
  type BrowserAppDataStore,
} from '../../web/browser-app-data'

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
  /** Synchronous Draft flush for `beforeunload` (WEB-03); advances the expected version for this tab's next async write. */
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

  return {
    flushDraftSync(key: string, file: Parameters<typeof flattenDocumentForJson>[0], expected: HomeVersion | null): boolean {
      try {
        const alias = syncAliases.get(key)
        const effectiveExpected = alias && alias.from === expected ? alias.to : expected
        const raw = parseCanopiJsonText(JSON.stringify(flattenDocumentForJson(file)))
        if (!isCurrentCanopiDocument(raw)) return false
        const decoded = normalizeLoadedDocument(raw)
        const result = appDataStore.saveDraft({
          id: key,
          file: decoded,
          now: nextMonotonicTimestamp(now(), effectiveExpected),
          expectedUpdatedAt: effectiveExpected,
        })
        if (!result.ok) return false
        syncAliases.set(key, { from: expected, to: result.value.updatedAt })
        return true
      } catch {
        // Invalid or unserializable Draft cannot flush synchronously; caller keeps beforeunload prompt (B2).
        return false
      }
    },
    async read(key: string): Promise<HomeRead> {
      const file = appDataStore.loadDraft(key)
      if (!file) return { kind: 'absent' }
      const bytes = Array.from(encoder.encode(JSON.stringify(flattenDocumentForJson(file))))
      const version = readUpdatedAt(key) ?? ''
      return { kind: 'present', bytes, version }
    },
    async write(key: string, bytes: Uint8Array, expected: HomeVersion | null): Promise<DesignHomeWriteResult> {
      let file: CanopiFile
      try {
        const raw = parseCanopiJsonText(decoder.decode(bytes))
        if (!isCurrentCanopiDocument(raw)) {
          return {
            kind: 'failed',
            failure: { code: { kind: 'invalid' }, user_may_retry: false, op: 'web.draft.write', operation: null, detail: null },
          }
        }
        file = normalizeLoadedDocument(raw)
      } catch {
        // Invalid or non-current .canopi bytes cannot be written to browser draft storage.
        return {
          kind: 'failed',
          failure: { code: { kind: 'invalid' }, user_may_retry: false, op: 'web.draft.write', operation: null, detail: null },
        }
      }
      const alias = syncAliases.get(key)
      const effectiveExpected = alias && alias.from === expected ? alias.to : expected
      const result = appDataStore.saveDraft({
        id: key,
        file,
        now: nextMonotonicTimestamp(now(), effectiveExpected),
        expectedUpdatedAt: effectiveExpected,
      })
      if (result.ok) {
        syncAliases.delete(key)
        return { kind: 'written', version: result.value.updatedAt }
      }
      if (result.error instanceof BrowserDraftChangedError) {
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
        const file = appDataStore.loadDraft(draft.id)
        return {
          id: draft.id as DraftId,
          updatedAt: draft.updatedAt,
          bytes: file ? encoder.encode(JSON.stringify(flattenDocumentForJson(file))) : null,
        }
      })
    },
    async deleteDraft(id: DraftId): Promise<DeleteDraftResult> {
      const result = appDataStore.deleteDraft(id)
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

export const browserFileAccessPort: FileAccessPort = {
  async pickOpen(): Promise<PickFileOutcome> {
    return { kind: 'cancelled' }
  },
  async pickHomeTarget(): Promise<PickFileOutcome> {
    return { kind: 'cancelled' }
  },
}

export const browserAppLifecyclePort: AppLifecyclePort = {
  subscribe(listener: (event: LifecycleEvent) => void): () => void {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') listener({ kind: 'hidden' })
      else listener({ kind: 'shown', persisted: false })
    }
    const onPageHide = () => listener({ kind: 'hidden' })
    const onPageShow = (event: PageTransitionEvent) => listener({ kind: 'shown', persisted: event.persisted })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  },
}
