/**
 * app/document-session/core/helpers.ts: Pure document patch, source reading, and home-identity
 * helpers for Session Core (keeps session-core.ts below the 600-line ceiling and complexity <= 20).
 */
import {
  type DesignHome,
  type DesignHomeStore,
  type DesignSource,
} from '../../../platform/design-home'
import type { CanopiFile } from '../../../types/design'
import { mintDraftId } from '../../../utils/ids'
import type { DocumentHistoryDelta } from './history'
import { deepFreezeDev, type DeepReadonly } from './immutable'

export function sameHome(a: DesignHome, source: DesignSource): boolean {
  if (source.kind === 'file' && a.kind === 'file') return a.key === source.grant
  if (source.kind === 'draft' && a.kind === 'draft') return a.key === source.id
  return false
}

export function diffDocumentPatch(
  current: DeepReadonly<CanopiFile>,
  patch: Partial<DeepReadonly<CanopiFile>>,
): DocumentHistoryDelta | null {
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const [key, nextVal] of Object.entries(patch)) {
    const prevVal = (current as Record<string, unknown>)[key]
    if (prevVal === nextVal) continue
    before[key] = prevVal
    after[key] = nextVal
  }
  if (Object.keys(after).length === 0) return null
  return { before, after }
}

/** Shallow-merges a top-level Document patch with structural sharing and dev-mode deep freeze. */
export function mergeFrozenDocument<T extends object>(base: DeepReadonly<T>, patch: Partial<DeepReadonly<T>>): DeepReadonly<T> {
  return deepFreezeDev({ ...(base as T), ...(patch as Partial<T>) })
}

export type ReadSourceResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly home: DesignHome }
  | {
    readonly ok: false
    readonly reason: string
    readonly error: { readonly kind: 'missing' | 'too_large' | 'unreadable'; readonly message: string }
  }

export async function readDesignSource(
  designHome: DesignHomeStore,
  source: DesignSource,
): Promise<ReadSourceResult> {
  if (source.kind === 'bytes') {
    return {
      ok: true,
      bytes: source.bytes,
      home: { kind: 'draft', key: mintDraftId(), version: null },
    }
  }
  const read = await designHome.read(source.kind === 'file' ? source.grant : source.id)
  if (read.kind !== 'present') {
    const reason = read.kind === 'unreadable' ? read.reason : 'absent'
    const kind = read.kind === 'absent'
      ? 'missing'
      : read.reason === 'too_large'
        ? 'too_large'
        : 'unreadable'
    return { ok: false, reason, error: { kind, message: reason } }
  }
  const home: DesignHome = source.kind === 'file'
    ? {
        kind: 'file',
        key: source.grant,
        displayName: source.displayName ?? source.grant,
        ...(source.recentId ? { recentId: source.recentId } : {}),
        version: read.version,
      }
    : { kind: 'draft', key: source.id, version: read.version }
  return { ok: true, bytes: new Uint8Array(read.bytes), home }
}
