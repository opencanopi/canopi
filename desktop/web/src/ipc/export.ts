import { invoke } from '@tauri-apps/api/core'
import { pickSave, type SaveDialogKind } from './dialogs'

/**
 * Show `kind`'s Save dialog suggesting `name`, then write the UTF-8 text through the native
 * boundary; the host gives the path the kind's extension.
 */
export async function exportFile(data: string, name: string, kind: SaveDialogKind): Promise<string> {
  const outcome = await pickSave(kind, name)
  if (outcome.kind === 'cancelled') throw new Error('Dialog cancelled')
  return invoke('export_file', { data, path: outcome.path })
}
