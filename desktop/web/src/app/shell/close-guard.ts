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

/**
 * Close writes the current Design to its home first, then the settings. Only a
 * failed write asks the user anything: for the Design Retry, Close without
 * saving or Cancel; for the settings Retry, Close anyway or Cancel, Cancel
 * and Escape keeping the window open (2.1-Q20, Q176, Q182). The settings
 * dialog calls the Design saved only when a Design is open and close wrote
 * it: flush also succeeds when no Design is open, which saved nothing (M175).
 */
async function runCloseWorkflow(
  closeGuard: ActiveCloseGuard,
  currentWindow: ReturnType<typeof getCurrentWindow>,
): Promise<void> {
  let designSaved = false;
  for (;;) {
    const flushed = await designContinuousSave.flush();
    if (closeGuard.disposed) return;
    if (flushed) {
      designSaved = currentDesign.peek() !== null;
      break;
    }
    const choice = await requestSaveProblemDecision({
      kind: "flush-failed",
      purpose: "close",
      conflict: designContinuousSave.conflict.peek() !== null,
    });
    if (closeGuard.disposed || choice === "cancel") return;
    if (choice === "discard") break;
  }

  for (;;) {
    try {
      await flushSettingsProjection();
      if (closeGuard.disposed) return;
      break;
    } catch (error) {
      if (closeGuard.disposed) return;
      console.error("Failed to flush settings before close:", error);
    }
    const choice = await requestSaveProblemDecision({ kind: "settings-failed", designSaved });
    if (closeGuard.disposed || choice === "cancel") return;
    if (choice === "discard") break;
  }

  await currentWindow.destroy();
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
