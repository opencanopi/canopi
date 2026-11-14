import { batch } from "@preact/signals";
import {
  CanvasDocumentReplacementNotAdmittedError,
  createCanvasDocumentReplacementToken,
  type CanvasDocumentReplacementToken,
  type CanvasDocumentSurface,
} from "../../canvas/runtime/runtime";
import type { CanopiFile } from "../../types/design";
import { CURRENT_CANOPI_FILE_VERSION } from "../../generated/canopi-design-format";
import { NEW_DESIGN_LAYER_DEFAULTS } from "../../generated/new-design-defaults";
import {
  DEFAULT_BUDGET_CURRENCY,
  normalizeLoadedDocument,
  normalizeNewDocument,
} from "../contracts/document";
import { PLANT_DISPLAY_EXTRA_KEY } from "../design-edit/plant-display";
import {
  EDITING_DESIGN_SESSION,
  type DesignSessionKind,
  type DesignSessionStore,
} from "./store";
import type { DesignSessionWorkflowRunner } from "./workflow-runner";

/** `close` ends the session: the Canvas gets an empty Scene and the store no Design. */
type DesignReplacementKind = "new" | "loaded" | "close";

export interface ResolvedDesignReplacement {
  readonly file: CanopiFile;
  readonly kind: DesignReplacementKind;
  readonly path: string | null;
  readonly name: string;
  /** The session the replacement starts; `editing` when omitted. A close always ends in `editing`. */
  readonly session?: DesignSessionKind;
  readonly finalizationIdentity?: string;
  readonly onDesignFinalized?: () => void;
}

interface DesignSessionApplicationReceipt {
  readonly file: CanopiFile | null;
  readonly canvasHydrated: boolean;
}

declare const designSessionPendingCanvasReplacementBrand: unique symbol;

export interface DesignSessionPendingCanvasReplacementIdentity {
  readonly [designSessionPendingCanvasReplacementBrand]: true;
}

interface PendingDesignReplacementStatus {
  readonly identity: DesignSessionPendingCanvasReplacementIdentity;
  readonly isDesignBaselineCurrent: boolean;
  readonly designWasApplied: boolean;
}

interface DesignReplacementSettlementReceipt {
  readonly preservedCurrentDesign: boolean;
}

export interface DesignSessionReplacement {
  attach(canvas: CanvasDocumentSurface): DesignSessionApplicationReceipt;
  pendingCanvasReplacement(canvas: CanvasDocumentSurface): PendingDesignReplacementStatus | null;
  matchesPendingCanvasReplacement(
    input: ResolvedDesignReplacement,
    canvas: CanvasDocumentSurface,
    identity: DesignSessionPendingCanvasReplacementIdentity,
  ): boolean;
  resumePendingCanvasReplacement(
    canvas: CanvasDocumentSurface,
    identity: DesignSessionPendingCanvasReplacementIdentity,
  ): DesignReplacementSettlementReceipt | null;
  settlePendingCanvasReplacementForHandoff(
    canvas: CanvasDocumentSurface,
    identity: DesignSessionPendingCanvasReplacementIdentity,
  ): DesignReplacementSettlementReceipt | null;
  replace(
    input: ResolvedDesignReplacement,
    canvas: CanvasDocumentSurface | null,
    isDesignBaselineCurrent: () => boolean,
  ): DesignSessionApplicationReceipt;
}

export interface DesignSessionReplacementDeps {
  readonly store: DesignSessionStore;
  readonly workflowRunner: DesignSessionWorkflowRunner;
}

interface PendingDesignReplacement {
  readonly identity: DesignSessionPendingCanvasReplacementIdentity;
  readonly closes: boolean;
  readonly key: string;
  readonly file: CanopiFile;
  readonly finalization: DesignReplacementFinalizer;
  isDesignBaselineCurrent: () => boolean;
  canvasApplication: PendingCanvasApplication | null;
  workflowsInstalled: boolean;
}

interface DesignReplacementFinalizer {
  run(): void;
  preserveCurrentDesign(): void;
  wasDesignApplied(): boolean;
  wasDesignPreserved(): boolean;
}

interface PendingCanvasApplication {
  readonly token: CanvasDocumentReplacementToken;
  readonly canvas: CanvasDocumentSurface;
  canvasReplaced: boolean;
  chromeShown: boolean;
  zoomedToFit: boolean;
}

export function createDesignSessionReplacement({
  store,
  workflowRunner,
}: DesignSessionReplacementDeps): DesignSessionReplacement {
  let pendingReplacement: PendingDesignReplacement | null = null;

  function settleAdmittedCanvasReplacement(
    operation: PendingDesignReplacement,
    canvasApplication: PendingCanvasApplication,
  ): void {
    try {
      settleCanvasReplacement(operation, canvasApplication);
    } catch (error) {
      if (!(error instanceof CanvasDocumentReplacementNotAdmittedError)) throw error;
      if (pendingReplacement === operation) pendingReplacement = null;
      throw error.reason;
    }
  }

  function settlePending(
    canvas: CanvasDocumentSurface,
    identity: DesignSessionPendingCanvasReplacementIdentity,
    purpose: "resume" | "handoff",
  ): DesignReplacementSettlementReceipt | null {
    const operation = pendingReplacement;
    const application = operation?.canvasApplication;
    if (!operation || operation.identity !== identity || !application
      || application.canvas !== canvas || application.canvasReplaced) return null;

    // Settlement must finish an admitted Scene swap, but cannot erase Design
    // edits made after its authorization. An applied finalizer remains one-shot.
    if (!operation.finalization.wasDesignApplied() && !operation.isDesignBaselineCurrent()) {
      operation.finalization.preserveCurrentDesign();
    }
    settleAdmittedCanvasReplacement(operation, application);
    if (purpose === "resume") finishCanvasApplication(operation, application, workflowRunner);
    if (pendingReplacement === operation) pendingReplacement = null;
    return { preservedCurrentDesign: operation.finalization.wasDesignPreserved() };
  }

  return {
    attach(canvas): DesignSessionApplicationReceipt {
      const file = store.readCurrentDesign();
      if (!file) {
        canvas.hideCanvasChrome();
        workflowRunner.install();
        return { file: null, canvasHydrated: false };
      }

      canvas.loadDocument(file);
      pendingReplacement = null;
      finishCanvasHydration(canvas);
      workflowRunner.install();
      return { file, canvasHydrated: true };
    },

    pendingCanvasReplacement(canvas) {
      const operation = pendingReplacement;
      if (!operation || operation.canvasApplication?.canvas !== canvas
        || operation.canvasApplication.canvasReplaced) return null;
      return {
        identity: operation.identity,
        isDesignBaselineCurrent: operation.isDesignBaselineCurrent(),
        designWasApplied: operation.finalization.wasDesignApplied(),
      };
    },

    matchesPendingCanvasReplacement(input, canvas, identity) {
      const operation = pendingReplacement;
      return operation?.identity === identity
        && operation.canvasApplication?.canvas === canvas
        && !operation.canvasApplication.canvasReplaced
        && operation.key === designReplacementKey(input, normalizeReplacement(input));
    },

    resumePendingCanvasReplacement: (canvas, identity) => settlePending(canvas, identity, "resume"),
    settlePendingCanvasReplacementForHandoff: (canvas, identity) => settlePending(canvas, identity, "handoff"),

    replace(input, canvas, isDesignBaselineCurrent): DesignSessionApplicationReceipt {
      const file = normalizeReplacement(input);
      const replacementKey = designReplacementKey(input, file);
      const operation = pendingReplacement?.key === replacementKey
        ? pendingReplacement
        : createPendingDesignReplacement(store, replacementKey, file, input, isDesignBaselineCurrent);
      // A fresh explicit replacement attempt has already passed its caller's
      // dirty guard; retain that authorization for any later interrupted retry.
      operation.isDesignBaselineCurrent = isDesignBaselineCurrent;
      pendingReplacement = operation;

      if (canvas) {
        const canvasApplication = operation.canvasApplication?.canvas === canvas
          ? operation.canvasApplication
          : createPendingCanvasApplication(canvas);
        operation.canvasApplication = canvasApplication;

        settleAdmittedCanvasReplacement(operation, canvasApplication);

        finishCanvasApplication(operation, canvasApplication, workflowRunner);

        const appliedFile = store.readCurrentDesign() ?? operation.file;
        pendingReplacement = null;
        return { file: appliedFile, canvasHydrated: true };
      }

      operation.finalization.run();
      if (!operation.workflowsInstalled) {
        workflowRunner.install();
        operation.workflowsInstalled = true;
      }

      const appliedFile = store.readCurrentDesign() ?? operation.file;
      pendingReplacement = null;
      return { file: appliedFile, canvasHydrated: false };
    },
  };
}

function createPendingDesignReplacement(
  store: DesignSessionStore,
  key: string,
  file: CanopiFile,
  input: ResolvedDesignReplacement,
  isDesignBaselineCurrent: () => boolean,
): PendingDesignReplacement {
  const ownedFile = cloneDocument(file);
  return {
    identity: Object.freeze({}) as DesignSessionPendingCanvasReplacementIdentity,
    closes: input.kind === "close",
    key,
    file: ownedFile,
    isDesignBaselineCurrent,
    finalization: createDesignReplacementFinalizer(
      store,
      input.kind === "close" ? null : ownedFile,
      input.path,
      input.name,
      input.session ?? EDITING_DESIGN_SESSION,
      input.onDesignFinalized,
    ),
    canvasApplication: null,
    workflowsInstalled: false,
  };
}

function createPendingCanvasApplication(
  canvas: CanvasDocumentSurface,
): PendingCanvasApplication {
  return {
    token: createCanvasDocumentReplacementToken(),
    canvas,
    canvasReplaced: false,
    chromeShown: false,
    zoomedToFit: false,
  };
}

function cloneDocument(file: CanopiFile): CanopiFile {
  return JSON.parse(JSON.stringify(file)) as CanopiFile;
}

function settleCanvasReplacement(
  operation: PendingDesignReplacement,
  canvasApplication: PendingCanvasApplication,
): void {
  if (canvasApplication.canvasReplaced) return;
  let replacementFinalized = false;
  const replacementReceipt = canvasApplication.canvas.replaceDocument(
    cloneDocument(operation.file),
    canvasApplication.token,
    () => {
      operation.finalization.run();
      replacementFinalized = true;
    },
  );
  if (replacementFinalized !== replacementReceipt.callerFinalizerInvoked) {
    throw new Error("Canvas replacement returned before Design state finalization");
  }
  canvasApplication.canvasReplaced = true;
}

function finishCanvasApplication(
  operation: PendingDesignReplacement,
  canvasApplication: PendingCanvasApplication,
  workflowRunner: DesignSessionWorkflowRunner,
): void {
  if (!canvasApplication.chromeShown) {
    if (operation.closes) {
      canvasApplication.canvas.hideCanvasChrome();
    } else {
      canvasApplication.canvas.showCanvasChrome();
    }
    canvasApplication.chromeShown = true;
  }
  // A closed Design keeps the camera where it was.
  if (!canvasApplication.zoomedToFit && !operation.closes) {
    canvasApplication.canvas.zoomToFit();
    canvasApplication.zoomedToFit = true;
  }
  if (!operation.workflowsInstalled) {
    workflowRunner.install();
    operation.workflowsInstalled = true;
  }
}

/** `file` null closes the current Design instead of replacing it. */
function createDesignReplacementFinalizer(
  store: DesignSessionStore,
  file: CanopiFile | null,
  path: string | null,
  name: string,
  session: DesignSessionKind,
  onDesignFinalized: () => void = () => {},
): DesignReplacementFinalizer {
  let outcome: "pending" | "applied" | "preserved" = "pending";
  let extensionFinalized = false;
  let preserveCurrentDesign = false;
  const wasDesignApplied = () => outcome === "applied";

  return Object.freeze({
    run() {
      if (outcome !== "pending") return;
      if (preserveCurrentDesign) {
        outcome = "preserved";
        return;
      }
      batch(() => {
        try {
          store.resetDirtyBaselines();
          if (file) {
            store.replaceCurrentDesignState(file, path, name, session);
          } else {
            store.clearCurrentDesign();
          }
        } finally {
          const identity = store.readIdentity();
          const identityApplied = file
            ? identity.file === file && identity.path === path && identity.name === name
            : identity.file === null && identity.path === null;
          if (identityApplied && !extensionFinalized) {
            onDesignFinalized();
            extensionFinalized = true;
          }
          if (identityApplied && extensionFinalized) outcome = "applied";
        }
      });
      if (!wasDesignApplied()) {
        throw new Error("Design Session store did not apply document replacement");
      }
    },
    preserveCurrentDesign() {
      if (outcome === "pending") preserveCurrentDesign = true;
    },
    wasDesignApplied,
    wasDesignPreserved: () => outcome === "preserved",
  });
}

function designReplacementKey(
  input: ResolvedDesignReplacement,
  file: CanopiFile,
): string {
  return JSON.stringify([
    input.kind,
    input.path,
    input.name,
    input.session ?? EDITING_DESIGN_SESSION,
    input.finalizationIdentity ?? null,
    file,
  ]);
}

/**
 * Close the current Design through the shared replacement path: the Canvas
 * settles an empty Scene (clearing undo history) and finalization empties the
 * store; `onDesignClosed` ends the edition's continuous-save session there.
 */
export function createCloseDesignReplacement(
  onDesignClosed: () => void,
): ResolvedDesignReplacement {
  return {
    file: emptySceneDocument(),
    kind: "close",
    path: null,
    name: "",
    finalizationIdentity: "close",
    onDesignFinalized: onDesignClosed,
  };
}

// Fixed timestamps keep a retried close's replacement key stable.
function emptySceneDocument(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: "",
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
    created_at: "1970-01-01T00:00:00.000Z",
    updated_at: "1970-01-01T00:00:00.000Z",
    extra: {},
  };
}

/** What a new Design may carry in `extra`: its Settings › New Designs display options. */
const NEW_DESIGN_EXTRA_KEYS: readonly string[] = [PLANT_DISPLAY_EXTRA_KEY];

function normalizeReplacement(input: ResolvedDesignReplacement): CanopiFile {
  return input.kind !== "loaded"
    ? normalizeNewDocument(input.file, NEW_DESIGN_EXTRA_KEYS)
    : normalizeLoadedDocument(input.file);
}

function finishCanvasHydration(canvas: CanvasDocumentSurface): void {
  canvas.showCanvasChrome();
  canvas.zoomToFit();
}
