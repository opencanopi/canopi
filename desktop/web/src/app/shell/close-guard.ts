/**
 * app/shell/close-guard.ts: Dialog adapter between SessionCore closing/replacing questions and
 * the SaveProblemDialog, plus update close-hold coordination (C4, ADR 0024, contracts §4, #497 N5).
 * SessionCore is the sole subscriber to AppLifecyclePort close-requested and focus-lost events.
 */
import { effect, signal, type ReadonlySignal } from "@preact/signals";
import type { QuestionId, QuestionKind, QuestionPurpose } from "../document-session/core";
import { activeSessionCore, getLiveSessionCore } from "../document-session/live-core";
import { answerSaveProblem, requestSaveProblemDecision } from "../document-session/save-problem";
import { holdModalLayer } from "./modal-layer";

export interface CloseGuardLifetime {
  dispose(): void;
}

export type UpdateHold = "install" | "exit";

interface CloseHold {
  readonly kind: UpdateHold;
  readonly settled: Promise<ExitAnswer>;
  waited: boolean;
}

const closeHold = signal<CloseHold | null>(null);

export const closeWaitsFor = signal<UpdateHold | null>(null);

export function holdCloseUntilSettled(kind: UpdateHold, run: Promise<ExitAnswer>): () => boolean {
  const hold: CloseHold = { kind, settled: run.catch(() => "proceed" as const), waited: false };
  closeHold.value = hold;
  void hold.settled.then(() => {
    if (closeHold.peek() === hold) closeHold.value = null;
  });
  return () => hold.waited;
}

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

type ExitPurpose = "close" | "update" | "reload";

export type ExitAnswer = "proceed" | "cancel";

export interface CloseGuardOptions {
  /** Web release reload offers Download a copy (`save-copy`) and asks again (2.1-Q83, Q188). */
  readonly downloadCopy?: () => Promise<void> | void;
}

async function promptForQuestion(
  kind: QuestionKind,
  purpose: QuestionPurpose,
  hasConflict: boolean,
  hasOpenDesign: boolean,
  options?: CloseGuardOptions,
): Promise<"retry" | "discard" | "cancel"> {
  if (kind === "settings-flush-failed-before-close") {
    const decision = await requestSaveProblemDecision(
      purpose === "reload"
        ? { kind: "settings-failed", designSaved: hasOpenDesign, purpose: "reload" }
        : { kind: "settings-failed", designSaved: hasOpenDesign },
    );
    return decision === "retry" || decision === "discard" ? decision : "cancel";
  }
  const downloadCopy = purpose === "reload" && kind !== "flush-failed-before-open" ? options?.downloadCopy : undefined;
  if (downloadCopy) {
    for (;;) {
      const decision = await requestSaveProblemDecision({
        kind: "flush-failed",
        purpose: "reload",
        conflict: hasConflict,
      });
      if (decision === "save-copy") {
        await downloadCopy();
        continue;
      }
      return decision === "retry" || decision === "discard" ? decision : "cancel";
    }
  }
  const dialogPurpose = kind === "flush-failed-before-open"
    ? "replace"
    : purpose === "reload"
      ? "app-reload"
      : "close";
  const decision = await requestSaveProblemDecision({
    kind: "flush-failed",
    purpose: dialogPurpose,
    conflict: hasConflict,
  });
  return decision === "retry" || decision === "discard" ? decision : "cancel";
}

export async function waitForCloseHold(): Promise<ExitAnswer> {
  const hold = closeHold.peek();
  if (!hold) return "proceed";
  hold.waited = true;
  closeWaitsFor.value = hold.kind;
  try {
    return await hold.settled;
  } finally {
    closeWaitsFor.value = null;
  }
}

/**
 * The one flush before Canopi exits (update install/restart or Desktop root Reload):
 * delegates to `SessionCore.close(purpose)` so the core's write lane, settings flush, and
 * question state machine run as the single authority.
 */
export async function flushBeforeExit(purpose: ExitPurpose): Promise<ExitAnswer> {
  if (purpose === "close" && (await waitForCloseHold()) === "cancel") return "cancel";
  const core = getLiveSessionCore();
  if (!core) return "proceed";
  const outcome = await core.close(purpose === "close" ? "quit" : purpose);
  return outcome === "closed" ? "proceed" : "cancel";
}

export function reloadAfterExitFlush(reload: () => void = () => location.reload()): void {
  void flushBeforeExit("reload").then((answer) => {
    if (answer === "proceed") reload();
  });
}

let activeStop: (() => void) | null = null;

/**
 * Subscribes to `SessionCore.state` closing/replacing questions and bridges each one to
 * `requestSaveProblemDecision`, calling `core.answer(id, choice)`.
 */
export function registerCloseGuard(options?: CloseGuardOptions): CloseGuardLifetime {
  activeStop?.();
  let disposed = false;
  let promptedId: QuestionId | null = null;

  const stop = effect(() => {
    const core = activeSessionCore.value;
    const state = core?.state.value;
    const question =
      state && (state.kind === "closing" || state.kind === "replacing") ? state.question : undefined;
    if (!core || !state || !question) {
      if (promptedId !== null) {
        promptedId = null;
        answerSaveProblem("cancel");
      }
      return;
    }
    if (question.id === promptedId) return;
    if (promptedId !== null) answerSaveProblem("cancel");
    promptedId = question.id;
    const current = state.kind === "closing" || state.kind === "replacing" ? state.current : undefined;
    const hasConflict = current?.save.kind === "conflict";
    const hasOpenDesign = question.designSaved ?? (current != null);
    void promptForQuestion(question.kind, question.purpose, hasConflict, hasOpenDesign, options).then((choice) => {
      if (disposed || promptedId !== question.id) return;
      promptedId = null;
      core.answer(question.id, choice);
    });
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (promptedId !== null) {
      promptedId = null;
      answerSaveProblem("cancel");
    }
    stop();
    if (activeStop === dispose) activeStop = null;
  };
  activeStop = dispose;
  return { dispose };
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    activeStop?.();
  });
}
