import { invokeCommand } from './transport'
import type { DialogKind, PickOpenOutcome, PickSaveOutcome } from '../generated/contracts'
import { failureOf, IpcFailure } from '../failures/ipc-failure'

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
  return invokeCommand<PickOpenOutcome>('pick_open', { kind }).catch(cancelIfAlreadyOpen)
}

/**
 * Show `kind`'s Save dialog suggesting `stem`; the host adds the kind's first extension to a name
 * that has none of the kind's, in the suggestion and the answer.
 */
export async function pickSave(kind: SaveDialogKind, stem: string): Promise<PickSaveOutcome> {
  return invokeCommand<PickSaveOutcome>('pick_save', { kind, stem }).catch(cancelIfAlreadyOpen)
}

/**
 * The settlement a caller throws when the user dismissed its pick: the typed `cancelled` code under the pick's op,
 * which isCancelledFailure reads; no text says it, so a real failure whose text says "cancelled" is never taken for
 * one (canopi-f47t.52.172).
 */
export function pickCancelled(op: 'dialog.pick_open' | 'dialog.pick_save'): IpcFailure {
  return new IpcFailure({ code: { kind: 'cancelled' }, user_may_retry: false, op, operation: null, detail: null }, 'The dialog was dismissed')
}

/** A cancel for the host's refusal of a second dialog; any other rejection unchanged. */
function cancelIfAlreadyOpen(error: unknown): { kind: 'cancelled' } {
  if (failureOf(error)?.code.kind === 'dialog_already_open') return { kind: 'cancelled' }
  throw error
}
