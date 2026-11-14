import type { CanvasDocumentSurface } from "../../canvas/runtime/runtime";
import { failureLogger } from "../../failures/report";
import * as designIpc from "../../ipc/design";
import {
  applyNewDesignBackground,
  withNewDesignDisplay,
} from "../settings/new-design-defaults";
import {
  createDesignSessionStateMachine,
  type DocumentTransitionResult,
  type QueuedDocumentLoadOptions,
  type SaveCurrentDesignOptions,
  type TeardownDesignSessionOptions,
} from "./state-machine";
import { draftLoadResultOf, loadResultOf } from "./load-result";
import type { DesignSaveSettlement } from "./persistence";
import { setPendingDesignPath } from "./store";

export { type DocumentTransitionResult } from "./state-machine";

const designSessionStateMachine = createDesignSessionStateMachine();

interface DesignSessionLoadOptions {
  readonly session?: CanvasDocumentSurface | null;
  readonly isCancelled?: () => boolean;
}

export function captureCurrentDesignObservation() {
  return designSessionStateMachine.captureCurrentDesignObservation();
}

/** @testonly */
export function resetDesignSessionStateForTests(): void {
  designSessionStateMachine.resetState();
}

export function startAttachedDesignSession(
  session: CanvasDocumentSurface,
): Promise<DocumentTransitionResult | null> {
  return designSessionStateMachine.startAttachedDesignSession(session);
}

export function abortFailedAttachedDesignSessionStart(
  session: CanvasDocumentSurface,
  logError: (message?: unknown, ...optionalParams: unknown[]) => void = failureLogger("document-session"),
): void {
  designSessionStateMachine.teardownAttachedDesignSession({
    session,
    runtimeInitialized: false,
    logError,
  });
}

export function consumeQueuedDocumentLoad(
  session: CanvasDocumentSurface,
  options: QueuedDocumentLoadOptions = {},
): () => void {
  return designSessionStateMachine.consumeQueuedDocumentLoad(session, options);
}

/** The continuous-save core of the Desktop Design Session. */
export const designContinuousSave = designSessionStateMachine.continuousSave;

/** Install continuous save for the Desktop application lifetime. */
export function installDesignContinuousSave(): () => void {
  return designContinuousSave.install();
}

export function saveCurrentDesign(
  options: SaveCurrentDesignOptions = {},
): Promise<boolean> {
  return designSessionStateMachine.saveCurrentDesign(options);
}

export function saveCurrentDesignEdits(
  options: SaveCurrentDesignOptions = {},
): Promise<boolean> {
  return designSessionStateMachine.saveCurrentDesignEdits(options);
}

export function resolveDesignSaveConflict(): Promise<DocumentTransitionResult | null> {
  return designSessionStateMachine.resolveSaveConflict();
}

export function revertDesignSessionToOpenedVersion(): Promise<DocumentTransitionResult> {
  return designSessionStateMachine.revertToOpenedVersion();
}

export function saveAsCurrentDesign(
  options: SaveCurrentDesignOptions = {},
): Promise<DesignSaveSettlement | null> {
  return designSessionStateMachine.saveAsCurrentDesign(options);
}

export function openDesignSessionFromDialog(): Promise<DocumentTransitionResult> {
  return designSessionStateMachine.transitionDocument({
    source: "open-dialog",
    dirtyGuard: "flush",
    load: async () => {
      const { design, path } = await designIpc.openDesignDialog();
      return loadResultOf(design, path);
    },
  });
}

export function openDesignSessionFromPath(
  path: string,
  options: DesignSessionLoadOptions = {},
): Promise<DocumentTransitionResult> {
  return designSessionStateMachine.transitionDocument({
    source: "open-path",
    dirtyGuard: "flush",
    session: options.session,
    load: () => designSessionStateMachine.loadDesignFromPath(path),
    isCancelled: options.isCancelled,
    deferWhenDetachedAndEmpty: () => {
      setPendingDesignPath(path);
    },
  });
}

export async function createNewDesignSession(): Promise<DocumentTransitionResult> {
  const draftId = createDraftId();
  const result = await designSessionStateMachine.transitionDocument({
    source: "new",
    dirtyGuard: "flush",
    load: async () => ({
      file: withNewDesignDisplay(await designIpc.newDesign()),
      path: null,
      name: "Untitled",
      draftId,
    }),
  });
  if (result.status === "applied") applyNewDesignBackground();
  return result;
}

export function openDesignDraftSession(id: string): Promise<DocumentTransitionResult> {
  return designSessionStateMachine.transitionDocument({
    source: "open-draft",
    dirtyGuard: "flush",
    load: async () => draftLoadResultOf(await designIpc.loadDesignDraft(id), id),
  });
}

export function closeDesignSession(): Promise<DocumentTransitionResult> {
  return designSessionStateMachine.closeDesign();
}

export function teardownAttachedDesignSession(options: TeardownDesignSessionOptions): void {
  designSessionStateMachine.teardownAttachedDesignSession(options);
}

function createDraftId(): string {
  return globalThis.crypto.randomUUID();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    designContinuousSave.dispose();
  });
}
