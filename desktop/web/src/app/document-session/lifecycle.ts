import {
  getCurrentCanvasSession,
  setCurrentCanvasSession,
} from "../../canvas/session";
import type { CanvasDocumentSurface, CanvasRuntimeSurfaces } from "../../canvas/runtime/runtime";
import {
  CanvasRuntimeCleanupError,
  runCanvasRuntimeCleanups,
} from "../../canvas/runtime/cleanup";
import { failureLogger } from "../../failures/report";
import { flushSettingsProjection } from "../settings/projection";
import {
  createDesktopWorkspaceRuntimeComposition,
} from "../canvas-map-surface/desktop-workspace-runtime";
import type {
  WorkspaceRuntimeComposition,
  WorkspaceRuntimeMountOptions,
} from "../canvas-map-surface/workspace-runtime-composition";
import { UNAVAILABLE_MAPLIBRE_CANVAS_SURFACE_STATE } from "../../maplibre/canvas-surface-state";
import {
  abortFailedAttachedDesignSessionStart,
  consumeQueuedDocumentLoad,
  startAttachedDesignSession,
  teardownAttachedDesignSession,
} from "./transition";

interface DesignSessionLifecycleHost {
  readonly canvasArea: HTMLElement;
  readonly container: HTMLElement;
  readonly onMapStateChange?: WorkspaceRuntimeMountOptions['onMapStateChange'];
}

interface DesignSessionResizeObserver {
  observe(target: Element): void;
  disconnect(): void;
}

interface DesignSessionLifecycleDeps {
  readonly createRuntimeComposition: (
    options: WorkspaceRuntimeMountOptions,
  ) => WorkspaceRuntimeComposition;
  readonly publishSurfaces: (surfaces: CanvasRuntimeSurfaces | null) => void;
  readonly createResizeObserver: (
    callback: ResizeObserverCallback,
  ) => DesignSessionResizeObserver | null;
  readonly logError: (message?: unknown, ...optionalParams: unknown[]) => void;
  readonly onInitializationFailure: () => void;
}

const DEFAULT_LIFECYCLE_DEPS: DesignSessionLifecycleDeps = {
  createRuntimeComposition: createDesktopWorkspaceRuntimeComposition,
  publishSurfaces: setCurrentCanvasSession,
  createResizeObserver: (callback) => {
    if (typeof ResizeObserver === "undefined") return null;
    return new ResizeObserver(callback);
  },
  logError: failureLogger("document-session"),
  onInitializationFailure: () => {},
};

export interface DesignSessionLifecycle {
  start(): void;
  /** The map notice's Retry (WorkspaceRuntimeComposition.retryMap). */
  retryMap(): void;
  dispose(): Promise<void>;
}

export function createDesignSessionLifecycle(
  host: DesignSessionLifecycleHost,
  deps: Partial<DesignSessionLifecycleDeps> = {},
): DesignSessionLifecycle {
  return new RuntimeDesignSessionLifecycle(host, {
    ...DEFAULT_LIFECYCLE_DEPS,
    ...deps,
  });
}

class RuntimeDesignSessionLifecycle implements DesignSessionLifecycle {
  private readonly runtime: WorkspaceRuntimeComposition;
  private readonly surfaces: CanvasRuntimeSurfaces;
  private readonly documents: CanvasDocumentSurface;
  private cancelled = false;
  private runtimeInitialized = false;
  private cancelQueuedLoad = () => {};
  private resizeObserver: DesignSessionResizeObserver | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly host: DesignSessionLifecycleHost,
    private readonly deps: DesignSessionLifecycleDeps,
  ) {
    this.runtime = deps.createRuntimeComposition({
      container: host.container,
      onMapStateChange: host.onMapStateChange,
      onFailure: (error) => deps.logError('Shared desktop workspace failed:', error),
    });
    this.surfaces = this.runtime.surfaces;
    this.documents = this.surfaces.documents;
  }

  start(): void {
    void this.runtime.start().then(async (outcome) => {
      if (this.cancelled) return;

      if (outcome === 'cancelled') {
        throw new Error('Shared workspace initialization was cancelled.');
      }
      this.runtimeInitialized = true;

      const result = await startAttachedDesignSession(this.documents);
      if (this.cancelled) return;
      if (result?.status === "failed") {
        abortFailedAttachedDesignSessionStart(this.documents, this.deps.logError);
        throw result.error;
      }

      const resizeObserver = this.deps.createResizeObserver(() => {
        this.documents.resize(this.host.canvasArea.clientWidth, this.host.canvasArea.clientHeight);
      });
      if (this.cancelled) {
        this.disconnectLateResizeObserver(resizeObserver);
        return;
      }
      this.resizeObserver = resizeObserver;
      resizeObserver?.observe(this.host.canvasArea);
      if (this.cancelled) return;

      const cancelQueuedLoad = consumeQueuedDocumentLoad(this.documents);
      if (this.cancelled) {
        try {
          cancelQueuedLoad();
        } catch (error) {
          this.deps.logError("Failed to cancel a late document load:", error);
        }
        return;
      }
      this.cancelQueuedLoad = cancelQueuedLoad;
      this.deps.publishSurfaces(this.surfaces);
    }).catch((error: unknown) => {
      if (this.cancelled) return;
      this.deps.logError("Failed to initialize scene canvas runtime:", error);
      // Nothing will draw: an open Design shows at once, over the map notice (design-reveal.ts).
      this.host.onMapStateChange?.(UNAVAILABLE_MAPLIBRE_CANVAS_SURFACE_STATE);
      try {
        this.deps.onInitializationFailure();
      } catch (cleanupError) {
        this.deps.logError(
          "Failed to clean up after Canvas runtime initialization failure:",
          cleanupError,
        );
      }
    });
  }

  retryMap(): void {
    if (this.cancelled) return;
    this.runtime.retryMap();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    this.cancelled = true;
    // The Design handoff is the loss-prevention boundary. It must complete
    // before this lifecycle yields to settings or renderer teardown.
    this.teardownDocumentSession();
    let synchronousCleanupError: unknown = null;
    try {
      runCanvasRuntimeCleanups([
        () => this.cancelPendingDocumentLoad(),
        () => this.disconnectResizeObserver(),
      ], "Design Session lifecycle cleanup failed");
    } catch (error) {
      synchronousCleanupError = error;
    }

    this.disposePromise = this.finishDisposal(synchronousCleanupError);
    return this.disposePromise;
  }

  private async finishDisposal(synchronousCleanupError: unknown): Promise<void> {
    const errors = synchronousCleanupError instanceof CanvasRuntimeCleanupError
      ? [...synchronousCleanupError.errors]
      : synchronousCleanupError ? [synchronousCleanupError] : [];
    try {
      await flushSettingsProjection();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.runtime.dispose();
    } catch (error) {
      errors.push(error);
    }

    try {
      if (getCurrentCanvasSession() === this.surfaces) {
        this.deps.publishSurfaces(null);
      }
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      this.deps.logError(
        "Failed to dispose Design Session lifecycle:",
        errors.length === 1
          ? errors[0]
          : new CanvasRuntimeCleanupError("Design Session lifecycle cleanup failed", errors),
      );
    }
  }

  private disconnectResizeObserver(): void {
    const observer = this.resizeObserver;
    this.resizeObserver = null;
    observer?.disconnect();
  }

  private cancelPendingDocumentLoad(): void {
    const cancel = this.cancelQueuedLoad;
    this.cancelQueuedLoad = () => {};
    cancel();
  }

  private disconnectLateResizeObserver(observer: DesignSessionResizeObserver | null): void {
    try {
      observer?.disconnect();
    } catch (error) {
      this.deps.logError("Failed to disconnect a late Canvas resize observer:", error);
    }
  }

  private teardownDocumentSession(): void {
    teardownAttachedDesignSession({
      session: this.documents,
      runtimeInitialized: this.runtimeInitialized,
      logError: this.deps.logError,
    });
  }
}
