// ipc/dialogs.ts
// Owner of the dialog pick outcome (no-cancelled-literal, ADR 0025; §18 R14, 2.1-M268). Invariant: 'cancelled' is
// a PickOpenOutcome or PickSaveOutcome value, returned only when the user dismisses the system dialog or a second
// dialog is refused with dialog_already_open (2.1-Q284); ast-grep skips this file, so a hand-written cancel guard
// added here goes uncounted and belongs to the catalogue's CancelToken instead.

import { invoke } from '@tauri-apps/api/core'
import type { DialogKind, Failure, PickOpenOutcome, PickSaveOutcome } from '../generated/contracts'

// Host file dialogs (2.1-M81): the page names what a dialog is for and the host shows the system's
// Open or Save dialog, with the system's own title, the kind's filter and start folder
// (`desktop/src/host/dialogs.rs`). The page holds no dialog permission; Phase 2b turns the paths
// into file grants. Both commands reject with a catalogue `Failure`. A second dialog while one is
// open in the window is refused with the silent `dialog_already_open`: the host has brought the open
// one forward and recorded it, so the wire settles that request as a cancel and no caller shows a
// notice (2.1-Q284). The kinds and answers are generated from `canopi_types::dialog`.

/** The kinds whose Open dialog answers the page with paths. */
type OpenDialogKind = Extract<DialogKind, 'design-open' | 'stamp-import' | 'lidar-geotiff-import'>

/** The kinds of Save dialog. */
export type SaveDialogKind = Extract<
  DialogKind,
  'design-save' | 'stamp-export' | 'geojson-export' | 'pdf-export' | 'budget-csv-export'
>

/** Show `kind`'s Open dialog. */
export async function pickOpen(kind: OpenDialogKind): Promise<PickOpenOutcome> {
  return invoke<PickOpenOutcome>('pick_open', { kind }).catch(cancelIfAlreadyOpen)
}

/**
 * Show `kind`'s Save dialog suggesting `stem`; the host adds the kind's first extension to a name
 * that has none of the kind's, in the suggestion and the answer.
 */
export async function pickSave(kind: SaveDialogKind, stem: string): Promise<PickSaveOutcome> {
  return invoke<PickSaveOutcome>('pick_save', { kind, stem }).catch(cancelIfAlreadyOpen)
}

/** A cancel for the host's refusal of a second dialog; any other rejection unchanged. */
function cancelIfAlreadyOpen(error: unknown): { kind: 'cancelled' } {
  if ((error as Partial<Failure> | null)?.code?.kind === 'dialog_already_open') return { kind: 'cancelled' }
  throw error
}
