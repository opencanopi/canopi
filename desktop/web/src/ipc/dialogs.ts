import { invoke } from '@tauri-apps/api/core'
import type { DialogKind, PickOpenOutcome, PickSaveOutcome } from '../generated/contracts'

// Host file dialogs (2.1-M81): the page names what a dialog is for and the host shows the system's
// Open or Save dialog, with the system's own title, the kind's filter and start folder
// (`desktop/src/host/dialogs.rs`). The page holds no dialog permission; Phase 2b turns the paths
// into file grants. A second dialog while one is open in the window is refused with the error
// `file-dialog-already-open`, which the error catalogue (Phase 1a) types. The kinds and answers are
// generated from `common_types::dialog`.

/** The kinds whose Open dialog answers the page with paths. */
type OpenDialogKind = Extract<DialogKind, 'design-open' | 'stamp-import' | 'lidar-geotiff-import'>

/** The kinds of Save dialog. */
export type SaveDialogKind = Extract<
  DialogKind,
  'design-save' | 'stamp-export' | 'geojson-export' | 'pdf-export' | 'budget-csv-export'
>

/** Show `kind`'s Open dialog. */
export async function pickOpen(kind: OpenDialogKind): Promise<PickOpenOutcome> {
  return invoke<PickOpenOutcome>('pick_open', { kind })
}

/**
 * Show `kind`'s Save dialog suggesting `stem`; the host adds the kind's first extension to a name
 * that has none of the kind's, in the suggestion and the answer.
 */
export async function pickSave(kind: SaveDialogKind, stem: string): Promise<PickSaveOutcome> {
  return invoke<PickSaveOutcome>('pick_save', { kind, stem })
}
