import { reportMapError } from '../../maplibre/map-errors'
import type { WorkspaceMapContributionSnapshot } from './workspace-map-contribution-adapter'
import { throwCanvasRuntimeCleanupErrors } from '../../canvas/runtime/cleanup'
import type { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'
import type { MapLibreMapInstance } from '../../maplibre/loader'
import {
  type WorkspaceMapSnapshot,
} from '../../maplibre/workspace-map'
import type { MapBackgroundPresentation } from '../../maplibre/map-background'
import {
  MAPLIBRE_SHARED_SCENE_LAYER_ID,
  type SharedMapSceneLayer,
  type SharedMapSceneMap,
} from '../../maplibre/shared-scene-layer'
import type { SharedMapSceneRendererComposition } from '../../maplibre/shared-scene-renderer'
import { createMapLibreCameraDriver, type MapLibreCameraDriverMap } from '../../maplibre/camera-driver'
import type { CameraDriverFailure, CameraDriverHost } from '../../canvas/runtime/view/camera-driver'
import { createSessionPlane } from '../../canvas/session-plane'

/**
 * `map-unavailable`: WebGL2 or MapLibre could not start or failed later. No
 * renderer is mounted and the map surface publishes its error state until a
 * user Retry rebuilds the map; nothing restarts on its own (ADR 0004).
 */
export type WorkspaceActivationOutcome = 'shared-ready' | 'map-unavailable' | 'cancelled'

/** The browser cannot create a WebGL2 context, so no map can be built and Retry is never offered. */
export class WorkspaceWebGL2UnavailableError extends Error {
  override readonly name = 'WorkspaceWebGL2UnavailableError'

  constructor() {
    super('WebGL2 is unavailable for the shared workspace map.')
  }
}

/** One immutable Design/map generation input. Session identity is compared only by ownership. */
export interface WorkspaceActivationSnapshot {
  readonly sessionIdentity: object
  readonly map: WorkspaceMapSnapshot
}

/** One map that is suitable for both the shared graphics layer and camera owner. */
export type WorkspaceActivationMap = MapLibreCameraDriverMap & Required<Pick<MapLibreMapInstance, 'getCanvas'>> & Pick<
  MapLibreMapInstance,
  | 'addLayer'
  | 'addSource'
  | 'getSource'
  | 'getLayer'
  | 'removeSource'
  | 'removeLayer'
  | 'getLayersOrder'
  | 'moveLayer'
  | 'setPaintProperty'
>

export interface WorkspaceActivationMapControls {
  createMap(
    signal: AbortSignal,
    snapshot: WorkspaceMapSnapshot,
  ): Promise<WorkspaceActivationMap>
  releaseMap(map: WorkspaceActivationMap, failure?: unknown): void
  getWebGL2Context(map: WorkspaceActivationMap): WebGL2RenderingContext | null
  updateMapContributions(snapshot: WorkspaceMapContributionSnapshot | null): void
  updateBackgroundPresentation(presentation: MapBackgroundPresentation): void
  /** Folds the map credits into their (i) button, now and on every later map. */
  setAttributionCompact(compact: boolean): void
  /** The user's Retry for a Basemap that couldn't load: downloads it again on the live map. */
  retryBasemap(): void
  /** Puts the shared scene layer in its band, above the basemap and LiDAR; called once, after the layer is added. */
  reconcileLayerStack(map: WorkspaceActivationMap): void
  /** Map/context failures that happen outside the custom layer. */
  watchFailure(
    map: WorkspaceActivationMap,
    reportFailure: (error: unknown) => void,
  ): () => void
}

export interface WorkspaceActivationRuntime {
  init(container: HTMLElement): Promise<void>
  /** Releases the renderer and editing after a map failure; the Scene stays loaded. */
  unmountRenderer(): Promise<void>
  /** Mounts them again on a rebuilt map after a user Retry. */
  remountRenderer(container: HTMLElement): Promise<void>
  destroy(): void
}

export interface WorkspaceActivationOptions {
  readonly container: HTMLElement
  readonly runtime: WorkspaceActivationRuntime | SceneCanvasRuntime
  /** The runtime's one camera: the activation attaches each map to it as a camera driver (spec §1.1 Attachment). */
  readonly camera: CameraDriverHost
  readonly composition: SharedMapSceneRendererComposition
  readonly map: WorkspaceActivationMapControls
  /** Live session plane origin of the runtime's open Design. */
  readonly readOrigin: () => { readonly lat: number; readonly lon: number }
  /** Called when `canRetry()` may have changed, so a Retry already on screen can be withdrawn. */
  readonly onRetryAvailabilityChange?: () => void
}

interface ActivationGeneration {
  readonly id: number
  readonly snapshot: WorkspaceActivationSnapshot
  presentation: MapBackgroundPresentation
  map: WorkspaceActivationMap | null
  layer: SharedMapSceneLayer | null
  unwatchFailure: (() => void) | null
  unsubscribeCameraFailure: (() => void) | null
  cameraAttached: boolean
  cancelled: boolean
  cleanupResult: Promise<void> | null
  cleanupStarted: boolean
  finishCleanup: ((errors: unknown[]) => void) | null
  setupResult: Promise<void> | null
  failure: Promise<WorkspaceActivationOutcome> | null
  /** The failure transaction settled: its cleanup ran and Retry may start a new generation. */
  failureSettled: boolean
  terminalMapFailure?: unknown
  readonly abortController: AbortController
}

interface PendingBackgroundPresentation {
  readonly request: number
  readonly presentation: MapBackgroundPresentation
  readonly hasUpdate: boolean
}

/** Transactionally admits production map-owned scene rendering. */
export class WorkspaceActivationCoordinator {
  private contributions: WorkspaceMapContributionSnapshot | null = null
  private generation = 0
  private activationRequest = 0
  private pendingBackgroundPresentation: PendingBackgroundPresentation | null = null
  private active: ActivationGeneration | null = null
  /**
   * The most recently requested generation cleanup remains observable after it
   * settles. A rejected cleanup deliberately rejects one successor admission;
   * that successor consumes the failure so a later explicit activation can
   * retry rather than silently admitting a map after an unobserved teardown.
   */
  private retainedCleanup: Promise<void> | null = null
  private terminalTeardownResult: Promise<void> | null = null
  private runtimeInit: Promise<void> | null = null
  private runtimeInitialized = false
  private runtimeDestroyed = false
  /** unmountRenderer ran after the runtime initialized: a rebuilt map remounts instead of initializing. */
  private rendererUnmounted = false
  private mapUnavailable = false
  /** The map failed for lack of WebGL2: no map can be built, so Retry is never offered. */
  private webGL2Missing = false
  private disposed = false

  constructor(private readonly options: WorkspaceActivationOptions) {}

  async activate(snapshot: WorkspaceActivationSnapshot): Promise<WorkspaceActivationOutcome> {
    if (this.disposed) return 'cancelled'
    const request = ++this.activationRequest
    this.pendingBackgroundPresentation = {
      request,
      presentation: snapshot.map.background,
      hasUpdate: false,
    }
    const priorCleanup = this.cleanupActiveGeneration()
    try {
      await priorCleanup
    } catch (error) {
      if (request !== this.activationRequest || this.disposed) return 'cancelled'
      if (this.retainedCleanup === priorCleanup) this.retainedCleanup = null
      throw error
    }
    if (request !== this.activationRequest || this.disposed) return 'cancelled'
    if (this.mapUnavailable) return 'map-unavailable'
    const current: ActivationGeneration = {
      id: ++this.generation,
      snapshot,
      presentation: this.pendingPresentationFor(request, snapshot.map),
      map: null,
      layer: null,
      unwatchFailure: null,
      unsubscribeCameraFailure: null,
      cameraAttached: false,
      cancelled: false,
      cleanupResult: null,
      cleanupStarted: false,
      finishCleanup: null,
      setupResult: null,
      failure: null,
      failureSettled: false,
      abortController: new AbortController(),
    }
    this.active = current

    let sharedRuntimeInitializationFailed = false
    try {
      const finishMapCreation = this.beginSetup(current)
      let mapPromise: Promise<WorkspaceActivationMap>
      try {
        mapPromise = this.options.map.createMap(current.abortController.signal, current.snapshot.map)
      } finally {
        finishMapCreation()
      }
      this.flushPendingPresentation(current, request)
      if (this.isCurrent(current) && this.contributions?.sessionIdentity === current.snapshot.sessionIdentity) {
        this.options.map.updateMapContributions(this.contributions)
      }
      const map = await mapPromise
      if (!this.isCurrent(current)) {
        this.releaseStaleMap(map)
        return 'cancelled'
      }
      current.map = map
      const finishFailureWatcher = this.beginSetup(current)
      let unwatchFailure: () => void
      try {
        unwatchFailure = this.options.map.watchFailure(map, (error) => {
          this.observeFailure(current, error)
        })
      } catch (error) {
        finishFailureWatcher()
        throw error
      }
      current.unwatchFailure = unwatchFailure
      finishFailureWatcher()
      if (!this.isCurrent(current)) return 'cancelled'
      if (current.failure) return current.failure

      // A context getter cannot re-enter teardown, so it needs no setup fence.
      const context = this.options.map.getWebGL2Context(map)
      if (!this.isCurrent(current)) return 'cancelled'
      if (!context) throw new Error('MapLibre did not expose a WebGL2 context for shared rendering.')

      const finishLayerCreation = this.beginSetup(current)
      let layer: SharedMapSceneLayer
      try {
        layer = this.options.composition.createLayer({
          id: MAPLIBRE_SHARED_SCENE_LAYER_ID,
          frames: this.cameraHost().frames,
          onFailure: (error) => {
            this.observeFailure(current, error)
          },
        })
      } catch (error) {
        finishLayerCreation()
        throw error
      }
      current.layer = layer
      finishLayerCreation()
      if (!this.isCurrent(current)) return 'cancelled'
      await layer.initialize(map as unknown as SharedMapSceneMap, context)
      if (!this.isCurrent(current)) return 'cancelled'
      if (current.failure) return current.failure

      // MapLibre admitted the map on its first style.load and never reloads it (ADR 0004), so the layer is added once.
      this.addSharedSceneLayer(current, map, layer)
      if (!this.isCurrent(current)) return 'cancelled'
      if (current.failure) return current.failure
      const finishLayerStack = this.beginSetup(current)
      try {
        this.options.map.reconcileLayerStack(map)
      } finally {
        finishLayerStack()
      }
      if (!this.isCurrent(current)) return 'cancelled'
      if (current.failure) return current.failure

      const finishCameraFailureSubscription = this.beginSetup(current)
      let unsubscribeCameraFailure: () => void
      try {
        // A failure the host still holds from an earlier map is not this generation's.
        const earlier = this.cameraHost().failure.peek()
        unsubscribeCameraFailure = this.cameraHost().failure.subscribe((failure) => {
          if (failure && failure !== earlier) this.observeFailure(current, cameraFailureError(failure))
        })
      } catch (error) {
        finishCameraFailureSubscription()
        throw error
      }
      current.unsubscribeCameraFailure = unsubscribeCameraFailure
      finishCameraFailureSubscription()
      if (!this.isCurrent(current)) return 'cancelled'

      // Mark the attachment before calling into the camera. attach() may
      // publish synchronously and trigger document replacement; that cleanup
      // must detach this pre-admitted attachment before attach() returns.
      current.cameraAttached = true
      const finishCameraAttachment = this.beginSetup(current)
      let attached: boolean
      try {
        // The map becomes the runtime's camera, in the plane of the Design's live origin. A map the driver cannot drive (a
        // pitched camera, or one whose camera cannot be read) never takes the camera: the host reports it as its failure.
        const host = this.cameraHost()
        const driver = createMapLibreCameraDriver(map, createSessionPlane(this.options.readOrigin()), host.driverDeps)
        host.attach(driver)
        attached = host.current() === driver
      } catch (error) {
        if (current.cameraAttached) current.cameraAttached = false
        finishCameraAttachment()
        throw error
      }
      if (!attached) current.cameraAttached = false
      finishCameraAttachment()
      if (!this.isCurrent(current)) return 'cancelled'
      if (!attached) throw new Error('MapLibre workspace camera rejected the shared map attachment.')
      if (current.failure) return current.failure

      if (this.rendererUnmounted) {
        // A Retry rebuilt the map: the initialized runtime mounts its renderer and editing on it again. A failed
        // remount leaves nothing mounted, and a failure that unmounts during it marks the renderer unmounted again.
        this.rendererUnmounted = false
        try {
          await this.options.runtime.remountRenderer(this.options.container)
        } catch (error) {
          this.rendererUnmounted = true
          throw error
        }
        if (!this.isCurrent(current)) return 'cancelled'
        return current.failure ?? 'shared-ready'
      }

      const runtimeInit = this.initializeRuntime()
      try {
        await runtimeInit
      } catch (error) {
        if (!this.isCurrent(current)) return 'cancelled'
        if (current.failure) return current.failure
        sharedRuntimeInitializationFailed = true
        current.terminalMapFailure = error
        const errors: unknown[] = [error]
        this.markMapUnavailable(error)
        this.destroyRuntime(errors)
        try {
          await this.cleanup(current)
        } catch (cleanupError) {
          errors.push(cleanupError)
        }
        throwCanvasRuntimeCleanupErrors(errors, 'Shared workspace renderer initialization failed')
      }
      if (!this.isCurrent(current)) {
        return 'cancelled'
      }
      this.runtimeInitialized = true
      return current.failure ?? 'shared-ready'
    } catch (error) {
      if (!this.isCurrent(current)) return 'cancelled'
      if (sharedRuntimeInitializationFailed) throw error
      return this.reportFailureFor(current, error)
    }
  }

  /** Allows the map host to report context loss without exposing runtime internals to UI code. */
  reportFailure(error: unknown): Promise<WorkspaceActivationOutcome> {
    const current = this.active
    return current ? this.reportFailureFor(current, error) : Promise.resolve('cancelled')
  }

  /**
   * Whether a user Retry could rebuild an unavailable map: the runtime is alive (a failed renderer
   * initialization destroys it), the map did not fail for lack of WebGL2, and no generation's failure
   * is still being handled (`retry()` refuses until it settles, so Retry is not offered before).
   */
  canRetry(): boolean {
    // A teardown publishes its result before it disposes, so it covers a disposed coordinator too.
    return (this.active?.failureSettled ?? true)
      && !this.runtimeDestroyed
      && !this.terminalTeardownResult
      && !this.webGL2Missing
  }

  /**
   * The user's Retry after the map became unavailable. It clears the unavailable state only when
   * `canRetry()` holds; the caller then activates
   * the current Design again. Returns whether it was accepted. Nothing calls this on its own (ADR 0004).
   */
  retry(): boolean {
    if (!this.mapUnavailable || !this.canRetry()) return false
    // The failed generation's failure transaction already reported every error, so the rebuilt map waits for its
    // cleanup but never fails on those errors a second time.
    if (this.active) {
      this.retainedCleanup = this.cleanupActiveGeneration().catch((error) => {
        reportMapError('Shared workspace cleanup before a map Retry failed:', error)
      })
    }
    this.mapUnavailable = false
    return true
  }

  updateMapContributions(snapshot: WorkspaceMapContributionSnapshot | null): void {
    if (this.terminalTeardownResult) return
    // Kept while the map is unavailable, so a rebuilt map starts from the latest contributions.
    this.contributions = snapshot
    if (this.mapUnavailable) return
    const current = this.active
    if (!current || !this.isCurrent(current)) return
    if (snapshot && snapshot.sessionIdentity !== current.snapshot.sessionIdentity) return
    this.options.map.updateMapContributions(this.contributions)
  }

  updateBackgroundPresentation(presentation: MapBackgroundPresentation): void {
    if (this.disposed || this.mapUnavailable || this.terminalTeardownResult) return
    const pending = this.pendingBackgroundPresentation
    if (pending?.request === this.activationRequest) {
      this.pendingBackgroundPresentation = {
        request: pending.request,
        presentation,
        hasUpdate: true,
      }
      return
    }
    const current = this.active
    if (!current || !this.isCurrent(current)) return
    current.presentation = presentation
    this.options.map.updateBackgroundPresentation(presentation)
  }

  private pendingPresentationFor(
    request: number,
    map: WorkspaceMapSnapshot,
  ): MapBackgroundPresentation {
    const pending = this.pendingBackgroundPresentation
    return pending?.request === request
      ? pending.presentation
      : map.background
  }

  private flushPendingPresentation(current: ActivationGeneration, request: number): void {
    const pending = this.pendingBackgroundPresentation
    if (!this.isCurrent(current) || pending?.request !== request) return
    this.pendingBackgroundPresentation = null
    current.presentation = pending.presentation
    if (pending.hasUpdate) {
      this.options.map.updateBackgroundPresentation(pending.presentation)
    }
  }

  /**
   * Synchronously fences one Design/map generation before Scene replacement.
   * Its returned settlement owns the asynchronous layer disposal and map
   * release; callers must not await it to establish the replacement fence.
   */
  requestGenerationDisconnect(): Promise<void> {
    if (this.disposed) {
      this.pendingBackgroundPresentation = null
      return this.retainedCleanup ?? Promise.resolve()
    }
    this.pendingBackgroundPresentation = null
    ++this.activationRequest
    const cleanup = this.cleanupActiveGeneration()
    // Design replacement is synchronous. Keep a terminal observation here so
    // an intentionally unjoined cleanup cannot become an unhandled rejection.
    void cleanup.catch((error) => {
      reportMapError('Shared workspace Design-replacement cleanup failed:', error)
    })
    return cleanup
  }

  teardown(): Promise<void> {
    if (this.terminalTeardownResult) return this.terminalTeardownResult
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const teardown = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    this.pendingBackgroundPresentation = null
    // Published before any disposer runs, so a teardown requested from inside one joins this one.
    this.terminalTeardownResult = teardown
    void this.performTeardown().then(resolve, reject)
    return teardown
  }

  private async performTeardown(): Promise<void> {
    if (this.disposed && this.runtimeDestroyed) return
    this.disposed = true
    ++this.activationRequest
    const errors: unknown[] = []
    try {
      await this.cleanupActiveGeneration()
    } catch (error) {
      errors.push(error)
    }
    if (this.runtimeInit) {
      try {
        await this.runtimeInit
      } catch (error) {
        errors.push(error)
      }
    }
    this.destroyRuntime(errors)
    throwCanvasRuntimeCleanupErrors(errors, 'Shared workspace teardown failed')
  }

  private cleanupActiveGeneration(): Promise<void> {
    const current = this.active
    if (!current) return this.retainedCleanup ?? Promise.resolve()
    this.active = null
    current.cancelled = true
    ++this.generation
    const resourceCleanup = this.prepareCleanup(current)
    const cleanup = this.prepareGenerationCleanup(current, resourceCleanup)
    this.retainedCleanup = cleanup
    // Publish the shared cleanup transaction before aborting acquisition or
    // invoking disposers. Either boundary may synchronously reenter us.
    current.abortController.abort()
    this.startCleanup(current)
    return cleanup
  }

  private reportFailureFor(
    current: ActivationGeneration,
    error: unknown,
  ): Promise<WorkspaceActivationOutcome> {
    if (!this.isCurrent(current)) return Promise.resolve('cancelled')
    if (current.failure) return current.failure
    // Every core map failure passes here once per generation. The notice and the
    // published state carry no engine text, so the log keeps the redacted cause.
    reportMapError('Shared workspace map failed:', error)

    // Install the failure fence before invoking composition, runtime, or
    // cleanup code. Those boundaries may synchronously report another failure.
    current.failure = Promise.resolve().then(() => {
      if (!this.isCurrent(current)) return 'cancelled'
      current.terminalMapFailure = error
      this.markMapUnavailable(error)
      return this.runtimeInitialized
        ? this.failActiveRenderer(current)
        : this.runtimeInit
          ? this.failWhileRuntimeInitializes(current)
          : this.failAdmission(current)
    })
    const settle = () => {
      current.failureSettled = true
      // A Retry withheld while the failure was handled can now be offered, also when a Design
      // replacement retired this generation meanwhile (the observer only recomputes canRetry()).
      this.notifyRetryAvailability()
    }
    void current.failure.then(settle, settle)
    return current.failure
  }

  private async failAdmission(current: ActivationGeneration): Promise<WorkspaceActivationOutcome> {
    // Nothing was mounted: the runtime keeps its Scene without a renderer.
    const errors: unknown[] = []
    try {
      await this.cleanup(current)
    } catch (cleanupError) {
      errors.push(cleanupError)
    }
    if (!this.isCurrent(current)) return 'cancelled'
    throwCanvasRuntimeCleanupErrors(errors, 'Shared workspace admission cleanup failed')
    return 'map-unavailable'
  }

  private async failActiveRenderer(current: ActivationGeneration): Promise<WorkspaceActivationOutcome> {
    const errors: unknown[] = []
    await this.unmountRuntimeRenderer(current, errors)
    try {
      await this.cleanup(current)
    } catch (cleanupError) {
      errors.push(cleanupError)
    }
    if (!this.isCurrent(current)) return 'cancelled'
    throwCanvasRuntimeCleanupErrors(errors, 'Shared workspace map failure handling failed')
    return 'map-unavailable'
  }

  private async failWhileRuntimeInitializes(current: ActivationGeneration): Promise<WorkspaceActivationOutcome> {
    const errors: unknown[] = []
    try {
      await this.cleanup(current)
    } catch (cleanupError) {
      errors.push(cleanupError)
    }
    try {
      await this.runtimeInit
    } catch (initializationError) {
      if (!this.isCurrent(current)) return 'cancelled'
      errors.push(initializationError)
      this.destroyRuntime(errors)
      throwCanvasRuntimeCleanupErrors(errors, 'Shared workspace renderer initialization failed')
    }
    if (!this.isCurrent(current)) return 'cancelled'
    this.runtimeInitialized = true
    await this.unmountRuntimeRenderer(current, errors)
    if (!this.isCurrent(current)) return 'cancelled'
    throwCanvasRuntimeCleanupErrors(errors, 'Shared workspace map failure handling failed')
    return 'map-unavailable'
  }

  private markMapUnavailable(cause: unknown): void {
    this.mapUnavailable = true
    if (cause instanceof WorkspaceWebGL2UnavailableError) this.webGL2Missing = true
    this.notifyRetryAvailability()
  }

  private notifyRetryAvailability(): void {
    try {
      this.options.onRetryAvailabilityChange?.()
    } catch (error) {
      reportMapError('Shared workspace Retry availability observer failed:', error)
    }
  }

  private async unmountRuntimeRenderer(current: ActivationGeneration, errors: unknown[]): Promise<void> {
    this.rendererUnmounted = true
    try {
      await this.options.runtime.unmountRenderer()
    } catch (unmountError) {
      if (this.isCurrent(current)) errors.push(unmountError)
    }
  }

  private cleanup(current: ActivationGeneration): Promise<void> {
    const cleanup = this.prepareCleanup(current)
    this.startCleanup(current)
    return cleanup
  }

  private prepareGenerationCleanup(
    current: ActivationGeneration,
    resourceCleanup: Promise<void>,
  ): Promise<void> {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const cleanup = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    // Capture the already-admitted failure transaction. It can itself await
    // resourceCleanup, so the generation transaction observes both without
    // feeding either result back into the resource cleanup path.
    const failure = current.failure
    void Promise.allSettled<unknown>([
      resourceCleanup,
      failure ?? Promise.resolve(),
    ]).then((settlements) => {
      const errors = settlements.flatMap((settlement) =>
        settlement.status === 'rejected' ? [settlement.reason] : [],
      )
      try {
        throwCanvasRuntimeCleanupErrors(errors, 'Shared workspace teardown failed')
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    return cleanup
  }

  private prepareCleanup(current: ActivationGeneration): Promise<void> {
    if (current.cleanupResult) return current.cleanupResult
    let resolve!: () => void
    let reject!: (error: unknown) => void
    current.cleanupResult = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    current.finishCleanup = (errors) => {
      try {
        throwCanvasRuntimeCleanupErrors(errors, 'Shared workspace resource cleanup failed')
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    return current.cleanupResult
  }

  private beginSetup(current: ActivationGeneration): () => void {
    if (current.setupResult) {
      throw new Error('Shared workspace attempted concurrent generation setup.')
    }
    let resolve!: () => void
    const setup = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise
    })
    current.setupResult = setup
    return () => {
      if (current.setupResult === setup) current.setupResult = null
      resolve()
    }
  }

  private startCleanup(current: ActivationGeneration): void {
    if (current.cleanupStarted) return
    current.cleanupStarted = true
    const errors: unknown[] = []
    this.cleanupGenerationCallbacks(current, errors)
    const setup = current.setupResult
    if (setup) {
      void setup.then(
        () => {
          this.cleanupGenerationCallbacks(current, errors)
          this.cleanupLayerAndMap(current, errors)
        },
        (error) => current.finishCleanup?.([...errors, error]),
      )
      return
    }
    this.cleanupLayerAndMap(current, errors)
  }

  private cleanupGenerationCallbacks(current: ActivationGeneration, errors: unknown[]): void {
    try {
      this.options.map.updateMapContributions(null)
    } catch (error) {
      errors.push(error)
    }
    const unwatchFailure = current.unwatchFailure
    current.unwatchFailure = null
    const unsubscribeCameraFailure = current.unsubscribeCameraFailure
    current.unsubscribeCameraFailure = null
    try {
      unwatchFailure?.()
    } catch (error) {
      errors.push(error)
    }
    try {
      unsubscribeCameraFailure?.()
    } catch (error) {
      errors.push(error)
    }
    if (current.cameraAttached) {
      current.cameraAttached = false
      try {
        this.cameraHost().detach()
      } catch (error) {
        errors.push(error)
      }
    }
  }

  private cleanupLayerAndMap(current: ActivationGeneration, errors: unknown[]): void {
    const layer = current.layer
    current.layer = null
    let layerDisposal: Promise<void>
    try {
      // Calling dispose is intentionally synchronous: Design replacement must
      // fence the layer before Scene authority changes, even though graphics
      // cleanup and map release settle later.
      layerDisposal = Promise.resolve(layer?.dispose())
    } catch (error) {
      errors.push(error)
      layerDisposal = Promise.resolve()
    }
    const map = current.map
    current.map = null
    void layerDisposal.then(
      () => this.releaseCleanupMap(map, errors, current.terminalMapFailure),
      (error) => {
        errors.push(error)
        this.releaseCleanupMap(map, errors, current.terminalMapFailure)
      },
    ).then(
      () => current.finishCleanup?.(errors),
      (error) => current.finishCleanup?.([...errors, error]),
    )
  }

  private releaseCleanupMap(
    map: WorkspaceActivationMap | null,
    errors: unknown[],
    failure?: unknown,
  ): void {
    if (!map) return
    try {
      this.options.map.releaseMap(map, failure)
    } catch (error) {
      errors.push(error)
    }
  }

  private observeFailure(current: ActivationGeneration, error: unknown): void {
    void this.reportFailureFor(current, error).catch((failure) => {
      if (this.isCurrent(current)) {
        reportMapError('Shared workspace map failure handling failed:', failure)
      }
    })
  }

  private addSharedSceneLayer(
    current: ActivationGeneration,
    map: WorkspaceActivationMap,
    layer: SharedMapSceneLayer,
  ): void {
    map.addLayer(layer.layer as unknown as Record<string, unknown>)
    if (!this.isCurrent(current)) return
    if (layer.diagnostics.phase !== 'attached') {
      throw new Error('MapLibre did not attach the initialized shared scene layer.')
    }
  }

  private initializeRuntime(): Promise<void> {
    // Record the pending transaction before runtime code runs so a synchronous
    // throw cannot be mistaken for a pre-admission map failure and retried.
    if (!this.runtimeInit) {
      this.runtimeInit = Promise.resolve().then(() => this.options.runtime.init(this.options.container))
    }
    return this.runtimeInit
  }

  private destroyRuntime(errors: unknown[]): void {
    if (this.runtimeDestroyed) return
    this.runtimeDestroyed = true
    try {
      this.options.runtime.destroy()
    } catch (error) {
      errors.push(error)
    }
    this.notifyRetryAvailability()
  }

  private releaseStaleMap(map: WorkspaceActivationMap): void {
    try {
      this.options.map.releaseMap(map)
    } catch (error) {
      reportMapError('Failed to release stale MapLibre workspace map:', error)
    }
  }

  /** The runtime's one camera. */
  private cameraHost(): CameraDriverHost {
    return this.options.camera
  }

  private isCurrent(current: ActivationGeneration): boolean {
    return !current.cancelled && this.active === current && this.generation === current.id
  }
}

/** A turned camera is never a failure: the map is unavailable only when its driver fails. */
function cameraFailureError(failure: CameraDriverFailure): Error {
  return new Error(failure.message)
}
