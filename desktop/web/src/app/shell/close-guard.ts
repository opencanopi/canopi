import { getCurrentWindow } from "@tauri-apps/api/window";
import { designContinuousSave } from "../document-session/transition";
import { requestSaveProblemDecision } from "../document-session/save-problem";
import { currentDesign } from "../document-session/store";
import { flushSettingsProjection } from "../settings/projection";

export interface CloseGuardLifetime {
  dispose(): void;
}

interface ActiveCloseGuard {
  disposed: boolean;
  closePromise: Promise<void> | null;
  unlisteners: (() => void)[];
}

let activeCloseGuard: ActiveCloseGuard | null = null;

/** Why Canopi is about to exit: the window's close, or an update's install or restart (2.1-M209). */
export type ExitPurpose = "close" | "update";

/** What the exit flush answers: go on and exit, or keep Canopi open. */
export type ExitAnswer = "proceed" | "cancel";

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

/** The window's close: the exit flush, then the window is destroyed only on proceed. */
async function runCloseWorkflow(
  closeGuard: ActiveCloseGuard,
  currentWindow: ReturnType<typeof getCurrentWindow>,
): Promise<void> {
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
