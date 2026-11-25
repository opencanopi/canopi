// app/canvas-map-surface/canvas-host.ts  (L3)
//
// The one canvas host for Desktop, Web and the UI gallery (docs/plans/2-1-foundations-contracts.md §5; canopi-f47t.52.8).
// Owns the canvas runtime lifecycle lease, Session attachment/detachment, container ResizeObserver, surface publication,
// and the exhaustive CanvasSurfaceState projection via composeSurface(lease, mapState).

import { batch, computed, signal, type ReadonlySignal } from '@preact/signals'
import { CanvasRuntimeCleanupError } from '../../canvas/runtime/cleanup'
import { acquireCanvasRuntimeLifecycle } from '../../canvas/runtime/lifecycle-owner'
import type { CanvasDocumentSurface } from '../../canvas/runtime/runtime'
import { getCurrentCanvasSession, setCurrentCanvasSession } from '../../canvas/session'
import type { LayerSlotId, MapLifetimeHandle, MapLifetimeState } from '../../maplibre/map-lifetime'
import type { WorkspaceRuntimeComposition } from './workspace-runtime-composition'

/** The element MapLibre and the scene draw into; the only element measured. */
interface CanvasHostElements {
  readonly container: HTMLElement
}

type CanvasUnavailableCause = 'runtime-failed' | 'start-cancelled' | 'runtime-destroyed'

type MapRetryAvailability = 'offered' | 'withheld' | 'never'

export type CanvasSurfaceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'unavailable', readonly cause: CanvasUnavailableCause }
  | { readonly kind: 'map', readonly map: MapLifetimeState, readonly retry: MapRetryAvailability }
  | { readonly kind: 'releasing' }

type CanvasHostStartState =
  | { readonly kind: 'starting' }
  | { readonly kind: 'attached' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly cause: CanvasUnavailableCause }

type CanvasHostLease =
  | { readonly kind: 'free' }
  | {
      readonly kind: 'held'
      readonly gen: number
      readonly start: CanvasHostStartState
      readonly runtime: 'alive' | 'destroyed'
      readonly mapFailure: 'none' | 'handling' | 'settled'
      readonly map: MapLifetimeHandle | null
    }
  | { readonly kind: 'releasing'; readonly gen: number }

type CanvasSceneAttachOutcome =
  | 'attached'
  | 'no-design'
  | 'aborted'
  | { readonly kind: 'failed'; readonly error: unknown }

export interface CanvasHostCore {
  attachScene(documents: CanvasDocumentSurface): Promise<CanvasSceneAttachOutcome> | CanvasSceneAttachOutcome
  /**
   * Runs synchronously before the first await in release (loss-prevention boundary, §5).
   * Interim 2b-2 cores may throw if live handoff capture fails; CanvasHost stops before dispose
   * and rejects releaseRuntime so lifecycle-owner retains the lease for retry.
   */
  detachScene(): void
}

interface CanvasHostFailureInfo {
  readonly code: 'canvas-start-failed' | 'canvas-release-failed'
  readonly source: 'canvas-host'
}

export interface CanvasHostCompositionOptions {
  readonly container: HTMLElement
  readonly onFailure: (error: unknown) => void
  readonly onRuntimeDestroyed: () => void
  readonly onMapFailureStateChange: (state: 'none' | 'handling' | 'settled') => void
}

export interface CanvasHostDeps {
  readonly elements: CanvasHostElements
  readonly core: CanvasHostCore
  readonly createComposition: (options: CanvasHostCompositionOptions) => WorkspaceRuntimeComposition
  readonly flushSettings: () => Promise<void>
  readonly reportFailure: (error: unknown, info: CanvasHostFailureInfo) => void
}

export interface CanvasHostView {
  readonly surface: ReadonlySignal<CanvasSurfaceState>
  readonly ready: ReadonlySignal<boolean>
  retryMap(): boolean
  retryLayer(slot: LayerSlotId): void
}

export interface CanvasHostHandle extends CanvasHostView {
  dispose(): Promise<void>
}

export const IDLE_CANVAS_SURFACE_STATE: CanvasSurfaceState = Object.freeze({ kind: 'idle' })

/**
 * Pure, exhaustive projection of the host lease and the map lifetime state into the one surface state
 * read by CanvasPanel, WebCanvasWorkspace, map-notice.ts, design-reveal.ts and data-map-active (§5).
 */
function composeSurface(
  lease: CanvasHostLease,
  mapState: MapLifetimeState | null,
): CanvasSurfaceState {
  if (lease.kind === 'free') return IDLE_CANVAS_SURFACE_STATE
  if (lease.kind === 'releasing') return { kind: 'releasing' }
  if (lease.runtime === 'destroyed') return { kind: 'unavailable', cause: 'runtime-destroyed' }
  if (lease.start.kind === 'failed') return { kind: 'unavailable', cause: lease.start.cause }
  if (lease.start.kind === 'aborted') return { kind: 'unavailable', cause: 'start-cancelled' }
  if (mapState === null) return { kind: 'starting' }
  const retry: MapRetryAvailability = mapState.kind !== 'failed'
    ? 'withheld'
    : mapState.cause === 'no-webgl2'
      ? 'never'
      : lease.mapFailure === 'settled' ? 'offered' : 'withheld'
  return { kind: 'map', map: mapState, retry }
}

/** @testonly */
export function composeSurfaceForTests(
  lease: CanvasHostLease,
  mapState: MapLifetimeState | null,
): CanvasSurfaceState {
  return composeSurface(lease, mapState)
}

const hostGeneration = { next: 0 }

/** Default deadline for a map-failure cleanup to settle before Retry is offered anyway (§5). */
const MAP_FAILURE_SETTLE_DEADLINE_MS = 5_000

/**
 * Mounts the one canvas host for Desktop, Web and the UI gallery (§5).
 * Start order: lease -> createComposition -> start -> core.attachScene -> resize -> observe -> publish -> ready=true.
 * Release order: core.detachScene (sync before any await) -> disconnect observer -> flushSettings -> dispose -> unpublish -> ready=false.
 */
export function mountCanvasHost(
  deps: CanvasHostDeps,
  options?: { readonly failureSettleDeadlineMs?: number },
): CanvasHostHandle {
  const gen = ++hostGeneration.next
  const lease = signal<CanvasHostLease>({ kind: 'free' })
  const ready = signal(false)
  const surface: ReadonlySignal<CanvasSurfaceState> = computed(() => {
    const current = lease.value
    const mapState = current.kind === 'held' && current.map ? current.map.state.value : null
    return composeSurface(current, mapState)
  })

  const settleDeadlineMs = options?.failureSettleDeadlineMs ?? MAP_FAILURE_SETTLE_DEADLINE_MS
  let cancelled = false
  let released = false
  let attached = false
  let composition: WorkspaceRuntimeComposition | null = null
  let resizeObserver: ResizeObserver | null = null
  let releaseLease: (() => Promise<void>) | null = null
  let creationSettlement: Promise<void> | null = null
  let attachmentSettlement: Promise<void> | null = null
  let disposePromise: Promise<void> | null = null
  let failureDeadlineTimer: ReturnType<typeof setTimeout> | null = null

  const isStopped = () => cancelled || released

  const clearFailureDeadline = () => {
    if (failureDeadlineTimer !== null) {
      clearTimeout(failureDeadlineTimer)
      failureDeadlineTimer = null
    }
  }

  const updateHeld = (patch: Partial<Omit<Extract<CanvasHostLease, { readonly kind: 'held' }>, 'kind' | 'gen'>>) => {
    const current = lease.peek()
    if (current.kind === 'held' && current.gen === gen) lease.value = { ...current, ...patch }
  }

  const handleMapFailureStateChange = (state: 'none' | 'handling' | 'settled') => {
    if (isStopped()) return
    clearFailureDeadline()
    updateHeld({ mapFailure: state })
    if (state !== 'handling') return
    failureDeadlineTimer = setTimeout(() => {
      failureDeadlineTimer = null
      if (isStopped()) return
      const current = lease.peek()
      if (current.kind === 'held' && current.mapFailure === 'handling') {
        safeReport(new Error('Map failure cleanup deadline exceeded'), 'canvas-release-failed')
        updateHeld({ mapFailure: 'settled' })
      }
    }, settleDeadlineMs)
  }

  const resizeContainerIfLaidOut = (documents: CanvasDocumentSurface) => {
    const { clientWidth: width, clientHeight: height } = deps.elements.container
    // A zero-size container is "not laid out": never pass 0x0 to produce a NaN camera (§5).
    if (width > 0 && height > 0) documents.resize(width, height)
  }

  const safeReport = (error: unknown, code: CanvasHostFailureInfo['code']) => {
    try {
      deps.reportFailure(error, { code, source: 'canvas-host' })
    } catch {
      // Never leak an unhandled rejection from the failure reporter.
    }
  }

  const runSyncStep = (errors: unknown[], run: () => void) => {
    try { run() } catch (error) { errors.push(error) }
  }

  const releaseRuntime = async (keepUnavailableState = false): Promise<void> => {
    while (!released && (creationSettlement || attachmentSettlement)) {
      await (creationSettlement ?? attachmentSettlement)
    }
    if (released) return

    // 1. Detach scene synchronously before any await (loss-prevention boundary, §5).
    // If detachScene throws, stop before disposing/unpublishing and reject so lifecycle-owner
    // keeps the lease and the next mount retries the handoff without losing unsaved edits.
    if (attached) {
      deps.core.detachScene()
      attached = false
    }

    released = true
    clearFailureDeadline()
    const activeComposition = composition
    const errors: unknown[] = []

    batch(() => {
      if (!keepUnavailableState) lease.value = { kind: 'releasing', gen }
      ready.value = false
    })

    // 2. Disconnect ResizeObserver.
    const observer = resizeObserver
    resizeObserver = null
    if (observer) runSyncStep(errors, () => observer.disconnect())
    // 3. Flush settings.
    try { await deps.flushSettings() } catch (error) { errors.push(error) }
    // 4. Dispose composition.
    if (activeComposition) {
      try { await activeComposition.dispose() } catch (error) { errors.push(error) }
    }
    // 5. Guarded unpublish.
    if (activeComposition) {
      runSyncStep(errors, () => {
        if (getCurrentCanvasSession() === activeComposition.surfaces) setCurrentCanvasSession(null)
      })
    }
    // 6. Release lease state.
    if (!keepUnavailableState) lease.value = { kind: 'free' }

    if (errors.length > 0) {
      safeReport(
        errors.length === 1 ? errors[0] : new CanvasRuntimeCleanupError('Canvas host release failed', errors),
        'canvas-release-failed',
      )
    }
  }

  const release = (keepUnavailableState = false): Promise<void> => {
    const releaseCurrentLease = releaseLease
    if (!releaseCurrentLease) return releaseRuntime(keepUnavailableState)
    return releaseCurrentLease().catch((error: unknown) => {
      if (!released) disposePromise = null
      safeReport(error, 'canvas-release-failed')
    })
  }

  const createTrackedComposition = (): WorkspaceRuntimeComposition => {
    let finishCreation!: () => void
    creationSettlement = new Promise<void>((resolve) => { finishCreation = resolve })
    try {
      composition = deps.createComposition({
        container: deps.elements.container,
        onFailure: (error) => safeReport(error, 'canvas-start-failed'),
        onRuntimeDestroyed: () => updateHeld({ runtime: 'destroyed' }),
        onMapFailureStateChange: handleMapFailureStateChange,
      })
      return composition
    } finally {
      finishCreation()
      creationSettlement = null
    }
  }

  const observeContainerResize = (documents: CanvasDocumentSurface): boolean => {
    resizeContainerIfLaidOut(documents)
    if (typeof ResizeObserver === 'undefined') return true
    const observer = new ResizeObserver(() => {
      if (!isStopped()) resizeContainerIfLaidOut(documents)
    })
    if (isStopped()) {
      try { observer.disconnect() } catch (error) { safeReport(error, 'canvas-release-failed') }
      return false
    }
    resizeObserver = observer
    observer.observe(deps.elements.container)
    return true
  }

  const startHost = async () => {
    let keepUnavailableOnRelease = false
    const abortStart = async (reportError?: Error) => {
      keepUnavailableOnRelease = true
      updateHeld({ start: { kind: 'aborted' } })
      if (reportError) safeReport(reportError, 'canvas-start-failed')
      await release(true)
    }
    try {
      const acquired = await acquireCanvasRuntimeLifecycle(() => releaseRuntime(keepUnavailableOnRelease))
      releaseLease = acquired.release
      if (cancelled) { await release(); return }

      lease.value = {
        kind: 'held',
        gen,
        start: { kind: 'starting' },
        runtime: 'alive',
        mapFailure: 'none',
        map: null,
      }

      const activeComposition = createTrackedComposition()
      updateHeld({ map: activeComposition.mapLifetime })
      if (isStopped()) { await release(); return }

      const startOutcome = await activeComposition.start()
      if (isStopped()) { await release(); return }
      if (startOutcome !== 'shared-ready' && startOutcome !== 'map-unavailable' && startOutcome !== 'no-design') {
        await abortStart(new Error('Shared workspace initialization was cancelled.'))
        return
      }

      const documents = activeComposition.surfaces.documents
      let finishAttachment!: () => void
      attachmentSettlement = new Promise<void>((resolve) => { finishAttachment = resolve })
      let attachOutcome: CanvasSceneAttachOutcome
      try {
        attachOutcome = await deps.core.attachScene(documents)
        if (attachOutcome === 'attached' || attachOutcome === 'no-design') attached = true
      } finally {
        finishAttachment()
        attachmentSettlement = null
      }
      if (isStopped()) { await release(); return }
      if (attachOutcome === 'aborted') { await abortStart(); return }
      if (typeof attachOutcome === 'object' && attachOutcome.kind === 'failed') throw attachOutcome.error

      if (!observeContainerResize(documents) || isStopped()) { await release(); return }

      setCurrentCanvasSession(activeComposition.surfaces)
      if (isStopped()) { await release(); return }
      batch(() => {
        updateHeld({ start: { kind: 'attached' } })
        ready.value = true
      })
    } catch (error) {
      if (cancelled) { await release(); return }
      keepUnavailableOnRelease = true
      updateHeld({ start: { kind: 'failed', cause: 'runtime-failed' } })
      safeReport(error, 'canvas-start-failed')
      await release(true)
    }
  }

  void startHost()

  const heldMap = (): MapLifetimeHandle | null => {
    if (isStopped()) return null
    const current = lease.peek()
    return current.kind === 'held' ? current.map : null
  }

  return {
    surface,
    ready,
    retryMap(): boolean {
      const map = heldMap()
      const current = surface.peek()
      return map !== null && current.kind === 'map' && current.retry === 'offered' ? map.restart() : false
    },
    retryLayer(slot: LayerSlotId): void {
      heldMap()?.retryLayer(slot)
    },
    dispose(): Promise<void> {
      if (!disposePromise) {
        cancelled = true
        disposePromise = release(false)
      }
      return disposePromise
    },
  }
}
