import {
  CanvasAuthorityBusyError,
  type CanvasDocumentSurface,
} from "../../canvas/runtime/runtime";
import { getCurrentCanvasDocumentSurface } from "../../canvas/session";
import { isCancelledFailure } from "../../failures/ipc-failure";
import * as designIpc from "../../ipc/design";
import type { CanopiFile, LoadedDesign } from "../../types/design";
import {
  designSessionStore,
  type PersistenceCapableDesignSessionStore,
} from "./store";
import {
  createDesignSessionPersistence,
  type DesignReplacementGuard,
  type DesignSaveSettlement,
  type DesignSessionPersistence,
} from "./persistence";
import {
  createContinuousSave,
  DesignHomeConflictError,
  type ContinuousSave,
  type DesignHome,
  type DesignSessionHomeInput,
  type HomeWriteOutcome,
} from "./continuous-save";
import {
  requestSaveProblemDecision,
} from "./save-problem";
import {
  createCloseDesignReplacement,
  createDesignSessionReplacement,
  type DesignSessionPendingCanvasReplacementIdentity,
  type DesignSessionReplacement,
  type ResolvedDesignReplacement,
} from "./replacement";
import { DESIGN_SESSION_WORKFLOWS } from "./workflows";
import { presentDesignOpenFailure } from "./open-failure";
import {
  createDesignSessionWorkflowRunner,
  type DesignSessionWorkflowRunner,
} from "./workflow-runner";

type DocumentTransitionSource =
  | "new"
  | "open-path"
  | "open-dialog"
  | "queued-path"
  | "open-draft"
  | "revert"
  | "mount-existing"
  | "close";

/**
 * `flush` writes the current Design to its home before replacing it and asks
 * the user only when that write fails; `skip` replaces without writing.
 */
type DirtyGuardMode = "flush" | "skip";

export interface DocumentTransitionLoadResult {
  file: CanopiFile;
  path: string | null;
  name: string;
  /** Draft home of a pathless Design. */
  draftId?: string | null;
  /** Fingerprint of the loaded file at `path`. */
  fingerprint?: string | null;
  /** The home does not hold this content yet. */
  writePending?: boolean;
}

interface DocumentLoadTransitionRequest {
  source: Exclude<DocumentTransitionSource, "close">;
  dirtyGuard: DirtyGuardMode;
  session?: CanvasDocumentSurface | null;
  load: () => Promise<DocumentTransitionLoadResult>;
  isCancelled?: () => boolean;
  deferWhenDetachedAndEmpty?: () => void;
}

/** Ends the current Design Session without loading another Design. */
interface DocumentCloseTransitionRequest {
  source: "close";
  dirtyGuard: "flush";
  session?: CanvasDocumentSurface | null;
}

export type DocumentTransitionRequest =
  | DocumentLoadTransitionRequest
  | DocumentCloseTransitionRequest;

type DocumentTransitionStatus = "applied" | "cancelled" | "queued" | "failed";

export interface DocumentTransitionResult {
  status: DocumentTransitionStatus;
  documentLoaded: boolean;
  error?: unknown;
}

export interface SaveCurrentDesignOptions {
  session?: CanvasDocumentSurface | null;
}

export interface QueuedDocumentLoadOptions {
  onResult?: (result: DocumentTransitionResult) => void;
}

export type DesignSessionStateStatus =
  | "detached-empty"
  | "detached-ready"
  | "attached-empty"
  | "attached-ready"
  | "loading"
  | "saving"
  | "tearing-down"
  | "failed";

export interface DesignSessionState {
  readonly status: DesignSessionStateStatus;
  readonly attached: boolean;
  readonly documentLoaded: boolean;
  readonly operation: DocumentTransitionSource | "save" | "save-as" | "teardown" | null;
  readonly error?: unknown;
}

export interface TeardownDesignSessionOptions {
  readonly session: CanvasDocumentSurface;
  readonly runtimeInitialized: boolean;
  readonly logError: (message?: unknown, ...optionalParams: unknown[]) => void;
}

export interface DesignSessionStateMachineDeps {
  readonly store: PersistenceCapableDesignSessionStore;
  readonly getCurrentSession: () => CanvasDocumentSurface | null;
  readonly selectDesignSavePath: typeof designIpc.selectDesignSavePath;
  readonly prepareDesignWrite: typeof designIpc.prepareDesignWrite;
  readonly prepareDraftWrite: typeof designIpc.prepareDraftWrite;
  readonly deleteDesignDraft: typeof designIpc.deleteDesignDraft;
  readonly loadDesign: typeof designIpc.loadDesign;
  readonly createDraftId: () => string;
  readonly presentOpenFailure: (error: unknown) => void;
  readonly requestSaveDecision: typeof requestSaveProblemDecision;
  readonly persistence: DesignSessionPersistence;
  readonly workflowRunner: DesignSessionWorkflowRunner;
}

type ReplacementDecision = "proceed" | "cancel";

class DesignSessionTransitionSupersededError extends Error {
  constructor() {
    super("Document transition was superseded");
    this.name = "DesignSessionTransitionSupersededError";
  }
}

const INITIAL_STATE: DesignSessionState = {
  status: "detached-empty",
  attached: false,
  documentLoaded: false,
  operation: null,
};

const DEFAULT_DEPS: Omit<DesignSessionStateMachineDeps, "persistence"> = {
  store: designSessionStore,
  getCurrentSession: getCurrentCanvasDocumentSurface,
  selectDesignSavePath: (hint) => designIpc.selectDesignSavePath(hint),
  prepareDesignWrite: (path, expectedFingerprint, onWritten) =>
    designIpc.prepareDesignWrite(path, expectedFingerprint, onWritten),
  prepareDraftWrite: (id) => designIpc.prepareDraftWrite(id),
  deleteDesignDraft: (id) => designIpc.deleteDesignDraft(id),
  loadDesign: (path) => designIpc.loadDesign(path),
  createDraftId: () => globalThis.crypto.randomUUID(),
  presentOpenFailure: presentDesignOpenFailure,
  requestSaveDecision: requestSaveProblemDecision,
  workflowRunner: createDesignSessionWorkflowRunner(DESIGN_SESSION_WORKFLOWS),
};

export class DesignSessionStateMachine {
  private state: DesignSessionState = INITIAL_STATE;
  private operationIntent = 0;
  private readonly activeOperationStates = new Map<number, DesignSessionState | null>();
  private activeTransitionOperationIntent: number | null = null;
  private presentedOperationIntent: number | null = null;
  private transitionIntent = 0;
  private readonly replacement: DesignSessionReplacement;
  readonly continuousSave: ContinuousSave;

  constructor(private readonly deps: DesignSessionStateMachineDeps) {
    this.replacement = createDesignSessionReplacement({
      store: deps.store,
      workflowRunner: deps.workflowRunner,
    });
    this.continuousSave = createContinuousSave({
      store: deps.store,
      writeHome: (home) => this.writeHome(home),
    });
  }

  getState(): DesignSessionState {
    return this.state;
  }

  captureCurrentDesignObservation(
    session = this.deps.getCurrentSession(),
  ): CanopiFile | null {
    return this.deps.persistence.captureObservation(session);
  }

  resetState(): void {
    this.transitionIntent += 1;
    this.operationIntent += 1;
    this.activeOperationStates.clear();
    this.activeTransitionOperationIntent = null;
    this.presentedOperationIntent = null;
    this.deps.persistence.dispose();
    this.publishState(INITIAL_STATE);
  }

  async startAttachedDesignSession(
    session: CanvasDocumentSurface,
  ): Promise<DocumentTransitionResult | null> {
    const operationIntent = this.claimOperationIntent();
    let canvasLease: ReturnType<DesignSessionPersistence["attachCanvas"]>;
    try {
      canvasLease = this.deps.persistence.attachCanvas(session);
    } catch (error) {
      this.finishTransitionOperationState(operationIntent, null);
      throw error;
    }
    if (!this.deps.store.hasCurrentDesign()) {
      this.beginEmptyDocumentSession(session);
      return null;
    }

    this.activateTransitionOperation(operationIntent, this.steadyStateFor(session));
    this.publishOperationState(
      operationIntent,
      this.operationState("loading", "mount-existing", session),
    );
    try {
      this.replacement.attach(session);
      canvasLease.assertCurrent();
      this.finishTransitionOperationState(
        operationIntent,
        this.steadyStateFor(session),
      );
      return {
        status: "applied",
        documentLoaded: session.hasLoadedDocument(),
      };
    } catch (error) {
      this.finishTransitionOperationState(operationIntent, {
        ...this.operationState("failed", "mount-existing", session),
        error,
      });
      return {
        status: "failed",
        documentLoaded: session.hasLoadedDocument(),
        error,
      };
    }
  }

  beginEmptyDocumentSession(session: CanvasDocumentSurface): void {
    this.deps.persistence.attachCanvas(session);
    this.operationIntent += 1;
    this.activeOperationStates.clear();
    this.activeTransitionOperationIntent = null;
    this.presentedOperationIntent = null;
    this.transitionIntent += 1;
    this.publishState({
      status: "attached-empty",
      attached: true,
      documentLoaded: session.hasLoadedDocument(),
      operation: null,
    });
    this.replacement.attach(session);
  }

  /** Save: write a file home now, with the live view; a draft home has no file yet, so Save As. */
  saveCurrentDesign(options: SaveCurrentDesignOptions = {}): Promise<boolean> {
    return this.saveCurrent(options, true);
  }

  /**
   * Make the home hold every edit (adding to a notebook): like Save, but a file home is written only when an edit
   * is pending, so a clean Design's file keeps its bytes (only Save writes when nothing was edited, U30).
   */
  saveCurrentDesignEdits(options: SaveCurrentDesignOptions = {}): Promise<boolean> {
    return this.saveCurrent(options, false);
  }

  private async saveCurrent(
    options: SaveCurrentDesignOptions,
    writeView: boolean,
  ): Promise<boolean> {
    if (this.continuousSave.conflict.peek()) {
      await this.resolveSaveConflict(options);
      return !this.continuousSave.hasPendingChanges();
    }
    if (this.continuousSave.readHome()?.kind === "file") {
      return writeView ? this.continuousSave.save() : this.continuousSave.flush();
    }
    const settlement = await this.saveAsCurrentDesign(options);
    return settlement?.status === "applied";
  }

  /** Save As writes a new file unconditionally and makes it the home. */
  async saveAsCurrentDesign(
    options: SaveCurrentDesignOptions = {},
  ): Promise<DesignSaveSettlement | null> {
    const operationIntent = this.claimOperationIntent();
    const session = this.sessionForOption(options.session);
    let stateStarted = false;
    try {
      if (session) this.deps.persistence.attachCanvas(session);
      this.publishOperationState(
        operationIntent,
        this.operationState("saving", "save-as", session),
      );
      stateStarted = true;
      // The intent is issued only once the path is chosen: continuous writes
      // made while the dialog is open must not supersede this Save As.
      const prepared = this.deps.persistence.prepareSaveAs();
      const token = this.continuousSave.sessionToken();
      const previousHome = this.continuousSave.readHome();
      let path: string;
      try {
        path = await this.deps.selectDesignSavePath(prepared.destinationHint);
      } catch (error) {
        if (isCancelledFailure(error)) return null;
        throw error;
      }
      const saveAs = prepared.begin();
      const settlement = await saveAs.execute(this.deps.prepareDesignWrite(
        path,
        null,
        (fingerprint) => this.continuousSave.recordFileFingerprint(token, path, fingerprint),
      ));
      if (settlement.status === "applied") {
        await this.adoptSavedFileHome(token, previousHome);
      }
      return settlement;
    } finally {
      this.finishOperationState(
        operationIntent,
        stateStarted ? this.steadyStateFor(session) : null,
      );
    }
  }

  /** Open the Design at `path`; a format from before Canopi 2.0 is refused (ADR 0021). */
  loadDesignFromPath(path: string): Promise<DocumentTransitionLoadResult> {
    return this.deps.loadDesign(path).then((design) => loadResultOf(design, path));
  }

  /** Ask how to resolve a file that changed outside Canopi, then act on it. */
  async resolveSaveConflict(
    options: SaveCurrentDesignOptions = {},
  ): Promise<DocumentTransitionResult | null> {
    const conflict = this.continuousSave.conflict.peek();
    const token = this.continuousSave.sessionToken();
    if (!conflict || !token) return null;
    const choice = await this.deps.requestSaveDecision({
      kind: "conflict",
      fileGone: conflict.fileGone,
    });
    // The answer belongs to the Design that asked; a replacement during the dialog voids it.
    if (this.continuousSave.sessionToken() !== token) return null;
    if (choice === "keep-mine") {
      await this.continuousSave.overwriteHome(token);
      return null;
    }
    if (choice === "save-copy") {
      await this.saveAsCurrentDesign(options);
      return null;
    }
    const path = this.deps.store.readDesignPath();
    if (choice !== "use-file" || conflict.fileGone || !path) return null;
    return this.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session: options.session,
      load: () => this.loadDesignFromPath(path),
    });
  }

  /**
   * Close the current Design: write it home (asking only when that fails),
   * then empty the Canvas Scene, undo history and store and end continuous
   * save. Nothing open is a no-op that supersedes no other transition.
   */
  closeDesign(
    options: SaveCurrentDesignOptions = {},
  ): Promise<DocumentTransitionResult> {
    if (!this.deps.store.hasCurrentDesign()) {
      return Promise.resolve(cancelledResult(this.sessionForOption(options.session)));
    }
    return this.transitionDocument({
      source: "close",
      dirtyGuard: "flush",
      session: options.session,
    });
  }

  /** Replace the Design with the version it had when this session began. */
  revertToOpenedVersion(
    options: SaveCurrentDesignOptions = {},
  ): Promise<DocumentTransitionResult> {
    const token = this.continuousSave.sessionToken();
    const session = this.sessionForOption(options.session);
    if (!token || !this.continuousSave.readSnapshot() || !this.continuousSave.readHome()) {
      return Promise.resolve(cancelledResult(session));
    }
    return this.deps.requestSaveDecision({ kind: "revert" }).then((choice) => {
      // Read after the answer: the confirmation only covers the session that asked.
      const snapshot = this.continuousSave.readSnapshot();
      const home = this.continuousSave.readHome();
      if (
        choice !== "revert"
        || this.continuousSave.sessionToken() !== token
        || !snapshot
        || !home
      ) {
        return cancelledResult(session);
      }
      return this.revertTo(snapshot, home, options);
    });
  }

  private revertTo(
    snapshot: CanopiFile,
    home: DesignHome,
    options: SaveCurrentDesignOptions,
  ): Promise<DocumentTransitionResult> {
    return this.transitionDocument({
      source: "revert",
      dirtyGuard: "skip",
      session: options.session,
      load: async () => ({
        file: snapshot,
        path: home.kind === "file" ? home.path : null,
        name: snapshot.name,
        draftId: home.kind === "draft" ? home.id : null,
        fingerprint: home.kind === "file" ? home.fingerprint : null,
        writePending: true,
      }),
    });
  }

  private async adoptSavedFileHome(
    token: object | null,
    previousHome: DesignHome | null,
  ): Promise<void> {
    this.continuousSave.rehome(token, { draftId: null });
    if (previousHome?.kind !== "draft") return;
    // A draft write already in flight must land before its draft is deleted.
    await this.continuousSave.idle();
    try {
      await this.deps.deleteDesignDraft(previousHome.id);
    } catch (error) {
      console.error("Failed to delete a Design Draft after Save As:", error);
    }
  }

  private async writeHome(home: DesignHome): Promise<HomeWriteOutcome> {
    const operationIntent = this.claimOperationIntent();
    // Continuous writes go through whichever Canvas holds the persistence lease.
    const session = this.deps.persistence.attachedCanvas();
    let stateStarted = false;
    try {
      this.publishOperationState(
        operationIntent,
        this.operationState("saving", "save", session),
      );
      stateStarted = true;
      if (home.kind === "file") {
        const token = this.continuousSave.sessionToken();
        const save = this.deps.persistence.beginSave();
        if (save.destinationPath !== home.path) {
          throw new Error("Design file home does not match the saved path");
        }
        const settlement = await save.execute(this.deps.prepareDesignWrite(
          home.path,
          home.fingerprint,
          (fingerprint) => this.continuousSave.recordFileFingerprint(
            token,
            home.path,
            fingerprint,
          ),
        ));
        if (settlement.status === "stale") return { kind: "stale" };
      } else {
        const save = this.deps.persistence.beginSnapshotSave();
        const settlement = await save.execute(this.deps.prepareDraftWrite(home.id));
        if (settlement.status === "stale") return { kind: "stale" };
      }
      return { kind: "written" };
    } catch (error) {
      if (error instanceof DesignHomeConflictError) {
        return { kind: "conflict", fileGone: error.fileGone };
      }
      throw error;
    } finally {
      this.finishOperationState(
        operationIntent,
        stateStarted ? this.steadyStateFor(session) : null,
      );
    }
  }

  async transitionDocument(
    request: DocumentTransitionRequest,
  ): Promise<DocumentTransitionResult> {
    const operationIntent = this.claimOperationIntent();
    const session = this.sessionForTransition(request);
    let canvasLease: ReturnType<DesignSessionPersistence["attachCanvas"]> | null = null;
    let replacementGuard: DesignReplacementGuard | null = null;
    let retainedReplacementRetry = false;
    let retainedReplacementWasAuthorized = false;
    let retainedReplacementDesignWasApplied = false;
    let retainedReplacementIdentity: DesignSessionPendingCanvasReplacementIdentity | null = null;
    let designBaselineIsCurrent = () => false;
    let intent: number | null = null;
    const transitionIsCurrent = () => intent !== null
      && intent === this.transitionIntent
      && canvasLease?.isCurrent() === true;
    const replacementIsCurrent = () => transitionIsCurrent()
      && replacementGuard?.isCurrent() === true;
    const assertReplacementCurrent = () => {
      if (!replacementIsCurrent()) throw new DesignSessionTransitionSupersededError();
    };
    const assertReplacementAttemptCurrent = () => {
      if (retainedReplacementRetry) {
        if (!transitionIsCurrent() || !designBaselineIsCurrent()) {
          throw new DesignSessionTransitionSupersededError();
        }
        return;
      }
      assertReplacementCurrent();
    };
    const publishCompletionIfOwned = (state: DesignSessionState) => {
      this.finishTransitionOperationState(
        operationIntent,
        intent === null ? null : state,
      );
    };

    try {
      canvasLease = session
        ? this.deps.persistence.attachCanvas(session)
        : this.deps.persistence.acquireDetachedCanvasLease();
      const activeCanvasLease = canvasLease;
      intent = this.activateTransitionOperation(
        operationIntent,
        this.steadyStateFor(session),
      );
      if (
        request.source !== "close"
        && !session
        && !this.deps.store.hasCurrentDesign()
        && request.deferWhenDetachedAndEmpty
      ) {
        request.deferWhenDetachedAndEmpty();
        publishCompletionIfOwned(this.steadyStateFor(session));
        return {
          status: "queued",
          documentLoaded: false,
        };
      }
      const guardCapture = this.deps.persistence.beginReplacementGuard();
      designBaselineIsCurrent = guardCapture.isDesignBaselineCurrent;
      replacementGuard = guardCapture.guard;
      if (!replacementGuard) {
        // Reactive Design publication may synchronously start a successor while
        // the predecessor still owns Scene replacement settlement. The capture
        // retains the Design baseline while this finalizer returns.
        await Promise.resolve();
        if (!transitionIsCurrent()) throw new DesignSessionTransitionSupersededError();
        try {
          replacementGuard = guardCapture.resume();
        } catch (error) {
          const pending = session ? this.replacement.pendingCanvasReplacement(session) : null;
          if (!(error instanceof CanvasAuthorityBusyError) || !pending) throw error;
          retainedReplacementRetry = true;
          retainedReplacementIdentity = pending.identity;
          retainedReplacementWasAuthorized = pending.isDesignBaselineCurrent;
          retainedReplacementDesignWasApplied = pending.designWasApplied;
        }
        if (!replacementGuard && !retainedReplacementRetry) {
          throw new DesignSessionTransitionSupersededError();
        }
      }
      assertReplacementAttemptCurrent();

      if (
        retainedReplacementRetry
        && !retainedReplacementWasAuthorized
        && !retainedReplacementDesignWasApplied
        && request.dirtyGuard === "skip"
      ) {
        publishCompletionIfOwned(this.steadyStateFor(session));
        return cancelledResult(session);
      }

      if (
        request.dirtyGuard === "flush"
        && (!retainedReplacementRetry || !retainedReplacementWasAuthorized)
      ) {
        const decision = await this.flushBeforeReplacement(
          retainedReplacementRetry
            ? () => transitionIsCurrent() && designBaselineIsCurrent()
            : replacementIsCurrent,
          request.source === "close" ? "close" : "replace",
        );
        if (decision === "cancel") {
          publishCompletionIfOwned(this.steadyStateFor(session));
          return cancelledResult(session);
        }
      }

      return await this.deps.persistence.withReplacementWriteFence(async (writeFence) => {
        assertReplacementAttemptCurrent();
        this.publishOperationState(
          operationIntent,
          this.operationState("loading", request.source, session),
        );
        let replacementInput: ResolvedDesignReplacement;
        if (request.source === "close") {
          replacementInput = createCloseDesignReplacement(() => this.continuousSave.endSession());
        } else {
          const loaded = await request.load();
          if (request.isCancelled?.()) {
            publishCompletionIfOwned(this.steadyStateFor(session));
            return cancelledResult(session);
          }
          assertReplacementAttemptCurrent();

          const home: DesignSessionHomeInput = {
            draftId: loaded.path ? null : loaded.draftId ?? null,
            fingerprint: loaded.path ? loaded.fingerprint ?? null : null,
            writePending: loaded.writePending ?? false,
          };
          replacementInput = {
            file: loaded.file,
            kind: request.source === "new" ? "new" : "loaded",
            path: loaded.path,
            name: loaded.name,
            finalizationIdentity: `home:${JSON.stringify(home)}`,
            onDesignFinalized: () => this.continuousSave.beginSession(home),
          };
        }
        if (
          retainedReplacementRetry
          && retainedReplacementIdentity
          && session
          && request.source !== "mount-existing"
          && !this.replacement.matchesPendingCanvasReplacement(
            replacementInput,
            session,
            retainedReplacementIdentity,
          )
        ) {
          const resumed = this.replacement.resumePendingCanvasReplacement(
            session,
            retainedReplacementIdentity,
          );
          if (!resumed) {
            throw new CanvasAuthorityBusyError("document-settlement");
          }
          if (resumed.preservedCurrentDesign) {
            writeFence.invalidatePredecessorWrites();
          }
          activeCanvasLease.assertCurrent();
          publishCompletionIfOwned(this.steadyStateFor(session));
          return cancelledResult(session);
        }

        try {
          if (request.source === "mount-existing") {
            if (!session) {
              throw new Error("mount-existing document transitions require an attached canvas session");
            }
            this.replacement.attach(session);
          } else {
            this.replacement.replace(replacementInput, session, designBaselineIsCurrent);
          }
        } catch (error) {
          const pending = session ? this.replacement.pendingCanvasReplacement(session) : null;
          if (pending && !pending.designWasApplied) {
            writeFence.invalidatePredecessorWrites();
          }
          throw error;
        }
        // Design publication can synchronously issue a successor transition. Once the
        // replacement is applied, supersession may hide this state but cannot cancel it.
        activeCanvasLease.assertCurrent();

        publishCompletionIfOwned(this.steadyStateFor(session));
        return {
          status: "applied",
          documentLoaded: session?.hasLoadedDocument() ?? false,
        };
      });
    } catch (error) {
      if (error instanceof DesignSessionTransitionSupersededError) {
        publishCompletionIfOwned(this.steadyStateFor(session));
        return cancelledResult(session);
      }
      if (isCancelledFailure(error)) {
        publishCompletionIfOwned(this.steadyStateFor(session));
        return cancelledResult(session);
      }
      publishCompletionIfOwned({
        ...this.operationState("failed", request.source, session),
        error,
      });
      return {
        status: "failed",
        documentLoaded: session?.hasLoadedDocument() ?? false,
        error,
      };
    }
  }

  consumeQueuedDocumentLoad(
    session: CanvasDocumentSurface,
    options: QueuedDocumentLoadOptions = {},
  ): () => void {
    const queuedPath = this.deps.store.readPendingDesignPath();
    if (!queuedPath) return () => {};

    return this.startQueuedDocumentLoad({
      session,
      options,
      source: "queued-path",
      label: nameFromPath(queuedPath),
      load: () => this.loadDesignFromPath(queuedPath),
      isStillPending: () => this.deps.store.readPendingDesignPath() === queuedPath,
      clearPending: () => {
        if (this.deps.store.readPendingDesignPath() === queuedPath) {
          this.deps.store.setPendingDesignPath(null);
        }
      },
    });
  }

  teardownAttachedDesignSession({
    session,
    runtimeInitialized,
    logError,
  }: TeardownDesignSessionOptions): void {
    if (!this.deps.persistence.isCanvasAttached(session)) return;
    const operationIntent = this.claimOperationIntent();
    let canvasLease: ReturnType<DesignSessionPersistence["attachCanvas"]>;
    try {
      canvasLease = this.deps.persistence.attachCanvas(session);
    } catch (error) {
      this.finishTransitionOperationState(operationIntent, null);
      throw error;
    }
    this.activateTransitionOperation(operationIntent, this.steadyStateFor(session));
    this.publishOperationState(
      operationIntent,
      this.operationState("tearing-down", "teardown", session),
    );

    if (runtimeInitialized && session.hasLoadedDocument()) {
      try {
        this.settlePendingCanvasReplacementForHandoff(session);
        if (this.deps.store.hasCurrentDesign()) {
          this.deps.persistence.settleCanvasHandoff(session);
          canvasLease.assertCurrent();
          this.deps.store.markCanvasDetachedDirty(this.deps.store.isCanvasDirty());
          canvasLease.assertCurrent();
        }
      } catch (error) {
        logError("Failed to snapshot canvas before teardown:", error);
        this.finishTransitionOperationState(
          operationIntent,
          this.steadyStateFor(session),
        );
        throw error;
      }
    }

    let canvasDetached = false;
    try {
      canvasLease.assertCurrent();
      this.deps.workflowRunner.dispose();
      canvasLease.assertCurrent();
      this.deps.persistence.detachCanvas(session);
      canvasDetached = true;
      this.deps.persistence.dispose();
    } finally {
      this.finishTransitionOperationState(
        operationIntent,
        this.steadyStateFor(canvasDetached ? null : session),
      );
    }
  }

  private settlePendingCanvasReplacementForHandoff(
    session: CanvasDocumentSurface,
  ): void {
    const pending = this.replacement.pendingCanvasReplacement(session);
    if (!pending) return;
    if (!this.replacement.settlePendingCanvasReplacementForHandoff(session, pending.identity)) {
      throw new CanvasAuthorityBusyError("document-settlement");
    }
  }

  private startQueuedDocumentLoad({
    session,
    options,
    source,
    label,
    load,
    isStillPending,
    clearPending,
  }: QueuedDocumentLoadRequest): () => void {
    let cancelled = false;

    void this.transitionDocument({
      source,
      dirtyGuard: "skip",
      session,
      load,
      isCancelled: () => cancelled,
    }).then((result) => {
      options.onResult?.(result);
      if (cancelled) return;
      if (result.status === "applied") {
        if (isStillPending()) clearPending();
        return;
      }
      if (result.status === "failed") {
        if (!isStillPending()) return;
        console.error(`Queued document load failed (${label}):`, result.error);
        this.deps.presentOpenFailure(result.error);
      }
    });

    return () => {
      cancelled = true;
    };
  }

  private async flushBeforeReplacement(
    replacementIsCurrent: () => boolean,
    purpose: "replace" | "close",
  ): Promise<ReplacementDecision> {
    if (!this.deps.store.hasCurrentDesign()) return "proceed";
    for (;;) {
      if (await this.continuousSave.flush()) return "proceed";
      if (!replacementIsCurrent()) return "cancel";
      const choice = await this.deps.requestSaveDecision({
        kind: "flush-failed",
        purpose,
        conflict: this.continuousSave.conflict.peek() !== null,
      });
      if (!replacementIsCurrent()) return "cancel";
      if (choice === "discard") return "proceed";
      if (choice === "cancel") return "cancel";
    }
  }

  private sessionForTransition(request: DocumentTransitionRequest): CanvasDocumentSurface | null {
    return this.sessionForOption(request.session);
  }

  private sessionForOption(
    session: CanvasDocumentSurface | null | undefined,
  ): CanvasDocumentSurface | null {
    return session === undefined
      ? this.deps.getCurrentSession()
      : session;
  }

  private operationState(
    status: DesignSessionStateStatus,
    operation: DesignSessionState["operation"],
    session: CanvasDocumentSurface | null,
  ): DesignSessionState {
    return {
      status,
      attached: session !== null,
      documentLoaded: session?.hasLoadedDocument() ?? false,
      operation,
    };
  }

  private publishState(state: DesignSessionState): void {
    this.state = state;
  }

  private claimOperationIntent(): number {
    this.operationIntent += 1;
    this.activeOperationStates.set(this.operationIntent, null);
    return this.operationIntent;
  }

  private activateTransitionOperation(
    intent: number,
    fallbackState: DesignSessionState,
  ): number {
    const predecessor = this.activeTransitionOperationIntent;
    this.activeTransitionOperationIntent = intent;
    if (predecessor !== null) {
      this.finishOperationState(predecessor, fallbackState);
    }
    this.transitionIntent += 1;
    return this.transitionIntent;
  }

  private publishOperationState(
    intent: number,
    state: DesignSessionState,
  ): void {
    if (!this.activeOperationStates.has(intent)) return;
    this.activeOperationStates.set(intent, state);
    if (intent !== this.latestActiveOperationIntent()) return;
    this.presentedOperationIntent = intent;
    this.publishState(state);
  }

  private finishOperationState(
    intent: number,
    state: DesignSessionState | null,
  ): void {
    if (!this.activeOperationStates.has(intent)) return;
    const wasPresented = intent === this.presentedOperationIntent;
    this.activeOperationStates.delete(intent);
    if (!wasPresented && this.presentedOperationIntent !== null) return;
    const next = this.latestActiveOperationState();
    this.presentedOperationIntent = next?.intent ?? null;
    const presentation = next?.state ?? state;
    if (presentation) this.publishState(presentation);
  }

  private finishTransitionOperationState(
    intent: number,
    state: DesignSessionState | null,
  ): void {
    if (this.activeTransitionOperationIntent === intent) {
      this.activeTransitionOperationIntent = null;
    }
    this.finishOperationState(intent, state);
  }

  private latestActiveOperationIntent(): number | null {
    let latest: number | null = null;
    for (const intent of this.activeOperationStates.keys()) latest = intent;
    return latest;
  }

  private latestActiveOperationState(): {
    readonly intent: number;
    readonly state: DesignSessionState;
  } | null {
    let latest: { intent: number; state: DesignSessionState } | null = null;
    for (const [intent, state] of this.activeOperationStates) {
      if (state) latest = { intent, state };
    }
    return latest;
  }

  private steadyStateFor(session: CanvasDocumentSurface | null): DesignSessionState {
    const attached = session !== null;
    const documentLoaded = session?.hasLoadedDocument() ?? false;
    const hasDesign = this.deps.store.hasCurrentDesign();
    return {
      status: attached
        ? documentLoaded || hasDesign ? "attached-ready" : "attached-empty"
        : hasDesign ? "detached-ready" : "detached-empty",
      attached,
      documentLoaded,
      operation: null,
    };
  }
}

export function createDesignSessionStateMachine(
  deps: Partial<DesignSessionStateMachineDeps> = {},
): DesignSessionStateMachine {
  const store = deps.store ?? DEFAULT_DEPS.store;
  return new DesignSessionStateMachine({
    ...DEFAULT_DEPS,
    ...deps,
    store,
    persistence: deps.persistence ?? createDesignSessionPersistence({ store }),
  });
}

interface QueuedDocumentLoadRequest {
  session: CanvasDocumentSurface;
  options: QueuedDocumentLoadOptions;
  source: "queued-path";
  label: string;
  load: () => Promise<DocumentTransitionLoadResult>;
  isStillPending: () => boolean;
  clearPending: () => void;
}

function cancelledResult(session: CanvasDocumentSurface | null): DocumentTransitionResult {
  return {
    status: "cancelled",
    documentLoaded: session?.hasLoadedDocument() ?? false,
  };
}

function nameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.canopi$/i, "") || "Untitled";
}

/** The document a transition applies for a Design the native side loaded from `path`. */
export function loadResultOf(design: LoadedDesign, path: string): DocumentTransitionLoadResult {
  return {
    file: design.file,
    path,
    name: design.file.name,
    fingerprint: design.fingerprint,
  };
}
