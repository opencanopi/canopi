import { reportMapError } from '../../maplibre/map-errors'
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
  createSceneLayerFactory,
  type SceneLayerFactory,
} from './scene-layer-factory'
import type { MapBackgroundPresentation } from '../../maplibre/map-background'
import type {
  WorkspaceActivationOptions,
  WorkspaceActivationOutcome,
  WorkspaceActivationRuntime,
  WorkspaceActivationMapControls,
  WorkspaceActivationSnapshot,
} from './workspace-activation'
import { WorkspaceActivationCoordinator } from './workspace-activation'
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
import { createMapLifetimeSlot, type MapLifetimeHandle } from '../../maplibre/map-lifetime'
import { DEFAULT_NEW_DESIGN_VIEW, geographicViewOfCamera, type GeographicView } from '../../geo/session-plane'
import type { CameraDriverHost } from '../../geo/view/camera-driver'
import type { SceneRenderTarget } from '../../canvas/runtime/renderers/scene-types'

export type WorkspaceRuntimeStartOutcome = WorkspaceActivationOutcome | 'no-design'

export interface WorkspaceRuntimeComposition {
  readonly surfaces: CanvasRuntimeSurfaces
  readonly mapLifetime: MapLifetimeHandle
  start(): Promise<WorkspaceRuntimeStartOutcome>
  dispose(): Promise<void>
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
  readonly onFailure?: (error: unknown) => void
  readonly onRuntimeDestroyed?: () => void
  readonly onMapFailureStateChange?: (state: 'none' | 'handling' | 'settled') => void
  readonly readSnapshot?: (
    readInitialCenter: () => { readonly lat: number; readonly lon: number },
  ) => WorkspaceActivationSnapshot | null
  readonly readBackgroundPresentation?: () => ReturnType<typeof readWorkspaceBackgroundPresentation>
  /**
   * Called with the settled camera, `WORKSPACE_VIEW_SETTLE_MS` after it last changed, on a Design that is not read-only:
   * a Design shown read-only writes no byte, the device's last view included (design check 5c, 2.1-M478). Both editions
   * compose here, so this is the rule's one owner.
   */
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
}

/** Constructor-only test seam. Production callers use the default cohesive assembly. */
interface WorkspaceRuntimeCompositionDependencies {
  readonly createRendererComposition: (
    connect: (target: SceneRenderTarget) => () => void,
  ) => SceneLayerFactory
  readonly createRuntime: (options: SceneCanvasRuntimeOptions) => WorkspaceCompositionRuntime
  readonly createControls: (options: ConstructorParameters<typeof WorkspaceMapControls>[0]) => WorkspaceActivationMapControls
  readonly createWorkspace: (options: WorkspaceActivationOptions) => WorkspaceCompositionLifecycle
  readonly installEffect: (callback: () => void) => () => void
}

const DEFAULT_DEPENDENCIES: WorkspaceRuntimeCompositionDependencies = {
  createRendererComposition: createSceneLayerFactory,
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
  const siteHover = options.mapContributions.readSiteHover ? createContributionFeed<readonly [number, number]>() : null
  const userLocation = options.mapContributions.readUserLocation ? createContributionFeed<UserLocationReading>() : null
  let disposeResult: Promise<void> | null = null
  const mapSlot = createMapLifetimeSlot({
    restart: () => (disposeResult ? false : reconciler.retry()),
    retryLayer: (slot) => {
      if (disposeResult) return
      if (controls.retryLayer) controls.retryLayer(slot)
      else if (slot === 'background') controls.retryBasemap()
    },
    release: () => {},
  })
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
      userLocationOverlay: options.mapContributions.userLocationOverlay,
      onMapLifetimeChange: (next) => mapSlot.setState(next),
    },
  })
  // Read without subscribing: the camera and scene layer call this per frame.
  const readOrigin = () => {
    const origin = runtime.querySurface.sessionPlane.peek()?.origin ?? DEFAULT_NEW_DESIGN_VIEW
    return { lat: origin.lat, lon: origin.lon }
  }
  const workspace = dependencies.createWorkspace({
    container: options.container,
    runtime,
    camera: runtime.cameraHost,
    composition: rendererComposition,
    map: controls,
    readOrigin,
    ...(options.onMapFailureStateChange ? { onMapFailureStateChange: options.onMapFailureStateChange } : {}),
    ...(options.onRuntimeDestroyed ? { onRuntimeDestroyed: options.onRuntimeDestroyed } : {}),
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
  const effectDisposers: Array<() => void> = []
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  const clearSettleTimer = () => {
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = null
  }
  return {
    surfaces,
    mapLifetime: mapSlot.handle,
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
          effectDisposers.push(dependencies.installEffect(() => {
            const camera = runtime.querySurface.view.settledCamera.value
            const plane = runtime.querySurface.sessionPlane.value
            clearSettleTimer()
            if (!plane) return
            settleTimer = setTimeout(() => {
              settleTimer = null
              // Before a Design is loaded and fitted the camera shows its
              // default viewport, which is not a view the user chose.
              if (!documents.hasLoadedDocument() || options.appAdapter.isReadOnly()) return
              onViewSettled(geographicViewOfCamera(camera))
            }, WORKSPACE_VIEW_SETTLE_MS)
          }))
        }
        // The chart hover changes at scrub rate: its own effect feeds the map's hover source, never the contributions read.
        // A story presentation hides it alongside the Site data pin and profile line (2.1-Q106).
        const readSiteHover = options.mapContributions.readSiteHover
        if (siteHover && readSiteHover) {
          effectDisposers.push(dependencies.installEffect(() => {
            siteHover.publish(storyPresentationHidesEditingAids.value ? null : readSiteHover())
          }))
        }
        // The device location, at fix rate, on its own feed: a story presentation hides it (it shows the story's map only, Q12).
        const readUserLocation = options.mapContributions.readUserLocation
        if (userLocation && readUserLocation) {
          effectDisposers.push(dependencies.installEffect(() => {
            userLocation.publish(storyPresentationHidesEditingAids.value ? null : readUserLocation())
          }))
        }
        effectDisposers.push(dependencies.installEffect(() => {
          workspace.updateMapContributions(options.mapContributions.read(runtime.querySurface))
          workspace.updateBackgroundPresentation(
            (options.readBackgroundPresentation ?? readWorkspaceBackgroundPresentation)(),
          )
          // Whether the map credits fold into their (i) button: the visible map area decides.
          controls.setAttributionCompact(mapAttributionFolded.value)
        }))
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
    dispose() {
      if (disposeResult) return disposeResult
      mapSlot.handle.release()
      let resolveDispose!: () => void
      let rejectDispose!: (error: unknown) => void
      disposeResult = new Promise<void>((resolve, reject) => {
        resolveDispose = resolve
        rejectDispose = reject
      })
      const disposers = effectDisposers.splice(0)
      clearSettleTimer()
      void (async () => {
        const errors: unknown[] = []
        for (const disposeEffect of disposers) {
          try {
            disposeEffect()
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
    else reportMapError('Shared workspace composition failed:', error)
  } catch (observerError) {
    reportMapError('Shared workspace failure observer failed:', observerError)
  }
}
