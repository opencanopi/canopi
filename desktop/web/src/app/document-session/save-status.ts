/**
 * app/document-session/save-status.ts: Pure projection from Session Core SaveState + dirty to
 * DesignSaveStatus used by TitleBar and SaveStatusLabel (contracts §4).
 */
import type { SaveState } from './core'

/**
 * `draft`: the Design lives in a Design Draft (never saved to a file); Canopi keeps every change there.
 * `saved`/`saving` describe a Design with a file; `read-only` shows a newer or unchecked Design without writing.
 */
export type DesignSaveStatus = 'saved' | 'saving' | 'draft' | 'error' | 'conflict' | 'read-only'

export function saveStatusOf(
  save: SaveState,
  dirty: boolean,
  options?: { readonly readOnly?: boolean; readonly homeKind?: 'file' | 'draft' },
): DesignSaveStatus {
  if (options?.readOnly) return 'read-only'
  if (save.kind === 'conflict') return 'conflict'
  if (save.kind === 'failed' || save.kind === 'refused' || save.kind === 'quota' || save.kind === 'copy_blocked') {
    return 'error'
  }
  if (options?.homeKind === 'draft') return 'draft'
  if (save.kind === 'writing' || save.kind === 'pending' || save.kind === 'busy' || dirty) return 'saving'
  return 'saved'
}
