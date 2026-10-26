import { logMapError } from '../../maplibre/redact-credentials'
import { effect } from '@preact/signals'
import { throwCanvasRuntimeCleanupErrors } from '../../canvas/runtime/cleanup'
import type { CanvasRuntimeAppAdapter } from '../../canvas/runtime/app-adapter'
import type { SceneRuntimePanelTargetAdapter } from '../../canvas/runtime/scene-runtime/panel-target-adapter'
import type {
  CanvasCommandSurface,
  CanvasDocumentSurface,
  CanvasKeyboardPort,
  CanvasQuerySurface,
  CanvasRuntimeSurfaces,
} from '../../canvas/runtime/runtime'
import { createForwardingCanvasKeyboardPort } from '../../canvas/runtime/keyboard-port'
import {
  SceneCanvasRuntime,
  type SceneCanvasRuntimeOptions,
} from '../../canvas/runtime/scene-runtime'
import {
  createSharedMapSceneRendererComposition,
  type SharedMapSceneRendererComposition,
} from '../../maplibre/shared-scene-renderer'
import type { MapBackgroundPresentation } from '../../maplibre/map-background'
import {
  WorkspaceActivationCoordinator,
  type WorkspaceActivationOptions,
  type WorkspaceActivationOutcome,
  type WorkspaceActivationRuntime,type WorkspaceActivationMapControls,type WorkspaceActivationSnapshot
} from './workspace-activation'
import { readWorkspaceActivationSnapshot, readWorkspaceBackgroundPresentation } from './workspace-activation-snapshot'
import { createWorkspaceDocumentSurface } from './workspace-document-surface'
import {
  WorkspaceGenerationReconciler,
  type WorkspaceGenerationLifecycle,
} from './workspace-generation-reconciler'
import { WorkspaceMapControls } from './workspace-map-controls'
import type { ContributionFeed } from './workspace-map-contributions'
import { mapAttributionFolded } from '../shell/visible-map-area'
import { storyPresentationHidesEditingAids } from '../story-presentation/overrides'
import type { UserLocationReading } from '../../maplibre/user-location-overlay'
import type { WorkspaceMapContributionAdapter, WorkspaceMapContributionSnapshot } from './workspace-map-contribution-adapter'
import type { MapLibreCanvasSurfaceState } from '../../maplibre/canvas-surface-state'
import { DEFAULT_NEW_DESIGN_VIEW, geographicViewOfCamera, type GeographicView } from '../../canvas/session-plane'
import type { CameraDriverHost } from '../../canvas/runtime/view/camera-driver'
import type { SceneRenderTarget } from '../../canvas/runtime/renderers/scene-types'

export type WorkspaceRuntimeStartOutcome = WorkspaceActivationOutcome | 'no-design'

export interface WorkspaceRuntimeComposition {
  readonly surfaces: CanvasRuntimeSurfaces
  start(): Promise<WorkspaceRuntimeStartOutcome>
  /**
   * The map notice's Retry: rebuilds a map that stopped drawing, keeping the Scene, view, selection and
   * undo, or downloads a basemap that couldn't load again. It can be pressed any number of times; nothing
   * retries on its own (ADR 0004).
   */
  retryMap(): void
  dispose(): Promise<void>
}

/**
 * The only details an edition mount supplies to the shared workspace. Edition
 * factories bind application adapters and contribution policy behind this
 * small mount-facing contract.
 */
export interface WorkspaceRuntimeMountOptions {
  readonly container: HTMLElement
  readonly onMapStateChange?: (state: MapLibreCanvasSurfaceState) => void
  readonly onFailure?: (error: unknown) => void
}

/** The geographic view a settled camera shows, for the app's last-view setting. */
export type WorkspaceSettledView = GeographicView

/** The last view is written this long after the view's settled camera last changed (the frame settles 150 ms after the last move). */
export const WORKSPACE_VIEW_SETTLE_MS = 600

export interface WorkspaceRuntimeCompositionOptions {
  readonly container: HTMLElement
  readonly appAdapter: CanvasRuntimeAppAdapter
  readonly targetPresentation: SceneRuntimePanelTargetAdapter
  readonly mapContributions: WorkspaceMapContributionAdapter
  readonly onMapStateChange?: (state: MapLibreCanvasSurfaceState) => void
  readonly onFailure?: (error: unknown) => void
  readonly readSnapshot?: (
    readInitialCenter: () => { readonly lat: number; readonly lon: number },
  ) => WorkspaceActivationSnapshot | null
  readonly readBackgroundPresentation?: () => ReturnType<typeof readWorkspaceBackgroundPresentation>
  /** Called with the settled camera, `WORKSPACE_VIEW_SETTLE_MS` after it last changed, on a Design. */
  readonly onViewSettled?: (view: WorkspaceSettledView) => void
}

interface WorkspaceCompositionRuntime extends WorkspaceActivationRuntime {
  /** The runtime's one target slot, which each map's shared scene layer fills. */
  connectRenderTarget(target: SceneRenderTarget): () => void
  /** The runtime's one camera: the activation attaches each map to it, and the map container's resizes reach its live driver. */
  readonly cameraHost: CameraDriverHost
  readonly commandSurface: CanvasCommandSurface
  readonly querySurface: CanvasQuerySurface
  readonly documentSurface: CanvasDocumentSurface
  /** The live interaction session's keyboard port, once init created it (null before and after). */
  readonly keyboardPort?: CanvasKeyboardPort | null
}

interface WorkspaceCompositionLifecycle extends WorkspaceGenerationLifecycle {
  updateBackgroundPresentation(presentation: MapBackgroundPresentation): void
  updateMapContributions(snapshot: WorkspaceMapContributionSnapshot | null): void
  /** Whether a Retry could rebuild an unavailable map (WorkspaceActivationCoordinator.canRetry). */
  canRetry(): boolean
}

/** Constructor-only test seam. Production callers use the default cohesive assembly. */
interface WorkspaceRuntimeCompositionDependencies {
  readonly createRendererComposition: (
    connect: (target: SceneRenderTarget) => () => void,
  ) => SharedMapSceneRendererComposition
  readonly createRuntime: (options: SceneCanvasRuntimeOptions) => WorkspaceCompositionRuntime
  readonly createControls: (options: ConstructorParameters<typeof WorkspaceMapControls>[0]) => WorkspaceActivationMapControls
  readonly createWorkspace: (options: WorkspaceActivationOptions) => WorkspaceCompositionLifecycle
  readonly installEffect: (callback: () => void) => () => void
}

const DEFAULT_DEPENDENCIES: WorkspaceRuntimeCompositionDependencies = {
  createRendererComposition: createSharedMapSceneRendererComposition,
  createRuntime: (options) => new SceneCanvasRuntime(options),
  createControls: (options) => new WorkspaceMapControls(options),
  createWorkspace: (options) => new WorkspaceActivationCoordinator(options),
  installEffect: effect,
}

/** App-owned composition for the production shared MapLibre runtime. */
export function createWorkspaceRuntimeComposition(
  options: WorkspaceRuntimeCompositionOptions,
  dependencyOverrides: Partial<WorkspaceRuntimeCompositionDependencies> = {},
): WorkspaceRuntimeComposition {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const runtime = dependencies.createRuntime({
    appAdapter: options.appAdapter,
    targetPresentation: options.targetPresentation,
  })
  const rendererComposition = dependencies.createRendererComposition((target) => runtime.connectRenderTarget(target))
  // The one writer of `retryable`: a map error offers Retry only while the workspace could rebuild the map.
  // The controls' own state is kept, so Retry appears once the workspace allows it (a failure settled).
  let mapState: MapLibreCanvasSurfaceState | null = null
  const publishMapState = (state: MapLibreCanvasSurfaceState) => {
    mapState = state
    options.onMapStateChange?.({ ...state, retryable: state.status === 'error' && workspace.canRetry() })
  }
  const siteHover = options.mapContributions.readSiteHover ? createContributionFeed<readonly [number, number]>() : null
  const userLocation = options.mapContributions.readUserLocation ? createContributionFeed<UserLocationReading>() : null
  const controls = dependencies.createControls({
    container: options.container,
    // The map container's resizes reach the live camera driver's setScreen: the driver is the map's one resize owner (both maps
    // are built with trackResize: false).
    setScreen: (screen) => {
      runtime.cameraHost.current().setScreen(screen)
    },
    contributions: {
      loadTerrainSupport: options.mapContributions.loadTerrainSupport,
      createRasterDisplay: options.mapContributions.createRasterDisplay,
      siteHover: siteHover ?? undefined,
      userLocation: userLocation ?? undefined,
      onStateChange: publishMapState,
    },
  })
  // Read without subscribing: the camera and scene layer call this per frame.
  const readOrigin = () => {
    const plane = runtime.querySurface.sessionPlane.peek()
    return plane
      ? { lat: plane.origin.lat, lon: plane.origin.lon }
      : { lat: DEFAULT_NEW_DESIGN_VIEW.lat, lon: DEFAULT_NEW_DESIGN_VIEW.lon }
  }
  const workspace = dependencies.createWorkspace({
    container: options.container,
    runtime,
    camera: runtime.cameraHost,
    composition: rendererComposition,
    map: controls,
    readOrigin,
    // A map error's Retry follows the workspace: offered once a failure settles, withdrawn once it can no longer rebuild.
    onRetryAvailabilityChange: () => {
      if (mapState?.status === 'error') publishMapState(mapState)
    },
  })
  const reconciler = new WorkspaceGenerationReconciler({
    workspace,
    readSnapshot: () => options.readSnapshot
      ? options.readSnapshot(readOrigin)
      : readWorkspaceActivationSnapshot({ readInitialCenter: readOrigin }),
    onFailure: options.onFailure,
  })
  const documents = createWorkspaceDocumentSurface({
    documents: runtime.documentSurface,
    reconciler,
  })
  const surfaces: CanvasRuntimeSurfaces = {
    commands: runtime.commandSurface,
    queries: runtime.querySurface,
    documents,
    // A forwarding port: the surfaces exist before runtime.init creates the session (spec §1.2a).
    keyboard: createForwardingCanvasKeyboardPort(() => runtime.keyboardPort ?? null, options.container),
  }
  let startResult: Promise<WorkspaceRuntimeStartOutcome> | null = null
  let cancelledStartResult: Promise<WorkspaceRuntimeStartOutcome> | null = null
  let disposeResult: Promise<void> | null = null
  let disposePresentationEffect: (() => void) | null = null
  let disposeSettleEffect: (() => void) | null = null
  let disposeSiteHoverEffect: (() => void) | null = null
  let disposeUserLocationEffect: (() => void) | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  const clearSettleTimer = () => {
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = null
  }
  return {
    surfaces,
    start() {
      if (disposeResult) {
        cancelledStartResult ??= Promise.resolve('cancelled')
        return cancelledStartResult
      }
      if (startResult) return startResult
      let resolveStart!: (outcome: WorkspaceRuntimeStartOutcome) => void
      startResult = new Promise((resolve) => {
        resolveStart = resolve
      })
      try {
        if (options.onViewSettled) {
          const onViewSettled = options.onViewSettled
          disposeSettleEffect = dependencies.installEffect(() => {
            const camera = runtime.querySurface.view.settledCamera.value
            const plane = runtime.querySurface.sessionPlane.value
            clearSettleTimer()
            if (!plane) return
            settleTimer = setTimeout(() => {
              settleTimer = null
              // Before a Design is loaded and fitted the camera shows its
              // default viewport, which is not a view the user chose.
              if (!documents.hasLoadedDocument()) return
              onViewSettled(geographicViewOfCamera(camera))
            }, WORKSPACE_VIEW_SETTLE_MS)
          })
        }
        // The chart hover changes at scrub rate: its own effect feeds the map's hover source, never the contributions read.
        const readSiteHover = options.mapContributions.readSiteHover
        if (siteHover && readSiteHover) {
          disposeSiteHoverEffect = dependencies.installEffect(() => siteHover.publish(readSiteHover()))
        }
        // The device location, at fix rate, on its own feed: a story presentation hides it (it shows the story's map only, Q12).
        const readUserLocation = options.mapContributions.readUserLocation
        if (userLocation && readUserLocation) {
          disposeUserLocationEffect = dependencies.installEffect(() => {
            userLocation.publish(storyPresentationHidesEditingAids.value ? null : readUserLocation())
          })
        }
        disposePresentationEffect = dependencies.installEffect(() => {
          workspace.updateMapContributions(options.mapContributions.read(runtime.querySurface))
          workspace.updateBackgroundPresentation(
            (options.readBackgroundPresentation ?? readWorkspaceBackgroundPresentation)(),
          )
          // Whether the map credits fold into their (i) button: the visible map area decides.
          controls.setAttributionCompact(mapAttributionFolded.value)
        })
        void reconciler.reconcileInitialGeneration().then(
          resolveStart,
          (error: unknown) => {
            reportCompositionFailure(options.onFailure, error)
            resolveStart('cancelled')
          },
        )
      } catch (error) {
        reportCompositionFailure(options.onFailure, error)
        resolveStart('cancelled')
      }
      return startResult
    },
    retryMap() {
      if (disposeResult) return
      if (mapState?.status !== 'error') {
        controls.retryBasemap()
        return
      }
      // A refused Retry that can never succeed withdraws the button.
      if (!reconciler.retry()) publishMapState(mapState)
    },
    dispose() {
      if (disposeResult) return disposeResult
      let resolveDispose!: () => void
      let rejectDispose!: (error: unknown) => void
      disposeResult = new Promise<void>((resolve, reject) => {
        resolveDispose = resolve
        rejectDispose = reject
      })
      const presentationEffect = disposePresentationEffect
      const settleEffect = disposeSettleEffect
      const siteHoverEffect = disposeSiteHoverEffect
      const userLocationEffect = disposeUserLocationEffect
      disposePresentationEffect = null
      disposeSettleEffect = null
      disposeSiteHoverEffect = null
      disposeUserLocationEffect = null
      clearSettleTimer()
      void (async () => {
        const errors: unknown[] = []
        for (const disposeEffect of [settleEffect, siteHoverEffect, userLocationEffect, presentationEffect]) {
          try {
            disposeEffect?.()
          } catch (error) {
            errors.push(error)
          }
        }
        try {
          await reconciler.dispose()
        } catch (error) {
          errors.push(error)
        }
        throwCanvasRuntimeCleanupErrors(errors, 'Shared workspace composition teardown failed')
      })().then(resolveDispose, rejectDispose)
      return disposeResult
    },
  }
}

/** The latest value, none at first, handed to whichever map's contributions are attached (a Retry attaches new ones). */
function createContributionFeed<T>(): ContributionFeed<T | null> & { publish(value: T | null): void } {
  let current: T | null = null
  const listeners = new Set<(value: T | null) => void>()
  return {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish(value) {
      current = value
      for (const listener of [...listeners]) listener(value)
    },
  }
}

function reportCompositionFailure(
  observer: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    if (observer) observer(error)
    else logMapError('Shared workspace composition failed:', error)
  } catch (observerError) {
    logMapError('Shared workspace failure observer failed:', observerError)
  }
}
