import { useCallback, useLayoutEffect, useRef } from "preact/hooks";
import { acquireCanvasRuntimeLifecycle } from "../../canvas/runtime/lifecycle-owner";
import { createDesignSessionLifecycle, type DesignSessionLifecycle } from "./lifecycle";
import type { WorkspaceRuntimeMountOptions } from '../canvas-map-surface/workspace-runtime-composition'

interface MutableDomRef<T> {
  current: T | null;
}

interface CanvasDocumentSessionRefs {
  canvasAreaRef: MutableDomRef<HTMLDivElement>;
  containerRef: MutableDomRef<HTMLDivElement>;
  onMapStateChange?: WorkspaceRuntimeMountOptions['onMapStateChange'];
}

interface CanvasDocumentSession {
  /** The map notice's Retry: rebuilds a map that stopped drawing, or downloads a basemap that couldn't load. */
  readonly retryMap: () => void;
}

/**
 * Connects CanvasPanel DOM refs to the Design Session lifecycle.
 * CanvasPanel remains responsible for layout and presentation only.
 */
export function useCanvasDocumentSession({
  canvasAreaRef,
  containerRef,
  onMapStateChange,
}: CanvasDocumentSessionRefs): CanvasDocumentSession {
  const lifecycleRef = useRef<DesignSessionLifecycle | null>(null);
  const retryMap = useCallback(() => lifecycleRef.current?.retryMap(), []);

  // A layout effect: Preact 11 runs useEffect cleanups after paint, and the lease must end at unmount, before a
  // successor Canvas or a pending start can act on it (F0e).
  useLayoutEffect(() => {
    const container = containerRef.current;
    const canvasArea = canvasAreaRef.current;
    if (!container || !canvasArea) return;

    let cancelled = false;
    let lifecycle: DesignSessionLifecycle | null = null;
    let lifecycleCreationSettlement: Promise<void> | null = null;
    let releaseLease: (() => Promise<void>) | null = null;
    const release = () => {
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      const releaseCurrentLease = releaseLease;
      if (!releaseCurrentLease) return;
      void releaseCurrentLease().catch((error: unknown) => {
        console.error("Failed to release Design Session Canvas runtime:", error);
      });
    };

    void (async () => {
      const lease = await acquireCanvasRuntimeLifecycle(async () => {
        const pendingCreation = lifecycleCreationSettlement;
        if (pendingCreation) await pendingCreation;
        await lifecycle?.dispose();
      });
      releaseLease = lease.release;
      if (cancelled) {
        release();
        return;
      }

      try {
        let finishCreation!: () => void;
        lifecycleCreationSettlement = new Promise<void>((resolve) => {
          finishCreation = resolve;
        });
        try {
          lifecycle = createDesignSessionLifecycle({
            canvasArea,
            container,
            onMapStateChange,
          }, {
            onInitializationFailure: release,
          });
        } finally {
          finishCreation();
          lifecycleCreationSettlement = null;
        }
        lifecycleRef.current = lifecycle;
        if (cancelled) {
          release();
          return;
        }
        lifecycle.start();
      } catch (error) {
        release();
        throw error;
      }
    })().catch((error: unknown) => {
      if (!cancelled) {
        console.error("Failed to acquire Design Session Canvas runtime:", error);
      }
    });

    return () => {
      cancelled = true;
      release();
    };
  }, []);

  return { retryMap };
}
