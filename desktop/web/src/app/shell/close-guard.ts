import { effect, signal, type ReadonlySignal } from "@preact/signals";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { designContinuousSave } from "../document-session/transition";
import { requestSaveProblemDecision } from "../document-session/save-problem";
import { currentDesign } from "../document-session/store";
import { flushSettingsProjection } from "../settings/projection";
import { holdModalLayer } from "./modal-layer";

export interface CloseGuardLifetime {
  dispose(): void;
}

interface ActiveCloseGuard {
  disposed: boolean;
  closePromise: Promise<void> | null;
  unlisteners: (() => void)[];
}

let activeCloseGuard: ActiveCloseGuard | null = null;

/** An update install a window close waits for, and whether a close is waiting for it. */
interface CloseHold {
  readonly settled: Promise<void>;
  waited: boolean;
}

/** The update install a window close waits for now; null when none runs. */
const closeHold = signal<CloseHold | null>(null);

/** A window close is waiting for an update install to settle: the Desktop root shows "Installing update…". */
export const closeWaitsForInstall = signal(false);

/**
 * Holds every window close until `install` settles, installed or failed (2.1-Q254): a close never ends Canopi in the
 * middle of an install, which would leave a truncated AppImage or an orphaned `pkexec` prompt. The close then runs as
 * usual, without restarting. The answer, read once the install has settled, is whether a close waited for it: the
 * caller then leaves the exit to that close and does not restart (app/updates/controller.ts).
 */
export function holdCloseUntilSettled(install: Promise<unknown>): () => boolean {
  const hold: CloseHold = { settled: install.then(() => undefined, () => undefined), waited: false };
  closeHold.value = hold;
  void hold.settled.then(() => {
    if (closeHold.peek() === hold) closeHold.value = null;
  });
  return () => hold.waited;
}

/**
 * Blocks every Design edit while `exiting` holds: an update's close request, until Canopi exits or the exit is called
 * off (app/updates/controller.ts `exiting`). The exit flush writes the edits made so far and the native drain waits
 * only for writes already sent, so an edit made after the flush would wait in continuous save's delay and be lost.
 * The block is the modal layer's hold: the workspace is inert and keyboard routes stand aside. Returns the binding's
 * end, which drops a hold still open.
 */
export function blockEditsWhile(exiting: ReadonlySignal<boolean>): () => void {
  let release: (() => void) | null = null;
  const drop = () => {
    release?.();
    release = null;
  };
  const stop = effect(() => {
    if (exiting.value) release ??= holdModalLayer();
    else drop();
  });
  return () => {
    stop();
    drop();
  };
}

/** Why Canopi is about to exit: the window's close, or an update's install or restart (2.1-M209). */
type ExitPurpose = "close" | "update";

/** What the exit flush answers: go on and exit, or keep Canopi open. */
type ExitAnswer = "proceed" | "cancel";

/**
 * Before Canopi exits it writes the current Design to its home first, then the settings. Only a failed write asks the
 * user anything: for the Design Retry, Close without saving or Cancel; for the settings Retry, Close anyway or Cancel,
 * Cancel and Escape keeping Canopi open (2.1-Q20, Q176, Q182, M71). The settings dialog calls the Design saved only
 * when a Design is open and the flush wrote it: flush also succeeds when no Design is open, which saved nothing
 * (M175). `abandoned` ends the flush with cancel, asking nothing more, once the caller no longer needs its answer.
 */
async function runExitFlush(purpose: ExitPurpose, abandoned: () => boolean): Promise<ExitAnswer> {
  let designSaved = false;
  for (;;) {
    const flushed = await designContinuousSave.flush();
    if (abandoned()) return "cancel";
    if (flushed) {
      designSaved = currentDesign.peek() !== null;
      break;
    }
    const choice = await requestSaveProblemDecision({
      kind: "flush-failed",
      purpose: "close",
      conflict: designContinuousSave.conflict.peek() !== null,
    });
    if (abandoned() || choice === "cancel") return "cancel";
    if (choice === "discard") break;
  }

  for (;;) {
    try {
      await flushSettingsProjection();
      if (abandoned()) return "cancel";
      break;
    } catch (error) {
      if (abandoned()) return "cancel";
      console.error(`Failed to flush settings before ${purpose}:`, error);
    }
    const choice = await requestSaveProblemDecision({ kind: "settings-failed", designSaved });
    if (abandoned() || choice === "cancel") return "cancel";
    if (choice === "discard") break;
  }
  return "proceed";
}

/**
 * The one flush before Canopi exits, for a caller that exits by its own means: an update's installer or restart awaits
 * the answer and exits only on proceed (2.1-M209, AF30). Until 2b's app-lifecycle port it asks nothing about a running
 * LiDAR job, so an update install stops it as today's Quit does (2.1-M63).
 */
export function flushBeforeExit(purpose: ExitPurpose): Promise<ExitAnswer> {
  return runExitFlush(purpose, () => false);
}

/**
 * The window's close: first the update install it must wait for, if one runs (the window stays open, showing
 * "Installing update…"), then the exit flush, then the window is destroyed only on proceed.
 */
async function runCloseWorkflow(
  closeGuard: ActiveCloseGuard,
  currentWindow: ReturnType<typeof getCurrentWindow>,
): Promise<void> {
  const hold = closeHold.peek();
  if (hold) {
    hold.waited = true;
    closeWaitsForInstall.value = true;
    try {
      await hold.settled;
    } finally {
      closeWaitsForInstall.value = false;
    }
    if (closeGuard.disposed) return;
  }
  const answer = await runExitFlush("close", () => closeGuard.disposed);
  if (answer === "proceed" && !closeGuard.disposed) await currentWindow.destroy();
}

/**
 * The Desktop window guard: flushes the current Design when the window loses
 * focus and before it closes.
 */
export function registerCloseGuard(): CloseGuardLifetime {
  if (activeCloseGuard) disposeCloseGuard(activeCloseGuard);

  const closeGuard: ActiveCloseGuard = {
    disposed: false,
    closePromise: null,
    unlisteners: [],
  };
  activeCloseGuard = closeGuard;
  const currentWindow = getCurrentWindow();

  const keepListener = (unlisten: () => void) => {
    if (closeGuard.disposed || activeCloseGuard !== closeGuard) {
      unlisten();
      return;
    }
    closeGuard.unlisteners.push(unlisten);
  };
  const reportRegistrationFailure = (error: unknown) => {
    if (!closeGuard.disposed && activeCloseGuard === closeGuard) {
      console.error("Failed to register close guard:", error);
    }
  };

  void currentWindow
    .onCloseRequested((event) => {
      event.preventDefault();
      if (closeGuard.disposed) return;
      if (closeGuard.closePromise) return closeGuard.closePromise;

      const closePromise = runCloseWorkflow(closeGuard, currentWindow).catch((error) => {
        console.error("Failed to complete close workflow:", error);
      });
      closeGuard.closePromise = closePromise;
      void closePromise.then(() => {
        if (closeGuard.closePromise === closePromise) closeGuard.closePromise = null;
      });
      return closePromise;
    })
    .then(keepListener)
    .catch(reportRegistrationFailure);

  void currentWindow
    .onFocusChanged(({ payload: focused }) => {
      if (focused || closeGuard.disposed) return;
      void designContinuousSave.flush().catch((error: unknown) => {
        console.error("Failed to save the Design when the window lost focus:", error);
      });
    })
    .then(keepListener)
    .catch(reportRegistrationFailure);

  return {
    dispose: () => disposeCloseGuard(closeGuard),
  };
}

function disposeCloseGuard(closeGuard: ActiveCloseGuard): void {
  if (closeGuard.disposed) return;
  closeGuard.disposed = true;
  for (const unlisten of closeGuard.unlisteners.splice(0)) unlisten();
  if (activeCloseGuard === closeGuard) activeCloseGuard = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (activeCloseGuard) disposeCloseGuard(activeCloseGuard);
  });
}
