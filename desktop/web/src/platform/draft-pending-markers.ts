/**
 * platform/draft-pending-markers.ts: Per-tab pending-write markers for the Web Drafts
 * IndexedDB store (2b-6, canopi-f47t.52.50; contracts §11). Each tab owns its own marker
 * record keyed by `tabId` (sourced from sessionStorage so reload/crash in the same tab
 * recovers its own marker immediately without stealing a live peer tab's markers).
 */
import type { BrowserStorage } from './browser-record'

const PENDING_TABS_KEY = 'canopi:web-drafts:pending-tabs'
const PENDING_TAB_PREFIX = 'canopi:web-drafts:pending-tab:'

/** A peer tab's pending-write marker older than this is treated as crashed and taken on launch. */
export const DEFAULT_STALE_PENDING_MS = 60_000

interface PendingTabRecord {
  readonly tabId: string
  readonly updatedAtMs: number
  readonly draftIds: readonly string[]
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPendingTabIds(storage: BrowserStorage | undefined): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(PENDING_TABS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
  } catch {
    // Corrupt pending-write tab index treated as empty.
    return []
  }
}

function readPendingTabRecord(storage: BrowserStorage, tabId: string): PendingTabRecord | null {
  try {
    const raw = storage.getItem(`${PENDING_TAB_PREFIX}${tabId}`)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainRecord(parsed) || typeof parsed.updatedAtMs !== 'number' || !Array.isArray(parsed.draftIds)) return null
    const draftIds = parsed.draftIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    return { tabId, updatedAtMs: parsed.updatedAtMs, draftIds }
  } catch {
    // Corrupt per-tab marker treated as empty.
    return null
  }
}

export function markPendingWrite(storage: BrowserStorage | undefined, tabId: string, draftId: string, nowMs: number): void {
  if (!storage || tabId.length === 0 || draftId.length === 0) return
  try {
    const existing = readPendingTabRecord(storage, tabId)
    const draftIds = existing && existing.draftIds.includes(draftId)
      ? existing.draftIds
      : [...(existing?.draftIds ?? []), draftId]
    const next: PendingTabRecord = { tabId, updatedAtMs: nowMs, draftIds }
    storage.setItem(`${PENDING_TAB_PREFIX}${tabId}`, JSON.stringify(next))
    const tabs = readPendingTabIds(storage)
    if (!tabs.includes(tabId)) storage.setItem(PENDING_TABS_KEY, JSON.stringify([...tabs, tabId]))
  } catch {
    // Pending-write marker is best-effort; storage quota refusal is handled by the write lane.
  }
}

export function clearPendingWrite(storage: BrowserStorage | undefined, tabId: string, draftId: string, nowMs: number): void {
  if (!storage || tabId.length === 0 || draftId.length === 0) return
  try {
    const existing = readPendingTabRecord(storage, tabId)
    if (!existing) return
    const draftIds = existing.draftIds.filter((entry) => entry !== draftId)
    if (draftIds.length === 0) {
      storage.removeItem(`${PENDING_TAB_PREFIX}${tabId}`)
      const tabs = readPendingTabIds(storage).filter((entry) => entry !== tabId)
      if (tabs.length === 0) storage.removeItem(PENDING_TABS_KEY)
      else storage.setItem(PENDING_TABS_KEY, JSON.stringify(tabs))
    } else {
      storage.setItem(`${PENDING_TAB_PREFIX}${tabId}`, JSON.stringify({ tabId, updatedAtMs: nowMs, draftIds } satisfies PendingTabRecord))
    }
  } catch {
    // Best-effort clear of pending-write marker.
  }
}

/**
 * Takes pending-write markers that belong to this tab (surviving reload/crash via `sessionStorage` tabId)
 * or to peer tabs whose markers are older than `staleAfterMs`. Live peer tabs' markers are left untouched.
 */
export function takePendingWrites(
  storage: BrowserStorage | undefined,
  myTabId: string,
  nowMs: number,
  staleAfterMs = DEFAULT_STALE_PENDING_MS,
  reloadTabId?: string | null,
): readonly string[] {
  if (!storage) return []
  const tabs = readPendingTabIds(storage)
  const found = new Set<string>()
  const remainingTabs: string[] = []
  for (const tabId of tabs) {
    const rec = readPendingTabRecord(storage, tabId)
    if (!rec) {
      try { storage.removeItem(`${PENDING_TAB_PREFIX}${tabId}`) } catch { /* Best-effort cleanup of corrupt marker. */ }
      continue
    }
    const isOwn = tabId === myTabId || (typeof reloadTabId === 'string' && reloadTabId.length > 0 && tabId === reloadTabId)
    const isStale = nowMs - rec.updatedAtMs >= staleAfterMs
    if (isOwn || isStale) {
      for (const draftId of rec.draftIds) found.add(draftId)
      try { storage.removeItem(`${PENDING_TAB_PREFIX}${tabId}`) } catch { /* Best-effort cleanup of taken marker. */ }
    } else {
      remainingTabs.push(tabId)
    }
  }
  try {
    if (remainingTabs.length === 0) storage.removeItem(PENDING_TABS_KEY)
    else storage.setItem(PENDING_TABS_KEY, JSON.stringify(remainingTabs))
  } catch {
    // Best-effort update of pending-write tab index.
  }
  return [...found]
}
