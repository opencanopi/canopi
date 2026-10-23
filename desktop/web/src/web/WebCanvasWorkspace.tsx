import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  designSessionStore,
  type DesignSessionStore,
} from '../app/document-session/store'
import { getCurrentCanvasSession, setCurrentCanvasSession } from '../canvas/session'
import { CanvasRuntimeCleanupError } from '../canvas/runtime/cleanup'
import type { CanvasDocumentSurface } from '../canvas/runtime/runtime'
import { acquireCanvasRuntimeLifecycle } from '../canvas/runtime/lifecycle-owner'
import { CanvasChrome } from '../components/canvas/CanvasChrome'
import { MyLocationButton } from '../components/canvas/MyLocationButton'
import { workspaceCanvasCommandProjection } from '../app/workspace-commands/canvas-actions'
import panelStyles from '../components/panels/Panels.module.css'
import { browserDesignSessionController, type BrowserDesignSessionController } from './browser-design-session'
import {
  createBrowserWorkspaceRuntimeComposition,
  type BrowserWorkspaceRuntimeMountOptions,
} from './browser-workspace-runtime'
import type { WorkspaceRuntimeComposition } from '../app/canvas-map-surface/workspace-runtime-composition'
import {
  IDLE_MAPLIBRE_CANVAS_SURFACE_STATE,
  UNAVAILABLE_MAPLIBRE_CANVAS_SURFACE_STATE,
  type MapLibreCanvasSurfaceState,
} from '../maplibre/canvas-surface-state'
import { getMapNoticeReadModel } from '../app/canvas-map-surface/map-notice'
import { useDesignReveal } from '../app/canvas-map-surface/design-reveal'
import { hasVisibleMapLayer } from '../app/map-layers/state'
import { presentedMapLayers } from '../app/story-presentation/overrides'
import { MapNotice } from '../components/canvas/MapNotice'
import { t } from '../i18n'
import { WebWelcomeScreen } from './WebWelcomeScreen'
import { useMapArea } from '../components/shared/useMapChrome'

interface WebCanvasWorkspaceProps {
  readonly controller?: BrowserDesignSessionController
  readonly store?: DesignSessionStore
  readonly createRuntimeComposition?: (
    options: BrowserWorkspaceRuntimeMountOptions,
  ) => WorkspaceRuntimeComposition
}

interface MountedRuntime {
  readonly composition: WorkspaceRuntimeComposition
  detachCanvasSession: () => void
  resizeObserver: ResizeObserver | null
}

export function WebCanvasWorkspace({
  controller = browserDesignSessionController,
  store = designSessionStore,
  createRuntimeComposition = createBrowserWorkspaceRuntimeComposition,
}: WebCanvasWorkspaceProps) {
  const hasDesign = store.currentDesign.value !== null
  const canvasAreaRef = useRef<HTMLDivElement>(null)
  useMapArea(canvasAreaRef)
  const containerRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<MountedRuntime | null>(null)
  const [mapState, setMapState] = useState<MapLibreCanvasSurfaceState | null>(null)

  // A layout effect: Preact 11 runs useEffect cleanups after paint, and the lease must end at unmount, before a
  // successor Canvas or a pending start can act on it (F0e).
  useLayoutEffect(() => {
    const container = containerRef.current
    const canvasArea = canvasAreaRef.current
    if (!container || !canvasArea) return

    let cancelled = false
    let releaseLease: (() => Promise<void>) | null = null
    let composition: WorkspaceRuntimeComposition | null = null
    let released = false
    let compositionCreationSettlement: Promise<void> | null = null
    let attachmentSettlement: Promise<void> | null = null

    const releaseRuntime = async () => {
      if (released) return
      const pendingCreation = compositionCreationSettlement
      if (pendingCreation) await pendingCreation
      if (released) return
      const activeComposition = composition
      if (!activeComposition) {
        released = true
        return
      }

      // A reentrant unmount can happen while browser attachment is still
      // returning its disposer. Keep the lease, then hand off with that exact
      // disposer before disposing the composition.
      const pendingAttachment = attachmentSettlement
      if (pendingAttachment) await pendingAttachment
      if (released) return
      const mounted = runtimeRef.current?.composition === activeComposition ? runtimeRef.current : null

      // Handoff is the loss-prevention boundary. Do it before the first await
      // so a failed capture retains this owner for a later retry.
      mounted?.detachCanvasSession()
      released = true

      const errors: unknown[] = []
      try {
        const observer = mounted?.resizeObserver
        if (mounted) mounted.resizeObserver = null
        observer?.disconnect()
      } catch (error) {
        errors.push(error)
      }
      try {
        await activeComposition.dispose()
      } catch (error) {
        errors.push(error)
      }
      if (mounted) runtimeRef.current = null
      try {
        if (getCurrentCanvasSession() === activeComposition.surfaces) {
          setCurrentCanvasSession(null)
        }
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) {
        console.error(
          'Failed to release browser canvas runtime:',
          errors.length === 1
            ? errors[0]
            : new CanvasRuntimeCleanupError('Browser Canvas runtime cleanup failed', errors),
        )
      }
    }
    const release = () => {
      const releaseCurrentLease = releaseLease
      if (!releaseCurrentLease) return
      void releaseCurrentLease().catch((error: unknown) => {
        console.error('Failed to release browser canvas runtime:', error)
      })
    }

    void (async () => {
      const lease = await acquireCanvasRuntimeLifecycle(releaseRuntime)
      releaseLease = lease.release
      if (cancelled) {
        release()
        return
      }

      let finishCompositionCreation!: () => void
      compositionCreationSettlement = new Promise<void>((resolve) => {
        finishCompositionCreation = resolve
      })
      try {
        composition = createRuntimeComposition({
          container,
          store,
          onMapStateChange: (state) => {
            setMapState(state)
          },
          onFailure: (error) => console.error('Shared browser workspace failed:', error),
        })
      } finally {
        finishCompositionCreation()
        compositionCreationSettlement = null
      }
      const activeComposition = composition
      runtimeRef.current = {
        composition: activeComposition,
        detachCanvasSession: () => {},
        resizeObserver: null,
      }
      if (cancelled) {
        release()
        return
      }

      const outcome = await activeComposition.start()
      if (outcome === 'cancelled') {
        throw new Error('Shared browser workspace initialization was cancelled.')
      }
      if (cancelled || released || runtimeRef.current?.composition !== activeComposition) {
        release()
        return
      }

      const mounted = runtimeRef.current
      const runtimeIsActive = () => !cancelled
        && !released
        && runtimeRef.current?.composition === activeComposition
      const documents = activeComposition.surfaces.documents
      let finishAttachment!: () => void
      attachmentSettlement = new Promise<void>((resolve) => {
        finishAttachment = resolve
      })
      try {
        mounted.detachCanvasSession = controller.attachCanvasSession(documents)
      } finally {
        finishAttachment()
        attachmentSettlement = null
      }
      if (!runtimeIsActive()) {
        release()
        return
      }

      installResizeObserver(mounted, canvasArea, documents, runtimeIsActive)
      if (!runtimeIsActive()) {
        release()
        return
      }
      setCurrentCanvasSession(activeComposition.surfaces)
      if (!runtimeIsActive()) release()
    })().catch((error: unknown) => {
      release()
      if (!cancelled) {
        console.error('Failed to initialize browser canvas runtime:', error)
        // Nothing will draw: an open Design shows at once, over the map notice (design-reveal.ts).
        setMapState(UNAVAILABLE_MAPLIBRE_CANVAS_SURFACE_STATE)
      }
    })

    return () => {
      cancelled = true
      release()
    }
  }, [controller, createRuntimeComposition, store])

  const mapSurface = mapState ?? IDLE_MAPLIBRE_CANVAS_SURFACE_STATE
  const mapNotice = getMapNoticeReadModel({
    hasDesign,
    // The map the workspace draws: a presented story step's layers, else the user's own.
    mapVisible: hasVisibleMapLayer(presentedMapLayers()),
    mapSurface,
    t,
  })
  const reveal = useDesignReveal(hasDesign, mapSurface)

  return (
    <div className={panelStyles.canvasPanel} data-testid="web-canvas-workspace">
      <div ref={canvasAreaRef} className={panelStyles.canvasArea} data-design-hidden={hasDesign && !reveal.shown ? '' : undefined}>
        {/* Focusable from script while no session holds it (tabIndex -1, which the session restores when it ends), so
            focus handed to the map after a Retry lands before the rebuilt session makes it a Tab stop again. */}
        <div
          ref={containerRef}
          tabIndex={-1}
          className={panelStyles.canvasContainer}
          data-map-active={mapState?.status === 'ready' ? 'true' : 'false'}
          data-testid="web-canvas-workspace-surface"
        />
        {hasDesign && <CanvasChrome projection={workspaceCanvasCommandProjection.value} canvasRef={containerRef} myLocation={MyLocationButton} />}
        <MapNotice notice={mapNotice} onRetry={() => runtimeRef.current?.composition.retryMap()} canvasRef={containerRef} />
        {reveal.startScreen && <WebWelcomeScreen controller={controller} />}
      </div>
    </div>
  )
}

function installResizeObserver(
  mounted: MountedRuntime,
  canvasArea: HTMLElement,
  documents: CanvasDocumentSurface,
  runtimeIsActive: () => boolean,
): void {
  const resize = () => {
    documents.resize(canvasArea.clientWidth, canvasArea.clientHeight)
  }
  resize()
  if (!runtimeIsActive() || typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(resize)
  if (!runtimeIsActive()) {
    observer.disconnect()
    return
  }
  mounted.resizeObserver = observer
  observer.observe(canvasArea)
}
