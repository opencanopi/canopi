import { decodeCanopiDesign } from "../app/contracts/design-ingestion";
import { asCanopiDesignIngestionError } from "../app/contracts/canopi-design-errors";
import { encodeCanopiDesign } from "../app/contracts/canopi-design-wire";
import { DEFAULT_BUDGET_CURRENCY } from "../app/contracts/document";
import type { DesignTemplateEnvelope } from "../app/design-template-import/types";
import {
  createContinuousSave,
  DesignHomeConflictError,
  type ContinuousSave,
  type DesignHome,
  type HomeWriteOutcome,
} from "../app/document-session/continuous-save";
import {
  createCloseDesignReplacement,
  createDesignSessionReplacement,
  type DesignSessionPendingCanvasReplacementIdentity,
  type ResolvedDesignReplacement,
} from "../app/document-session/replacement";
import { presentDesignOpenFailure } from "../app/document-session/open-failure";
import { requestSaveProblemDecision } from "../app/document-session/save-problem";
import {
  designSessionStore,
  type PersistenceCapableDesignSessionStore,
} from "../app/document-session/store";
import { DESIGN_SESSION_WORKFLOWS } from "../app/document-session/workflows";
import {
  createDesignSessionWorkflowRunner,
  type DesignSessionWorkflowRunner,
} from "../app/document-session/workflow-runner";
import {
  createDesignSessionPersistence,
  DesignPersistenceLeaseError,
  type DesignReplacementGuardCapture,
} from "../app/document-session/persistence";
import {
  prepareDesignWriteDestination,
  prepareSynchronousDesignWriteDestination,
} from "../app/document-session/write-admission";
import {
  CanvasAuthorityBusyError,
  type CanvasDocumentSurface,
} from "../canvas/runtime/runtime";
import type { CanopiFile } from "../types/design";
import {
  applyNewDesignBackground,
  withNewDesignDisplay,
} from "../app/settings/new-design-defaults";
import { CURRENT_CANOPI_FILE_VERSION } from "../generated/canopi-design-format";
import {
  NEW_DESIGN_LAYER_DEFAULTS,
} from "../generated/new-design-defaults";
import {
  browserAppDataStore,
  BrowserDraftChangedError,
  type BrowserAppDataStore,
  type BrowserAppDataWriteResult,
  type BrowserDraftSummary,
} from "./browser-app-data";
import type { BrowserShellDesignIdentity } from "./browser-shell-commands";
import { browserDraftPersistence } from "./browser-draft-persistence";
import { downloadBrowserTextFile, pickBrowserTextFile } from "./browser-text-files";

export interface BrowserOpenedCanopiFile {
  readonly fileName: string;
  readonly text: string;
}

export interface BrowserCanopiDownload {
  readonly fileName: string;
  readonly text: string;
}

export interface BrowserDesignFileAdapter {
  openCanopiFile(): Promise<BrowserOpenedCanopiFile | null>;
  downloadCanopiFile(download: BrowserCanopiDownload): Promise<void>;
}

/** Page events that end a visit; continuous save flushes on them. */
export interface BrowserPageLifecycleTarget {
  readonly document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
}

interface BrowserDesignSessionControllerOptions {
  readonly store?: PersistenceCapableDesignSessionStore;
  readonly fileAdapter?: BrowserDesignFileAdapter;
  readonly appDataStore?: BrowserAppDataStore;
  readonly now?: () => Date;
  readonly createDraftId?: () => string;
  readonly workflowRunner?: DesignSessionWorkflowRunner;
  readonly requestSaveDecision?: typeof requestSaveProblemDecision;
  /** Tells the user why a picked file cannot be opened (older, newer, damaged). */
  readonly presentOpenFailure?: (error: unknown) => void;
  readonly saveDelayMs?: number;
  /**
   * Asks the browser to keep Drafts, once per launch (2.1-Q82, M180). Called first, before any await, by New and
   * Open, so Firefox's prompt keeps the click's activation; Open template never asks (2.1-Q198).
   */
  readonly requestDraftPersistence?: () => void;
  /** Loads the page again, on the release the server now serves (2.1-Q83). */
  readonly reload?: () => void;
}

export interface BrowserDesignSessionController {
  readonly continuousSave: Pick<ContinuousSave, "status" | "revertAvailable" | "flush" | "save">;
  hasCurrentDesign(): boolean;
  readDesignIdentity(): BrowserShellDesignIdentity | null;
  newDesign(): Promise<void>;
  /** Write the Design to its Draft, then close it; false when cancelled or nothing was open. */
  closeDesign(): Promise<boolean>;
  openCanopi(): Promise<boolean>;
  openCanopiTemplate(
    template: DesignTemplateEnvelope,
    options?: { readonly isCancelled?: () => boolean },
  ): Promise<"opened" | "cancelled">;
  downloadCanopi(): Promise<void>;
  /** Download a copy of a stored Draft without opening it (the welcome screen's Draft row, 2.1-Q193). */
  downloadDraft(id: string): Promise<void>;
  renameDesign(name: string): void;
  revertDesign(): Promise<boolean>;
  /** Ask how to settle a Draft another browser tab changed, then act on it. */
  resolveSaveConflict(): Promise<void>;
  /**
   * Reload for a waiting release (2.1-Q83, Q188, Q189): write the Design first, asking only when that write fails
   * (Retry, Download a copy, Reload without saving, Cancel), note this tab's Draft so the reload reopens it, then
   * reload. False when cancelled; a call while one runs joins it.
   */
  reloadForRelease(): Promise<boolean>;
  listDrafts(): readonly BrowserDraftSummary[];
  openDraft(id: string): Promise<boolean>;
  deleteDraft(id: string): BrowserAppDataWriteResult<null>;
  /** At launch: the Draft this tab had open before a release reload (2.1-Q189), else the newest Draft. */
  restoreLatestDraft(): boolean;
  attachCanvasSession(session: CanvasDocumentSurface): () => void;
  installContinuousSave(page?: BrowserPageLifecycleTarget): () => void;
}

export const browserDesignFileAdapter: BrowserDesignFileAdapter = {
  openCanopiFile,
  downloadCanopiFile,
};

export function createBrowserDesignSessionController({
  store = designSessionStore,
  fileAdapter = browserDesignFileAdapter,
  appDataStore = browserAppDataStore,
  now = () => new Date(),
  createDraftId = createBrowserDraftId,
  workflowRunner = createDesignSessionWorkflowRunner(DESIGN_SESSION_WORKFLOWS),
  requestSaveDecision = requestSaveProblemDecision,
  presentOpenFailure = presentDesignOpenFailure,
  saveDelayMs,
  requestDraftPersistence = () => browserDraftPersistence.requestOnce(),
  reload = () => globalThis.location.reload(),
}: BrowserDesignSessionControllerOptions = {}): BrowserDesignSessionController {
  let canvasSession: CanvasDocumentSurface | null = null;
  let nextDownloadWrite = 0;
  let replacementIntent = 0;
  let workflowInstallAttempt = 0;
  const replacement = createDesignSessionReplacement({
    store,
    workflowRunner: {
      install() {
        workflowInstallAttempt += 1;
        workflowRunner.install();
      },
      dispose: () => workflowRunner.dispose(),
    },
  });
  const persistence = createDesignSessionPersistence({ store });
  const continuousSave = createContinuousSave({
    store,
    writeHome: writeDraftHome,
    delayMs: saveDelayMs,
  });

  // What this tab last read or wrote for its Draft. Every tab of the Web
  // Edition shares the same Drafts, so a write checks that no other tab has
  // written the Draft since; `overwrite` is the user's "keep my version".
  let draftStamp: { id: string; updatedAt: string | null; overwrite: boolean } | null = null;

  // Web homes are always browser Design Drafts; a write is one synchronous
  // localStorage record update, so a page-hide flush completes before unload.
  function writeDraftHome(home: DesignHome): HomeWriteOutcome {
    if (home.kind !== "draft") throw new Error("Web Designs live in browser Drafts");
    const stamp = draftStamp?.id === home.id ? draftStamp : null;
    const settlement = persistence.beginBrowserDraft().executeImmediately(
      prepareSynchronousDesignWriteDestination({
        resource: "browser-app-data:drafts",
        write(content) {
          const result = appDataStore.saveDraft({
            id: home.id,
            file: content,
            now: now().toISOString(),
            expectedUpdatedAt: stamp && !stamp.overwrite ? stamp.updatedAt : undefined,
          });
          if (!result.ok) {
            if (result.error instanceof BrowserDraftChangedError) {
              throw new DesignHomeConflictError(false);
            }
            throw new BrowserDraftStorageError(result);
          }
          draftStamp = { id: home.id, updatedAt: result.value.updatedAt, overwrite: false };
          return undefined;
        },
      }),
    );
    return settlement.status === "stale" ? { kind: "stale" } : { kind: "written" };
  }

  function storedDraftUpdatedAt(id: string): string | null {
    return appDataStore.listDrafts().find((draft) => draft.id === id)?.updatedAt ?? null;
  }

  function draftReplacement(
    input: Omit<ResolvedDesignReplacement, "path" | "finalizationIdentity" | "onDesignFinalized">,
    draftId: string,
    writePending: boolean,
    draftUpdatedAt: string | null = null,
  ): ResolvedDesignReplacement {
    return {
      ...input,
      path: null,
      finalizationIdentity: `browser-draft:${draftId}:${writePending}`,
      onDesignFinalized: () => {
        draftStamp = { id: draftId, updatedAt: draftUpdatedAt, overwrite: false };
        continuousSave.beginSession({ draftId, fingerprint: null, writePending });
      },
    };
  }

  function applyDesignReplacement(
    input: ResolvedDesignReplacement,
    baseline: DesignReplacementGuardCapture = persistence.beginReplacementGuard(),
  ): void {
    const canvas = canvasSession;
    if (canvas) quarantineCompetingPendingReplacement(input, canvas);
    replacement.replace(input, canvas, baseline.isDesignBaselineCurrent);
  }

  function quarantineCompetingPendingReplacement(
    input: ResolvedDesignReplacement,
    canvas: CanvasDocumentSurface,
  ): void {
    const identity = replacement.pendingCanvasReplacement(canvas)?.identity ?? null;
    if (
      !identity
      || replacement.matchesPendingCanvasReplacement(input, canvas, identity)
    ) return;

    resumeExactPendingCanvasReplacement(canvas, identity);
    throw new CanvasAuthorityBusyError("document-settlement");
  }

  function resumeExactPendingCanvasReplacement(
    canvas: CanvasDocumentSurface,
    identity: DesignSessionPendingCanvasReplacementIdentity,
  ): void {
    if (!replacement.resumePendingCanvasReplacement(canvas, identity)) {
      throw new Error("Browser Canvas replacement changed before quarantine");
    }
  }

  /**
   * Write the current Design first; ask only when that write fails. Resolves
   * synchronously when nothing is pending so a replacement keeps its turn.
   */
  function flushBeforeReplacement(intent: number): true | Promise<boolean> {
    if (!continuousSave.hasPendingChanges()) return true;
    // A retained Canvas replacement cannot be captured; the replacement
    // itself settles or quarantines it first.
    if (canvasSession && replacement.pendingCanvasReplacement(canvasSession)) return true;
    return flushPendingBeforeReplacement(intent);
  }

  async function flushPendingBeforeReplacement(intent: number): Promise<boolean> {
    for (;;) {
      if (await continuousSave.flush()) return intent === replacementIntent;
      if (intent !== replacementIntent) return false;
      const conflict = continuousSave.conflict.peek() !== null;
      const choice = await requestSaveDecision(conflict
        ? { kind: "flush-failed", purpose: "replace", conflict, where: "another-tab" }
        : { kind: "flush-failed", purpose: "replace", conflict });
      if (intent !== replacementIntent) return false;
      if (choice === "discard") return true;
      if (choice === "cancel") return false;
    }
  }

  async function newDesign(): Promise<void> {
    requestDraftPersistence();
    const intent = ++replacementIntent;
    const flushed = flushBeforeReplacement(intent);
    if (flushed !== true && !(await flushed)) return;
    const file = withNewDesignDisplay(createNewWebCanopiFile("Untitled", now().toISOString()));
    applyDesignReplacement(draftReplacement({
      file,
      kind: "new",
      name: file.name,
    }, createDraftId(), false));
    applyNewDesignBackground();
  }

  async function closeDesign(): Promise<boolean> {
    if (!store.hasCurrentDesign()) return false;
    const intent = ++replacementIntent;
    const flushed = flushBeforeReplacement(intent);
    if (flushed !== true && !(await flushed)) return false;
    if (intent !== replacementIntent || !store.hasCurrentDesign()) return false;
    applyDesignReplacement(createCloseDesignReplacement(() => continuousSave.endSession()));
    return true;
  }

  async function openCanopi(): Promise<boolean> {
    requestDraftPersistence();
    const intent = ++replacementIntent;
    const canvas = canvasSession;
    const pendingIdentity = canvas
      ? replacement.pendingCanvasReplacement(canvas)?.identity ?? null
      : null;
    if (canvas && pendingIdentity) {
      resumeExactPendingCanvasReplacement(canvas, pendingIdentity);
      return false;
    }
    const flushed = flushBeforeReplacement(intent);
    if (flushed !== true && !(await flushed)) return false;
    const guardCapture = persistence.beginReplacementGuard();
    let replacementGuard = guardCapture.guard;
    if (!replacementGuard) {
      await Promise.resolve();
      if (intent !== replacementIntent) return false;
      replacementGuard = guardCapture.resume();
    }
    if (
      !replacementGuard
      || intent !== replacementIntent
      || !replacementGuard.isCurrent()
    ) return false;

    const opened = await fileAdapter.openCanopiFile();
    if (intent !== replacementIntent || !replacementGuard.isCurrent()) return false;
    if (!opened) return false;
    let file: CanopiFile;
    try {
      if (!opened.fileName.toLowerCase().endsWith(".canopi")) {
        throw new Error(`Expected a .canopi file, received ${opened.fileName}.`);
      }
      file = parseCanopiJson(opened.text);
    } catch (error) {
      // A refused file leaves the open Design as it was and says why.
      presentOpenFailure(error);
      return false;
    }
    const draftId = createDraftId();
    if (intent !== replacementIntent || !replacementGuard.isCurrent()) return false;
    applyDesignReplacement(draftReplacement({
      file,
      kind: "loaded",
      name: file.name || nameFromFileName(opened.fileName),
    }, draftId, true), guardCapture);
    return true;
  }

  async function openCanopiTemplate(
    template: DesignTemplateEnvelope,
    options: { readonly isCancelled?: () => boolean } = {},
  ): Promise<"opened" | "cancelled"> {
    // No persistence request here: the import workflow asks first in `acquire`, before the fetch (review F2).
    const intent = ++replacementIntent;
    if (options.isCancelled?.()) return "cancelled";
    const flushed = flushBeforeReplacement(intent);
    if (flushed !== true && !(await flushed)) return "cancelled";
    if (options.isCancelled?.()) return "cancelled";
    applyDesignReplacement(draftReplacement({
      file: template.file,
      kind: "loaded",
      name: template.name,
    }, createDraftId(), true));
    return "opened";
  }

  async function downloadCanopi(): Promise<void> {
    const current = store.readCurrentDesign();
    if (!current) throw new Error("No browser Design is loaded.");

    const name = current.name || store.readDesignName() || "Untitled";
    const operation = persistence.beginBrowserDownload();
    await operation.execute(prepareDesignWriteDestination({
      resource: `browser-download:${++nextDownloadWrite}`,
      blocksReplacement: false,
      async write(content) {
        await fileAdapter.downloadCanopiFile({
          fileName: `${safeFileStem(content.name || name || "Untitled")}.canopi`,
          text: `${JSON.stringify(encodeCanopiDesign(content), null, 2)}\n`,
        });
      },
    }));
  }

  async function downloadDraft(id: string): Promise<void> {
    const draft = appDataStore.loadDraft(id);
    if (!draft) throw new Error(`No browser Draft ${id}`);
    await fileAdapter.downloadCanopiFile({
      fileName: `${safeFileStem(draft.name || "Untitled")}.canopi`,
      text: `${JSON.stringify(encodeCanopiDesign(draft), null, 2)}\n`,
    });
  }

  function renameDesign(name: string): void {
    const nextName = name.trim();
    if (nextName.length === 0) return;
    if (nextName === store.readDesignName()) return;

    const design = store.readCurrentDesign();
    if (!design) return;

    store.renameCurrentDesign(nextName);
  }

  async function revertDesign(): Promise<boolean> {
    const token = continuousSave.sessionToken();
    if (!token || !continuousSave.readSnapshot() || continuousSave.readHome()?.kind !== "draft") {
      return false;
    }
    const intent = replacementIntent;
    if (await requestSaveDecision({ kind: "revert" }) !== "revert") return false;
    // The confirmation covers only the session that asked: another replacement voids it.
    if (continuousSave.sessionToken() !== token || replacementIntent !== intent) return false;
    replacementIntent += 1;
    const snapshot = continuousSave.readSnapshot();
    const home = continuousSave.readHome();
    if (!snapshot || home?.kind !== "draft") return false;
    applyDesignReplacement(draftReplacement({
      file: snapshot,
      kind: "loaded",
      name: snapshot.name || "Untitled",
    }, home.id, true, draftStamp?.id === home.id ? draftStamp.updatedAt : null));
    return true;
  }

  async function resolveSaveConflict(): Promise<void> {
    const token = continuousSave.sessionToken();
    const home = continuousSave.readHome();
    if (!continuousSave.conflict.peek() || !token || home?.kind !== "draft") return;
    const intent = replacementIntent;
    const choice = await requestSaveDecision({
      kind: "conflict",
      fileGone: false,
      where: "another-tab",
    });
    // The answer belongs to the Design that asked; a replacement during the dialog voids it.
    if (continuousSave.sessionToken() !== token || replacementIntent !== intent) return;
    if (choice === "keep-mine") {
      draftStamp = { id: home.id, updatedAt: null, overwrite: true };
      await continuousSave.overwriteHome(token);
      return;
    }
    if (choice === "use-file") {
      replacementIntent += 1;
      applyDraft(home.id);
    }
  }

  let releaseReload: Promise<boolean> | null = null;

  function reloadForRelease(): Promise<boolean> {
    releaseReload ??= flushThenReload().finally(() => { releaseReload = null; });
    return releaseReload;
  }

  async function flushThenReload(): Promise<boolean> {
    const intent = ++replacementIntent;
    for (;;) {
      if (await continuousSave.flush()) break;
      if (intent !== replacementIntent) return false;
      const conflict = continuousSave.conflict.peek() !== null;
      const choice = await requestSaveDecision(conflict
        ? { kind: "flush-failed", purpose: "reload", conflict, where: "another-tab" }
        : { kind: "flush-failed", purpose: "reload", conflict });
      if (intent !== replacementIntent) return false;
      if (choice === "cancel") return false;
      if (choice === "discard") break;
      if (choice === "save-copy") {
        // Download a copy, then back to the same question: the Draft is still unwritten.
        await downloadCanopi().catch(logBrowserDesignSessionError);
        if (intent !== replacementIntent) return false;
      }
    }
    const home = continuousSave.readHome();
    if (home?.kind === "draft") appDataStore.noteReloadDraft(home.id);
    reload();
    return true;
  }

  function applyDraft(id: string): boolean {
    const draft = appDataStore.loadDraft(id);
    if (!draft) return false;
    applyDesignReplacement(draftReplacement({
      file: draft,
      kind: "loaded",
      name: draft.name || "Untitled",
    }, id, false, storedDraftUpdatedAt(id)));
    return true;
  }

  async function openDraft(id: string): Promise<boolean> {
    const intent = ++replacementIntent;
    const flushed = flushBeforeReplacement(intent);
    if (flushed !== true && !(await flushed)) return false;
    return applyDraft(id);
  }

  function deleteDraft(id: string): BrowserAppDataWriteResult<null> {
    const home = continuousSave.readHome();
    if (home?.kind === "draft" && home.id === id) {
      return { ok: false, error: new Error("The open Design's Draft cannot be deleted") };
    }
    return appDataStore.deleteDraft(id);
  }

  function restoreLatestDraft(): boolean {
    if (store.hasCurrentDesign()) return false;
    replacementIntent += 1;
    // After a release reload this tab reopens its own Design, not whichever Draft another tab wrote last (2.1-Q189).
    const reloaded = appDataStore.takeReloadDraft();
    if (reloaded !== null && applyDraft(reloaded)) return true;
    const latestDraft = appDataStore.listDrafts()[0];
    return latestDraft ? applyDraft(latestDraft.id) : false;
  }

  function attachCanvasSession(session: CanvasDocumentSurface): () => void {
    if (canvasSession === session) {
      throw new DesignPersistenceLeaseError("Browser Canvas session is already attached");
    }
    persistence.attachCanvas(session);
    const installAttemptBeforeAttachment = workflowInstallAttempt;
    try {
      replacement.attach(session);
    } catch (error) {
      try {
        if (workflowInstallAttempt !== installAttemptBeforeAttachment) {
          try {
            workflowRunner.dispose();
          } catch (cleanupError) {
            console.error(
              "Failed to clean up browser Design Session workflows after Canvas attachment failure:",
              cleanupError,
            );
          }
        }
      } finally {
        persistence.detachCanvas(session);
      }
      throw error;
    }
    canvasSession = session;
    return () => {
      if (canvasSession !== session) return;

      try {
        settlePendingReplacementForHandoff(session);
        if (session.hasLoadedDocument() && store.hasCurrentDesign()) {
          persistence.settleCanvasHandoff(session);
          store.markCanvasDetachedDirty(store.isCanvasDirty());
        }
      } catch (error) {
        console.error("Failed to snapshot browser canvas before detach:", error);
        throw error;
      }
      workflowRunner.dispose();
      persistence.detachCanvas(session);
      canvasSession = null;
    };
  }

  function settlePendingReplacementForHandoff(
    session: CanvasDocumentSurface,
  ): void {
    const pending = replacement.pendingCanvasReplacement(session);
    if (!pending) return;
    if (!replacement.settlePendingCanvasReplacementForHandoff(session, pending.identity)) {
      throw new Error("Browser Canvas replacement changed before handoff");
    }
  }

  function installContinuousSave(
    page: BrowserPageLifecycleTarget = { document: globalThis.document, window: globalThis.window },
  ): () => void {
    const uninstall = continuousSave.install();
    const flush = () => {
      void continuousSave.flush().catch(logBrowserDesignSessionError);
    };
    const flushWhenHidden = () => {
      if (page.document.visibilityState === "hidden") flush();
    };
    page.document.addEventListener("visibilitychange", flushWhenHidden);
    page.window.addEventListener("pagehide", flush);
    return () => {
      page.document.removeEventListener("visibilitychange", flushWhenHidden);
      page.window.removeEventListener("pagehide", flush);
      uninstall();
    };
  }

  return {
    continuousSave,
    hasCurrentDesign: () => store.currentDesign.value !== null,
    readDesignIdentity() {
      const design = store.currentDesign.value;
      if (!design) return null;
      return {
        name: store.designName.value || design.name || "Untitled",
        saveStatus: continuousSave.status.value,
        saveFailureReason: continuousSave.failureReason.value,
      };
    },
    newDesign,
    closeDesign,
    openCanopi,
    openCanopiTemplate,
    downloadCanopi,
    downloadDraft,
    renameDesign,
    revertDesign,
    resolveSaveConflict,
    reloadForRelease,
    listDrafts: () => appDataStore.listDrafts(),
    openDraft,
    deleteDraft,
    restoreLatestDraft,
    attachCanvasSession,
    installContinuousSave,
  };
}

class BrowserDraftStorageError extends Error {
  readonly result: Extract<
    BrowserAppDataWriteResult<BrowserDraftSummary>,
    { readonly ok: false }
  >;

  constructor(result: BrowserDraftStorageError["result"]) {
    super("Browser Draft storage failed");
    this.name = "BrowserDraftStorageError";
    this.result = result;
  }
}

export const browserDesignSessionController = createBrowserDesignSessionController();

function createNewWebCanopiFile(name: string, timestamp: string): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: NEW_DESIGN_LAYER_DEFAULTS.map((layer) => ({ ...layer })),
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: DEFAULT_BUDGET_CURRENCY,
    views: [],
    stories: [],
    created_at: timestamp,
    updated_at: timestamp,
    extra: {},
  };
}

function parseCanopiJson(text: string): CanopiFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Unparseable text is a damaged Design, like any other refused document.
    throw asCanopiDesignIngestionError(error);
  }
  return decodeCanopiDesign(parsed);
}

async function openCanopiFile(): Promise<BrowserOpenedCanopiFile | null> {
  return pickBrowserTextFile(".canopi,application/json");
}

async function downloadCanopiFile({ fileName, text }: BrowserCanopiDownload): Promise<void> {
  downloadBrowserTextFile(fileName, text, "application/json");
}

function nameFromFileName(fileName: string): string {
  return fileName.replace(/\.canopi$/i, "") || "Untitled";
}

function safeFileStem(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Untitled";
}

function createBrowserDraftId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `draft-${randomUuid}`;
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function logBrowserDesignSessionError(error: unknown): void {
  console.error("Browser Design Session command failed:", error);
}
