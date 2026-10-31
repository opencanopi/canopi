// @vitest-environment jsdom

import { effect, signal } from "@preact/signals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  editDesignSessionForTest,
  markDesignSessionDirtyForTest,
  reconcileDesignSessionForTest,
} from "./support/design-session-edit";

const mocks = vi.hoisted(() => ({
  installConsortiumSync: vi.fn(),
  deleteDesignDraft: vi.fn(),
  loadDesign: vi.fn(),
  message: vi.fn(),
  presentOpenFailure: vi.fn(),
  requestSaveDecision: vi.fn(),
  saveDesign: vi.fn(),
  saveDesignDraft: vi.fn(),
  expectedFingerprints: [] as Array<string | null>,
  selectDesignSavePath: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: mocks.message,
}));

vi.mock("../ipc/design", async () => {
  const { prepareDesignWriteDestination } = await import(
    "../app/document-session/write-admission"
  );
  return {
    loadDesign: mocks.loadDesign,
    selectDesignSavePath: mocks.selectDesignSavePath,
    prepareDesignWrite: (
      path: string,
      expectedFingerprint: string | null,
      onWritten: (fingerprint: string) => void,
    ) => prepareDesignWriteDestination({
      resource: `native-design:${path}`,
      destinationPath: path,
      write: (content) => {
        mocks.expectedFingerprints.push(expectedFingerprint);
        return mocks.saveDesign(path, content).then(() => onWritten(`fp-${path}`));
      },
    }),
    prepareDraftWrite: (id: string) => prepareDesignWriteDestination({
      resource: `native-draft:${id}`,
      write: (content) => mocks.saveDesignDraft(id, content),
    }),
    deleteDesignDraft: mocks.deleteDesignDraft,
    openDesignDialog: vi.fn(),
    newDesign: vi.fn(),
  };
});

vi.mock("../app/document-session/workflows", () => ({
  DESIGN_SESSION_WORKFLOWS: [{
    id: "consortium-sync",
    install: mocks.installConsortiumSync,
  }],
}));

import {
  CanvasAuthorityBusyError,
  CanvasDocumentReplacementNotAdmittedError,
  type CanvasDocumentSurface,
} from "../canvas/runtime/runtime";
import { SceneHistory } from "../canvas/runtime/scene-history";
import { SceneStore } from "../canvas/runtime/scene";
import { SceneRuntimeEditCoordinator } from "../canvas/runtime/scene-runtime/transactions";
import { setCurrentCanvasSession } from "../canvas/session";
import { createTestCanvasRuntimeSurfaces } from "./support/canvas-runtime-surfaces";
import {
  createDesignSessionStateMachine,
  type DesignSessionStateMachine,
  type DocumentTransitionLoadResult,
  type DocumentTransitionResult,
} from "../app/document-session/state-machine";
import { createDesignSessionPersistence } from "../app/document-session/persistence";
import { prepareDesignWriteDestination } from "../app/document-session/write-admission";
import {
  createDesignSessionStore,
  type PersistenceCapableDesignSessionStore,
} from "../app/document-session/store";
import type { CanopiFile } from "../types/design";
import { DesignHomeConflictError } from "../app/document-session/continuous-save";

let store: PersistenceCapableDesignSessionStore;
let machine: DesignSessionStateMachine;

function makeFile(name: string): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: "2026-04-28T00:00:00.000Z",
    updated_at: "2026-04-28T00:00:00.000Z",
    extra: {},
  };
}

function makeSession(): CanvasDocumentSurface {
  let loaded = false;
  return {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
    showCanvasChrome: vi.fn(),
    hideCanvasChrome: vi.fn(),
    zoomToFit: vi.fn(),
    loadDocument: vi.fn(() => {
      loaded = true;
    }),
    replaceDocument: vi.fn((_file, _token, finalizeReplacement) => {
      loaded = true;
      finalizeReplacement();
      return { callerFinalizerInvoked: true };
    }),
    hasLoadedDocument: vi.fn(() => loaded),
    captureForPersistence: vi.fn((metadata, doc) => ({
      content: { ...doc, name: metadata.name },
      isCurrent: vi.fn(() => true),
      acknowledgeSaved: vi.fn(() => "applied" as const),
    })),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeSettledSceneSession(
  file: CanopiFile,
  history = new SceneHistory(),
): CanvasDocumentSurface {
  const sceneStore = new SceneStore().hydrate(file);
  const authority = new SceneRuntimeEditCoordinator({
    sceneStore,
    history,
    setSelection: (ids) => sceneStore.setSelection(ids),
    incrementSceneRevision: () => {},
    syncCanvasSignalsFromScene: () => {},
    invalidate: () => {},
  });
  let loaded = true;
  let settling = false;

  return {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
    showCanvasChrome: vi.fn(),
    hideCanvasChrome: vi.fn(),
    zoomToFit: vi.fn(),
    loadDocument: vi.fn((nextFile) => {
      settling = true;
      authority.hydrate(nextFile);
      loaded = true;
      settling = false;
    }),
    replaceDocument: vi.fn((nextFile, token, finalizeReplacement) => {
      settling = true;
      const callerFinalizerInvoked = authority.replaceDocument(nextFile, {
        token,
        prepare: () => {},
        finalizeReplacement,
      });
      loaded = true;
      settling = false;
      return { callerFinalizerInvoked };
    }),
    hasLoadedDocument: vi.fn(() => loaded),
    captureForPersistence: vi.fn((metadata, document) => {
      if (settling) throw new CanvasAuthorityBusyError("document-settlement");
      const capture = authority.capturePersistence();
      return {
        content: { ...document, name: metadata.name },
        isCurrent: () => capture.isCurrent(),
        acknowledgeSaved: () => capture.acknowledgeSaved(),
      };
    }),
    resize: vi.fn(),
    destroy: vi.fn(() => authority.disposePersistence()),
  };
}

function makePostFinalizerFailureSession(): CanvasDocumentSurface {
  let settling = false;
  let acceptedToken: object | null = null;
  let retainedFinalizer: (() => void) | null = null;
  return {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
    showCanvasChrome: vi.fn(),
    hideCanvasChrome: vi.fn(),
    zoomToFit: vi.fn(),
    loadDocument: vi.fn(),
    replaceDocument: vi.fn((_file, token, finalizeReplacement) => {
      settling = true;
      if (!acceptedToken) {
        acceptedToken = token;
        retainedFinalizer = finalizeReplacement;
        finalizeReplacement();
        throw new Error("post-finalizer Scene publication failed");
      }
      expect(token).toBe(acceptedToken);
      retainedFinalizer?.();
      settling = false;
      return { callerFinalizerInvoked: false };
    }),
    hasLoadedDocument: vi.fn(() => true),
    captureForPersistence: vi.fn((metadata, document) => {
      if (settling) throw new CanvasAuthorityBusyError("document-settlement");
      return {
        content: { ...document, name: metadata.name },
        isCurrent: () => true,
        acknowledgeSaved: () => "applied" as const,
      };
    }),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

function makePreFinalizerFailureSession(): CanvasDocumentSurface {
  let settling = false;
  return {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
    showCanvasChrome: vi.fn(),
    hideCanvasChrome: vi.fn(),
    zoomToFit: vi.fn(),
    loadDocument: vi.fn(),
    replaceDocument: vi.fn(() => {
      settling = true;
      throw new Error("pre-finalizer Scene publication failed");
    }),
    hasLoadedDocument: vi.fn(() => true),
    captureForPersistence: vi.fn((metadata, document) => {
      if (settling) throw new CanvasAuthorityBusyError("document-settlement");
      return {
        content: { ...document, name: metadata.name },
        isCurrent: () => true,
        acknowledgeSaved: () => "applied" as const,
      };
    }),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
}

function resetMachine({
  file = makeFile("Current"),
  path = "/designs/current.canopi",
  name = "Current",
}: {
  file?: CanopiFile | null;
  path?: string | null;
  name?: string;
} = {}): void {
  store = createDesignSessionStore({ file, path, name });
  machine = createDesignSessionStateMachine({
    store,
    requestSaveDecision: mocks.requestSaveDecision,
    presentOpenFailure: mocks.presentOpenFailure,
  });
  if (file) {
    machine.continuousSave.beginSession({
      draftId: path ? null : "draft-current",
      fingerprint: "fp-current",
      writePending: false,
    });
  }
}

beforeEach(() => {
  setCurrentCanvasSession(null);
  mocks.installConsortiumSync.mockClear();
  mocks.deleteDesignDraft.mockReset();
  mocks.deleteDesignDraft.mockResolvedValue(undefined);
  mocks.loadDesign.mockReset();
  mocks.message.mockReset();
  mocks.presentOpenFailure.mockReset();
  mocks.requestSaveDecision.mockReset();
  mocks.requestSaveDecision.mockResolvedValue("cancel");
  mocks.saveDesign.mockReset();
  mocks.saveDesign.mockResolvedValue(undefined);
  mocks.saveDesignDraft.mockReset();
  mocks.saveDesignDraft.mockResolvedValue(undefined);
  mocks.expectedFingerprints.length = 0;
  mocks.selectDesignSavePath.mockReset();
  mocks.selectDesignSavePath.mockResolvedValue("/designs/current.canopi");

  resetMachine();
});

describe("continuous save conflicts", () => {
  async function conflictOnNextWrite(fileGone = false): Promise<void> {
    markDesignSessionDirtyForTest(store);
    mocks.saveDesign.mockRejectedValueOnce(new DesignHomeConflictError(fileGone));
    await expect(machine.continuousSave.flush()).resolves.toBe(false);
    expect(machine.continuousSave.status.value).toBe("conflict");
  }

  it("pauses on a conflict and overwrites the file when the user keeps their version", async () => {
    await conflictOnNextWrite();
    mocks.requestSaveDecision.mockResolvedValueOnce("keep-mine");

    await machine.resolveSaveConflict();

    expect(mocks.requestSaveDecision).toHaveBeenCalledWith({ kind: "conflict", fileGone: false });
    expect(mocks.expectedFingerprints).toEqual(["fp-current", null]);
    expect(machine.continuousSave.status.value).toBe("saved");
    expect(machine.continuousSave.readHome()).toMatchObject({
      fingerprint: "fp-/designs/current.canopi",
    });
  });

  it("reloads the file without writing when the user takes the file's version", async () => {
    await conflictOnNextWrite();
    mocks.requestSaveDecision.mockResolvedValueOnce("use-file");
    mocks.loadDesign.mockResolvedValueOnce({
      file: { ...makeFile("From Disk"), description: "external" },
      fingerprint: "fp-disk",
    });

    await expect(machine.resolveSaveConflict()).resolves.toMatchObject({ status: "applied" });

    expect(mocks.loadDesign).toHaveBeenCalledWith("/designs/current.canopi");
    expect(mocks.saveDesign).toHaveBeenCalledOnce();
    expect(store.readCurrentDesign()?.description).toBe("external");
    expect(machine.continuousSave.status.value).toBe("saved");
    expect(machine.continuousSave.readHome()).toMatchObject({ fingerprint: "fp-disk" });
  });

  it("saves the user's version as a copy that becomes the home", async () => {
    await conflictOnNextWrite(true);
    mocks.requestSaveDecision.mockResolvedValueOnce("save-copy");
    mocks.selectDesignSavePath.mockResolvedValueOnce("/designs/copy.canopi");

    await machine.resolveSaveConflict();

    expect(mocks.requestSaveDecision).toHaveBeenCalledWith({ kind: "conflict", fileGone: true });
    expect(mocks.expectedFingerprints).toEqual(["fp-current", null]);
    expect(store.readDesignPath()).toBe("/designs/copy.canopi");
    expect(machine.continuousSave.status.value).toBe("saved");
  });

  it("opens the conflict decision from Save instead of writing", async () => {
    await conflictOnNextWrite();

    await expect(machine.saveCurrentDesign()).resolves.toBe(false);

    expect(mocks.requestSaveDecision).toHaveBeenCalledWith({ kind: "conflict", fileGone: false });
    expect(mocks.saveDesign).toHaveBeenCalledOnce();
  });

  it("asks once before replacing a Design whose changes are paused by a conflict", async () => {
    await conflictOnNextWrite();
    mocks.requestSaveDecision.mockResolvedValueOnce("discard");

    await expect(machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session: null,
      load: async () => ({ file: makeFile("Next"), path: "/designs/next.canopi", name: "Next" }),
    })).resolves.toMatchObject({ status: "applied" });

    expect(mocks.requestSaveDecision).toHaveBeenCalledOnce();
    expect(mocks.requestSaveDecision).toHaveBeenCalledWith({
      kind: "flush-failed",
      purpose: "replace",
      conflict: true,
    });
    expect(mocks.saveDesign).toHaveBeenCalledOnce();
    expect(machine.continuousSave.status.value).toBe("saved");
  });
});

describe("save decisions stay bound to the session that asked", () => {
  async function openNextDuringDecision(): Promise<void> {
    await expect(machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session: null,
      load: async () => ({
        file: { ...makeFile("Next"), description: "next" },
        path: "/designs/next.canopi",
        name: "Next",
        fingerprint: "fp-next",
      }),
    })).resolves.toMatchObject({ status: "applied" });
    expect(store.readDesignPath()).toBe("/designs/next.canopi");
  }

  it("does not overwrite a Design opened while the conflict dialog was open", async () => {
    markDesignSessionDirtyForTest(store);
    mocks.saveDesign.mockRejectedValueOnce(new DesignHomeConflictError(false));
    await machine.continuousSave.flush();
    const decision = deferred<string>();
    mocks.requestSaveDecision.mockReturnValueOnce(decision.promise);
    mocks.requestSaveDecision.mockResolvedValueOnce("discard");

    const resolving = machine.resolveSaveConflict();
    await openNextDuringDecision();
    markDesignSessionDirtyForTest(store);
    mocks.saveDesign.mockClear();
    mocks.expectedFingerprints.length = 0;
    decision.resolve("keep-mine");

    await expect(resolving).resolves.toBeNull();
    expect(mocks.saveDesign).not.toHaveBeenCalled();
    expect(machine.continuousSave.readHome()).toMatchObject({ fingerprint: "fp-next" });
  });

  it("does not reload over a Design opened while the conflict dialog was open", async () => {
    markDesignSessionDirtyForTest(store);
    mocks.saveDesign.mockRejectedValueOnce(new DesignHomeConflictError(false));
    await machine.continuousSave.flush();
    const decision = deferred<string>();
    mocks.requestSaveDecision.mockReturnValueOnce(decision.promise);
    mocks.requestSaveDecision.mockResolvedValueOnce("discard");

    const resolving = machine.resolveSaveConflict();
    await openNextDuringDecision();
    decision.resolve("use-file");

    await expect(resolving).resolves.toBeNull();
    expect(mocks.loadDesign).not.toHaveBeenCalled();
    expect(store.readCurrentDesign()?.description).toBe("next");
  });

  it("does not revert a Design opened while the revert confirmation was open", async () => {
    editDesignSessionForTest(store, (design) => ({ ...design, description: "edited" }));
    const decision = deferred<string>();
    mocks.requestSaveDecision.mockReturnValueOnce(decision.promise);

    const reverting = machine.revertToOpenedVersion();
    await openNextDuringDecision();
    decision.resolve("revert");

    await expect(reverting).resolves.toMatchObject({ status: "cancelled" });
    expect(store.readDesignPath()).toBe("/designs/next.canopi");
    expect(store.readCurrentDesign()?.description).toBe("next");
  });
});

describe("continuous save homes", () => {
  it("turns Save on a Draft home into Save As and deletes the Draft", async () => {
    resetMachine({ file: makeFile("Draft Garden"), path: null, name: "Draft Garden" });
    markDesignSessionDirtyForTest(store);
    mocks.selectDesignSavePath.mockResolvedValueOnce("/designs/draft-garden.canopi");

    await expect(machine.saveCurrentDesign()).resolves.toBe(true);

    expect(mocks.expectedFingerprints).toEqual([null]);
    expect(mocks.deleteDesignDraft).toHaveBeenCalledWith("draft-current");
    expect(machine.continuousSave.readHome()).toEqual({
      kind: "file",
      path: "/designs/draft-garden.canopi",
      fingerprint: "fp-/designs/draft-garden.canopi",
    });
  });

  it("writes the Save As file when a continuous write runs while its dialog is open", async () => {
    resetMachine({ file: makeFile("Draft Garden"), path: null, name: "Draft Garden" });
    markDesignSessionDirtyForTest(store);
    const selected = deferred<string>();
    mocks.selectDesignSavePath.mockReturnValueOnce(selected.promise);

    const saving = machine.saveAsCurrentDesign({ session: null });
    await flushMicrotasks();
    // The dialog takes focus, so close-guard flushes the Draft meanwhile.
    markDesignSessionDirtyForTest(store);
    await expect(machine.continuousSave.flush()).resolves.toBe(true);
    expect(mocks.saveDesignDraft).toHaveBeenCalledOnce();
    selected.resolve("/designs/garden.canopi");

    await expect(saving).resolves.toMatchObject({
      status: "applied",
      path: "/designs/garden.canopi",
    });
    expect(mocks.saveDesign).toHaveBeenCalledWith("/designs/garden.canopi", expect.anything());
    expect(store.readDesignPath()).toBe("/designs/garden.canopi");
    expect(machine.continuousSave.readHome()).toMatchObject({
      kind: "file",
      path: "/designs/garden.canopi",
    });
  });

  it("keeps the home pending when a continuous write settles stale", async () => {
    store = createDesignSessionStore({ file: makeFile("Template"), path: null, name: "Template" });
    const persistence = createDesignSessionPersistence({ store });
    machine = createDesignSessionStateMachine({
      store,
      requestSaveDecision: mocks.requestSaveDecision,
      presentOpenFailure: mocks.presentOpenFailure,
      persistence: {
        ...persistence,
        beginSnapshotSave: () => ({
          execute: async () => ({
            status: "stale" as const,
            path: null,
            content: makeFile("Template"),
          }),
        }),
      },
    });
    machine.continuousSave.beginSession({
      draftId: "draft-template",
      fingerprint: null,
      writePending: true,
    });

    await expect(machine.continuousSave.flush()).resolves.toBe(false);

    expect(machine.continuousSave.hasPendingChanges()).toBe(true);
  });

  it("asks before reverting and keeps the Design when cancelled", async () => {
    editDesignSessionForTest(store, (design) => ({ ...design, description: "edited" }));
    mocks.requestSaveDecision.mockResolvedValueOnce("cancel");

    await expect(machine.revertToOpenedVersion()).resolves.toMatchObject({ status: "cancelled" });

    expect(mocks.requestSaveDecision).toHaveBeenCalledWith({ kind: "revert" });
    expect(store.readCurrentDesign()?.description).toBe("edited");
  });

  it("reverts to the opened version and writes it to the same file", async () => {
    editDesignSessionForTest(store, (design) => ({ ...design, description: "edited" }));
    expect(machine.continuousSave.revertAvailable.value).toBe(true);
    mocks.requestSaveDecision.mockResolvedValueOnce("revert");

    await expect(machine.revertToOpenedVersion()).resolves.toMatchObject({ status: "applied" });
    expect(store.readCurrentDesign()?.description).toBeNull();
    expect(machine.continuousSave.revertAvailable.value).toBe(false);
    await expect(machine.continuousSave.flush()).resolves.toBe(true);

    expect(mocks.saveDesign).toHaveBeenCalledWith(
      "/designs/current.canopi",
      expect.objectContaining({ description: null }),
    );
    expect(mocks.expectedFingerprints).toEqual(["fp-current"]);
  });
});

describe("document session sequences", () => {
  it("closes after a write in flight lands and writes nothing more for the closed Design", async () => {
    const session = makeSession();
    await machine.startAttachedDesignSession(session);
    markDesignSessionDirtyForTest(store);
    const pending = deferred<void>();
    mocks.saveDesign.mockReturnValueOnce(pending.promise);

    const saving = machine.saveCurrentDesign({ session });
    await flushMicrotasks();
    expect(mocks.saveDesign).toHaveBeenCalledTimes(1);
    expect(machine.getState()).toMatchObject({ status: "saving", operation: "save" });

    const closing = machine.closeDesign({ session });
    await flushMicrotasks();
    // Close waits for the write; the Design is still open meanwhile.
    expect(store.hasCurrentDesign()).toBe(true);

    pending.resolve();
    await expect(saving).resolves.toBe(true);
    await expect(closing).resolves.toMatchObject({ status: "applied" });
    expect(mocks.saveDesign).toHaveBeenCalledTimes(1);
    expect(mocks.requestSaveDecision).not.toHaveBeenCalled();
    expect(store.hasCurrentDesign()).toBe(false);
    expect(machine.continuousSave.sessionToken()).toBeNull();
    expect(machine.getState()).toMatchObject({ attached: true, operation: null });
  });

  it("asks once with the Close wording when the write before Close fails, and closes after Retry succeeds", async () => {
    const session = makeSession();
    await machine.startAttachedDesignSession(session);
    markDesignSessionDirtyForTest(store);
    mocks.saveDesign.mockRejectedValueOnce(new Error("disk full"));
    mocks.requestSaveDecision.mockResolvedValueOnce("retry");

    await expect(machine.closeDesign({ session })).resolves.toMatchObject({ status: "applied" });

    expect(mocks.requestSaveDecision).toHaveBeenCalledTimes(1);
    expect(mocks.requestSaveDecision).toHaveBeenCalledWith({
      kind: "flush-failed",
      purpose: "close",
      conflict: false,
    });
    expect(mocks.saveDesign).toHaveBeenCalledTimes(2);
    expect(store.hasCurrentDesign()).toBe(false);
    expect(machine.continuousSave.status.peek()).toBe("saved");
    expect(machine.getState()).toMatchObject({ attached: true, operation: null });
  });

  it("keeps the Design open, dirty and retryable when the write before Close fails and the user cancels", async () => {
    const session = makeSession();
    await machine.startAttachedDesignSession(session);
    markDesignSessionDirtyForTest(store);
    mocks.saveDesign.mockRejectedValueOnce(new Error("disk full"));
    mocks.requestSaveDecision.mockResolvedValueOnce("cancel");

    await expect(machine.closeDesign({ session })).resolves.toMatchObject({ status: "cancelled" });

    expect(store.hasCurrentDesign()).toBe(true);
    expect(store.isDesignDirty()).toBe(true);
    expect(machine.continuousSave.status.peek()).toBe("error");
    expect(machine.continuousSave.failureReason.peek()).toBe("disk full");
    expect(machine.getState()).toMatchObject({ status: "attached-ready", operation: null });

    // Save (Retry) writes and clears the failure.
    await expect(machine.saveCurrentDesign({ session })).resolves.toBe(true);
    expect(machine.continuousSave.status.peek()).toBe("saved");
    expect(store.isDesignDirty()).toBe(false);
  });

  it("cancels Close when an edit lands while its write is in flight, keeping the edit", async () => {
    const session = makeSession();
    await machine.startAttachedDesignSession(session);
    markDesignSessionDirtyForTest(store);
    const pending = deferred<void>();
    mocks.saveDesign.mockReturnValueOnce(pending.promise);

    const closing = machine.closeDesign({ session });
    await flushMicrotasks();
    expect(mocks.saveDesign).toHaveBeenCalledTimes(1);
    editDesignSessionForTest(store, (design) => ({ ...design, description: "Edited during the close write" }));
    pending.resolve();

    await expect(closing).resolves.toMatchObject({ status: "cancelled" });
    expect(store.hasCurrentDesign()).toBe(true);
    expect(store.readCurrentDesign()?.description).toBe("Edited during the close write");
    expect(store.isDesignDirty()).toBe(true);
    expect(machine.continuousSave.sessionToken()).not.toBeNull();
    expect(machine.getState()).toMatchObject({ status: "attached-ready", operation: null });
  });

  it("keeps the Draft home and its write when Save As is cancelled during a Draft write", async () => {
    resetMachine({ path: null });
    const session = makeSession();
    await machine.startAttachedDesignSession(session);
    markDesignSessionDirtyForTest(store);
    const pending = deferred<void>();
    mocks.saveDesignDraft.mockReturnValueOnce(pending.promise);
    mocks.selectDesignSavePath.mockRejectedValueOnce("Dialog cancelled");

    const flushing = machine.continuousSave.flush();
    await flushMicrotasks();
    expect(mocks.saveDesignDraft).toHaveBeenCalledTimes(1);
    // A Save As whose dialog is cancelled never issues a save, so the Draft write stands.
    await expect(machine.saveAsCurrentDesign({ session })).resolves.toBeNull();
    pending.resolve();
    await expect(flushing).resolves.toBe(true);

    expect(machine.continuousSave.readHome()).toEqual({ kind: "draft", id: "draft-current" });
    expect(machine.getState()).toMatchObject({ status: "attached-ready", operation: null });
    await expect(machine.continuousSave.flush()).resolves.toBe(true);
    expect(mocks.saveDesignDraft).toHaveBeenCalledTimes(1);
    expect(store.isDesignDirty()).toBe(false);
    expect(machine.continuousSave.status.peek()).toBe("draft");
  });
});

describe("document session transition", () => {
  it("writes a dirty Design, then applies an open-path replacement through the full post-load sequence", async () => {
    const session = makeSession();
    markDesignSessionDirtyForTest(store);

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load: async () => ({
        file: makeFile("Next"),
        path: "/designs/next.canopi",
        name: "Next",
      }),
    });

    expect(result).toEqual({ status: "applied", documentLoaded: true });
    expect(mocks.requestSaveDecision).not.toHaveBeenCalled();
    expect(mocks.saveDesign).toHaveBeenCalledOnce();
    expect(mocks.expectedFingerprints).toEqual(["fp-current"]);
    expect(session.replaceDocument).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Next", extra: {} }),
      expect.any(Object),
      expect.any(Function),
    );
    expect(session.loadDocument).not.toHaveBeenCalled();
    expect(store.readCurrentDesign()?.name).toBe("Next");
    expect(store.readDesignName()).toBe("Next");
    expect(store.readDesignPath()).toBe("/designs/next.canopi");
    expect(store.designDirty.value).toBe(false);
    expect(session.showCanvasChrome).toHaveBeenCalledTimes(1);
    expect(session.zoomToFit).toHaveBeenCalledTimes(1);
    expect(mocks.installConsortiumSync).toHaveBeenCalledTimes(1);
  });

  it("exposes loading and attached-ready states around attached transitions", async () => {
    const session = makeSession();
    const pending = deferred<DocumentTransitionLoadResult>();

    const transition = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => pending.promise,
    });

    expect(machine.getState()).toMatchObject({
      status: "loading",
      attached: true,
      documentLoaded: false,
      operation: "open-path",
    });

    pending.resolve({
      file: makeFile("Next"),
      path: "/designs/next.canopi",
      name: "Next",
    });

    await transition;

    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      attached: true,
      documentLoaded: true,
      operation: null,
    });
  });

  it("does not apply an attached transition after teardown releases its Canvas lease", async () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    const pending = deferred<DocumentTransitionLoadResult>();
    const transition = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => pending.promise,
    });

    machine.teardownAttachedDesignSession({
      session,
      runtimeInitialized: true,
      logError: vi.fn(),
    });
    pending.resolve({
      file: makeFile("Late replacement"),
      path: "/designs/late.canopi",
      name: "Late replacement",
    });

    await expect(transition).resolves.toMatchObject({ status: "cancelled" });
    expect(session.replaceDocument).not.toHaveBeenCalled();
    expect(store.readDesignName()).toBe("Current");
    expect(mocks.installConsortiumSync).not.toHaveBeenCalled();
    expect(machine.getState()).toMatchObject({
      status: "detached-ready",
      attached: false,
      operation: null,
    });
  });

  it("safely aborts an unpublished failed initial hydration so a later Canvas can mount", async () => {
    const firstSession = makeSession();
    const loadFirstDocument = vi.mocked(firstSession.loadDocument).getMockImplementation()!;
    vi.mocked(firstSession.loadDocument).mockImplementationOnce((file) => {
      loadFirstDocument(file);
      throw new Error("late initial hydration publication failed");
    });
    const workflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    };
    const persistence = createDesignSessionPersistence({ store });
    machine = createDesignSessionStateMachine({ store, persistence, workflowRunner });

    await expect(machine.startAttachedDesignSession(firstSession)).resolves.toMatchObject({
      status: "failed",
      documentLoaded: true,
    });
    expect(persistence.isCanvasAttached(firstSession)).toBe(true);

    machine.teardownAttachedDesignSession({
      session: firstSession,
      runtimeInitialized: false,
      logError: vi.fn(),
    });

    expect(persistence.isCanvasAttached(firstSession)).toBe(false);
    const successor = makeSession();
    await expect(machine.startAttachedDesignSession(successor)).resolves.toEqual({
      status: "applied",
      documentLoaded: true,
    });
    expect(successor.loadDocument).toHaveBeenCalledOnce();
  });

  it("mounts the current Scene before a same-turn non-canvas Design edit", async () => {
    const session = makeSession();

    const mounting = machine.startAttachedDesignSession(session);
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Field note published while mount returns",
    }));

    await expect(mounting).resolves.toEqual({
      status: "applied",
      documentLoaded: true,
    });
    expect(session.loadDocument).toHaveBeenCalledOnce();
    expect(store.readCurrentDesign()?.description).toBe(
      "Field note published while mount returns",
    );
    expect(store.isDesignDirty()).toBe(true);
  });

  it("rejects a detached replacement while a Canvas still owns the session", async () => {
    const session = makeSession();
    machine.beginEmptyDocumentSession(session);
    const load = vi.fn(async () => ({
      file: makeFile("Detached replacement"),
      path: "/designs/detached.canopi",
      name: "Detached replacement",
    }));

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session: null,
      load,
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(load).not.toHaveBeenCalled();
    expect(store.readDesignName()).toBe("Current");
  });

  it("lets only the latest attached transition replace the Design", async () => {
    const session = makeSession();
    const firstPending = deferred<DocumentTransitionLoadResult>();
    const secondPending = deferred<DocumentTransitionLoadResult>();
    const first = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => firstPending.promise,
    });
    const second = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => secondPending.promise,
    });

    secondPending.resolve({
      file: makeFile("Second"),
      path: "/designs/second.canopi",
      name: "Second",
    });
    await expect(second).resolves.toMatchObject({ status: "applied" });
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });
    firstPending.resolve({
      file: makeFile("First"),
      path: "/designs/first.canopi",
      name: "First",
    });

    await expect(first).resolves.toMatchObject({ status: "cancelled" });
    expect(store.readDesignName()).toBe("Second");
    expect(store.readDesignPath()).toBe("/designs/second.canopi");
    expect(session.replaceDocument).toHaveBeenCalledOnce();
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });
  });

  it("reports an applied transition when its Design publication starts a successor", async () => {
    const session = makeSession();
    const successorLoad = deferred<DocumentTransitionLoadResult>();
    let successorTransition: Promise<DocumentTransitionResult> | null = null;
    const disposeEffect = effect(() => {
      if (store.currentDesign.value?.name !== "First" || successorTransition) return;
      successorTransition = machine.transitionDocument({
        source: "open-path",
        dirtyGuard: "skip",
        session,
        load: () => successorLoad.promise,
      });
    });

    const first = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("First"),
        path: "/designs/first.canopi",
        name: "First",
      }),
    });

    expect(first).toEqual({ status: "applied", documentLoaded: true });
    expect(successorTransition).not.toBeNull();
    expect(machine.getState()).toMatchObject({
      status: "loading",
      operation: "open-path",
    });

    const successorError = new Error("Successor failed");
    successorLoad.reject(successorError);
    await expect(successorTransition!).resolves.toEqual({
      status: "failed",
      documentLoaded: true,
      error: successorError,
    });
    expect(store.readDesignName()).toBe("First");
    expect(store.readDesignPath()).toBe("/designs/first.canopi");
    disposeEffect();
  });

  it("executes a successor Save issued by replacement finalization", async () => {
    const session = makeSession();
    mocks.selectDesignSavePath.mockResolvedValue("/designs/first.canopi");
    let successorSave: ReturnType<typeof machine.saveAsCurrentDesign> | null = null;
    const disposeEffect = effect(() => {
      if (store.currentDesign.value?.name !== "First" || successorSave) return;
      successorSave = machine.saveAsCurrentDesign({ session });
    });

    try {
      await expect(machine.transitionDocument({
        source: "open-path",
        dirtyGuard: "skip",
        session,
        load: async () => ({
          file: makeFile("First"),
          path: "/designs/first.canopi",
          name: "First",
        }),
      })).resolves.toEqual({ status: "applied", documentLoaded: true });

      expect(successorSave).not.toBeNull();
      await expect(successorSave!).resolves.toMatchObject({
        status: "applied",
        path: "/designs/first.canopi",
        content: { name: "First" },
      });
      expect(mocks.saveDesign).toHaveBeenCalledWith(
        "/designs/first.canopi",
        expect.objectContaining({ name: "First" }),
      );
    } finally {
      disposeEffect();
    }
  });

  it("admits a reactive successor after the predecessor Scene replacement settles", async () => {
    const session = makeSettledSceneSession(makeFile("Current"));
    const successorPending = deferred<DocumentTransitionLoadResult>();
    const successorLoad = vi.fn(() => successorPending.promise);
    let successorTransition: Promise<DocumentTransitionResult> | null = null;
    const disposeEffect = effect(() => {
      if (store.currentDesign.value?.name !== "First" || successorTransition) return;
      successorTransition = machine.transitionDocument({
        source: "open-path",
        dirtyGuard: "skip",
        session,
        load: successorLoad,
      });
    });

    try {
      await expect(machine.transitionDocument({
        source: "open-path",
        dirtyGuard: "skip",
        session,
        load: async () => ({
          file: makeFile("First"),
          path: "/designs/first.canopi",
          name: "First",
        }),
      })).resolves.toEqual({ status: "applied", documentLoaded: true });

      expect(successorTransition).not.toBeNull();
      expect(successorLoad).toHaveBeenCalledOnce();

      successorPending.resolve({
        file: makeFile("Second"),
        path: "/designs/second.canopi",
        name: "Second",
      });
      await expect(successorTransition!).resolves.toEqual({
        status: "applied",
        documentLoaded: true,
      });
      expect(store.readDesignName()).toBe("Second");
    } finally {
      disposeEffect();
    }
  });

  it("retries a retained Scene replacement after late hydration publication fails", async () => {
    let cleanStateFailures = 1;
    const history = new SceneHistory({
      reportCleanState: () => {
        if (cleanStateFailures > 0) {
          cleanStateFailures -= 1;
          throw new Error("clean-state publication failed");
        }
      },
    });
    const session = makeSettledSceneSession(makeFile("Current"), history);
    const request = () => machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("Recovered"),
        path: "/designs/recovered.canopi",
        name: "Recovered",
      }),
    });

    await expect(request()).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({ message: "clean-state publication failed" }),
    });

    await expect(request()).resolves.toEqual({
      status: "applied",
      documentLoaded: true,
    });
    expect(store.readDesignName()).toBe("Recovered");
    expect(session.replaceDocument).toHaveBeenCalledTimes(2);
  });

  it("resumes retained Scene settlement after Design finalization without erasing later edits", async () => {
    const session = makePostFinalizerFailureSession();
    const replaceState = vi.spyOn(store, "replaceCurrentDesignState");
    const request = () => machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("Recovered"),
        path: "/designs/recovered.canopi",
        name: "Recovered",
      }),
    });

    await expect(request()).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        message: "post-finalizer Scene publication failed",
      }),
    });
    expect(store.readDesignName()).toBe("Recovered");
    expect(replaceState).toHaveBeenCalledOnce();

    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Edit made after Design finalization",
    }));

    await expect(request()).resolves.toEqual({
      status: "applied",
      documentLoaded: true,
    });
    expect(replaceState).toHaveBeenCalledOnce();
    expect(store.readCurrentDesign()?.description).toBe(
      "Edit made after Design finalization",
    );
    expect(session.replaceDocument).toHaveBeenCalledTimes(2);
  });

  it("does not lend a finalized replacement authorization to a different target", async () => {
    const session = makePostFinalizerFailureSession();
    await expect(machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("First Target"),
        path: "/designs/first-target.canopi",
        name: "First Target",
      }),
    })).resolves.toMatchObject({ status: "failed" });
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Edit made after First Target finalized",
    }));
    const loadSecondTarget = vi.fn(async () => ({
      file: makeFile("Second Target"),
      path: "/designs/second-target.canopi",
      name: "Second Target",
    }));

    await expect(machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: loadSecondTarget,
    })).resolves.toEqual({
      status: "cancelled",
      documentLoaded: true,
    });
    expect(loadSecondTarget).toHaveBeenCalledOnce();
    expect(store.readDesignName()).toBe("First Target");
    expect(store.readCurrentDesign()?.description).toBe(
      "Edit made after First Target finalized",
    );
    expect(session.replaceDocument).toHaveBeenCalledTimes(2);
  });

  it("prompts before a different target can supersede a finalized replacement", async () => {
    const session = makePostFinalizerFailureSession();
    await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("First Target"),
        path: "/designs/first-target.canopi",
        name: "First Target",
      }),
    });
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Edit requiring a fresh decision",
    }));
    mocks.requestSaveDecision.mockResolvedValueOnce("cancel");
    const loadSecondTarget = vi.fn(async () => ({
      file: makeFile("Second Target"),
      path: "/designs/second-target.canopi",
      name: "Second Target",
    }));

    await expect(machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load: loadSecondTarget,
    })).resolves.toEqual({
      status: "cancelled",
      documentLoaded: true,
    });
    expect(mocks.requestSaveDecision).toHaveBeenCalledOnce();
    expect(loadSecondTarget).not.toHaveBeenCalled();
    expect(store.readCurrentDesign()?.description).toBe(
      "Edit requiring a fresh decision",
    );
    expect(session.replaceDocument).toHaveBeenCalledOnce();
  });

  it("settles a pending replacement before teardown without erasing newer Design edits", async () => {
    let settling = false;
    let acceptedToken: object | null = null;
    let retainedFinalizer: (() => void) | null = null;
    const session: CanvasDocumentSurface = {
      presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
      showCanvasChrome: vi.fn(),
      hideCanvasChrome: vi.fn(),
      zoomToFit: vi.fn(),
      loadDocument: vi.fn(),
      replaceDocument: vi.fn((_file, token, finalizeReplacement) => {
        settling = true;
        if (!acceptedToken) {
          acceptedToken = token;
          retainedFinalizer = finalizeReplacement;
          throw new Error("pre-finalizer Scene publication failed");
        }
        expect(token).toBe(acceptedToken);
        retainedFinalizer?.();
        settling = false;
        return { callerFinalizerInvoked: false };
      }),
      hasLoadedDocument: vi.fn(() => true),
      captureForPersistence: vi.fn((metadata, document) => {
        if (settling) throw new CanvasAuthorityBusyError("document-settlement");
        return {
          content: { ...document, name: metadata.name },
          isCurrent: () => true,
          acknowledgeSaved: () => "applied" as const,
        };
      }),
      resize: vi.fn(),
      destroy: vi.fn(),
    };

    await expect(machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("Replacement"),
        path: "/designs/replacement.canopi",
        name: "Replacement",
      }),
    })).resolves.toMatchObject({ status: "failed" });
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Field note added after replacement failed",
    }));

    expect(() => machine.teardownAttachedDesignSession({
      session,
      runtimeInitialized: true,
      logError: vi.fn(),
    })).not.toThrow();
    expect(store.readDesignName()).toBe("Current");
    expect(store.readCurrentDesign()?.description).toBe(
      "Field note added after replacement failed",
    );

    const successor = makeSession();
    await expect(machine.startAttachedDesignSession(successor)).resolves.toEqual({
      status: "applied",
      documentLoaded: true,
    });
    expect(successor.loadDocument).toHaveBeenCalledOnce();
  });

  it("hands off the old Scene after a replacement was rejected before hydration", async () => {
    const scene: { color?: string } = {};
    const preparationError = new Error("replacement preparation failed");
    const replaceDocument = vi.fn(() => {
      throw new CanvasDocumentReplacementNotAdmittedError(preparationError);
    });
    const session: CanvasDocumentSurface = {
      presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
      showCanvasChrome: vi.fn(),
      hideCanvasChrome: vi.fn(),
      zoomToFit: vi.fn(),
      loadDocument: vi.fn(),
      replaceDocument,
      hasLoadedDocument: vi.fn(() => true),
      captureForPersistence: vi.fn((_metadata, document) => ({
        content: {
          ...document,
          plant_species_colors: scene.color
            ? { "Malus domestica": scene.color }
            : {},
        },
        isCurrent: () => true,
        acknowledgeSaved: () => "applied" as const,
      })),
      resize: vi.fn(),
      destroy: vi.fn(),
    };

    await expect(machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("Rejected Target"),
        path: "/designs/rejected.canopi",
        name: "Rejected Target",
      }),
    })).resolves.toMatchObject({
      status: "failed",
      error: preparationError,
    });

    scene.color = "#335577";
    store.setCanvasClean(false);
    expect(() => machine.teardownAttachedDesignSession({
      session,
      runtimeInitialized: true,
      logError: vi.fn(),
    })).not.toThrow();

    expect(replaceDocument).toHaveBeenCalledOnce();
    expect(store.readDesignName()).toBe("Current");
    expect(store.readCurrentDesign()?.plant_species_colors)
      .toEqual({ "Malus domestica": "#335577" });
    const successor = makeSession();
    await expect(machine.startAttachedDesignSession(successor)).resolves.toEqual({
      status: "applied",
      documentLoaded: true,
    });
    expect(successor.loadDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Current",
        plant_species_colors: { "Malus domestica": "#335577" },
      }),
    );
  });

  it("settles an admitted replacement before tearing down an initially empty session", async () => {
    resetMachine({ file: null, path: null, name: "Untitled" });
    let settling = false;
    let acceptedToken: object | null = null;
    let retainedFinalizer: (() => void) | null = null;
    const session: CanvasDocumentSurface = {
      presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
      showCanvasChrome: vi.fn(),
      hideCanvasChrome: vi.fn(),
      zoomToFit: vi.fn(),
      loadDocument: vi.fn(),
      replaceDocument: vi.fn((_file, token, finalizeReplacement) => {
        settling = true;
        if (!acceptedToken) {
          acceptedToken = token;
          retainedFinalizer = finalizeReplacement;
          throw new Error("pre-finalizer Scene publication failed");
        }
        expect(token).toBe(acceptedToken);
        retainedFinalizer?.();
        settling = false;
        return { callerFinalizerInvoked: false };
      }),
      hasLoadedDocument: vi.fn(() => true),
      captureForPersistence: vi.fn((metadata, document) => {
        if (settling) throw new CanvasAuthorityBusyError("document-settlement");
        return {
          content: { ...document, name: metadata.name },
          isCurrent: () => true,
          acknowledgeSaved: () => "applied" as const,
        };
      }),
      resize: vi.fn(),
      destroy: vi.fn(),
    };

    await expect(machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("First Document"),
        path: "/designs/first.canopi",
        name: "First Document",
      }),
    })).resolves.toMatchObject({ status: "failed" });
    expect(store.hasCurrentDesign()).toBe(false);

    expect(() => machine.teardownAttachedDesignSession({
      session,
      runtimeInitialized: true,
      logError: vi.fn(),
    })).not.toThrow();
    expect(store.readDesignName()).toBe("First Document");

    const successor = makeSession();
    await expect(machine.startAttachedDesignSession(successor)).resolves.toEqual({
      status: "applied",
      documentLoaded: true,
    });
    expect(successor.loadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ name: "First Document" }),
    );
  });

  it("does not let a retained Scene replacement erase a newer Design edit without confirmation", async () => {
    let cleanStateFailures = 1;
    const history = new SceneHistory({
      reportCleanState: () => {
        if (cleanStateFailures > 0) {
          cleanStateFailures -= 1;
          throw new Error("clean-state publication failed");
        }
      },
    });
    const session = makeSettledSceneSession(makeFile("Current"), history);
    const transition = () => machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load: async () => ({
        file: makeFile("Recovered"),
        path: "/designs/recovered.canopi",
        name: "Recovered",
      }),
    });

    await expect(transition()).resolves.toMatchObject({ status: "failed" });
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Edit made after failed replacement",
    }));
    mocks.requestSaveDecision.mockResolvedValueOnce("cancel");

    await expect(transition()).resolves.toEqual({
      status: "cancelled",
      documentLoaded: true,
    });
    expect(store.readCurrentDesign()?.description).toBe(
      "Edit made after failed replacement",
    );
    expect(store.readDesignName()).toBe("Current");
    expect(session.replaceDocument).toHaveBeenCalledOnce();

    mocks.requestSaveDecision.mockResolvedValueOnce("discard");
    await expect(transition()).resolves.toEqual({
      status: "applied",
      documentLoaded: true,
    });
    expect(store.readDesignName()).toBe("Recovered");
  });

  it("cancels a retained replacement when Design changes while its retry load awaits", async () => {
    let cleanStateFailures = 1;
    const history = new SceneHistory({
      reportCleanState: () => {
        if (cleanStateFailures > 0) {
          cleanStateFailures -= 1;
          throw new Error("clean-state publication failed");
        }
      },
    });
    const session = makeSettledSceneSession(makeFile("Current"), history);
    const immediateLoad = async () => ({
      file: makeFile("Recovered"),
      path: "/designs/recovered.canopi",
      name: "Recovered",
    });
    await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: immediateLoad,
    });
    const retryLoad = deferred<DocumentTransitionLoadResult>();
    const retry = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => retryLoad.promise,
    });
    await flushMicrotasks();
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Edit made during retry load",
    }));
    retryLoad.resolve(await immediateLoad());

    await expect(retry).resolves.toEqual({
      status: "cancelled",
      documentLoaded: true,
    });
    expect(store.readCurrentDesign()?.description).toBe("Edit made during retry load");
    expect(session.replaceDocument).toHaveBeenCalledOnce();
  });

  it("lets only the latest detached transition replace the Design", async () => {
    const firstPending = deferred<DocumentTransitionLoadResult>();
    const secondPending = deferred<DocumentTransitionLoadResult>();
    const first = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session: null,
      load: () => firstPending.promise,
    });
    const second = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session: null,
      load: () => secondPending.promise,
    });

    secondPending.resolve({
      file: makeFile("Detached Second"),
      path: "/designs/detached-second.canopi",
      name: "Detached Second",
    });
    await expect(second).resolves.toMatchObject({ status: "applied" });
    firstPending.resolve({
      file: makeFile("Detached First"),
      path: "/designs/detached-first.canopi",
      name: "Detached First",
    });

    await expect(first).resolves.toMatchObject({ status: "cancelled" });
    expect(store.readDesignName()).toBe("Detached Second");
    expect(store.readDesignPath()).toBe("/designs/detached-second.canopi");
    expect(machine.getState()).toMatchObject({
      status: "detached-ready",
      operation: null,
    });
  });

  it("saves a dirty current document before applying the replacement", async () => {
    const session = makeSession();
    markDesignSessionDirtyForTest(store);

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load: async () => ({
        file: makeFile("Next"),
        path: "/designs/next.canopi",
        name: "Next",
      }),
    });

    expect(result.status).toBe("applied");
    expect(mocks.saveDesign).toHaveBeenCalledWith(
      "/designs/current.canopi",
      expect.objectContaining({ name: "Current" }),
    );
    expect(store.readCurrentDesign()?.name).toBe("Next");
  });

  it("saves persistence-diverged content before applying the replacement", async () => {
    const olderPersistence = createDesignSessionPersistence({ store });
    const pendingWrite = deferred<void>();
    const olderSave = olderPersistence.beginSave().execute(
      prepareDesignWriteDestination({
        resource: "native-design:/designs/current.canopi",
        destinationPath: "/designs/current.canopi",
        write: () => pendingWrite.promise,
      }),
    );
    await flushMicrotasks();
    reconcileDesignSessionForTest(store, (design) => ({
      ...design,
      description: "derived reconciliation",
    }));
    pendingWrite.resolve();
    await expect(olderSave).resolves.toMatchObject({ status: "applied" });
    expect(store.isDesignDirty()).toBe(true);

    const session = makeSession();
    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load: async () => ({
        file: makeFile("Next"),
        path: "/designs/next.canopi",
        name: "Next",
      }),
    });

    expect(result.status).toBe("applied");
    expect(mocks.saveDesign).toHaveBeenCalledWith(
      "/designs/current.canopi",
      expect.objectContaining({ description: "derived reconciliation" }),
    );
    expect(store.readCurrentDesign()?.name).toBe("Next");
    olderPersistence.dispose();
  });

  it("does not let a superseded save decision retry against the successor Design", async () => {
    const session = makeSession();
    markDesignSessionDirtyForTest(store);
    mocks.saveDesign.mockRejectedValueOnce(new Error("disk full"));
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prompt = deferred<string>();
    mocks.requestSaveDecision.mockReturnValue(prompt.promise);
    const stale = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load: async () => ({
        file: makeFile("Stale"),
        path: "/designs/stale.canopi",
        name: "Stale",
      }),
    });
    await flushMicrotasks();

    const successor = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("Successor"),
        path: "/designs/successor.canopi",
        name: "Successor",
      }),
    });
    prompt.resolve("retry");

    expect(successor.status).toBe("applied");
    await expect(stale).resolves.toMatchObject({ status: "cancelled" });
    expect(mocks.saveDesign).toHaveBeenCalledOnce();
    expect(store.readDesignName()).toBe("Successor");
    logError.mockRestore();
  });

  it("cancels a replacement when a Design edit lands during loading", async () => {
    const session = makeSession();
    const pending = deferred<DocumentTransitionLoadResult>();
    const transition = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => pending.promise,
    });

    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Edit committed while loading",
    }));
    pending.resolve({
      file: makeFile("Replacement"),
      path: "/designs/replacement.canopi",
      name: "Replacement",
    });

    await expect(transition).resolves.toMatchObject({ status: "cancelled" });
    expect(session.replaceDocument).not.toHaveBeenCalled();
    expect(store.readCurrentDesign()?.description).toBe("Edit committed while loading");
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });
  });

  it("cancels replacement when final Canvas guard capture reenters a Design edit", async () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    let captureNumber = 0;
    vi.mocked(session.captureForPersistence).mockImplementation((metadata, document) => {
      captureNumber += 1;
      const content = { ...document, name: metadata.name };
      if (captureNumber === 3) {
        editDesignSessionForTest(store, (current) => ({
          ...current,
          description: "Reentrant final-guard edit",
        }));
      }
      return {
        content,
        isCurrent: () => true,
        acknowledgeSaved: vi.fn(() => "applied" as const),
      };
    });
    const pending = deferred<DocumentTransitionLoadResult>();
    const transition = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => pending.promise,
    });

    pending.resolve({
      file: makeFile("Replacement"),
      path: "/designs/replacement.canopi",
      name: "Replacement",
    });

    await expect(transition).resolves.toMatchObject({ status: "cancelled" });
    expect(session.replaceDocument).not.toHaveBeenCalled();
    expect(store.readCurrentDesign()?.description).toBe("Reentrant final-guard edit");
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });
  });

  it("cancels a replacement when a committed Scene edit lands during loading", async () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    let committedSceneVersion = 0;
    vi.mocked(session.captureForPersistence).mockImplementation((metadata, document) => ({
      content: {
        ...document,
        name: metadata.name,
        plants: committedSceneVersion === 0
          ? []
          : [{ id: "committed-during-load" } as CanopiFile["plants"][number]],
      },
      isCurrent: () => true,
      acknowledgeSaved: vi.fn(() => "applied" as const),
    }));
    const pending = deferred<DocumentTransitionLoadResult>();
    const transition = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => pending.promise,
    });

    committedSceneVersion = 1;
    store.setCanvasClean(false);
    pending.resolve({
      file: makeFile("Replacement"),
      path: "/designs/replacement.canopi",
      name: "Replacement",
    });

    await expect(transition).resolves.toMatchObject({ status: "cancelled" });
    expect(session.replaceDocument).not.toHaveBeenCalled();
    expect(store.isDesignDirty()).toBe(true);
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });
  });

  it("ignores regenerated persistence timestamps when guarding replacement", async () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    let captureNumber = 0;
    vi.mocked(session.captureForPersistence).mockImplementation((metadata, document) => {
      captureNumber += 1;
      return {
        content: {
          ...document,
          name: metadata.name,
          updated_at: new Date(captureNumber * 1000).toISOString(),
        },
        isCurrent: () => true,
        acknowledgeSaved: vi.fn(() => "applied" as const),
      };
    });

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("Replacement"),
        path: "/designs/replacement.canopi",
        name: "Replacement",
      }),
    });

    expect(result.status).toBe("applied");
    expect(session.replaceDocument).toHaveBeenCalledOnce();
  });

  it("cancels replacement when Design changes while the requested save is pending", async () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    markDesignSessionDirtyForTest(store);
    const pending = deferred<string>();
    mocks.saveDesign.mockReturnValue(pending.promise);
    const load = vi.fn(async () => ({
      file: makeFile("Next"),
      path: "/designs/next.canopi",
      name: "Next",
    }));

    const transition = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load,
    });
    await flushMicrotasks();
    expect(mocks.saveDesign).toHaveBeenCalledTimes(1);

    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Edited while save was pending",
    }));
    const currentAfterEdit = store.readCurrentDesign();
    pending.resolve("/designs/current.canopi");

    await expect(transition).resolves.toEqual({
      status: "cancelled",
      documentLoaded: true,
    });
    expect(load).not.toHaveBeenCalled();
    expect(store.readCurrentDesign()).toBe(currentAfterEdit);
    expect(store.readCurrentDesign()?.description).toBe("Edited while save was pending");
    expect(store.isDesignDirty()).toBe(true);
  });

  it("acknowledges the captured save without replacing edits made during I/O", async () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    markDesignSessionDirtyForTest(store);
    const pending = deferred<string>();
    mocks.saveDesign.mockReturnValue(pending.promise);

    const saving = machine.saveAsCurrentDesign({ session });
    await flushMicrotasks();
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Edited while save was pending",
    }));
    const currentAfterEdit = store.readCurrentDesign();

    pending.resolve("/designs/current.canopi");
    const settlement = await saving;

    expect(settlement).toMatchObject({
      status: "applied",
      path: "/designs/current.canopi",
      content: { name: "Current", description: null },
    });
    expect(store.readCurrentDesign()).toBe(currentAfterEdit);
    expect(store.readCurrentDesign()?.description).toBe("Edited while save was pending");
    expect(store.isDesignDirty()).toBe(true);
  });

  it("does not load a replacement until admitted predecessor writes drain", async () => {
    const session = makeSession();
    const pendingWrite = deferred<string>();
    mocks.saveDesign.mockReturnValue(pendingWrite.promise);
    markDesignSessionDirtyForTest(store);
    const saving = machine.saveCurrentDesign({ session });
    const load = vi.fn(async () => ({
      file: makeFile('Replacement'),
      path: '/designs/replacement.canopi',
      name: 'Replacement',
    }));

    const transitioning = machine.transitionDocument({
      source: 'open-path',
      dirtyGuard: 'skip',
      session,
      load,
    });
    await flushMicrotasks();

    expect(load).not.toHaveBeenCalled();

    pendingWrite.resolve('/designs/current.canopi');
    await saving;
    await expect(transitioning).resolves.toMatchObject({ status: 'applied' });
    expect(load).toHaveBeenCalledOnce();
  });

  it("skips predecessor writes queued while a successful replacement is fenced", async () => {
    const session = makeSession();
    const pendingLoad = deferred<DocumentTransitionLoadResult>();
    const transitioning = machine.transitionDocument({
      source: 'open-path',
      dirtyGuard: 'skip',
      session,
      load: () => pendingLoad.promise,
    });
    const saving = machine.saveAsCurrentDesign({ session });
    await flushMicrotasks();

    expect(mocks.saveDesign).not.toHaveBeenCalled();

    pendingLoad.resolve({
      file: makeFile('Replacement'),
      path: '/designs/replacement.canopi',
      name: 'Replacement',
    });
    await expect(transitioning).resolves.toMatchObject({ status: 'applied' });
    await expect(saving).resolves.toMatchObject({ status: 'stale' });
    expect(mocks.saveDesign).not.toHaveBeenCalled();
  });

  it("resumes still-current writes after a fenced replacement load fails", async () => {
    const session = makeSession();
    const pendingLoad = deferred<DocumentTransitionLoadResult>();
    const transitioning = machine.transitionDocument({
      source: 'open-path',
      dirtyGuard: 'skip',
      session,
      load: () => pendingLoad.promise,
    });
    const saving = machine.saveAsCurrentDesign({ session });
    await flushMicrotasks();

    expect(mocks.saveDesign).not.toHaveBeenCalled();

    pendingLoad.reject(new Error('read failed'));
    await expect(transitioning).resolves.toMatchObject({ status: 'failed' });
    await expect(saving).resolves.toMatchObject({ status: 'applied' });
    expect(mocks.saveDesign).toHaveBeenCalledOnce();
  });

  it("keeps a newer Save state authoritative when a fenced load fails", async () => {
    const session = makeSession();
    const pendingLoad = deferred<DocumentTransitionLoadResult>();
    const pendingWrite = deferred<string>();
    mocks.saveDesign.mockReturnValue(pendingWrite.promise);
    const transitioning = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => pendingLoad.promise,
    });
    markDesignSessionDirtyForTest(store);
    const saving = machine.saveCurrentDesign({ session });

    expect(machine.getState()).toMatchObject({
      status: "saving",
      operation: "save",
    });

    pendingLoad.reject(new Error("read failed"));
    await expect(transitioning).resolves.toMatchObject({ status: "failed" });
    await flushMicrotasks();

    expect(mocks.saveDesign).toHaveBeenCalledOnce();
    expect(machine.getState()).toMatchObject({
      status: "saving",
      operation: "save",
    });

    pendingWrite.resolve("/designs/current.canopi");
    await expect(saving).resolves.toBe(true);
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });
  });

  it("does not let a draining older transition publish over a newer Save", async () => {
    const session = makeSession();
    const predecessorWrite = deferred<string>();
    const successorWrite = deferred<string>();
    const pendingLoad = deferred<DocumentTransitionLoadResult>();
    const load = vi.fn(() => pendingLoad.promise);
    mocks.saveDesign
      .mockReturnValueOnce(predecessorWrite.promise)
      .mockReturnValueOnce(successorWrite.promise);

    markDesignSessionDirtyForTest(store);
    const predecessorSave = machine.saveCurrentDesign({ session });
    const transitioning = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load,
    });
    const successorSave = machine.saveAsCurrentDesign({ session });

    expect(load).not.toHaveBeenCalled();
    expect(machine.getState()).toMatchObject({
      status: "saving",
      operation: "save-as",
    });

    predecessorWrite.resolve("/designs/current.canopi");
    await expect(predecessorSave).resolves.toBe(false);
    await flushMicrotasks();
    expect(load).toHaveBeenCalledOnce();
    expect(machine.getState()).toMatchObject({
      status: "saving",
      operation: "save-as",
    });

    pendingLoad.reject(new Error("read failed"));
    await expect(transitioning).resolves.toMatchObject({ status: "failed" });
    await flushMicrotasks();
    expect(mocks.saveDesign).toHaveBeenCalledTimes(2);
    expect(machine.getState()).toMatchObject({
      status: "saving",
      operation: "save-as",
    });

    successorWrite.resolve("/designs/current.canopi");
    await expect(successorSave).resolves.toMatchObject({ status: "applied" });
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });
  });

  it("restores an older active transition after a newer Save finishes", async () => {
    const session = makeSession();
    const decision = deferred<string>();
    const pendingLoad = deferred<DocumentTransitionLoadResult>();
    const load = vi.fn(() => pendingLoad.promise);
    markDesignSessionDirtyForTest(store);
    mocks.saveDesign.mockRejectedValueOnce(new Error("disk full"));
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requestSaveDecision.mockReturnValue(decision.promise);

    const transitioning = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load,
    });
    await flushMicrotasks();
    expect(mocks.requestSaveDecision).toHaveBeenCalledOnce();

    await expect(machine.saveAsCurrentDesign({ session })).resolves.toMatchObject({
      status: "applied",
    });
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });

    decision.resolve("discard");
    await flushMicrotasks();
    expect(load).toHaveBeenCalledOnce();
    expect(machine.getState()).toMatchObject({
      status: "loading",
      operation: "open-path",
    });

    pendingLoad.reject(new Error("read failed"));
    await expect(transitioning).resolves.toMatchObject({ status: "failed" });
    expect(machine.getState()).toMatchObject({
      status: "failed",
      operation: "open-path",
    });
    logError.mockRestore();
  });

  it("clears a finished Save presentation while a save decision waits", async () => {
    const session = makeSession();
    const pendingWrite = deferred<string>();
    const decision = deferred<string>();
    markDesignSessionDirtyForTest(store);
    mocks.saveDesign
      .mockRejectedValueOnce(new Error("disk full"))
      .mockReturnValueOnce(pendingWrite.promise);
    mocks.requestSaveDecision.mockReturnValue(decision.promise);
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const transitioning = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load: vi.fn(),
    });
    await flushMicrotasks();
    expect(mocks.requestSaveDecision).toHaveBeenCalledOnce();

    const saving = machine.saveAsCurrentDesign({ session });
    await flushMicrotasks();
    expect(machine.getState()).toMatchObject({
      status: "saving",
      operation: "save-as",
    });

    pendingWrite.resolve("/designs/current.canopi");
    await expect(saving).resolves.toMatchObject({ status: "applied" });
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });

    decision.resolve("cancel");
    await expect(transitioning).resolves.toMatchObject({ status: "cancelled" });
    logError.mockRestore();
  });

  it("restores an active transition after a newer foreign-session Save is rejected", async () => {
    const session = makeSession();
    const foreignSession = makeSession();
    const pendingLoad = deferred<DocumentTransitionLoadResult>();
    const transitioning = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => pendingLoad.promise,
    });

    await expect(machine.saveAsCurrentDesign({ session: foreignSession })).rejects.toThrow(
      "Canvas persistence lease belongs to another session",
    );
    expect(machine.getState()).toMatchObject({
      status: "loading",
      operation: "open-path",
    });

    pendingLoad.reject(new Error("read failed"));
    await expect(transitioning).resolves.toMatchObject({ status: "failed" });
    expect(machine.getState()).toMatchObject({
      status: "failed",
      operation: "open-path",
    });
  });

  it("keeps a predecessor transition active when a foreign successor cannot acquire its lease", async () => {
    const session = makeSession();
    const foreignSession = makeSession();
    const predecessorLoad = deferred<DocumentTransitionLoadResult>();
    const predecessor = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => predecessorLoad.promise,
    });
    const foreignLoad = vi.fn(async () => ({
      file: makeFile("Foreign"),
      path: "/designs/foreign.canopi",
      name: "Foreign",
    }));

    await expect(machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session: foreignSession,
      load: foreignLoad,
    })).resolves.toMatchObject({ status: "failed" });
    expect(foreignLoad).not.toHaveBeenCalled();
    expect(machine.getState()).toMatchObject({
      status: "loading",
      operation: "open-path",
    });

    predecessorLoad.resolve({
      file: makeFile("Predecessor"),
      path: "/designs/predecessor.canopi",
      name: "Predecessor",
    });
    await expect(predecessor).resolves.toMatchObject({ status: "applied" });
    expect(store.readDesignName()).toBe("Predecessor");
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      operation: null,
    });
  });

  it("does not supersede an active transition before an empty foreign session acquires its lease", async () => {
    const session = makeSession();
    const foreignSession = makeSession();
    const pendingLoad = deferred<DocumentTransitionLoadResult>();
    const transitioning = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => pendingLoad.promise,
    });

    expect(() => machine.beginEmptyDocumentSession(foreignSession)).toThrow(
      "Canvas persistence lease belongs to another session",
    );
    expect(machine.getState()).toMatchObject({
      status: "loading",
      operation: "open-path",
    });

    pendingLoad.reject(new Error("read failed"));
    await expect(transitioning).resolves.toMatchObject({ status: "failed" });
  });

  it("cancels a predecessor replacement after the session machine resets", async () => {
    const predecessor = makeSession();
    const pendingLoad = deferred<DocumentTransitionLoadResult>();
    const transitioning = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session: predecessor,
      load: () => pendingLoad.promise,
    });
    await flushMicrotasks();

    machine.resetState();
    const successor = makeSession();
    await expect(machine.saveAsCurrentDesign({ session: successor })).resolves.toMatchObject({
      status: "applied",
    });
    expect(mocks.saveDesign).toHaveBeenCalledOnce();

    pendingLoad.resolve({
      file: makeFile("Obsolete replacement"),
      path: "/designs/obsolete.canopi",
      name: "Obsolete replacement",
    });
    await expect(transitioning).resolves.toMatchObject({ status: "cancelled" });
    expect(store.readDesignName()).toBe("Current");
  });

  it("skips predecessor writes after Scene admits a replacement that fails before Design finalization", async () => {
    const session = makePreFinalizerFailureSession();
    const pendingLoad = deferred<DocumentTransitionLoadResult>();
    const transitioning = machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: () => pendingLoad.promise,
    });
    const saving = machine.saveAsCurrentDesign({ session });
    await flushMicrotasks();

    expect(mocks.saveDesign).not.toHaveBeenCalled();

    pendingLoad.resolve({
      file: makeFile("Replacement"),
      path: "/designs/replacement.canopi",
      name: "Replacement",
    });
    await expect(transitioning).resolves.toMatchObject({
      status: "failed",
      error: expect.objectContaining({
        message: "pre-finalizer Scene publication failed",
      }),
    });
    await expect(saving).resolves.toMatchObject({ status: "stale" });
    expect(mocks.saveDesign).not.toHaveBeenCalled();
  });

  it("retries exact settlement without rewriting after persistence publication fails", async () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    const acknowledgeSaved = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("clean publication failed");
      })
      .mockReturnValue("applied" as const);
    vi.mocked(session.captureForPersistence).mockImplementation((metadata, doc) => ({
      content: { ...doc, name: metadata.name },
      isCurrent: () => true,
      acknowledgeSaved,
    }));
    markDesignSessionDirtyForTest(store);

    await expect(machine.saveAsCurrentDesign({ session })).resolves.toMatchObject({
      status: "applied",
    });
    expect(mocks.saveDesign).toHaveBeenCalledOnce();
    expect(acknowledgeSaved).toHaveBeenCalledTimes(2);
    expect(store.isDesignDirty()).toBe(false);
  });

  it("applies only the Save As path while preserving later Design state and name", async () => {
    const pending = deferred<string>();
    mocks.selectDesignSavePath.mockResolvedValue("/designs/saved-snapshot.canopi");
    mocks.saveDesign.mockReturnValue(pending.promise);

    const saving = machine.saveAsCurrentDesign({ session: null });
    await flushMicrotasks();
    editDesignSessionForTest(store, (design) => ({
      ...design,
      description: "Later field note",
    }));
    store.renameCurrentDesign("Later Name");
    const currentAfterEdits = store.readCurrentDesign();

    pending.resolve("/designs/saved-snapshot.canopi");
    const settlement = await saving;

    expect(settlement).toMatchObject({
      status: "applied",
      path: "/designs/saved-snapshot.canopi",
      content: { name: "Current", description: null },
    });
    expect(store.readCurrentDesign()).toBe(currentAfterEdits);
    expect(store.readCurrentDesign()).toMatchObject({
      name: "Later Name",
      description: "Later field note",
    });
    expect(store.readDesignName()).toBe("Later Name");
    expect(store.readDesignPath()).toBe("/designs/saved-snapshot.canopi");
    expect(store.isDesignDirty()).toBe(true);
  });

  it("selects a Save As destination before starting its write", async () => {
    mocks.selectDesignSavePath.mockResolvedValue('/designs/selected.canopi');

    const settlement = await machine.saveAsCurrentDesign({ session: null });

    expect(mocks.selectDesignSavePath).toHaveBeenCalledWith({
      currentPath: '/designs/current.canopi',
      suggestedName: 'Current',
    });
    expect(mocks.saveDesign).toHaveBeenCalledWith(
      '/designs/selected.canopi',
      expect.objectContaining({ name: 'Current' }),
    );
    expect(settlement).toMatchObject({
      status: 'applied',
      path: '/designs/selected.canopi',
    });
  });

  it("skips a Save As write when its destination dialog returns after replacement", async () => {
    const selected = deferred<string>();
    mocks.selectDesignSavePath.mockReturnValue(selected.promise);
    const saving = machine.saveAsCurrentDesign({ session: null });

    store.replaceCurrentDesignState(
      makeFile('Replacement'),
      '/designs/replacement.canopi',
      'Replacement',
    );
    selected.resolve('/designs/predecessor.canopi');

    await expect(saving).resolves.toMatchObject({ status: 'stale' });
    expect(mocks.saveDesign).not.toHaveBeenCalled();
    expect(store.readDesignName()).toBe('Replacement');
    expect(store.readDesignPath()).toBe('/designs/replacement.canopi');
  });

  it("cancels before loading and preserves dirty baselines", async () => {
    const session = makeSession();
    markDesignSessionDirtyForTest(store);
    mocks.requestSaveDecision.mockResolvedValue("cancel");
    mocks.saveDesign.mockRejectedValue(new Error("disk full"));
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn(async () => ({
      file: makeFile("Next"),
      path: "/designs/next.canopi",
      name: "Next",
    }));

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session,
      load,
    });

    expect(result).toEqual({ status: "cancelled", documentLoaded: false });
    expect(load).not.toHaveBeenCalled();
    expect(session.replaceDocument).not.toHaveBeenCalled();
    expect(store.readCurrentDesign()?.name).toBe("Current");
    expect(store.designDirty.value).toBe(true);
    expect(mocks.requestSaveDecision).toHaveBeenCalledOnce();
    logError.mockRestore();
  });

  it("cancels after an async load without replacing state or dirty baselines", async () => {
    const session = makeSession();
    markDesignSessionDirtyForTest(store);

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: makeFile("Next"),
        path: "/designs/next.canopi",
        name: "Next",
      }),
      isCancelled: () => true,
    });

    expect(result).toEqual({ status: "cancelled", documentLoaded: false });
    expect(session.replaceDocument).not.toHaveBeenCalled();
    expect(store.readCurrentDesign()?.name).toBe("Current");
    expect(store.designDirty.value).toBe(true);
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      attached: true,
      operation: null,
    });
  });

  it("records failed transition state with the failing operation", async () => {
    const session = makeSession();
    const error = new Error("Disk read failed");

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "skip",
      session,
      load: async () => {
        throw error;
      },
    });

    expect(result).toEqual({
      status: "failed",
      documentLoaded: false,
      error,
    });
    expect(machine.getState()).toMatchObject({
      status: "failed",
      attached: true,
      documentLoaded: false,
      operation: "open-path",
      error,
    });
  });

  it("applies detached replacements without requiring a canvas session", async () => {
    markDesignSessionDirtyForTest(store);

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session: null,
      load: async () => ({
        file: makeFile("Detached Next"),
        path: "/designs/detached-next.canopi",
        name: "Detached Next",
      }),
    });

    expect(result).toEqual({ status: "applied", documentLoaded: false });
    expect(store.readCurrentDesign()?.name).toBe("Detached Next");
    expect(store.readDesignName()).toBe("Detached Next");
    expect(store.readDesignPath()).toBe("/designs/detached-next.canopi");
    expect(store.designDirty.value).toBe(false);
    expect(mocks.installConsortiumSync).toHaveBeenCalledTimes(1);
  });

  it("saves dirty detached documents before applying a transition", async () => {
    markDesignSessionDirtyForTest(store);

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session: null,
      load: async () => ({
        file: makeFile("Detached Next"),
        path: "/designs/detached-next.canopi",
        name: "Detached Next",
      }),
    });

    expect(result.status).toBe("applied");
    expect(mocks.saveDesign).toHaveBeenCalledWith(
      "/designs/current.canopi",
      expect.objectContaining({ name: "Current" }),
    );
    expect(store.readCurrentDesign()?.name).toBe("Detached Next");
  });

  it("does not use the current canvas session when a transition is explicitly detached", async () => {
    const currentSession = makeSession();
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ documents: currentSession }));
    markDesignSessionDirtyForTest(store);

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session: null,
      load: async () => ({
        file: makeFile("Detached Next"),
        path: "/designs/detached-next.canopi",
        name: "Detached Next",
      }),
    });

    expect(result).toEqual({ status: "applied", documentLoaded: false });
    expect(currentSession.captureForPersistence).not.toHaveBeenCalled();
    expect(mocks.saveDesign).toHaveBeenCalledWith(
      "/designs/current.canopi",
      expect.objectContaining({ name: "Current" }),
    );
  });

  it("queues deferrable detached transitions when no current design is loaded", async () => {
    resetMachine({ file: null, path: null, name: "Untitled" });
    const defer = vi.fn();
    const load = vi.fn(async () => ({
      file: makeFile("Queued"),
      path: "/designs/queued.canopi",
      name: "Queued",
    }));

    const result = await machine.transitionDocument({
      source: "open-path",
      dirtyGuard: "flush",
      session: null,
      load,
      deferWhenDetachedAndEmpty: defer,
    });

    expect(result).toEqual({ status: "queued", documentLoaded: false });
    expect(defer).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    expect(mocks.requestSaveDecision).not.toHaveBeenCalled();
  });

  it("loads an existing mounted document without replacing canonical document state", async () => {
    const session = makeSession();
    markDesignSessionDirtyForTest(store);
    const mounted = store.readCurrentDesign()!;

    const result = await machine.transitionDocument({
      source: "mount-existing",
      dirtyGuard: "skip",
      session,
      load: async () => ({
        file: mounted,
        path: store.readDesignPath(),
        name: store.readDesignName(),
      }),
    });

    expect(result).toEqual({ status: "applied", documentLoaded: true });
    expect(session.loadDocument).toHaveBeenCalledWith(mounted);
    expect(session.replaceDocument).not.toHaveBeenCalled();
    expect(store.readCurrentDesign()).toBe(mounted);
    expect(store.designDirty.value).toBe(true);
    expect(session.zoomToFit).toHaveBeenCalledTimes(1);
  });

  it("consumes queued path loads, clears the queue, and reports the transition result", async () => {
    const session = makeSession();
    const results: Array<{ status: string; documentLoaded: boolean }> = [];
    store.setPendingDesignPath("/designs/queued.canopi");
    mocks.loadDesign.mockResolvedValue({
      file: makeFile("Queued"),
      fingerprint: "fp-queued",
    });

    const cancel = machine.consumeQueuedDocumentLoad(session, {
      onResult: (result) => results.push({ status: result.status, documentLoaded: result.documentLoaded }),
    });
    await flushMicrotasks();

    expect(mocks.loadDesign).toHaveBeenCalledWith("/designs/queued.canopi");
    expect(session.replaceDocument).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Queued" }),
      expect.any(Object),
      expect.any(Function),
    );
    expect(store.readPendingDesignPath()).toBe(null);
    expect(results).toEqual([{ status: "applied", documentLoaded: true }]);
    expect(machine.continuousSave.readHome()).toEqual({
      kind: "file",
      path: "/designs/queued.canopi",
      fingerprint: "fp-queued",
    });
    cancel();
  });

  it("keeps queued failures pending and surfaces a retryable error", async () => {
    const session = makeSession();
    const queued = deferred<CanopiFile>();
    store.setPendingDesignPath("/designs/broken.canopi");
    mocks.loadDesign.mockReturnValue(queued.promise);

    machine.consumeQueuedDocumentLoad(session);
    queued.reject(new Error("Disk read failed"));
    await flushMicrotasks();

    expect(session.replaceDocument).not.toHaveBeenCalled();
    expect(store.readPendingDesignPath()).toBe("/designs/broken.canopi");
    expect(mocks.presentOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "Disk read failed" }));
  });

  it("keeps queued loads pending when teardown cancels them before apply", async () => {
    const session = makeSession();
    const queued = deferred<CanopiFile>();
    store.setPendingDesignPath("/designs/queued.canopi");
    mocks.loadDesign.mockReturnValue(queued.promise);

    const cancel = machine.consumeQueuedDocumentLoad(session);
    cancel();
    queued.resolve(makeFile("Queued"));
    await flushMicrotasks();

    expect(session.replaceDocument).not.toHaveBeenCalled();
    expect(store.readPendingDesignPath()).toBe("/designs/queued.canopi");
  });

  it("starts an empty session by installing workflows and hiding canvas chrome", () => {
    resetMachine({ file: null, path: null, name: "Untitled" });
    const session = makeSession();

    machine.beginEmptyDocumentSession(session);

    expect(mocks.installConsortiumSync).toHaveBeenCalledTimes(1);
    expect(session.hideCanvasChrome).toHaveBeenCalledTimes(1);
    expect(session.showCanvasChrome).not.toHaveBeenCalled();
  });

  it("disposes workflow runner and persistence during attached teardown", () => {
    const session = makeSession();
    const workflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    };
    const persistence = createDesignSessionPersistence({ store });
    persistence.attachCanvas(session);
    const disposePersistence = vi.spyOn(persistence, "dispose");
    machine = createDesignSessionStateMachine({
      store,
      workflowRunner,
      persistence,
    });

    machine.teardownAttachedDesignSession({
      session,
      runtimeInitialized: false,
      logError: vi.fn(),
    });

    expect(workflowRunner.dispose).toHaveBeenCalledTimes(1);
    expect(disposePersistence).toHaveBeenCalledTimes(1);
  });

  it("keeps attached state while workflow cleanup remains retryable", () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    const cleanupFailure = new Error("workflow cleanup failed");
    const workflowRunner = {
      install: vi.fn(),
      dispose: vi.fn()
        .mockImplementationOnce(() => {
          throw cleanupFailure;
        })
        .mockImplementation(() => undefined),
    };
    const persistence = createDesignSessionPersistence({ store });
    persistence.attachCanvas(session);
    machine = createDesignSessionStateMachine({ store, workflowRunner, persistence });

    expect(() => machine.teardownAttachedDesignSession({
      session,
      runtimeInitialized: false,
      logError: vi.fn(),
    })).toThrow(cleanupFailure);

    expect(persistence.isCanvasAttached(session)).toBe(true);
    expect(machine.getState()).toMatchObject({
      status: "attached-ready",
      attached: true,
      operation: null,
    });

    expect(() => machine.teardownAttachedDesignSession({
      session,
      runtimeInitialized: false,
      logError: vi.fn(),
    })).not.toThrow();
    expect(machine.getState()).toMatchObject({
      status: "detached-ready",
      attached: false,
      operation: null,
    });
  });

  it("ignores stale teardown from a Canvas that no longer owns the session lease", () => {
    const staleSession = makeSession();
    const currentSession = makeSession();
    staleSession.loadDocument(makeFile("Stale"));
    currentSession.loadDocument(makeFile("Current"));
    const workflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    };
    const persistence = createDesignSessionPersistence({ store });
    persistence.attachCanvas(staleSession);
    persistence.detachCanvas(staleSession);
    persistence.attachCanvas(currentSession);
    const settleCanvasHandoff = vi.spyOn(persistence, "settleCanvasHandoff");
    const disposePersistence = vi.spyOn(persistence, "dispose");
    machine = createDesignSessionStateMachine({
      store,
      workflowRunner,
      persistence,
    });

    machine.teardownAttachedDesignSession({
      session: staleSession,
      runtimeInitialized: true,
      logError: vi.fn(),
    });

    expect(settleCanvasHandoff).not.toHaveBeenCalled();
    expect(workflowRunner.dispose).not.toHaveBeenCalled();
    expect(disposePersistence).not.toHaveBeenCalled();
  });

  it("blocks teardown when the live Canvas handoff cannot be captured", () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    const workflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    };
    const persistence = createDesignSessionPersistence({ store });
    persistence.attachCanvas(session);
    vi.spyOn(persistence, "settleCanvasHandoff").mockImplementation(() => {
      throw new Error("handoff capture failed");
    });
    const disposePersistence = vi.spyOn(persistence, "dispose");
    const logError = vi.fn();
    machine = createDesignSessionStateMachine({
      store,
      workflowRunner,
      persistence,
    });

    expect(() => machine.teardownAttachedDesignSession({
      session,
      runtimeInitialized: true,
      logError,
    })).toThrow("handoff capture failed");

    expect(logError).toHaveBeenCalledWith(
      "Failed to snapshot canvas before teardown:",
      expect.any(Error),
    );
    expect(workflowRunner.dispose).not.toHaveBeenCalled();
    expect(disposePersistence).not.toHaveBeenCalled();
  });

  it("does not dispose a successor Canvas attached during handoff publication", () => {
    const session = makeSession();
    const successor = makeSession();
    session.loadDocument(makeFile("Current"));
    successor.loadDocument(makeFile("Successor"));
    const workflowRunner = {
      install: vi.fn(),
      dispose: vi.fn(),
    };
    const persistence = createDesignSessionPersistence({ store });
    persistence.attachCanvas(session);
    machine = createDesignSessionStateMachine({ store, workflowRunner, persistence });
    let replaceLeaseDuringHandoff = false;
    const disposeEffect = effect(() => {
      void store.currentDesign.value;
      if (!replaceLeaseDuringHandoff) return;
      replaceLeaseDuringHandoff = false;
      persistence.detachCanvas(session);
      persistence.attachCanvas(successor);
    });

    replaceLeaseDuringHandoff = true;
    expect(() => machine.teardownAttachedDesignSession({
      session,
      runtimeInitialized: true,
      logError: vi.fn(),
    })).toThrow("Canvas persistence lease");

    expect(persistence.isCanvasAttached(successor)).toBe(true);
    expect(workflowRunner.dispose).not.toHaveBeenCalled();
    disposeEffect();
  });

  it("recaptures Canvas handoff when snapshot publication commits a newer Scene", () => {
    const session = makeSession();
    session.loadDocument(makeFile("Current"));
    let sceneVersion = 0;
    vi.mocked(session.captureForPersistence).mockImplementation((metadata, document) => {
      const capturedVersion = sceneVersion;
      return {
        content: {
          ...document,
          name: metadata.name,
          description: `Scene version ${capturedVersion}`,
        },
        isCurrent: () => capturedVersion === sceneVersion,
        acknowledgeSaved: vi.fn(() => "applied" as const),
      };
    });
    const persistence = createDesignSessionPersistence({ store });
    persistence.attachCanvas(session);
    machine = createDesignSessionStateMachine({ store, persistence });
    let commitDuringPublication = false;
    const disposeEffect = effect(() => {
      void store.currentDesign.value;
      if (!commitDuringPublication) return;
      commitDuringPublication = false;
      sceneVersion += 1;
      store.setCanvasClean(false);
    });

    try {
      commitDuringPublication = true;
      machine.teardownAttachedDesignSession({
        session,
        runtimeInitialized: true,
        logError: vi.fn(),
      });

      expect(session.captureForPersistence).toHaveBeenCalledTimes(2);
      expect(store.readCurrentDesign()?.description).toBe("Scene version 1");
      expect(store.isDesignDirty()).toBe(true);
      expect(persistence.isCanvasAttached(session)).toBe(false);
    } finally {
      disposeEffect();
    }
  });
});
