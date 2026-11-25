import type { CanvasDocumentSurface } from "../../canvas/runtime/runtime";
import { computed } from "@preact/signals";
import {
  type DocumentTransitionResult,
  closeDesignSession,
  consumeQueuedDocumentLoad,
  createNewDesignSession,
  designContinuousSave,
  openDesignDraftSession,
  openDesignSessionFromDialog,
  openDesignSessionFromPath,
  resolveDesignSaveConflict,
  revertDesignSessionToOpenedVersion,
  saveCurrentDesign,
  saveCurrentDesignEdits,
  saveAsCurrentDesign,
} from "./transition";
import { presentDesignOpenFailure } from "./open-failure";

interface DocumentLoadOptions {
  session?: CanvasDocumentSurface | null;
  isCancelled?: () => boolean;
  /** Whether a failed open is shown to the user via `presentDesignOpenFailure` (defaults to `true`). */
  presentFailure?: boolean;
  /** When false, load immediately even while detached on the Start screen instead of queueing. */
  deferWhenDetached?: boolean;
}

export {
  consumeQueuedDocumentLoad,
  saveCurrentDesign,
  saveCurrentDesignEdits,
  saveAsCurrentDesign,
};

/** Continuous-save status of the current Design. */
export const designSaveStatus = computed(() => designContinuousSave.status.value);

/** Why the last continuous save failed; null unless the status is `error`. */
export const designSaveFailureReason = computed(() => designContinuousSave.failureReason.value);

/** The current Design changed since it was opened or created. */
export const designRevertAvailable = computed(() => designContinuousSave.revertAvailable.value);

/**
 * Retry a failed save: the same write Save asks for, so a refused Save of a moved view writes again even with no edit
 * pending (U30); a refusal keeps the error and a write that lands clears it.
 */
export async function retryDesignSave(): Promise<void> {
  await designContinuousSave.save();
}

/** Open the dialog that resolves a file changed outside Canopi. */
export async function resolveDesignConflict(): Promise<void> {
  throwIfFailed(await resolveDesignSaveConflict());
}

/** Replace the current Design with the version it had when opened. */
export async function revertDesign(): Promise<void> {
  throwIfFailed(await revertDesignSessionToOpenedVersion());
}

/** Open a Design Draft through the shared replacement path. */
export async function openDesignDraft(
  id: string,
  options: Pick<DocumentLoadOptions, "presentFailure"> = {},
): Promise<void> {
  const result = await openDesignDraftSession(id);
  if (options.presentFailure !== false) presentIfFailed(result);
  throwIfFailed(result);
}

/** Open file dialog and replace the active document through the shared guard. */
export async function openDesign(): Promise<void> {
  const result = await openDesignSessionFromDialog();

  presentIfFailed(result);
  throwIfFailed(result);
}

/** Open a design from a known path (for example, recent files). */
export async function openDesignFromPath(
  path: string,
  options: DocumentLoadOptions = {},
): Promise<void> {
  const result = await openDesignSessionFromPath(path, {
    session: options.session,
    isCancelled: options.isCancelled,
    deferWhenDetached: options.deferWhenDetached,
  });

  if (options.presentFailure !== false) presentIfFailed(result);
  throwIfFailed(result);
}

/** Create a new blank design through the shared replacement guard. */
export async function newDesignAction(): Promise<void> {
  const result = await createNewDesignSession();

  throwIfFailed(result);
}

/**
 * Close the current Design and return to the Start screen. Continuous save
 * writes it home first; only a failed write asks (Cancel keeps it open).
 */
export async function closeDesign(): Promise<void> {
  throwIfFailed(await closeDesignSession());
}

/** A Design that could not be opened is told to the user before the caller sees the error. */
function presentIfFailed(result: DocumentTransitionResult | null): void {
  if (result?.status === "failed") presentDesignOpenFailure(result.error);
}

function throwIfFailed(result: DocumentTransitionResult | null): void {
  if (result?.status === "failed") {
    throw result.error;
  }
}
