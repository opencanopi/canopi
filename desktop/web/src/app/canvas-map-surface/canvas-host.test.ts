// @vitest-environment jsdom

import { effect } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasRuntimeCleanupError } from '../../canvas/runtime/cleanup'
import type { CanvasRuntimeSurfaces } from '../../canvas/runtime/runtime'
import { currentCanvasSession, getCurrentCanvasSession, setCurrentCanvasSession } from '../../canvas/session'
import {
  createMapLifetimeSlot,
  type LayerSlotId,
  type MapLifetimeState,
} from '../../maplibre/map-lifetime'
import {
  createTestCanvasDocumentSurface,
  createTestCanvasRuntimeSurfaces,
} from '../../__tests__/support/canvas-runtime-surfaces'
import {
  composeSurfaceForTests as composeSurface,
  IDLE_CANVAS_SURFACE_STATE,
  mountCanvasHost,
  type CanvasHostCompositionOptions,
  type CanvasHostCore,
  type CanvasHostDeps,
  type CanvasHostHandle,
} from './canvas-host'

type CanvasHostLease = Parameters<typeof composeSurface>[0]
type CanvasSceneAttachOutcome = Awaited<ReturnType<CanvasHostCore['attachScene']>>
type CanvasHostFailureInfo = Parameters<CanvasHostDeps['reportFailure']>[1]
import type {
  WorkspaceRuntimeComposition,
  WorkspaceRuntimeStartOutcome,
} from './workspace-runtime-composition'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

function makeContainer(width: number, height: number): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true })
  return el
}

interface FakeResizeObserverRecord {
  readonly observe: ReturnType<typeof vi.fn>
  readonly disconnect: ReturnType<typeof vi.fn>
  trigger(): void
}

function installFakeResizeObserver(): FakeResizeObserverRecord {
  const observe = vi.fn()
  const disconnect = vi.fn()
  let latestCallback: ResizeObserverCallback | null = null
  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      latestCallback = callback
    }
    observe = observe
    unobserve = vi.fn()
    disconnect = disconnect
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  return {
    observe,
    disconnect,
    trigger: () => latestCallback?.([], {} as ResizeObserver),
  }
}

function makeFakeComposition(options: {
  readonly surfaces?: CanvasRuntimeSurfaces
  readonly start?: () => Promise<WorkspaceRuntimeStartOutcome>
  readonly dispose?: () => Promise<void>
  readonly restart?: () => boolean
  readonly retryLayer?: (slot: LayerSlotId) => void
  readonly initialMapState?: MapLifetimeState
} = {}) {
  const surfaces = options.surfaces ?? createTestCanvasRuntimeSurfaces({ documents: createTestCanvasDocumentSurface() })
  const restart = vi.fn(options.restart ?? (() => true))
  const retryLayer = vi.fn(options.retryLayer ?? (() => {}))
  const mapSlot = createMapLifetimeSlot(
    { restart, retryLayer, release: () => {} },
    options.initialMapState ?? { kind: 'ready', attempt: 1, layers: new Map() },
  )
  const start = vi.fn(options.start ?? (async () => 'shared-ready' as const))
  const dispose = vi.fn(options.dispose ?? (async () => undefined))
  const composition: WorkspaceRuntimeComposition = {
    surfaces,
    mapLifetime: mapSlot.handle,
    start,
    dispose,
  }
  return { composition, surfaces, mapSlot, start, dispose, restart, retryLayer }
}

describe('composeSurface', () => {
  const mapStates: readonly (MapLifetimeState | null)[] = [
    null,
    { kind: 'creating', attempt: 1 },
    { kind: 'admitted', attempt: 1 },
    { kind: 'ready', attempt: 1, layers: new Map() },
    { kind: 'failed', attempt: 1, cause: 'no-webgl2' },
    { kind: 'failed', attempt: 1, cause: 'engine-start' },
    { kind: 'failed', attempt: 1, cause: 'style' },
    { kind: 'failed', attempt: 1, cause: 'context-lost' },
    { kind: 'released' },
  ]

  it('exhaustively projects every lease and map-lifetime combination', () => {
    for (const mapState of mapStates) {
      expect(composeSurface({ kind: 'free' }, mapState)).toEqual(IDLE_CANVAS_SURFACE_STATE)
      expect(composeSurface({ kind: 'releasing', gen: 1 }, mapState)).toEqual({ kind: 'releasing' })

      const destroyed: CanvasHostLease = {
        kind: 'held', gen: 1, start: { kind: 'attached' }, runtime: 'destroyed', mapFailure: 'settled', map: null,
      }
      expect(composeSurface(destroyed, mapState)).toEqual({ kind: 'unavailable', cause: 'runtime-destroyed' })

      const failedStart: CanvasHostLease = {
        kind: 'held', gen: 1, start: { kind: 'failed', cause: 'runtime-failed' }, runtime: 'alive', mapFailure: 'none', map: null,
      }
      expect(composeSurface(failedStart, mapState)).toEqual({ kind: 'unavailable', cause: 'runtime-failed' })

      const cancelledStart: CanvasHostLease = {
        kind: 'held', gen: 1, start: { kind: 'aborted' }, runtime: 'alive', mapFailure: 'none', map: null,
      }
      expect(composeSurface(cancelledStart, mapState)).toEqual({ kind: 'unavailable', cause: 'start-cancelled' })
    }

    const aliveLease = (mapFailure: 'none' | 'handling' | 'settled'): CanvasHostLease => ({
      kind: 'held', gen: 1, start: { kind: 'attached' }, runtime: 'alive', mapFailure, map: null,
    })

    expect(composeSurface(aliveLease('none'), null)).toEqual({ kind: 'starting' })
    expect(composeSurface(aliveLease('none'), { kind: 'ready', attempt: 1, layers: new Map() })).toEqual({
      kind: 'map', map: { kind: 'ready', attempt: 1, layers: new Map() }, retry: 'withheld',
    })
    expect(composeSurface(aliveLease('settled'), { kind: 'failed', attempt: 1, cause: 'no-webgl2' })).toEqual({
      kind: 'map', map: { kind: 'failed', attempt: 1, cause: 'no-webgl2' }, retry: 'never',
    })
    expect(composeSurface(aliveLease('handling'), { kind: 'failed', attempt: 1, cause: 'context-lost' })).toEqual({
      kind: 'map', map: { kind: 'failed', attempt: 1, cause: 'context-lost' }, retry: 'withheld',
    })
    expect(composeSurface(aliveLease('settled'), { kind: 'failed', attempt: 1, cause: 'context-lost' })).toEqual({
      kind: 'map', map: { kind: 'failed', attempt: 1, cause: 'context-lost' }, retry: 'offered',
    })
    expect(composeSurface(aliveLease('settled'), { kind: 'failed', attempt: 1, cause: 'engine-start' })).toEqual({
      kind: 'map', map: { kind: 'failed', attempt: 1, cause: 'engine-start' }, retry: 'offered',
    })
  })
})

describe('mountCanvasHost', () => {
  let handles: CanvasHostHandle[] = []

  beforeEach(() => {
    setCurrentCanvasSession(null)
    handles = []
  })

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.dispose()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    setCurrentCanvasSession(null)
  })

  it.each<CanvasSceneAttachOutcome>(['attached', 'no-design'])(
    'runs the full startup order, measures its container, publishes, and marks ready when attachScene returns %s',
    async (attachOutcome) => {
      const observer = installFakeResizeObserver()
      const container = makeContainer(800, 600)
      const order: string[] = []
      const resize = vi.fn(() => order.push('resize'))
      const documents = createTestCanvasDocumentSurface({ resize })
      const fake = makeFakeComposition({
        surfaces: createTestCanvasRuntimeSurfaces({ documents }),
        start: async () => {
          order.push('start')
          return 'shared-ready'
        },
      })
      const core: CanvasHostCore = {
        attachScene: vi.fn(async () => {
          order.push('attachScene')
          return attachOutcome
        }),
        detachScene: vi.fn(() => order.push('detachScene')),
      }
      observer.observe.mockImplementation(() => order.push('observe'))
      const reportFailure = vi.fn()

      const host = mountCanvasHost({
        elements: { container },
        core,
        createComposition: () => {
          order.push('createComposition')
          return fake.composition
        },
        flushSettings: vi.fn(async () => {}),
        reportFailure,
      })
      handles.push(host)
      await flushMicrotasks()

      expect(reportFailure).not.toHaveBeenCalled()
      expect(host.ready.value).toBe(true)
      expect(getCurrentCanvasSession()).toBe(fake.surfaces)
      expect(resize).toHaveBeenCalledWith(800, 600)
      expect(observer.observe).toHaveBeenCalledWith(container)
      expect(order).toEqual(['createComposition', 'start', 'attachScene', 'resize', 'observe'])

      await host.dispose()
      expect(host.ready.value).toBe(false)
      expect(getCurrentCanvasSession()).toBeNull()
      expect(host.surface.value).toEqual(IDLE_CANVAS_SURFACE_STATE)
    },
  )

  it('reads unavailable when composition start is cancelled and does not attach or publish', async () => {
    const fake = makeFakeComposition({ start: async () => 'cancelled' })
    const attachScene = vi.fn(async () => 'attached' as const)
    const reportFailure = vi.fn()
    const host = mountCanvasHost({
      elements: { container: makeContainer(640, 480) },
      core: { attachScene, detachScene: vi.fn() },
      createComposition: () => fake.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure,
    })
    handles.push(host)
    await flushMicrotasks()

    expect(attachScene).not.toHaveBeenCalled()
    expect(getCurrentCanvasSession()).toBeNull()
    expect(host.ready.value).toBe(false)
    expect(host.surface.value).toEqual({ kind: 'unavailable', cause: 'start-cancelled' })
    expect(reportFailure).toHaveBeenCalledWith(
      expect.any(Error),
      { code: 'canvas-start-failed', source: 'canvas-host' },
    )
  })

  it('reads unavailable when attachScene returns cancelled and aborts when attachScene fails', async () => {
    const fakeCancel = makeFakeComposition()
    const hostCancel = mountCanvasHost({
      elements: { container: makeContainer(640, 480) },
      core: { attachScene: async () => 'aborted' as const, detachScene: vi.fn() },
      createComposition: () => fakeCancel.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(hostCancel)
    await flushMicrotasks()
    expect(hostCancel.surface.value).toEqual({ kind: 'unavailable', cause: 'start-cancelled' })
    expect(getCurrentCanvasSession()).toBeNull()
    await hostCancel.dispose()

    const mountError = new Error('late document hydration failed')
    const reportFailure = vi.fn()
    const fakeFail = makeFakeComposition()
    const hostFail = mountCanvasHost({
      elements: { container: makeContainer(640, 480) },
      core: { attachScene: async () => ({ kind: 'failed', error: mountError }), detachScene: vi.fn() },
      createComposition: () => fakeFail.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure,
    })
    handles.push(hostFail)
    await flushMicrotasks()
    expect(hostFail.surface.value).toEqual({ kind: 'unavailable', cause: 'runtime-failed' })
    expect(getCurrentCanvasSession()).toBeNull()
    expect(reportFailure).toHaveBeenCalledWith(
      mountError,
      { code: 'canvas-start-failed', source: 'canvas-host' },
    )
  })

  it('detaches synchronously before any await during release, then disconnects, flushes settings, disposes, and unpublishes', async () => {
    const observer = installFakeResizeObserver()
    const settingsFlush = deferred<void>()
    const compositionDispose = deferred<void>()
    const order: string[] = []
    const fake = makeFakeComposition({
      dispose: () => {
        order.push('dispose')
        return compositionDispose.promise
      },
    })
    observer.disconnect.mockImplementation(() => order.push('disconnect'))
    const host = mountCanvasHost({
      elements: { container: makeContainer(800, 600) },
      core: {
        attachScene: async () => 'attached' as const,
        detachScene: () => order.push('detachScene'),
      },
      createComposition: () => fake.composition,
      flushSettings: () => {
        order.push('flushSettings')
        return settingsFlush.promise
      },
      reportFailure: vi.fn(),
    })
    handles.push(host)
    await flushMicrotasks()

    const disposal = host.dispose()
    // Detach and disconnect run synchronously before the first await; composition is not yet disposed.
    expect(order).toEqual(['detachScene', 'disconnect', 'flushSettings'])
    expect(host.surface.value).toEqual({ kind: 'releasing' })
    expect(getCurrentCanvasSession()).toBe(fake.surfaces)

    settingsFlush.resolve()
    await Promise.resolve()
    expect(order).toEqual(['detachScene', 'disconnect', 'flushSettings', 'dispose'])
    expect(getCurrentCanvasSession()).toBe(fake.surfaces)

    compositionDispose.resolve()
    await disposal
    expect(getCurrentCanvasSession()).toBeNull()
    expect(host.ready.value).toBe(false)
    expect(host.surface.value).toEqual(IDLE_CANVAS_SURFACE_STATE)
  })

  it('does not call resize on a zero-size container (not laid out) and resizes once laid out', async () => {
    const observer = installFakeResizeObserver()
    const container = makeContainer(0, 0)
    const resize = vi.fn()
    const fake = makeFakeComposition({
      surfaces: createTestCanvasRuntimeSurfaces({ documents: createTestCanvasDocumentSurface({ resize }) }),
    })
    const host = mountCanvasHost({
      elements: { container },
      core: { attachScene: async () => 'attached' as const, detachScene: vi.fn() },
      createComposition: () => fake.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(host)
    await flushMicrotasks()
    expect(resize).not.toHaveBeenCalled()

    Object.defineProperty(container, 'clientWidth', { value: 1024, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 768, configurable: true })
    observer.trigger()
    expect(resize).toHaveBeenCalledWith(1024, 768)
  })

  it('aggregates cleanup errors and reports them once without leaking unhandled rejections when unpublish or reporter throws', async () => {
    const settingsError = new Error('settings flush failed')
    const disposeError = new Error('composition dispose failed')
    const unpublishError = new Error('unpublish observer failed')
    const reported: Array<{ error: unknown; info: CanvasHostFailureInfo }> = []
    const fake = makeFakeComposition({
      dispose: async () => { throw disposeError },
    })
    const host = mountCanvasHost({
      elements: { container: makeContainer(800, 600) },
      core: { attachScene: async () => 'attached' as const, detachScene: vi.fn() },
      createComposition: () => fake.composition,
      flushSettings: async () => { throw settingsError },
      reportFailure: (error, info) => {
        reported.push({ error, info })
        throw new Error('reporter exploded')
      },
    })
    handles.push(host)
    await flushMicrotasks()

    const stop = effect(() => {
      if (currentCanvasSession.value === null && reported.length === 0) throw unpublishError
    })
    try {
      await expect(host.dispose()).resolves.toBeUndefined()
      await expect(host.dispose()).resolves.toBeUndefined()
    } finally {
      stop()
    }

    expect(reported).toHaveLength(1)
    expect(reported[0]!.info).toEqual({ code: 'canvas-release-failed', source: 'canvas-host' })
    expect(reported[0]!.error).toBeInstanceOf(CanvasRuntimeCleanupError)
    const cleanup = reported[0]!.error as CanvasRuntimeCleanupError
    expect(cleanup.errors).toEqual([settingsError, disposeError, unpublishError])
  })

  it('waits for an in-flight attachment before detaching on unmount during start', async () => {
    const attachDeferred = deferred<CanvasSceneAttachOutcome>()
    const detachScene = vi.fn()
    const fake = makeFakeComposition()
    const host = mountCanvasHost({
      elements: { container: makeContainer(800, 600) },
      core: {
        attachScene: () => attachDeferred.promise,
        detachScene,
      },
      createComposition: () => fake.composition,
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(host)
    await flushMicrotasks()

    const disposal = host.dispose()
    expect(detachScene).not.toHaveBeenCalled()

    attachDeferred.resolve('attached')
    await disposal
    expect(detachScene).toHaveBeenCalledOnce()
    expect(getCurrentCanvasSession()).toBeNull()
  })

  it('offers Retry only when mapFailure is settled and retry===offered implies retryMap() returns true', async () => {
    let compOpts!: CanvasHostCompositionOptions
    const fake = makeFakeComposition()
    const host = mountCanvasHost({
      elements: { container: makeContainer(800, 600) },
      core: { attachScene: async () => 'attached' as const, detachScene: vi.fn() },
      createComposition: (opts) => {
        compOpts = opts
        return fake.composition
      },
      flushSettings: vi.fn(async () => {}),
      reportFailure: vi.fn(),
    })
    handles.push(host)
    await flushMicrotasks()

    expect(host.retryMap()).toBe(false)

    // Map fails and cleanup is handling -> retry is withheld.
    fake.mapSlot.setState({ kind: 'failed', attempt: 1, cause: 'context-lost' })
    compOpts.onMapFailureStateChange('handling')
    expect(host.surface.value).toEqual({
      kind: 'map',
      map: { kind: 'failed', attempt: 1, cause: 'context-lost' },
      retry: 'withheld',
    })
    expect(host.retryMap()).toBe(false)

    // Failure cleanup settles -> retry is offered and retryMap() returns true.
    compOpts.onMapFailureStateChange('settled')
    expect(host.surface.value).toEqual({
      kind: 'map',
      map: { kind: 'failed', attempt: 1, cause: 'context-lost' },
      retry: 'offered',
    })
    expect(host.retryMap()).toBe(true)
    expect(fake.restart).toHaveBeenCalledOnce()

    // No WebGL2 -> retry is never offered.
    fake.mapSlot.setState({ kind: 'failed', attempt: 2, cause: 'no-webgl2' })
    expect(host.surface.value).toEqual({
      kind: 'map',
      map: { kind: 'failed', attempt: 2, cause: 'no-webgl2' },
      retry: 'never',
    })
    expect(host.retryMap()).toBe(false)
  })

  it('settles mapFailure after the failure cleanup deadline and reports once', async () => {
    vi.useFakeTimers()
    let compOpts!: CanvasHostCompositionOptions
    const fake = makeFakeComposition()
    const reportFailure = vi.fn()
    const host = mountCanvasHost(
      {
        elements: { container: makeContainer(800, 600) },
        core: { attachScene: async () => 'attached' as const, detachScene: vi.fn() },
        createComposition: (opts) => {
          compOpts = opts
          return fake.composition
        },
        flushSettings: vi.fn(async () => {}),
        reportFailure,
      },
      { failureSettleDeadlineMs: 1_000 },
    )
    handles.push(host)
    await flushMicrotasks()

    fake.mapSlot.setState({ kind: 'failed', attempt: 1, cause: 'engine-start' })
    compOpts.onMapFailureStateChange('handling')
    expect(host.retryMap()).toBe(false)

    vi.advanceTimersByTime(1_000)
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(host.surface.value).toEqual({
      kind: 'map',
      map: { kind: 'failed', attempt: 1, cause: 'engine-start' },
      retry: 'offered',
    })
    expect(host.retryMap()).toBe(true)
  })

  it('retains the lease without disposing or unpublishing when detachScene throws, and retries handoff on next mount', async () => {
    const handoffError = new Error('live handoff snapshot failed')
    let shouldFailDetach = true
    const detachScene = vi.fn(() => { if (shouldFailDetach) throw handoffError })
    const flushSettings = vi.fn(async () => {})
    const reportFailure = vi.fn()
    const fake1 = makeFakeComposition()
    const host1 = mountCanvasHost({
      elements: { container: makeContainer(800, 600) },
      core: { attachScene: async () => 'attached' as const, detachScene },
      createComposition: () => fake1.composition, flushSettings, reportFailure,
    })
    handles.push(host1)
    await flushMicrotasks()
    expect(getCurrentCanvasSession()).toBe(fake1.surfaces)

    await host1.dispose()
    expect(detachScene).toHaveBeenCalledTimes(1)
    expect(fake1.dispose).not.toHaveBeenCalled()
    expect(flushSettings).not.toHaveBeenCalled()
    expect(getCurrentCanvasSession()).toBe(fake1.surfaces)
    expect(reportFailure).toHaveBeenCalledWith(handoffError, { code: 'canvas-release-failed', source: 'canvas-host' })

    shouldFailDetach = false
    const fake2 = makeFakeComposition()
    const host2 = mountCanvasHost({
      elements: { container: makeContainer(800, 600) },
      core: { attachScene: async () => 'attached' as const, detachScene: vi.fn() },
      createComposition: () => fake2.composition, flushSettings: vi.fn(async () => {}), reportFailure: vi.fn(),
    })
    handles.push(host2)
    await flushMicrotasks()
    expect(detachScene).toHaveBeenCalledTimes(2)
    expect(fake1.dispose).toHaveBeenCalledOnce()
    expect(getCurrentCanvasSession()).toBe(fake2.surfaces)
    expect(host2.ready.value).toBe(true)
  })

  it('does not mark ready when a currentCanvasSession subscriber synchronously disposes the host', async () => {
    const fake = makeFakeComposition()
    const hostRef: { current?: CanvasHostHandle } = {}
    const stop = effect(() => { if (currentCanvasSession.value === fake.surfaces) void hostRef.current?.dispose() })
    try {
      hostRef.current = mountCanvasHost({
        elements: { container: makeContainer(800, 600) },
        core: { attachScene: async () => 'attached' as const, detachScene: vi.fn() },
        createComposition: () => fake.composition, flushSettings: vi.fn(async () => {}), reportFailure: vi.fn(),
      })
      handles.push(hostRef.current)
      await flushMicrotasks()
      expect(hostRef.current.ready.value).toBe(false)
      expect(getCurrentCanvasSession()).toBeNull()
    } finally { stop() }
  })

  it('handles reentrant dispose during createComposition and keeps a successor published on stale teardown', async () => {
    const fake1 = makeFakeComposition()
    const host1Ref: { current?: CanvasHostHandle } = {}
    host1Ref.current = mountCanvasHost({
      elements: { container: makeContainer(800, 600) },
      core: { attachScene: async () => 'attached' as const, detachScene: vi.fn() },
      createComposition: () => { void host1Ref.current?.dispose(); return fake1.composition },
      flushSettings: vi.fn(async () => {}), reportFailure: vi.fn(),
    })
    handles.push(host1Ref.current)
    await flushMicrotasks()
    expect(fake1.dispose).toHaveBeenCalledOnce()
    expect(getCurrentCanvasSession()).toBeNull()

    const disposeDeferred = deferred<void>()
    const fake2 = makeFakeComposition({ dispose: () => disposeDeferred.promise })
    const successor = createTestCanvasRuntimeSurfaces({ documents: createTestCanvasDocumentSurface() })
    const host2 = mountCanvasHost({
      elements: { container: makeContainer(800, 600) },
      core: { attachScene: async () => 'attached' as const, detachScene: vi.fn() },
      createComposition: () => fake2.composition, flushSettings: vi.fn(async () => {}), reportFailure: vi.fn(),
    })
    handles.push(host2)
    await flushMicrotasks()
    const disposal = host2.dispose()
    setCurrentCanvasSession(successor)
    disposeDeferred.resolve()
    await disposal
    expect(getCurrentCanvasSession()).toBe(successor)
  })
})
