import { invokeCommand } from './transport'
import { pickCancelled, pickSave, type SaveDialogKind } from './dialogs'

/**
 * Show `kind`'s Save dialog suggesting `name`, then write the UTF-8 text through the native
 * boundary; the host gives the path the kind's extension.
 */
export async function exportFile(data: string, name: string, kind: SaveDialogKind): Promise<string> {
  const outcome = await pickSave(kind, name)
  if (outcome.kind === 'cancelled') throw pickCancelled('dialog.pick_save')
  return invokeCommand('export_file', { data, path: outcome.path })
}

/** Write the canvas PDF's bytes to `path`, a path the PDF Save dialog returned. */
export async function saveCanvasPdf(bytes: Uint8Array, path: string): Promise<void> {
  return invokeCommand('save_canvas_pdf', { data: Array.from(bytes), path })
}
