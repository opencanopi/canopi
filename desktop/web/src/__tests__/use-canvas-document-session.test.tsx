// @vitest-environment jsdom

import { render } from "preact";
import { effect } from "@preact/signals";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopiFile } from "../types/design";

const mocks = vi.hoisted(() => ({
  beginEmptyDocumentSession: vi.fn((session: any) => {
    session.hideCanvasChrome();
  }),
  cancelQueuedLoad: vi.fn(),
  consumeQueuedDocumentLoad: vi.fn((_session?: unknown) => () => {}),
  flushSettingsProjection: vi.fn(),
  runtimeInitImpl: vi.fn(async (_container?: HTMLElement) => undefined),
  resizeDisconnect: vi.fn(),
  runtimeInstances: [] as Array<{
    host: Record<string, unknown>;
    documents: Record<string, unknown>;
  }>,
  teardownAttachedDesignSession: vi.fn(),
  startAttachedDesignSession: vi.fn(),
}));

vi.mock("../app/canvas-map-surface/desktop-workspace-runtime", () => ({
  createDesktopWorkspaceRuntimeComposition: vi.fn((options?: { container: HTMLElement }) => {
    let loaded = false;
    const documents = {
      showCanvasChrome: vi.fn(),
      hideCanvasChrome: vi.fn(),
      zoomToFit: vi.fn(),
      loadDocument: vi.fn(() => {
        loaded = true;
      }),
      replaceDocument: vi.fn((_file: unknown, _token: unknown, finalizeReplacement: () => void) => {
        loaded = true;
        finalizeReplacement();
        return { callerFinalizerInvoked: true };
      }),
      hasLoadedDocument: vi.fn(() => loaded),
      captureForPersistence: vi.fn((_metadata, doc) => ({
        content: doc,
        isCurrent: vi.fn(() => true),
        acknowledgeSaved: vi.fn(() => "applied"),
      })),
      resize: vi.fn(),
      destroy: vi.fn(async () => undefined),
    };
    const host = {
      surfaces: {
        commands: {},
        queries: {},
        documents,
      },
      init: vi.fn((container) => mocks.runtimeInitImpl(container)),
      destroy: vi.fn(async () => undefined),
    };
    (documents as Record<string, unknown>).originalLoadDocument = documents.loadDocument;
    (documents as Record<string, unknown>).originalReplaceDocument = documents.replaceDocument;
    mocks.runtimeInstances.push({ host, documents });
    return {
      surfaces: host.surfaces,
      start: async () => {
        await host.init(options?.container);
        return 'shared-ready' as const;
      },
      dispose: () => host.destroy(),
    };
  }),
}));

vi.mock("../app/document-session/transition", async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentSessionTransitionModule>();
  return {
    ...actual,
    consumeQueuedDocumentLoad: mocks.consumeQueuedDocumentLoad,
    startAttachedDesignSession: mocks.startAttachedDesignSession,
    teardownAttachedDesignSession: mocks.teardownAttachedDesignSession,
  };
});

vi.mock("../app/settings/projection", () => ({
  flushSettingsProjection: mocks.flushSettingsProjection,
}));

import { useCanvasDocumentSession } from "../app/document-session/use-canvas-document-session";
import { createDesktopWorkspaceRuntimeComposition } from "../app/canvas-map-surface/desktop-workspace-runtime";
import {
  currentCanvasDocumentSurface,
  currentCanvasSession,
  setCurrentCanvasSession,
} from "../canvas/session";
import { createTestCanvasRuntimeSurfaces } from "./support/canvas-runtime-surfaces";
import { createCanvasDocumentReplacementToken } from "../canvas/runtime/runtime";
import {
  designSessionFixture,
  currentDesign,
  resetDirtyBaselines,
} from "./support/design-session-state";
import type * as DocumentSessionTransitionModule from "../app/document-session/transition";

function Harness() {
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useCanvasDocumentSession({ canvasAreaRef, containerRef });

  return (
    <div>
      <div ref={canvasAreaRef}>
        <div ref={containerRef} />
      </div>
    </div>
  );
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

async function mountHarness(container: HTMLElement): Promise<void> {
  await act(async () => {
    render(<Harness />, container);
  });
  await act(async () => {
    await flushMicrotasks();
  });
}

function makeDesign(name = "Demo"): CanopiFile {
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
    created_at: "2026-04-13T00:00:00.000Z",
    updated_at: "2026-04-13T00:00:00.000Z",
    extra: {},
  };
}

describe("useCanvasDocumentSession", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.beginEmptyDocumentSession.mockClear();
    mocks.cancelQueuedLoad.mockReset();
    mocks.cancelQueuedLoad.mockImplementation(() => {});
    mocks.consumeQueuedDocumentLoad.mockClear();
    mocks.consumeQueuedDocumentLoad.mockImplementation(() => mocks.cancelQueuedLoad);
    mocks.flushSettingsProjection.mockClear();
    mocks.runtimeInitImpl.mockReset();
    mocks.runtimeInitImpl.mockResolvedValue(undefined);
    mocks.resizeDisconnect.mockClear();
    mocks.runtimeInstances.length = 0;
    mocks.teardownAttachedDesignSession.mockClear();
    mocks.startAttachedDesignSession.mockReset();
    mocks.startAttachedDesignSession.mockImplementation((session: any) => {
      if (currentDesign.value) {
        session.loadDocument({ name: "Mounted" });
        session.showCanvasChrome();
        return Promise.resolve({ status: "applied", documentLoaded: session.hasLoadedDocument() });
      }
      mocks.beginEmptyDocumentSession(session);
      return Promise.resolve(null);
    });
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      disconnect() {
        mocks.resizeDisconnect();
      }
    };
    container = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(container);
    setCurrentCanvasSession(null);
    designSessionFixture.file = null;
    designSessionFixture.name = "Demo";
    designSessionFixture.path = "/designs/demo.canopi";
    resetDirtyBaselines();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    render(null, container);
    container.remove();
  });

  it("mounts an empty session by installing workflows and hiding canvas chrome", async () => {
    await mountHarness(container);

    const documents = mocks.runtimeInstances[0]?.documents as {
      hideCanvasChrome: ReturnType<typeof vi.fn>;
    };

    expect(documents).toBeDefined();
    expect(mocks.runtimeInstances[0]?.host.init).toHaveBeenCalledTimes(1);
    expect(mocks.startAttachedDesignSession).toHaveBeenCalledWith(currentCanvasDocumentSurface.value);
    expect(documents.hideCanvasChrome).toHaveBeenCalledTimes(1);
    expect(mocks.consumeQueuedDocumentLoad).toHaveBeenCalledWith(currentCanvasDocumentSurface.value);
  });

  it("releases a lifecycle created by a host factory that unmounts reentrantly", async () => {
    const createHost = vi.mocked(createDesktopWorkspaceRuntimeComposition);
    const defaultCreateHost = createHost.getMockImplementation()!;
    createHost.mockImplementationOnce(() => {
      const host = defaultCreateHost({ container: document.createElement('div') });
      render(null, container);
      return host;
    });

    await mountHarness(container);

    expect(mocks.runtimeInstances).toHaveLength(1);
    expect(mocks.runtimeInstances[0]?.host.init).not.toHaveBeenCalled();
    expect(mocks.runtimeInstances[0]?.host.destroy).toHaveBeenCalledOnce();
    expect(currentCanvasSession.value).toBeNull();
  });

  it("does not continue initialization after publication synchronously releases the runtime", async () => {
    let releasedFirst = false;
    const disposePublicationEffect = effect(() => {
      const published = currentCanvasSession.value;
      const firstSurfaces = mocks.runtimeInstances[0]?.host.surfaces;
      if (
        !releasedFirst
        && firstSurfaces
        && published === firstSurfaces
      ) {
        releasedFirst = true;
        render(null, container);
      }
    });

    try {
      await mountHarness(container);

      const first = mocks.runtimeInstances[0] as unknown as {
        host: { init: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
      };
      const destroyOrder = first.host.destroy.mock.invocationCallOrder[0] ?? 0;

      expect(first.host.destroy).toHaveBeenCalledOnce();
      expect(first.host.init.mock.invocationCallOrder[0])
        .toBeLessThan(destroyOrder);
      expect(mocks.startAttachedDesignSession.mock.invocationCallOrder[0])
        .toBeLessThan(destroyOrder);
      expect(mocks.consumeQueuedDocumentLoad.mock.invocationCallOrder[0])
        .toBeLessThan(destroyOrder);
      expect(currentCanvasSession.value).toBeNull();

      await mountHarness(container);
      expect(mocks.runtimeInstances).toHaveLength(2);
      expect(currentCanvasSession.value).toBe(mocks.runtimeInstances[1]?.host.surfaces);
    } finally {
      disposePublicationEffect();
    }
  });

  it("loads the current design on mount and snapshots before teardown", async () => {
    designSessionFixture.file = makeDesign();

    await mountHarness(container);

    const instance = mocks.runtimeInstances[0] as unknown as {
      host: { destroy: ReturnType<typeof vi.fn> };
      documents: {
        loadDocument: ReturnType<typeof vi.fn>;
        replaceDocument: ReturnType<typeof vi.fn>;
        showCanvasChrome: ReturnType<typeof vi.fn>;
      } & Record<string, unknown>;
    };
    const documents = instance.documents;

    expect(mocks.startAttachedDesignSession).toHaveBeenCalledWith(currentCanvasDocumentSurface.value);
    expect(documents.showCanvasChrome).toHaveBeenCalledTimes(1);
    expect(documents.loadDocument).toBe(documents.originalLoadDocument);
    expect(documents.replaceDocument).toBe(documents.originalReplaceDocument);

    await act(async () => {
      render(null, container);
    });

    expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledTimes(1);
    expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeInitialized: true }),
    );
    expect(mocks.cancelQueuedLoad).toHaveBeenCalledTimes(1);
    expect(mocks.flushSettingsProjection).toHaveBeenCalledTimes(1);
    expect(instance.host.destroy).toHaveBeenCalledTimes(1);
    expect(currentCanvasSession.value).toBe(null);
    const snapshotOrder = mocks.teardownAttachedDesignSession.mock.invocationCallOrder[0];
    const destroyOrder = instance.host.destroy.mock.invocationCallOrder[0];
    expect(snapshotOrder).toBeLessThan(destroyOrder ?? Number.POSITIVE_INFINITY);
  });

  it("retains a failed handoff owner and retries it before the next mount", async () => {
    designSessionFixture.file = makeDesign();
    mocks.teardownAttachedDesignSession.mockImplementationOnce(() => {
      throw new Error("handoff capture failed");
    });

    await mountHarness(container);

    const instance = mocks.runtimeInstances[0] as unknown as {
      host: { destroy: ReturnType<typeof vi.fn> };
    };

    render(null, container);
    await flushMicrotasks();
    expect(instance.host.destroy).not.toHaveBeenCalled();
    expect(currentCanvasSession.value).not.toBeNull();
    expect(mocks.resizeDisconnect).not.toHaveBeenCalled();
    expect(mocks.cancelQueuedLoad).not.toHaveBeenCalled();
    expect(mocks.flushSettingsProjection).not.toHaveBeenCalled();

    await mountHarness(container);

    expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledTimes(2);
    expect(instance.host.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.resizeDisconnect).toHaveBeenCalledTimes(1);
    expect(mocks.cancelQueuedLoad).toHaveBeenCalledTimes(1);
    expect(mocks.flushSettingsProjection).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeInstances).toHaveLength(2);
    expect(currentCanvasSession.value).toBe(mocks.runtimeInstances[1]?.host.surfaces);
  });

  it("does not clear a successor publication while retrying a stale teardown", async () => {
    designSessionFixture.file = makeDesign();
    const successorSurfaces = createTestCanvasRuntimeSurfaces();
    mocks.teardownAttachedDesignSession.mockImplementationOnce(() => {
      setCurrentCanvasSession(successorSurfaces);
      throw new Error("old Canvas lease is stale");
    });

    await mountHarness(container);
    render(null, container);
    await flushMicrotasks();
    expect(currentCanvasSession.value).toBe(successorSurfaces);

    mocks.runtimeInitImpl.mockImplementationOnce(() => new Promise(() => {}));
    await mountHarness(container);

    expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledTimes(2);
    expect(mocks.runtimeInstances[0]?.host.destroy).toHaveBeenCalledOnce();
    expect(currentCanvasSession.value).toBe(successorSurfaces);
  });

  it("releases the lifecycle after reporting exhaustive post-handoff cleanup failures", async () => {
    designSessionFixture.file = makeDesign();
    const disconnectError = new Error("observer disconnect failed");
    const settingsError = new Error("settings flush failed");
    mocks.resizeDisconnect.mockImplementationOnce(() => {
      throw disconnectError;
    });
    mocks.flushSettingsProjection.mockImplementationOnce(() => {
      throw settingsError;
    });
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await mountHarness(container);

      const first = mocks.runtimeInstances[0] as unknown as {
        host: { destroy: ReturnType<typeof vi.fn> };
      };

      render(null, container);
      await flushMicrotasks();

      expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledTimes(1);
      expect(mocks.resizeDisconnect).toHaveBeenCalledTimes(1);
      expect(mocks.cancelQueuedLoad).toHaveBeenCalledTimes(1);
      expect(mocks.flushSettingsProjection).toHaveBeenCalledTimes(1);
      expect(first.host.destroy).toHaveBeenCalledTimes(1);
      expect(currentCanvasSession.value).toBe(null);
      expect(logError).toHaveBeenCalledWith(
        "Failed to dispose Design Session lifecycle:",
        expect.objectContaining({
          name: "CanvasRuntimeCleanupError",
          errors: [disconnectError, settingsError],
        }),
      );

      await mountHarness(container);

      expect(mocks.runtimeInstances).toHaveLength(2);
      expect(currentCanvasSession.value).toBe(mocks.runtimeInstances[1]?.host.surfaces);
    } finally {
      logError.mockRestore();
    }
  });

  it("releases a failed runtime immediately and allows a later mount to retry", async () => {
    designSessionFixture.file = makeDesign();
    mocks.runtimeInitImpl.mockRejectedValueOnce(new Error("init failed"));

    await act(async () => {
      render(<Harness />, container);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const failedInstance = mocks.runtimeInstances[0] as unknown as {
      host: { destroy: ReturnType<typeof vi.fn> };
      documents: { loadDocument: ReturnType<typeof vi.fn> };
    };

    expect(mocks.startAttachedDesignSession).not.toHaveBeenCalled();
    expect(failedInstance.documents.loadDocument).not.toHaveBeenCalled();
    expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledOnce();
    expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeInitialized: false }),
    );
    expect(failedInstance.host.destroy).toHaveBeenCalledTimes(1);
    expect(currentCanvasSession.value).toBe(null);

    await act(async () => {
      render(null, container);
    });
    await mountHarness(container);

    expect(mocks.runtimeInstances).toHaveLength(2);
    expect(currentCanvasSession.value).toBe(mocks.runtimeInstances[1]?.host.surfaces);
  });

  it("does not snapshot before the runtime has loaded a document", async () => {
    designSessionFixture.file = makeDesign();
    let resolveInit: (() => void) | null = null;
    mocks.runtimeInitImpl.mockImplementation(
      () => new Promise<undefined>((resolve) => {
        resolveInit = () => resolve(undefined);
      }),
    );

    await mountHarness(container);

    await act(async () => {
      render(null, container);
      await flushMicrotasks();
    });

    await act(async () => {
      resolveInit?.();
      await flushMicrotasks();
    });

    const instance = mocks.runtimeInstances[0] as unknown as {
      host: { destroy: ReturnType<typeof vi.fn> };
      documents: { loadDocument: ReturnType<typeof vi.fn> };
    };

    expect(mocks.startAttachedDesignSession).not.toHaveBeenCalled();
    expect(instance.documents.loadDocument).not.toHaveBeenCalled();
    expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledOnce();
    expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeInitialized: false }),
    );
    expect(instance.host.destroy).toHaveBeenCalledTimes(1);
    expect(currentCanvasSession.value).toBe(null);
  });

  it("snapshots after a queued document replacement loads through replaceDocument", async () => {
    const queuedDesign = makeDesign("Queued");
    mocks.consumeQueuedDocumentLoad.mockImplementation((session: any) => {
      session.replaceDocument(queuedDesign, createCanvasDocumentReplacementToken(), () => {});
      designSessionFixture.file = queuedDesign;
      return mocks.cancelQueuedLoad;
    });

    await mountHarness(container);

    await act(async () => {
      render(null, container);
    });

    const instance = mocks.runtimeInstances[0] as unknown as {
      host: { destroy: ReturnType<typeof vi.fn> };
    };

    expect(mocks.teardownAttachedDesignSession).toHaveBeenCalledTimes(1);
    expect(instance.host.destroy).toHaveBeenCalledTimes(1);
  });

});
