import { invoke } from '@tauri-apps/api/core'

// Host file dialogs (2.1-M81): the page names what a dialog is for and the host shows the system's
// Open or Save dialog, with the system's own title, the kind's filter and start folder
// (`desktop/src/host/dialogs.rs`). The page holds no dialog permission; Phase 2b turns the paths
// into file grants. A second dialog while one is open in the window is refused with the error
// `file-dialog-already-open`, which the error catalogue (Phase 1a) types.

/** One purpose a host file dialog serves (`common_types::dialog::DialogKind`). */
export type DialogKind =
  | 'design-open'
  | 'design-save'
  | 'stamp-import'
  | 'stamp-export'
  | 'geojson-import'
  | 'geojson-export'
  | 'pdf-export'
  | 'budget-csv-export'
  | 'lidar-geotiff-import'

/** The kinds whose Open dialog answers the page with paths. */
export type OpenDialogKind = Extract<DialogKind, 'design-open' | 'stamp-import' | 'lidar-geotiff-import'>

/** The kinds of Save dialog. */
export type SaveDialogKind = Extract<
  DialogKind,
  'design-save' | 'stamp-export' | 'geojson-export' | 'pdf-export' | 'budget-csv-export'
>

/** What an Open dialog answered: one path unless the kind allows several. */
export type PickOpenOutcome = { kind: 'cancelled' } | { kind: 'picked'; paths: string[] }

/** What a Save dialog answered: the path ends in one of the kind's extensions. */
export type PickSaveOutcome = { kind: 'cancelled' } | { kind: 'picked'; path: string }

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
