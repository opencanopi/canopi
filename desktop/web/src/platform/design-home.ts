/**
 * platform/design-home.ts: L1 port for reading and durably writing Design homes
 * (2b-3, 2b-4; contracts §4, ADR 0024, ADR 0027, 2.1-Q165, 2.1-M526).
 */
import type {
  DraftId,
  Failure,
  FileGrantId,
  HomeRead,
  HomeVersion,
  HomeWrite,
  LastOpenHome,
} from '../generated/contracts'

export type { DraftId, FileGrantId, HomeRead, HomeVersion, LastOpenHome }

/** SHA-256 of a 0-byte file (FAT32/exFAT crash remnant fingerprint; #341, #400). */
export const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' as HomeVersion

/** A Design's durable home identity and last acknowledged compare-and-swap version. */
export type DesignHome =
  | {
      readonly kind: 'file'
      readonly key: FileGrantId
      readonly displayName: string
      readonly recentId?: string
      readonly version: HomeVersion | null
    }
  | {
      readonly kind: 'draft'
      readonly key: DraftId
      readonly version: HomeVersion | null
    }

/** Single open source union accepted by `core.openFrom(source)` (contracts §4). */
export type DesignSource =
  | {
      readonly kind: 'file'
      readonly grant: FileGrantId
      readonly displayName?: string
      readonly recentId?: string
    }
  | { readonly kind: 'bytes'; readonly name: string; readonly bytes: Uint8Array }
  | { readonly kind: 'draft'; readonly id: DraftId }

/** Raw Draft record returned by `DesignHomeStore.listDrafts()`. */
export interface DraftRecord {
  readonly id: DraftId
  readonly updatedAt: string
  readonly bytes: Uint8Array | null
  readonly unreadableReason?: string
}

/** Result of writing a home through `DesignHomeStore` (extends Desktop's `HomeWrite` with Web `quota_refused`). */
export type DesignHomeWriteResult =
  | HomeWrite
  | { readonly kind: 'quota_refused' }

export type DeleteDraftResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: Failure }

/** Canonical home identity string used for already-open checks, Notebook keys, and deleteDraft guards. */
export function homeKey(home: Pick<DesignHome, 'kind' | 'key'>): string {
  return `${home.kind}:${home.key}`
}

/**
 * Canonical `file:<recent_id>` / `draft:<id>` encoder and decoder for `last_open_home`
 * (contracts §4, 2.1-M523, reconciled with 2b-4 `#430`).
 */
/**
 * Canonical `last_open_home` codec (2b-4; #430, #481 N5):
 * File homes encode as `file:<sha256-of-path>` (TS SHA-256 of the path, resolved against
 * `getRecentFiles()` at Desktop launch so raw filesystem paths never persist in settings).
 */
export function encodeLastOpenHome(home: LastOpenHome | null): string | null {
  if (!home) return null
  return home.kind === 'draft' ? `draft:${home.id}` : `file:${home.recent_id}`
}

export function decodeLastOpenHome(raw: string | null | undefined): LastOpenHome | null {
  if (!raw) return null
  const colon = raw.indexOf(':')
  const value = colon > 0 ? raw.slice(colon + 1).trim() : ''
  if (!value) return null
  const kind = raw.slice(0, colon)
  if (kind === 'draft') return { kind: 'draft', id: value as DraftId }
  if (kind === 'file') return { kind: 'file', recent_id: value }
  return null
}

/**
 * Computes the stable `recent_id` for a Desktop Recent Designs path (`file:<sha256-of-path>`),
 * shared by `editions/desktop/last-open-home.ts` and `updater.spec.ts` until `get_recent_files`
 * emits a native `recent_id` column (#430).
 */
export async function recentFileIdForPath(path: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Unified Design home store port implemented by Desktop (`home_read`/`home_write`) and Web
 * (IndexedDB Drafts). Adapters resolve keys and never branch on `DesignHome.kind` (contracts §4).
 */
export interface DesignHomeStore {
  read(key: string): Promise<HomeRead>
  write(
    key: string,
    bytes: Uint8Array,
    expected: HomeVersion | null,
    options?: { readonly keepPrevious?: boolean },
  ): Promise<DesignHomeWriteResult>
  listDrafts(): Promise<readonly DraftRecord[]>
  deleteDraft(id: DraftId): Promise<DeleteDraftResult>
  onVersionChange(cb: () => void): () => void
}

/** Narrow read/write subset used by Desktop's native `home_read`/`home_write` IPC wrapper (2b-4). */
export interface DesktopHomePort {
  read(key: string): Promise<HomeRead>
  write(
    key: string,
    bytes: Uint8Array,
    expected: HomeVersion | null,
    options?: { readonly keepPrevious?: boolean },
  ): Promise<HomeWrite>
}
