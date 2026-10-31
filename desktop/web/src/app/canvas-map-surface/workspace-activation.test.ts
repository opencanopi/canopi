// @vitest-environment jsdom

import type { WorkspaceMapContributionSnapshot } from './workspace-map-contribution-adapter'
import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceActivationCoordinator,
  WorkspaceWebGL2UnavailableError,
  type WorkspaceActivationMap,
  type WorkspaceActivationMapControls,
  type WorkspaceActivationSnapshot,
  type WorkspaceActivationRuntime,
} from './workspace-activation'
import { createTestView } from '../../__tests__/support/test-view'
import { planarCameraOf } from '../../canvas/runtime/view/view-transform'
import { SceneCanvasRuntime } from '../../canvas/runtime/scene-runtime'
import {
  MAPLIBRE_SHARED_SCENE_LAYER_ID,
  type SharedMapSceneLayer,
  type SharedMapSceneLayerOptions,
  type SharedPixiRenderer,
} from '../../maplibre/shared-scene-layer'
import { createSharedMapSceneRendererComposition, type SharedMapSceneRendererComposition } from '../../maplibre/shared-scene-renderer'
import { WorkspaceGenerationReconciler } from './workspace-generation-reconciler'
import type { MapBackgroundPresentation } from '../../maplibre/map-background'
import { geoToScreen } from '../../__tests__/support/geo-to-screen'
import { screenToGeo } from '../../canvas/runtime/view/camera-math'
import type { ViewCamera } from '../../canvas/runtime/view/types'
import { createDetachedCanvasRuntimeAppAdapter } from '../../canvas/runtime/app-adapter'
import { createCanvasDocumentReplacementToken } from '../../canvas/runtime/runtime'
import { createDetachedSceneRuntimePanelTargetAdapter } from '../../canvas/runtime/scene-runtime/panel-target-adapter'
import {
  IDLE_MAPLIBRE_CANVAS_SURFACE_STATE,
  type MapLibreCanvasSurfaceState,
} from '../../maplibre/canvas-surface-state'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'
import { createWorkspaceRuntimeComposition, type WorkspaceRuntimeComposition } from './workspace-runtime-composition'

function background(
  basemap: Partial<MapBackgroundPresentation['basemap']> = {},
  satellite: Partial<MapBackgroundPresentation['satellite']> = {},
): MapBackgroundPresentation {
  return {
    basemap: { style: 'liberty', visible: true, opacity: 1, ...basemap },
    satellite: { visible: false, opacity: 1, ...satellite },
    locale: 'en',
  }
}

function createActivationSnapshot(
  overrides: Partial<WorkspaceActivationSnapshot['map']> = {},
  sessionIdentity: object = {},
): WorkspaceActivationSnapshot {
  return {
    sessionIdentity,
    map: {
      initialCenter: { lat: 0, lon: 0 },
      background: background(),
      ...overrides,
    },
  }
}

class TestWorkspaceActivationCoordinator extends WorkspaceActivationCoordinator {
  override activate(
    snapshot: WorkspaceActivationSnapshot = createActivationSnapshot(),
  ) {
    return super.activate(snapshot)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/**
 * A consistent MapLibre fake (plan §4, 0A "Attached-map fakes"): its read-backs describe one fixed camera, jumpTo fires 'move',
 * flyTo fires 'move' and 'moveend', and the guard is recorded.
 */
class FakeMap {
  readonly canvas = document.createElement('canvas')
  readonly context = {} as WebGL2RenderingContext
  readonly camera: ViewCamera = { center: { lon: 0, lat: 0 }, zoom: 18, bearingDeg: 0, pitchDeg: 0 }
  readonly jumpTo = vi.fn(() => this.emit('move'))
  readonly flyTo = vi.fn(() => {
    this.emit('move')
    this.emit('moveend')
  })
  readonly setTransformConstrain = vi.fn()
  readonly stop = vi.fn()
  readonly resize = vi.fn()
  readonly remove = vi.fn()
  readonly listeners = new Map<string, Set<() => void>>()
  readonly on = vi.fn((type: string, listener: () => void) => {
    const listeners = this.listeners.get(type) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  })
  readonly off = vi.fn((type: string, listener: () => void) => this.listeners.get(type)?.delete(listener))
  readonly layers = new Map<string, { onAdd?: (map: unknown, context: WebGL2RenderingContext) => void; onRemove?: (map: unknown, context: WebGL2RenderingContext) => void }>()
  readonly layerOrder: string[] = []
  readonly addLayer = vi.fn((layer: { id?: string; onAdd?: (map: unknown, context: WebGL2RenderingContext) => void; onRemove?: (map: unknown, context: WebGL2RenderingContext) => void }) => {
    if (layer.id) {
      this.layers.set(layer.id, layer)
      if (!this.layerOrder.includes(layer.id)) this.layerOrder.push(layer.id)
    }
    layer.onAdd?.(this, this.context)
  })
  readonly getLayer = vi.fn((id: string) => this.layers.get(id))
  readonly getLayersOrder = vi.fn(() => [...this.layerOrder])
  readonly moveLayer = vi.fn((id: string, beforeId?: string) => {
    const index = this.layerOrder.indexOf(id)
    if (index < 0) return
    this.layerOrder.splice(index, 1)
    const beforeIndex = beforeId == null ? -1 : this.layerOrder.indexOf(beforeId)
    if (beforeIndex < 0) this.layerOrder.push(id)
    else this.layerOrder.splice(beforeIndex, 0, id)
  })
  readonly triggerRepaint = vi.fn()
  pitch = 0

  constructor() {
    Object.defineProperties(this.canvas, {
      clientWidth: { value: 400 }, clientHeight: { value: 300 },
      width: { value: 800, writable: true }, height: { value: 600, writable: true },
    })
  }

  getCanvas() { return this.canvas }
  getPitch() { return this.pitch }
  getBearing() { return this.camera.bearingDeg }
  getZoom() { return this.camera.zoom }
  getMinZoom() { return 0 }
  getMaxZoom() { return 27 }
  getCenter() { return { lng: this.camera.center.lon, lat: this.camera.center.lat } }
  project([lon, lat]: [number, number]) { return geoToScreen(this.camera, this.screen(), { lon, lat }) }
  unproject([x, y]: [number, number]) {
    const ground = screenToGeo(this.camera, this.screen(), { x, y })
    return { lng: ground.lon, lat: ground.lat }
  }
  private screen() { return { width: this.canvas.clientWidth, height: this.canvas.clientHeight, devicePixelRatio: 2 } }
  emit(type: string) { this.listeners.get(type)?.forEach((listener) => listener()) }
}

function createRuntime() {
  return {
    init: vi.fn(async () => {}),
    unmountRenderer: vi.fn(async () => {}),
    remountRenderer: vi.fn(async () => {}),
    destroy: vi.fn(),
  } satisfies WorkspaceActivationRuntime
}

function createComposition(options: {
  initialize?: () => Promise<void>
  onAdd?: () => void
  dispose?: () => Promise<void>
  directDispose?: () => Promise<void>
} = {}) {
  let phase: SharedMapSceneLayer['diagnostics']['phase'] = 'new'
  const dispose = options.directDispose
    ? vi.fn(options.directDispose)
    : vi.fn(async () => {
      await options.dispose?.()
      phase = 'disposed'
    })
  const layer: SharedMapSceneLayer = {
    layer: {
      id: MAPLIBRE_SHARED_SCENE_LAYER_ID, type: 'custom', renderingMode: '2d',
      onAdd: () => {
        phase = 'attached'
        options.onAdd?.()
      },
      render: () => {},
    },
    get diagnostics() {
      return { phase, sceneSyncCount: 0 }
    },
    initialize: vi.fn(async () => {
      await options.initialize?.()
      phase = 'initialized'
    }),
    setSnapshot: vi.fn(), dispose,
  }
  const composition = {
    createLayer: vi.fn(() => layer),
  } satisfies SharedMapSceneRendererComposition
  return { composition, layer, dispose }
}

function createCoordinator(input: {
  map?: FakeMap
  createMap?: WorkspaceActivationMapControls['createMap']
  composition?: SharedMapSceneRendererComposition
  runtime?: ReturnType<typeof createRuntime>
  context?: WebGL2RenderingContext | null
  unwatchFailure?: () => void
  watchFailure?: WorkspaceActivationMapControls['watchFailure']
  reconcileLayerStack?: WorkspaceActivationMapControls['reconcileLayerStack']
  readOrigin?: () => { readonly lat: number; readonly lon: number }
} = {}) {
  const map = input.map ?? new FakeMap()
  // The runtime's camera, at the start frame today's runtime placed: 100 m across the 300 px side.
  const camera = createTestView({ viewport: { x: 50, y: 0, scale: 3 } }).host
  const runtime = input.runtime ?? createRuntime()
  const composition = input.composition ?? createComposition().composition
  const mapControls: WorkspaceActivationMapControls = {
    createMap: input.createMap ?? (async () => map as unknown as WorkspaceActivationMap),
    releaseMap: vi.fn((candidate) => (candidate as unknown as FakeMap).remove()),
    getWebGL2Context: () => input.context === undefined ? map.context : input.context,
    updateMapContributions: vi.fn(),
    updateBackgroundPresentation: vi.fn(),
    retryBasemap: vi.fn(),
    setAttributionCompact: vi.fn(),
    reconcileLayerStack: input.reconcileLayerStack ?? vi.fn(),
    watchFailure: input.watchFailure ?? (() => input.unwatchFailure ?? (() => {})),
  }
  const readOrigin = input.readOrigin ?? (() => ({ lat: 0, lon: 0 }))
  const coordinator = new TestWorkspaceActivationCoordinator({
    container: document.createElement('div'), runtime, camera, composition,
    map: mapControls,
    readOrigin,
  })
  return { coordinator, camera, composition, runtime, map, mapControls, readOrigin }
}

describe('WorkspaceActivationCoordinator', () => {
  it.each([new Error('shared renderer failed'), new DOMException('renderer cancelled internally', 'AbortError')])('passes the original terminal renderer failure through map release: %s', async (error) => {
    const f = createCoordinator()
    await f.coordinator.activate(createActivationSnapshot())
    await expect(f.coordinator.reportFailure(error)).resolves.toBe('map-unavailable')
    expect(f.mapControls.releaseMap).toHaveBeenCalledExactlyOnceWith(f.map, error)
    await f.coordinator.teardown()
    expect(f.mapControls.releaseMap).toHaveBeenCalledOnce()
  })

  it('does not attach a stale pending failure to ordinary generation cancellation', async () => {
    const f = createCoordinator()
    await f.coordinator.activate(createActivationSnapshot())
    const failure = f.coordinator.reportFailure(new Error('stale failure'))
    await f.coordinator.requestGenerationDisconnect()
    await expect(failure).resolves.toBe('cancelled')
    expect(f.mapControls.releaseMap).toHaveBeenCalledExactlyOnceWith(f.map, undefined)
  })

  it('binds buffered contributions to the session and clears them synchronously before map removal', async () => {
    const f = createCoordinator()
    const activation = createActivationSnapshot()
    const contribution: WorkspaceMapContributionSnapshot = {
      sessionIdentity: activation.sessionIdentity, lidar: [],
      terrain: { contourIntervalMeters: 1, contoursVisible: false, contoursOpacity: 1, hillshadeVisible: false, hillshadeOpacity: 1, isDark: false },
      overlays: { runtime: { getSceneSnapshot: vi.fn() }, location: { lat: 0, lon: 0 }, hoveredTargets: [], selectedTargets: [] , site: null },
    }
    f.coordinator.updateMapContributions(contribution)
    expect(f.mapControls.updateMapContributions).not.toHaveBeenCalled()
    await f.coordinator.activate(activation)
    expect(f.mapControls.updateMapContributions).toHaveBeenLastCalledWith(contribution)
    vi.mocked(f.mapControls.updateMapContributions).mockClear()
    f.coordinator.updateMapContributions({ ...contribution, sessionIdentity: {} })
    expect(f.mapControls.updateMapContributions).not.toHaveBeenCalled()
    const disconnect = f.coordinator.requestGenerationDisconnect()
    expect(f.mapControls.updateMapContributions).toHaveBeenLastCalledWith(null)
    expect(f.map.remove).not.toHaveBeenCalled()
    await disconnect
    expect(f.map.remove).toHaveBeenCalledOnce()
  })

  it('a contribution snapshot of another session never reaches the map', async () => {
    const f = createCoordinator()
    const contribution = (sessionIdentity: object): WorkspaceMapContributionSnapshot => ({
      sessionIdentity, lidar: [],
      terrain: { contourIntervalMeters: 1, contoursVisible: true, contoursOpacity: 1, hillshadeVisible: true, hillshadeOpacity: 1, isDark: false },
      overlays: { runtime: { getSceneSnapshot: vi.fn() }, location: { lat: 0, lon: 0 }, hoveredTargets: [], selectedTargets: [] , site: null },
    })
    const first = createActivationSnapshot()
    const second = createActivationSnapshot()
    const forwarded = () => vi.mocked(f.mapControls.updateMapContributions).mock.calls
      .map(([snapshot]) => snapshot?.sessionIdentity ?? null)

    // Buffered before the map exists, from a session that is not the one that opens.
    f.coordinator.updateMapContributions(contribution(first.sessionIdentity))
    await f.coordinator.activate(second)
    // Live, from the session the map no longer shows.
    f.coordinator.updateMapContributions(contribution(first.sessionIdentity))
    // Its own session's snapshot does reach it.
    f.coordinator.updateMapContributions(contribution(second.sessionIdentity))
    // A late snapshot of the replaced session, after the Design changes again.
    await f.coordinator.activate(first)
    f.coordinator.updateMapContributions(contribution(second.sessionIdentity))

    expect(forwarded().filter((identity) => identity !== null)).toEqual([second.sessionIdentity])
  })

  it('destroys its constructed runtime once when torn down before activation', async () => {
    const runtime = createRuntime()
    const { coordinator } = createCoordinator({ runtime })

    await coordinator.teardown()
    await coordinator.teardown()

    expect(runtime.destroy).toHaveBeenCalledOnce()
    expect(runtime.init).not.toHaveBeenCalled()
  })

  it('hands the activation snapshot to map creation and attaches the runtime camera in the plane of the live origin', async () => {
    const created = deferred<WorkspaceActivationMap>()
    let capturedMapSnapshot: WorkspaceActivationSnapshot['map'] | null = null
    const createMap = vi.fn((
      _signal: AbortSignal,
      snapshot: WorkspaceActivationSnapshot['map'],
    ) => {
      capturedMapSnapshot = snapshot
      return created.promise
    })
    const composed = createComposition()
    const readOrigin = () => ({ lat: 10, lon: 20 })
    const { coordinator, camera, map } = createCoordinator({
      createMap,
      composition: composed.composition,
      readOrigin,
    })
    const attach = vi.spyOn(camera, 'attach')
    const snapshot: WorkspaceActivationSnapshot = createActivationSnapshot({
      initialCenter: { lat: 10, lon: 20 },
      background: background({ opacity: 0.3 }),
    })

    const activation = coordinator.activate(snapshot)
    await vi.waitFor(() => expect(createMap).toHaveBeenCalledOnce())
    expect(capturedMapSnapshot).toEqual(expect.objectContaining({
      initialCenter: { lat: 10, lon: 20 },
      background: background({ opacity: 0.3 }),
    }))

    created.resolve(map as unknown as WorkspaceActivationMap)

    await expect(activation).resolves.toBe('shared-ready')
    // The layer draws from the runtime's camera frames.
    expect(composed.composition.createLayer).toHaveBeenCalledWith(expect.objectContaining({ frames: camera.frames }))
    // The map's driver took the runtime's camera, in the plane of the live origin.
    expect(attach).toHaveBeenCalledOnce()
    expect(camera.current()).toBe(attach.mock.calls[0]![0])
    const attached = camera.frames.viewFrame.peek()
    expect(attached.attached).toBe(true)
    const originPx = attached.view.worldToScreen({ x: 0, y: 0 })
    const origin = map.unproject([originPx.x, originPx.y])
    expect(origin.lng).toBeCloseTo(20, 6)
    expect(origin.lat).toBeCloseTo(10, 6)
  })

  it('waits for connected shared-layer admission before initializing the runtime', async () => {
    const initialized = deferred<void>()
    const composed = createComposition({ initialize: () => initialized.promise })
    const { coordinator, runtime, map } = createCoordinator({ composition: composed.composition })

    const activation = coordinator.activate()
    await Promise.resolve()
    expect(runtime.init).not.toHaveBeenCalled()

    initialized.resolve()
    await expect(activation).resolves.toBe('shared-ready')
    expect(composed.composition.createLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: MAPLIBRE_SHARED_SCENE_LAYER_ID,
    }))
    expect(map.addLayer).toHaveBeenCalledOnce()
    expect(runtime.init).toHaveBeenCalledOnce()
  })

  it('forwards only current-generation background presentation without recreating workspace resources', async () => {
    const { coordinator, map, runtime, mapControls } = createCoordinator()
    const updateBackgroundPresentation = vi.fn()
    mapControls.updateBackgroundPresentation = updateBackgroundPresentation
    await expect(coordinator.activate()).resolves.toBe('shared-ready')
    const addLayerCount = map.addLayer.mock.calls.length

    coordinator.updateBackgroundPresentation(background(
      { visible: true, opacity: 0.5 },
      { visible: true, opacity: 0.25 },
    ))

    expect(updateBackgroundPresentation).toHaveBeenCalledWith(background(
      { visible: true, opacity: 0.5 },
      { visible: true, opacity: 0.25 },
    ))
    expect(map.addLayer).toHaveBeenCalledTimes(addLayerCount)
    expect(runtime.init).toHaveBeenCalledOnce()
    await coordinator.teardown()
    coordinator.updateBackgroundPresentation(background({ visible: false, opacity: 0 }))
    expect(updateBackgroundPresentation).toHaveBeenCalledOnce()
  })

  it('forwards a presentation posted immediately after initial activation once map acquisition starts', async () => {
    const created = deferred<WorkspaceActivationMap>()
    const createMap = vi.fn(() => created.promise)
    const { coordinator, map, mapControls } = createCoordinator({ createMap })
    const updateBackgroundPresentation = vi.fn()
    mapControls.updateBackgroundPresentation = updateBackgroundPresentation

    const activation = coordinator.activate()
    coordinator.updateBackgroundPresentation(background({ visible: false, opacity: 0.4 }))

    await vi.waitFor(() => expect(createMap).toHaveBeenCalledOnce())
    expect(updateBackgroundPresentation).toHaveBeenCalledOnce()
    expect(updateBackgroundPresentation).toHaveBeenCalledWith(background({ visible: false, opacity: 0.4 }))
    created.resolve(map as unknown as WorkspaceActivationMap)

    await expect(activation).resolves.toBe('shared-ready')
    await coordinator.teardown()
  })

  it('fences presentation updates synchronously when teardown is requested', async () => {
    const created = deferred<WorkspaceActivationMap>()
    const { coordinator, mapControls, map } = createCoordinator({ createMap: () => created.promise })
    const updateBackgroundPresentation = vi.fn()
    mapControls.updateBackgroundPresentation = updateBackgroundPresentation

    const activation = coordinator.activate()
    coordinator.updateBackgroundPresentation(background({ visible: false, opacity: 0.4 }))
    const teardown = coordinator.teardown()
    coordinator.updateBackgroundPresentation(background({ visible: false, opacity: 0.2 }))
    created.resolve(map as unknown as WorkspaceActivationMap)

    await expect(activation).resolves.toBe('cancelled')
    await expect(teardown).resolves.toBeUndefined()
    expect(updateBackgroundPresentation).not.toHaveBeenCalled()
  })

  it('settles a teardown after a failed activation without a re-entry error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { coordinator, runtime, map } = createCoordinator({ context: null })

    await expect(coordinator.activate()).resolves.toBe('map-unavailable')
    await expect(coordinator.teardown()).resolves.toBeUndefined()

    expect(map.remove).toHaveBeenCalledOnce()
    expect(runtime.destroy).toHaveBeenCalledOnce()
    expect(consoleError.mock.calls.map(([label]) => label)).toEqual(['Shared workspace map failed:'])
    consoleError.mockRestore()
  })

  it('drops a buffered presentation when synchronous disconnect cancels activation', async () => {
    const { coordinator, mapControls } = createCoordinator()
    const updateBackgroundPresentation = vi.fn()
    mapControls.updateBackgroundPresentation = updateBackgroundPresentation

    const activation = coordinator.activate()
    coordinator.updateBackgroundPresentation(background({ visible: false, opacity: 0.2 }))
    await coordinator.requestGenerationDisconnect()

    await expect(activation).resolves.toBe('cancelled')
    expect(updateBackgroundPresentation).not.toHaveBeenCalled()
  })

  it('fences presentation updates after the map becomes unavailable', async () => {
    const { coordinator, mapControls } = createCoordinator()
    const updateBackgroundPresentation = vi.fn()
    mapControls.updateBackgroundPresentation = updateBackgroundPresentation
    await expect(coordinator.activate()).resolves.toBe('shared-ready')

    await expect(coordinator.reportFailure(new Error('shared layer failed'))).resolves.toBe('map-unavailable')
    coordinator.updateBackgroundPresentation(background({ visible: false, opacity: 0.2 }))

    expect(updateBackgroundPresentation).not.toHaveBeenCalled()
    await coordinator.teardown()
  })

  it('buffers the latest presentation for a replacement while prior cleanup is pending', async () => {
    const firstDisposal = deferred<void>()
    const first = createComposition({ dispose: () => firstDisposal.promise })
    const second = createComposition()
    const composition: SharedMapSceneRendererComposition = {
      createLayer: vi.fn()
        .mockReturnValueOnce(first.layer)
        .mockReturnValue(second.layer),
    }
    const firstMap = new FakeMap()
    const secondMap = new FakeMap()
    const createMap = vi.fn()
      .mockResolvedValueOnce(firstMap as unknown as WorkspaceActivationMap)
      .mockResolvedValueOnce(secondMap as unknown as WorkspaceActivationMap)
    const { coordinator, mapControls } = createCoordinator({ createMap, composition })
    const updateBackgroundPresentation = vi.fn()
    mapControls.updateBackgroundPresentation = updateBackgroundPresentation
    await expect(coordinator.activate()).resolves.toBe('shared-ready')

    const replacement = coordinator.activate()
    coordinator.updateBackgroundPresentation(background({ visible: false, opacity: 0.3 }))
    coordinator.updateBackgroundPresentation(background({ visible: true, opacity: 0.7 }))
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce())

    expect(updateBackgroundPresentation).not.toHaveBeenCalled()
    expect(createMap).toHaveBeenCalledOnce()
    firstDisposal.resolve()

    await expect(replacement).resolves.toBe('shared-ready')
    expect(createMap).toHaveBeenCalledTimes(2)
    expect(updateBackgroundPresentation).toHaveBeenCalledOnce()
    expect(updateBackgroundPresentation).toHaveBeenCalledWith(background({ visible: true, opacity: 0.7 }))

    await coordinator.teardown()
  })

  it('adds the initialized shared scene layer once, then reconciles the layer stack', async () => {
    const composed = createComposition()
    const { coordinator, map, mapControls } = createCoordinator({ composition: composed.composition })

    await expect(coordinator.activate()).resolves.toBe('shared-ready')

    expect(map.addLayer).toHaveBeenCalledExactlyOnceWith(composed.layer.layer)
    expect(composed.layer.diagnostics.phase).toBe('attached')
    const reconcile = vi.mocked(mapControls.reconcileLayerStack)
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(map)
    expect(map.addLayer.mock.invocationCallOrder[0]).toBeLessThan(reconcile.mock.invocationCallOrder[0]!)
  })

  it('replaces A with B from B snapshot after ordered A cleanup while retaining one runtime', async () => {
    const events: string[] = []
    const firstMap = new FakeMap()
    const secondMap = new FakeMap()
    firstMap.off.mockImplementation(() => {
      events.push('camera-detach')
      return undefined
    })
    firstMap.remove.mockImplementation(() => { events.push('map-release') })
    const first = createComposition({ dispose: async () => { events.push('layer-dispose') } })
    const second = createComposition()
    const composition: SharedMapSceneRendererComposition = {
      createLayer: vi.fn()
        .mockReturnValueOnce(first.layer)
        .mockReturnValueOnce(second.layer),
    }
    const snapshots: WorkspaceActivationSnapshot['map'][] = []
    const createMap = vi.fn(async (
      _signal: AbortSignal,
      snapshot: WorkspaceActivationSnapshot['map'],
    ) => {
      snapshots.push(snapshot)
      return snapshots.length === 1
        ? firstMap as unknown as WorkspaceActivationMap
        : secondMap as unknown as WorkspaceActivationMap
    })
    const unwatchFailure = vi.fn(() => { events.push('failure-watcher') })
    const { coordinator, camera, runtime } = createCoordinator({
      createMap,
      composition,
      watchFailure: () => unwatchFailure,
    })
    const attach = vi.spyOn(camera, 'attach')
    const snapshotA = createActivationSnapshot({
      initialCenter: { lat: 1, lon: 2 },
      background: background({ opacity: 0.2 }),
    })
    const snapshotB: WorkspaceActivationSnapshot = createActivationSnapshot({
      initialCenter: { lat: 40, lon: -70 },
      background: background({ opacity: 0.8 }),
    })

    await expect(coordinator.activate(snapshotA)).resolves.toBe('shared-ready')
    await expect(coordinator.activate(snapshotB)).resolves.toBe('shared-ready')

    expect(snapshots).toEqual([snapshotA.map, snapshotB.map])
    expect(composition.createLayer).toHaveBeenLastCalledWith(expect.objectContaining({ frames: camera.frames }))
    // B's map drives the camera now; A's driver released A's map.
    expect(attach).toHaveBeenCalledTimes(2)
    expect(camera.current()).toBe(attach.mock.calls[1]![0])
    expect(camera.frames.viewFrame.peek().attached).toBe(true)
    expect(secondMap.jumpTo).toHaveBeenCalled()
    expect(events).toEqual([
      'failure-watcher',
      'camera-detach',
      'camera-detach',
      'layer-dispose',
      'map-release',
    ])
    expect(runtime.init).toHaveBeenCalledOnce()
    expect(runtime.destroy).not.toHaveBeenCalled()

    await coordinator.teardown()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('replaces equal map values when session identity changes', async () => {
    const maps = [new FakeMap(), new FakeMap()]
    const first = createComposition()
    const second = createComposition()
    const composition: SharedMapSceneRendererComposition = {
      createLayer: vi.fn()
        .mockReturnValueOnce(first.layer)
        .mockReturnValueOnce(second.layer),
    }
    const createMap = vi.fn(async () => maps[createMap.mock.calls.length - 1] as unknown as WorkspaceActivationMap)
    const { coordinator, runtime } = createCoordinator({ createMap, composition })
    const mapSnapshot = createActivationSnapshot().map

    await coordinator.activate({ sessionIdentity: {}, map: mapSnapshot })
    await coordinator.activate({ sessionIdentity: {}, map: mapSnapshot })

    expect(createMap).toHaveBeenCalledTimes(2)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(maps[0]!.remove).toHaveBeenCalledOnce()
    expect(runtime.init).toHaveBeenCalledOnce()
  })

  it('fences stale failure callbacks from a replaced generation', async () => {
    const reports: Array<(error: unknown) => void> = []
    const maps = [new FakeMap(), new FakeMap()]
    const first = createComposition()
    const second = createComposition()
    const composition: SharedMapSceneRendererComposition = {
      createLayer: vi.fn()
        .mockReturnValueOnce(first.layer)
        .mockReturnValueOnce(second.layer),
    }
    const createMap = vi.fn(async () => maps[createMap.mock.calls.length - 1] as unknown as WorkspaceActivationMap)
    const { coordinator, runtime } = createCoordinator({
      createMap,
      composition,
      watchFailure: (_map, report) => {
        reports.push(report)
        return () => {}
      },
    })

    await coordinator.activate(createActivationSnapshot())
    await coordinator.activate(createActivationSnapshot())
    reports[0]!(new Error('stale A failure'))
    await Promise.resolve()

    expect(runtime.unmountRenderer).not.toHaveBeenCalled()
    expect(maps[1]!.remove).not.toHaveBeenCalled()
  })

  it('waits for a pending runtime initialization before unmounting its renderer', async () => {
    const initialized = deferred<void>()
    const runtime = createRuntime()
    runtime.init = vi.fn(() => initialized.promise)
    const { coordinator, map } = createCoordinator({ runtime })
    const activation = coordinator.activate()
    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledOnce())

    const failure = coordinator.reportFailure(new Error('map context lost during initialization'))
    await Promise.resolve()
    expect(runtime.unmountRenderer).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(map.remove).toHaveBeenCalledOnce())

    initialized.resolve()
    await expect(failure).resolves.toBe('map-unavailable')
    await expect(activation).resolves.toBe('map-unavailable')
    expect(runtime.unmountRenderer).toHaveBeenCalledOnce()
  })

  it('installs failure and cleanup fences before a watcher can report synchronously', async () => {
    const unwatchFailure = vi.fn()
    const watchFailure = vi.fn((_map, reportFailure) => {
      reportFailure(new Error('map failed during watcher installation'))
      return () => {
        unwatchFailure()
        reportFailure(new Error('map failed again during watcher cleanup'))
      }
    })
    const composed = createComposition()
    const { coordinator, runtime, map } = createCoordinator({
      composition: composed.composition,
      watchFailure,
    })

    await expect(coordinator.activate()).resolves.toBe('map-unavailable')

    expect(watchFailure).toHaveBeenCalledOnce()
    expect(unwatchFailure).toHaveBeenCalledOnce()
    expect(composed.dispose).not.toHaveBeenCalled()
    expect(map.remove).toHaveBeenCalledOnce()
    expect(runtime.init).not.toHaveBeenCalled()
  })

  it('propagates a concurrent runtime initialization rejection instead of masking it as map-unavailable', async () => {
    const initialized = deferred<void>()
    const runtime = createRuntime()
    runtime.init = vi.fn(() => initialized.promise)
    const failure = new Error('runtime initialization rejected')
    const { coordinator, map } = createCoordinator({ runtime })
    const activation = coordinator.activate()
    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledOnce())
    const reportedFailure = coordinator.reportFailure(new Error('map context lost during initialization'))

    initialized.reject(failure)

    await expect(reportedFailure).rejects.toBe(failure)
    await expect(activation).rejects.toBe(failure)
    expect(runtime.unmountRenderer).not.toHaveBeenCalled()
    expect(map.remove).toHaveBeenCalledOnce()
  })

  it('removes the failed map and mounts no renderer before resolving', async () => {
    const map = new FakeMap()
    map.addLayer.mockImplementation(() => { throw new Error('add layer failed') })
    const composed = createComposition()
    const { coordinator, runtime } = createCoordinator({ map, composition: composed.composition })

    await expect(coordinator.activate()).resolves.toBe('map-unavailable')

    expect(composed.dispose).toHaveBeenCalledOnce()
    expect(map.remove).toHaveBeenCalledOnce()
    expect(runtime.init).not.toHaveBeenCalled()
  })

  it.each([
    ['WebGL2 is unavailable', () => ({ context: null })],
    ['shared layer initialization rejects', () => ({
      composition: createComposition({ initialize: async () => { throw new Error('Pixi init failed') } }).composition,
    })],
    ['camera attachment is rejected', () => {
      // A pitched read-back fails the map's camera driver ('map-error'); it never takes the camera.
      const map = new FakeMap()
      vi.spyOn(map, 'getPitch').mockReturnValue(1)
      return { map }
    }],
  ])('reports the map unavailable without mounting a renderer when %s', async (reason, setup) => {
    const configured = setup()
    const { coordinator, runtime, map, camera } = createCoordinator(configured)

    await expect(coordinator.activate()).resolves.toBe('map-unavailable')

    expect(map.remove).toHaveBeenCalledOnce()
    expect(runtime.init).not.toHaveBeenCalled()
    expect(runtime.unmountRenderer).not.toHaveBeenCalled()
    if (reason === 'camera attachment is rejected') {
      expect(camera.failure.peek()).toMatchObject({ reason: 'map-error' })
      expect(camera.frames.viewFrame.peek().attached).toBe(false)
    }
  })

  it('reports the map unavailable when map acquisition rejects before a map is admitted', async () => {
    const failure = new Error('MapLibre loader failed')
    const { coordinator, runtime } = createCoordinator({
      createMap: async () => { throw failure },
    })

    await expect(coordinator.activate()).resolves.toBe('map-unavailable')
    expect(runtime.init).not.toHaveBeenCalled()
  })

  it('logs a lost map\'s cause once, with the tile key redacted', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { coordinator } = createCoordinator()
      await expect(coordinator.activate()).resolves.toBe('shared-ready')
      const failure = new Error('AJAXError: Forbidden (403): https://example.test/style.json?key=AIzaLeakedCoreKey')

      const outcome = coordinator.reportFailure(failure)
      void coordinator.reportFailure(new Error('a second report of the same loss'))
      await expect(outcome).resolves.toBe('map-unavailable')

      expect(consoleError).toHaveBeenCalledExactlyOnceWith('Shared workspace map failed:', expect.any(Error))
      const logged = String((consoleError.mock.calls[0]?.[1] as Error).message)
      expect(logged).toContain('key=<redacted>')
      expect(logged).not.toContain('AIzaLeakedCoreKey')
      await coordinator.teardown()
    } finally {
      consoleError.mockRestore()
    }
  })

  it.each([
    ['map acquisition rejects before admission', () => ({ createMap: async () => { throw new Error('context lost before the style loaded') } }), 'context lost before the style loaded'],
    ['WebGL2 is missing', () => ({ createMap: async () => { throw new WorkspaceWebGL2UnavailableError() } }), 'WebGL2 is unavailable'],
    ['the shared layer fails to initialize', () => ({
      composition: createComposition({ initialize: async () => { throw new Error('Pixi init failed') } }).composition,
    }), 'Pixi init failed'],
  ])('logs the cause when %s', async (_reason, setup, message) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { coordinator } = createCoordinator(setup())

      await expect(coordinator.activate()).resolves.toBe('map-unavailable')

      expect(consoleError).toHaveBeenCalledExactlyOnceWith(
        'Shared workspace map failed:',
        expect.objectContaining({ message: expect.stringContaining(message) }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  it('unmounts once when replacement admission fails and never restarts on its own', async () => {
    const map = new FakeMap()
    const replacementFailure = new Error('replacement map failed')
    const createMap = vi.fn()
      .mockResolvedValueOnce(map as unknown as WorkspaceActivationMap)
      .mockRejectedValueOnce(replacementFailure)
    const { coordinator, runtime } = createCoordinator({ createMap })

    await expect(coordinator.activate(createActivationSnapshot())).resolves.toBe('shared-ready')
    await expect(coordinator.activate(createActivationSnapshot())).resolves.toBe('map-unavailable')
    await expect(coordinator.activate(createActivationSnapshot())).resolves.toBe('map-unavailable')

    expect(createMap).toHaveBeenCalledTimes(2)
    expect(runtime.init).toHaveBeenCalledOnce()
    expect(runtime.unmountRenderer).toHaveBeenCalledOnce()
    expect(runtime.destroy).not.toHaveBeenCalled()
  })

  it('rebuilds the map on Retry after a failure and remounts the renderer, any number of times', async () => {
    const maps = [new FakeMap(), new FakeMap(), new FakeMap()]
    const createMap = vi.fn(async () => maps[createMap.mock.calls.length - 1] as unknown as WorkspaceActivationMap)
    const { coordinator, runtime, camera } = createCoordinator({ createMap })
    await expect(coordinator.activate()).resolves.toBe('shared-ready')

    for (const round of [1, 2]) {
      await expect(coordinator.reportFailure(new Error('context lost'))).resolves.toBe('map-unavailable')
      expect(maps[round - 1]!.remove).toHaveBeenCalledOnce()
      expect(coordinator.retry()).toBe(true)
      await expect(coordinator.activate()).resolves.toBe('shared-ready')
      expect(runtime.remountRenderer).toHaveBeenCalledTimes(round)
      expect(camera.frames.viewFrame.peek().attached).toBe(true)
    }
    expect(createMap).toHaveBeenCalledTimes(3)
    expect(runtime.init).toHaveBeenCalledOnce()
    expect(runtime.unmountRenderer).toHaveBeenCalledTimes(2)
    expect(runtime.destroy).not.toHaveBeenCalled()
    await coordinator.teardown()
  })

  it('rebuilds the map on Retry after the failure handling itself failed', async () => {
    const maps = [new FakeMap(), new FakeMap()]
    const createMap = vi.fn(async () => maps[createMap.mock.calls.length - 1] as unknown as WorkspaceActivationMap)
    const runtime = createRuntime()
    runtime.unmountRenderer.mockRejectedValueOnce(new Error('unmount boom'))
    const { coordinator } = createCoordinator({ createMap, runtime })
    await expect(coordinator.activate()).resolves.toBe('shared-ready')
    await expect(coordinator.reportFailure(new Error('context lost'))).rejects.toThrow('unmount boom')

    expect(coordinator.retry()).toBe(true)
    await expect(coordinator.activate()).resolves.toBe('shared-ready')
    expect(createMap).toHaveBeenCalledTimes(2)
    expect(runtime.remountRenderer).toHaveBeenCalledOnce()
    await coordinator.teardown()
  })

  it('initializes the runtime on Retry when the first map failed before admission', async () => {
    const map = new FakeMap()
    const createMap = vi.fn()
      .mockRejectedValueOnce(new Error('MapLibre loader failed'))
      .mockResolvedValueOnce(map as unknown as WorkspaceActivationMap)
    const { coordinator, runtime } = createCoordinator({ createMap })
    await expect(coordinator.activate()).resolves.toBe('map-unavailable')

    expect(coordinator.retry()).toBe(true)
    await expect(coordinator.activate()).resolves.toBe('shared-ready')

    expect(runtime.init).toHaveBeenCalledOnce()
    expect(runtime.remountRenderer).not.toHaveBeenCalled()
    await coordinator.teardown()
  })

  it('refuses Retry while the map is up and while its failure is still being handled', async () => {
    const { coordinator } = createCoordinator()
    expect(coordinator.retry()).toBe(false)
    await expect(coordinator.activate()).resolves.toBe('shared-ready')
    expect(coordinator.retry()).toBe(false)

    const failure = coordinator.reportFailure(new Error('context lost'))
    expect(coordinator.retry()).toBe(false)
    await expect(failure).resolves.toBe('map-unavailable')

    expect(coordinator.canRetry()).toBe(true)
    expect(coordinator.retry()).toBe(true)
    await coordinator.teardown()
    expect(coordinator.canRetry()).toBe(false)
  })

  it('refuses Retry when WebGL2 is missing', async () => {
    const createMap = vi.fn(async () => { throw new WorkspaceWebGL2UnavailableError() })
    const { coordinator } = createCoordinator({ createMap })
    await expect(coordinator.activate()).resolves.toBe('map-unavailable')

    expect(coordinator.canRetry()).toBe(false)
    expect(coordinator.retry()).toBe(false)
    await expect(coordinator.activate()).resolves.toBe('map-unavailable')
    expect(createMap).toHaveBeenCalledOnce()
  })

  it('refuses Retry once a failed renderer initialization destroyed the runtime', async () => {
    const runtime = createRuntime()
    runtime.init = vi.fn(async () => { throw new Error('runtime init failed') })
    const createMap = vi.fn(async () => new FakeMap() as unknown as WorkspaceActivationMap)
    const { coordinator } = createCoordinator({ runtime, createMap })
    await expect(coordinator.activate()).rejects.toThrow('runtime init failed')

    expect(coordinator.canRetry()).toBe(false)
    expect(coordinator.retry()).toBe(false)
    expect(createMap).toHaveBeenCalledOnce()
  })

  it('hands the rebuilt map the contributions published while the map was unavailable', async () => {
    const f = createCoordinator({ createMap: async () => new FakeMap() as unknown as WorkspaceActivationMap })
    const activation = createActivationSnapshot()
    await expect(f.coordinator.activate(activation)).resolves.toBe('shared-ready')
    await expect(f.coordinator.reportFailure(new Error('context lost'))).resolves.toBe('map-unavailable')
    const contribution: WorkspaceMapContributionSnapshot = {
      sessionIdentity: activation.sessionIdentity, lidar: [],
      terrain: { contourIntervalMeters: 1, contoursVisible: false, contoursOpacity: 1, hillshadeVisible: false, hillshadeOpacity: 1, isDark: false },
      overlays: { runtime: { getSceneSnapshot: vi.fn() }, location: { lat: 7, lon: 7 }, hoveredTargets: [], selectedTargets: [] , site: null },
    }
    f.coordinator.updateMapContributions(contribution)
    expect(f.mapControls.updateMapContributions).not.toHaveBeenLastCalledWith(contribution)

    expect(f.coordinator.retry()).toBe(true)
    await expect(f.coordinator.activate(activation)).resolves.toBe('shared-ready')

    expect(f.mapControls.updateMapContributions).toHaveBeenLastCalledWith(contribution)
    await f.coordinator.teardown()
  })

  it('unmounts the renderer on map failure and retains the spatial camera frame', async () => {
    const { coordinator, runtime, camera, map } = createCoordinator()
    await expect(coordinator.activate()).resolves.toBe('shared-ready')
    const attachedFrame = camera.frames.viewFrame.peek()

    await expect(coordinator.reportFailure(new Error('context lost'))).resolves.toBe('map-unavailable')

    expect(runtime.unmountRenderer).toHaveBeenCalledOnce()
    const retained = camera.frames.viewFrame.peek()
    expect(retained.attached).toBe(false)
    expect(retained.mode).toBe(attachedFrame.mode)
    expect(retained.view.screen).toEqual(attachedFrame.view.screen)
    expect(retained.scaleBounds).toStrictEqual(attachedFrame.scaleBounds)
    const kept = planarCameraOf(retained.view)
    const attachedPlacement = planarCameraOf(attachedFrame.view)
    expect(kept.x).toBeCloseTo(attachedPlacement.x, 6)
    expect(kept.y).toBeCloseTo(attachedPlacement.y, 6)
    expect(kept.scale).toBeCloseTo(attachedPlacement.scale, 6)
    expect(map.off).toHaveBeenCalledTimes(2)
    expect(map.remove).toHaveBeenCalledOnce()
  })

  it('observes a later camera projection failure and unmounts the renderer', async () => {
    const { coordinator, runtime, map, camera } = createCoordinator()
    await expect(coordinator.activate()).resolves.toBe('shared-ready')

    // A pitched read-back fails the driver: the host takes the camera back and reports it.
    map.pitch = 1
    map.emit('move')
    expect(camera.failure.peek()).toMatchObject({ reason: 'map-error' })
    expect(camera.frames.viewFrame.peek().attached).toBe(false)

    await vi.waitFor(() => expect(runtime.unmountRenderer).toHaveBeenCalledOnce())
    expect(runtime.unmountRenderer).toHaveBeenCalledOnce()
    expect(map.remove).toHaveBeenCalledOnce()
  })

  it('synchronously fences an active generation while deferring map release until layer disposal settles', async () => {
    const layerDisposal = deferred<void>()
    const events: string[] = []
    const map = new FakeMap()
    map.off.mockImplementation(() => {
      events.push('camera-detach')
      return undefined
    })
    map.remove.mockImplementation(() => { events.push('map-release') })
    const composed = createComposition({ dispose: () => {
      events.push('layer-dispose')
      return layerDisposal.promise
    } })
    let reportFailure: ((error: unknown) => void) | null = null
    const { coordinator, runtime } = createCoordinator({
      map,
      composition: composed.composition,
      watchFailure: vi.fn((_map, callback) => {
        reportFailure = callback
        return () => { events.push('failure-watcher-disposed') }
      }),
    })
    await coordinator.activate()

    const disconnected = coordinator.requestGenerationDisconnect()

    expect(map.off).toHaveBeenCalledTimes(2)
    expect(composed.dispose).toHaveBeenCalledOnce()
    expect(events).toContain('camera-detach')
    expect(events).toContain('layer-dispose')
    expect(events).not.toContain('map-release')
    expect(runtime.destroy).not.toHaveBeenCalled()
    expect(runtime.unmountRenderer).not.toHaveBeenCalled()
    reportFailure!(new Error('stale callback'))
    expect(map.addLayer).toHaveBeenCalledOnce()
    expect(runtime.unmountRenderer).not.toHaveBeenCalled()

    layerDisposal.resolve()
    await expect(disconnected).resolves.toBeUndefined()
    expect(events).toEqual(expect.arrayContaining(['layer-dispose', 'map-release']))
    expect(events.indexOf('layer-dispose')).toBeLessThan(events.indexOf('map-release'))
  })

  it.each([
    'layer creation',
    'failure watcher installation',
    'layer stack reconciliation',
    'camera failure subscription',
    'camera attachment',
    'shared layer attachment',
  ] as const)('rolls back a generation when replacement reenters from %s', async (boundary) => {
    const layer = createComposition({
      onAdd: boundary === 'shared layer attachment'
        ? () => { coordinator.requestGenerationDisconnect() }
        : undefined,
    })
    const watcherDisposer = vi.fn()
    const subscriptionDisposer = vi.fn()
    const composition: SharedMapSceneRendererComposition = boundary === 'layer creation'
      ? {
        ...layer.composition,
        createLayer: vi.fn(() => {
          coordinator.requestGenerationDisconnect()
          return layer.layer
        }),
      }
      : layer.composition
    const { camera, map, runtime, coordinator } = createCoordinator({
      composition,
      watchFailure: boundary === 'failure watcher installation'
        ? vi.fn(() => {
          coordinator.requestGenerationDisconnect()
          return watcherDisposer
        })
        : undefined,
      reconcileLayerStack: boundary === 'layer stack reconciliation'
        ? vi.fn(() => { coordinator.requestGenerationDisconnect() })
        : undefined,
    })
    const subscribeFailure = vi.spyOn(camera.failure, 'subscribe')
    if (boundary === 'camera failure subscription') {
      subscribeFailure.mockImplementation(() => {
        coordinator.requestGenerationDisconnect()
        return subscriptionDisposer
      })
    }
    const detach = vi.spyOn(camera, 'detach')
    if (boundary === 'camera attachment') {
      vi.spyOn(camera, 'attach').mockImplementation(() => {
        coordinator.requestGenerationDisconnect()
      })
    }

    await expect(coordinator.activate()).resolves.toBe('cancelled')
    await vi.waitFor(() => expect(map.remove).toHaveBeenCalledOnce())

    if (boundary === 'failure watcher installation') {
      expect(layer.dispose).not.toHaveBeenCalled()
    } else {
      expect(layer.dispose).toHaveBeenCalledOnce()
    }
    expect(runtime.init).not.toHaveBeenCalled()
    if (boundary === 'failure watcher installation') expect(watcherDisposer).toHaveBeenCalledOnce()
    if (boundary === 'camera failure subscription') expect(subscriptionDisposer).toHaveBeenCalledOnce()
    if (boundary === 'camera attachment') expect(detach).toHaveBeenCalledOnce()
    if (boundary === 'shared layer attachment') expect(subscribeFailure).not.toHaveBeenCalled()
  })

  it('waits for a requested disconnect before creating a successor map', async () => {
    const layerDisposal = deferred<void>()
    const first = createComposition({ dispose: () => layerDisposal.promise })
    const successor = createComposition()
    const composition: SharedMapSceneRendererComposition = {
      createLayer: vi.fn().mockReturnValueOnce(first.layer).mockReturnValueOnce(successor.layer),
    }
    const maps = [new FakeMap(), new FakeMap()]
    const createMap = vi.fn(async () => maps[createMap.mock.calls.length - 1] as unknown as WorkspaceActivationMap)
    const { coordinator } = createCoordinator({ createMap, composition })
    await coordinator.activate(createActivationSnapshot({ background: background({ opacity: 0.1 }) }))

    coordinator.requestGenerationDisconnect()
    const activation = coordinator.activate(createActivationSnapshot({ background: background({ opacity: 0.2 }) }))
    await Promise.resolve()

    expect(createMap).toHaveBeenCalledOnce()
    layerDisposal.resolve()
    await expect(activation).resolves.toBe('shared-ready')
    expect(createMap).toHaveBeenCalledTimes(2)
  })

  it('blocks one successor after a requested disconnect rejects, then permits recovery', async () => {
    const firstMap = new FakeMap()
    const recoveredMap = new FakeMap()
    const cleanupFailure = new Error('map release failed')
    firstMap.remove.mockImplementation(() => { throw cleanupFailure })
    const maps = [firstMap, recoveredMap]
    const createMap = vi.fn(async () => maps[createMap.mock.calls.length - 1] as unknown as WorkspaceActivationMap)
    const { coordinator } = createCoordinator({ createMap })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await coordinator.activate()

    await expect(coordinator.requestGenerationDisconnect()).rejects.toBe(cleanupFailure)
    await expect(coordinator.activate()).rejects.toBe(cleanupFailure)
    expect(createMap).toHaveBeenCalledOnce()

    await expect(coordinator.activate()).resolves.toBe('shared-ready')
    expect(createMap).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })

  it('shares one requested disconnect and does not dispose the generation twice', async () => {
    const layerDisposal = deferred<void>()
    const composed = createComposition({ dispose: () => layerDisposal.promise })
    const { coordinator, map } = createCoordinator({ composition: composed.composition })
    await coordinator.activate()

    const first = coordinator.requestGenerationDisconnect()
    const repeated = coordinator.requestGenerationDisconnect()

    expect(repeated).toBe(first)
    expect(composed.dispose).toHaveBeenCalledOnce()
    layerDisposal.resolve()
    await expect(first).resolves.toBeUndefined()
    expect(map.remove).toHaveBeenCalledOnce()
  })

  it('joins a requested disconnect during terminal teardown and destroys the runtime once', async () => {
    const layerDisposal = deferred<void>()
    const composed = createComposition({ dispose: () => layerDisposal.promise })
    const { coordinator, runtime, map } = createCoordinator({ composition: composed.composition })
    await coordinator.activate()

    coordinator.requestGenerationDisconnect()
    const teardown = coordinator.teardown()
    await Promise.resolve()
    expect(runtime.destroy).not.toHaveBeenCalled()

    layerDisposal.resolve()
    await expect(teardown).resolves.toBeUndefined()
    expect(map.remove).toHaveBeenCalledOnce()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('joins an already-started renderer unmount before disconnect and terminal teardown settle', async () => {
    const rendererUnmount = deferred<void>()
    const runtime = createRuntime()
    runtime.unmountRenderer = vi.fn(() => rendererUnmount.promise)
    const { coordinator } = createCoordinator({ runtime })
    await coordinator.activate()

    const failure = coordinator.reportFailure(new Error('context lost'))
    await vi.waitFor(() => expect(runtime.unmountRenderer).toHaveBeenCalledOnce())
    const disconnected = coordinator.requestGenerationDisconnect()
    const teardown = coordinator.teardown()
    await Promise.resolve()

    expect(runtime.destroy).not.toHaveBeenCalled()
    rendererUnmount.resolve()

    await expect(failure).resolves.toBe('cancelled')
    await expect(disconnected).resolves.toBeUndefined()
    await expect(teardown).resolves.toBeUndefined()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('keeps a void-disposer teardown pending until requested disconnect cleanup completes', async () => {
    let nestedTeardown!: Promise<void>
    let nestedSettled = false
    const layerDisposal = deferred<void>()
    const unwatchFailure = vi.fn(() => {
      nestedTeardown = coordinator.teardown()
      void nestedTeardown.then(
        () => { nestedSettled = true },
        () => { nestedSettled = true },
      )
    })
    const composed = createComposition({ dispose: () => layerDisposal.promise })
    const { coordinator, runtime } = createCoordinator({
      composition: composed.composition,
      unwatchFailure,
    })
    await coordinator.activate()

    const disconnected = coordinator.requestGenerationDisconnect()
    expect(coordinator.teardown()).toBe(nestedTeardown)
    await Promise.resolve()

    expect(nestedSettled).toBe(false)
    expect(runtime.destroy).not.toHaveBeenCalled()

    layerDisposal.resolve()
    await expect(disconnected).resolves.toBeUndefined()
    await expect(nestedTeardown).resolves.toBeUndefined()
    expect(runtime.destroy).toHaveBeenCalledOnce()
    expect(unwatchFailure).toHaveBeenCalledOnce()
  })

  it('propagates requested-disconnect cleanup failure to a void-disposer teardown caller', async () => {
    let nestedTeardown!: Promise<void>
    const cleanupFailure = new Error('map release failed after teardown request')
    const map = new FakeMap()
    map.remove.mockImplementation(() => { throw cleanupFailure })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { coordinator, runtime } = createCoordinator({
      map,
      unwatchFailure: () => {
        nestedTeardown = coordinator.teardown()
      },
    })
    await coordinator.activate()

    const disconnected = coordinator.requestGenerationDisconnect()

    await expect(disconnected).rejects.toBe(cleanupFailure)
    await expect(nestedTeardown).rejects.toBe(cleanupFailure)
    expect(runtime.destroy).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('logs a rejected reconciler disposal once when a coordinator callback initiates it', async () => {
    const cleanupFailure = new Error('reentrant reconciler teardown failed')
    const map = new FakeMap()
    map.remove.mockImplementation(() => { throw cleanupFailure })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { coordinator } = createCoordinator({
      map,
      unwatchFailure: () => {
        void reconciler.dispose()
      },
    })
    const reconciler: WorkspaceGenerationReconciler = new WorkspaceGenerationReconciler({
      workspace: coordinator,
      readSnapshot: () => null,
    })
    await coordinator.activate(createActivationSnapshot())

    const teardown = coordinator.teardown()

    await expect(teardown).rejects.toBe(cleanupFailure)
    expect(reconciler.dispose()).toBe(teardown)
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1))
    expect(consoleError).toHaveBeenCalledWith('Shared workspace teardown failed:', cleanupFailure)
    consoleError.mockRestore()
  })

  it('fences a stale asynchronous map creation after cancellation and tears down once', async () => {
    const created = deferred<WorkspaceActivationMap>()
    const captured = { signal: null as AbortSignal | null }
    const { coordinator, runtime, mapControls } = createCoordinator({
      createMap: (nextSignal) => {
        captured.signal = nextSignal
        return created.promise
      },
    })
    const activation = coordinator.activate()

    await vi.waitFor(() => expect(captured.signal).not.toBeNull())
    await coordinator.teardown()
    expect(captured.signal?.aborted).toBe(true)
    const staleMap = new FakeMap()
    created.resolve(staleMap as unknown as WorkspaceActivationMap)

    await expect(activation).resolves.toBe('cancelled')
    await coordinator.teardown()
    expect(staleMap.remove).toHaveBeenCalledOnce()
    expect(mapControls.releaseMap).toHaveBeenCalledWith(staleMap)
    expect(runtime.init).not.toHaveBeenCalled()
  })

  it('keeps the newest activation when an older replacement is still cleaning up', async () => {
    const firstDisposal = deferred<void>()
    const first = createComposition({ dispose: () => firstDisposal.promise })
    const newest = createComposition()
    const composition: SharedMapSceneRendererComposition = {
      createLayer: vi.fn()
        .mockReturnValueOnce(first.layer)
        .mockReturnValue(newest.layer),
    }
    const firstMap = new FakeMap()
    const newestMap = new FakeMap()
    const maps = [firstMap, newestMap]
    const signals: AbortSignal[] = []
    const snapshots: WorkspaceActivationSnapshot['map'][] = []
    const createMap = vi.fn(async (
      signal: AbortSignal,
      snapshot: WorkspaceActivationSnapshot['map'],
    ) => {
      signals.push(signal)
      snapshots.push(snapshot)
      return maps[signals.length - 1] as unknown as WorkspaceActivationMap
    })
    const { coordinator, mapControls } = createCoordinator({ createMap, composition })
    const snapshotA = createActivationSnapshot({ background: background({ opacity: 0.1 }) })
    const snapshotB = createActivationSnapshot({ background: background({ opacity: 0.2 }) })
    const snapshotC = createActivationSnapshot({ background: background({ opacity: 0.3 }) })
    await expect(coordinator.activate(snapshotA)).resolves.toBe('shared-ready')

    const superseded = coordinator.activate(snapshotB)
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce())
    const latest = coordinator.activate(snapshotC)

    await Promise.resolve()
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(firstMap.remove).not.toHaveBeenCalled()
    expect(newestMap.remove).not.toHaveBeenCalled()

    firstDisposal.resolve()
    await expect(superseded).resolves.toBe('cancelled')
    await expect(latest).resolves.toBe('shared-ready')
    expect(signals).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(false)
    expect(snapshots).toEqual([snapshotA.map, snapshotC.map])
    expect(firstMap.remove).toHaveBeenCalledOnce()
    expect(mapControls.releaseMap).toHaveBeenCalledWith(firstMap, undefined)

    await coordinator.teardown()
    expect(newest.dispose).toHaveBeenCalledOnce()
    expect(newestMap.remove).toHaveBeenCalledOnce()
  })

  it('lets public teardown cancel a replacement waiting on prior cleanup', async () => {
    const firstDisposal = deferred<void>()
    const composed = createComposition({ dispose: () => firstDisposal.promise })
    const map = new FakeMap()
    const signals: AbortSignal[] = []
    const createMap = vi.fn(async (signal: AbortSignal) => {
      signals.push(signal)
      return map as unknown as WorkspaceActivationMap
    })
    const { coordinator, runtime } = createCoordinator({
      createMap,
      composition: composed.composition,
    })
    await expect(coordinator.activate()).resolves.toBe('shared-ready')

    const replacement = coordinator.activate()
    await vi.waitFor(() => expect(composed.dispose).toHaveBeenCalledOnce())
    const teardown = coordinator.teardown()

    await Promise.resolve()
    expect(createMap).toHaveBeenCalledOnce()
    expect(map.remove).not.toHaveBeenCalled()

    firstDisposal.resolve()
    await expect(replacement).resolves.toBe('cancelled')
    await expect(teardown).resolves.toBeUndefined()
    expect(map.remove).toHaveBeenCalledOnce()
    expect(runtime.init).toHaveBeenCalledOnce()
    expect(runtime.destroy).toHaveBeenCalledOnce()
    expect(signals[0]?.aborted).toBe(true)
  })

  it('waits for initialization before final teardown destroys the runtime once', async () => {
    const initialized = deferred<void>()
    const runtime = createRuntime()
    runtime.init = vi.fn(() => initialized.promise)
    const { coordinator, map } = createCoordinator({ runtime })
    const activation = coordinator.activate(createActivationSnapshot())
    await vi.waitFor(() => expect(runtime.init).toHaveBeenCalledOnce())

    const teardown = coordinator.teardown()
    await vi.waitFor(() => expect(map.remove).toHaveBeenCalledOnce())
    expect(runtime.destroy).not.toHaveBeenCalled()

    initialized.resolve()
    await expect(activation).resolves.toBe('cancelled')
    await expect(teardown).resolves.toBeUndefined()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('recovers on a later request after replacement cleanup rejects', async () => {
    const firstMap = new FakeMap()
    const recoveredMap = new FakeMap()
    const cleanupFailure = new Error('A map release failed')
    firstMap.remove.mockImplementation(() => { throw cleanupFailure })
    const maps = [firstMap, recoveredMap]
    const first = createComposition()
    const recovered = createComposition()
    const composition: SharedMapSceneRendererComposition = {
      createLayer: vi.fn()
        .mockReturnValueOnce(first.layer)
        .mockReturnValueOnce(recovered.layer),
    }
    const createMap = vi.fn(async () => maps[createMap.mock.calls.length - 1] as unknown as WorkspaceActivationMap)
    const { coordinator, runtime } = createCoordinator({ createMap, composition })

    await coordinator.activate(createActivationSnapshot())
    await expect(coordinator.activate(createActivationSnapshot())).rejects.toBe(cleanupFailure)
    await expect(coordinator.activate(createActivationSnapshot())).resolves.toBe('shared-ready')

    expect(createMap).toHaveBeenCalledTimes(2)
    expect(recoveredMap.remove).not.toHaveBeenCalled()
    expect(runtime.init).toHaveBeenCalledOnce()
  })

  it('reports a stale map release failure without rejecting cancelled activation', async () => {
    const created = deferred<WorkspaceActivationMap>()
    let capturedSignal: AbortSignal | null = null
    const { coordinator } = createCoordinator({
      createMap: (signal) => {
        capturedSignal = signal
        return created.promise
      },
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const activation = coordinator.activate()
    await vi.waitFor(() => expect(capturedSignal).not.toBeNull())
    await coordinator.teardown()
    const staleMap = new FakeMap()
    staleMap.remove.mockImplementation(() => { throw new Error('stale remove failed') })

    created.resolve(staleMap as unknown as WorkspaceActivationMap)

    await expect(activation).resolves.toBe('cancelled')
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to release stale MapLibre workspace map:',
      expect.any(Error),
    )
    consoleError.mockRestore()
  })

  it('makes repeated active teardown idempotent', async () => {
    const { coordinator, runtime, map, mapControls } = createCoordinator()
    await coordinator.activate()

    await coordinator.teardown()
    await coordinator.teardown()

    expect(map.remove).toHaveBeenCalledOnce()
    expect(mapControls.releaseMap).toHaveBeenCalledOnce()
    expect(mapControls.releaseMap).toHaveBeenCalledWith(map, undefined)
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('attempts every teardown cleanup even when each resource cleanup fails', async () => {
    const map = new FakeMap()
    map.remove.mockImplementation(() => { throw new Error('remove failed') })
    map.off.mockImplementation(() => { throw new Error('detach failed') })
    const composed = createComposition({ dispose: async () => { throw new Error('dispose failed') } })
    const runtime = createRuntime()
    runtime.destroy = vi.fn(() => { throw new Error('destroy failed') })
    const unwatchFailure = vi.fn(() => { throw new Error('unwatch failed') })
    const { coordinator } = createCoordinator({
      map, composition: composed.composition, runtime, unwatchFailure,
    })
    await coordinator.activate()

    await expect(coordinator.teardown()).rejects.toThrow('Shared workspace teardown failed')

    expect(unwatchFailure).toHaveBeenCalledOnce()
    expect(map.off).toHaveBeenCalledTimes(2)
    expect(composed.dispose).toHaveBeenCalledOnce()
    expect(map.remove).toHaveBeenCalledOnce()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('rejects shared activation when runtime initialization itself fails', async () => {
    const runtime = createRuntime()
    const failure = new Error('runtime init failed')
    runtime.init = vi.fn(async () => { throw failure })
    const { coordinator, map } = createCoordinator({ runtime })

    await expect(coordinator.activate()).rejects.toBe(failure)

    expect(runtime.unmountRenderer).not.toHaveBeenCalled()
    expect(map.remove).toHaveBeenCalledOnce()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('records a synchronous runtime initialization throw without retrying it', async () => {
    const runtime = createRuntime()
    const failure = new Error('runtime init threw synchronously')
    runtime.init = vi.fn(() => { throw failure })
    const { coordinator, map } = createCoordinator({ runtime })

    await expect(coordinator.activate()).rejects.toBe(failure)

    expect(runtime.init).toHaveBeenCalledOnce()
    expect(runtime.destroy).toHaveBeenCalledOnce()
    expect(map.remove).toHaveBeenCalledOnce()
  })

  it('retains cleanup and destroy failures when runtime initialization rejects', async () => {
    const runtime = createRuntime()
    const initializationError = new Error('runtime init failed')
    runtime.init = vi.fn(async () => { throw initializationError })
    const destroyError = new Error('runtime destroy failed')
    runtime.destroy = vi.fn(() => { throw destroyError })
    const map = new FakeMap()
    const cleanupError = new Error('map removal failed')
    map.remove.mockImplementation(() => { throw cleanupError })
    const { coordinator } = createCoordinator({ map, runtime })

    await expect(coordinator.activate()).rejects.toMatchObject({
      name: 'CanvasRuntimeCleanupError',
      errors: expect.arrayContaining([cleanupError, initializationError, destroyError]),
    })
    expect(runtime.init).toHaveBeenCalledOnce()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('turns a renderer cancellation during teardown into a cancelled activation result', async () => {
    const rendererFailure = deferred<void>()
    const runtime = createRuntime()
    runtime.unmountRenderer = vi.fn(() => rendererFailure.promise)
    const { coordinator } = createCoordinator({ runtime })
    await coordinator.activate()

    const failure = coordinator.reportFailure(new Error('context lost'))
    await Promise.resolve()
    const teardown = coordinator.teardown()
    rendererFailure.reject(new Error('renderer lifecycle cancelled'))

    await expect(failure).resolves.toBe('cancelled')
    await expect(teardown).resolves.toBeUndefined()
  })

  it('does not start a deferred renderer unmount after same-turn teardown', async () => {
    const { coordinator, runtime } = createCoordinator()
    await coordinator.activate()

    const failure = coordinator.reportFailure(new Error('context lost'))
    const teardown = coordinator.teardown()

    await expect(failure).resolves.toBe('cancelled')
    await expect(teardown).resolves.toBeUndefined()
    expect(runtime.unmountRenderer).not.toHaveBeenCalled()
    expect(runtime.destroy).toHaveBeenCalledOnce()
  })

  it('sinks a rejected camera callback unmount while public failure reports still reject', async () => {
    const runtime = createRuntime()
    const failure = new Error('renderer unmount failed')
    runtime.unmountRenderer = vi.fn(async () => { throw failure })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { coordinator, map } = createCoordinator({ runtime })
    await coordinator.activate()

    map.pitch = 1
    map.emit('move')
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      'Shared workspace map failure handling failed:', failure,
    ))
    await expect(coordinator.reportFailure(failure)).rejects.toBe(failure)
    consoleError.mockRestore()
  })

  it('rebuilds a map that lost its context through the real composition, keeping the Scene, view, selection and undo', async () => {
    const f = realComposition()
    await expect(f.composition.start()).resolves.toBe('shared-ready')
    const runtime = f.runtime()
    f.composition.surfaces.documents.loadDocument(designWithPlant())
    // A site-scale view of the plant (editing needs one), away from the map's start camera.
    runtime.cameraHost.current().apply({
      kind: 'set',
      target: { center: { lon: 0.0001, lat: 0.00005 }, zoom: 19, bearingDeg: 0, pitchDeg: 0 },
      animation: 'none',
    })
    f.composition.surfaces.commands.sceneEdits.selectAll()
    f.composition.surfaces.commands.sceneEdits.nudgeSelected({ x: 1, y: 0 })
    f.composition.surfaces.commands.sceneEdits.endNudge()
    await vi.waitFor(() => expect(f.composition.surfaces.commands.history.canUndo.value).toBe(true))
    const camera = runtime.cameraHost.frames.viewFrame.peek().view.camera
    const scene = runtime.querySurface.getSceneSnapshot()
    const selection = runtime.querySurface.getSelection()
    expect(selection).toHaveLength(1)

    f.loseContext()
    expect(f.states.at(-1)).toMatchObject({ status: 'error' })
    await vi.waitFor(() => expect(runtime.keyboardPort).toBeNull())
    await failureHandled(f.maps[0]!)
    expect(f.states.at(-1)).toMatchObject({ status: 'error', retryable: true })

    f.composition.retryMap()

    await vi.waitFor(() => expect(runtime.keyboardPort).not.toBeNull())
    expect(f.maps).toHaveLength(2)
    expect(f.maps[0]!.remove).toHaveBeenCalledOnce()
    expect(f.maps[1]!.addLayer).toHaveBeenCalledOnce()
    expect(runtime.querySurface.getSceneSnapshot()).toEqual(scene)
    expect(runtime.querySurface.getSelection()).toEqual(selection)
    expect(f.composition.surfaces.commands.history.canUndo.value).toBe(true)
    const kept = runtime.cameraHost.frames.viewFrame.peek()
    expect(kept.attached).toBe(true)
    expect(kept.view.camera.center.lon).toBeCloseTo(camera.center.lon, 6)
    expect(kept.view.camera.center.lat).toBeCloseTo(camera.center.lat, 6)
    expect(kept.view.camera.zoom).toBeCloseTo(camera.zoom, 6)

    // Retry can be pressed again after a later loss.
    f.loseContext()
    await vi.waitFor(() => expect(runtime.keyboardPort).toBeNull())
    await failureHandled(f.maps[1]!)
    f.composition.retryMap()
    await vi.waitFor(() => expect(runtime.keyboardPort).not.toBeNull())
    expect(f.maps).toHaveLength(3)
    await f.composition.dispose()
  })

  it('offers Retry only once the lost map\'s failure is handled, so a press the moment it shows rebuilds the map', async () => {
    let composition: WorkspaceRuntimeComposition | null = null
    let pressed = 0
    const f = realComposition({
      // The user presses Retry as soon as it is on screen.
      onMapStateChange: (state) => {
        if (state.status !== 'error' || !state.retryable || pressed > 0) return
        pressed += 1
        queueMicrotask(() => composition!.retryMap())
      },
    })
    composition = f.composition
    await expect(f.composition.start()).resolves.toBe('shared-ready')

    f.loseContext()
    expect(f.states.at(-1)).toMatchObject({ status: 'error', retryable: false })

    await vi.waitFor(() => expect(f.maps).toHaveLength(2))
    expect(pressed).toBe(1)
    await vi.waitFor(() => expect(f.runtime().keyboardPort).not.toBeNull())
    await f.composition.dispose()
  })

  it('offers Retry when a Design is opened while the lost map\'s failure is still being handled', async () => {
    const f = realComposition()
    await expect(f.composition.start()).resolves.toBe('shared-ready')

    f.loseContext()
    // The failure is now being handled (the map is marked unavailable, Retry withheld)...
    for (let i = 0; i < 3; i += 1) await Promise.resolve()
    expect(f.states.at(-1)).toMatchObject({ status: 'error', retryable: false })
    // ...when the user opens another Design, which retires the failed generation.
    f.composition.surfaces.documents.replaceDocument(designWithPlant(), createCanvasDocumentReplacementToken(), () => {})
    await failureHandled(f.maps[0]!)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(f.states.at(-1)).toMatchObject({ status: 'error', retryable: true })
    f.composition.retryMap()
    await vi.waitFor(() => expect(f.maps).toHaveLength(2))
    await f.composition.dispose()
  })

  it('offers no Retry once a failed renderer initialization destroyed the runtime', async () => {
    const f = realComposition({ failRuntimeInit: true })
    await f.composition.start()

    await vi.waitFor(() => expect(f.states.at(-1)).toMatchObject({ status: 'error', retryable: false }))
    f.composition.retryMap()
    await Promise.resolve()
    expect(f.maps).toHaveLength(1)
    await expect(f.composition.dispose()).rejects.toThrow('renderer init failed')
  })

  it('offers no Retry when a context lost during renderer initialization ends with the runtime destroyed', async () => {
    const init = deferred<void>()
    const f = realComposition({ runtimeInit: init.promise })
    void f.composition.start()
    await vi.waitFor(() => expect(f.runtime().init).toHaveBeenCalledOnce())

    f.loseContext()
    // Its failure is handled only once initialization ends, so Retry is not offered meanwhile.
    expect(f.states.at(-1)).toMatchObject({ status: 'error', retryable: false })
    const destroy = vi.spyOn(f.runtime(), 'destroy')
    init.reject(new Error('renderer init failed'))

    await vi.waitFor(() => expect(destroy).toHaveBeenCalled())
    expect(f.states.at(-1)).toMatchObject({ status: 'error', retryable: false })
    expect(f.states.some((state) => state.retryable)).toBe(false)
    expect(f.maps).toHaveLength(1)
    await expect(f.composition.dispose()).rejects.toThrow('Shared workspace teardown failed')
  })

  it('uses a real SceneCanvasRuntime and shared composition without adding a runtime canvas', async () => {
    const map = new FakeMap()
    const runtime = new SceneCanvasRuntime()
    const composition = createSharedMapSceneRendererComposition((target) => runtime.connectRenderTarget(target))
    runtime.documentSurface.resize(400, 300)
    const camera = runtime.cameraHost
    const container = document.createElement('div')
    Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 300 } })
    const renderer: SharedPixiRenderer = {
      init: vi.fn(async () => {}), render: vi.fn(), resize: vi.fn(), resetState: vi.fn(),
      destroy: vi.fn(), context: { extensions: {} },
    }
    const coordinator = new WorkspaceActivationCoordinator({
      container, runtime, camera,
      composition: withLayerFactories(composition, {
        createRenderer: () => renderer,
        createStage: () => ({ destroy: vi.fn() }) as never,
        createPresentation: () => ({ dispose() {}, resize() {}, present() {}, setDraft() {} }),
      }),
      map: {
        createMap: async () => map as unknown as WorkspaceActivationMap,
        releaseMap: () => map.remove(),
        getWebGL2Context: () => map.context,
        updateMapContributions: () => {},
        updateBackgroundPresentation: () => {},
        setAttributionCompact: () => {},
        retryBasemap: vi.fn(),
        reconcileLayerStack: () => {},
        watchFailure: () => () => {},
      },
      readOrigin: () => ({ lat: 0, lon: 0 }),
    })

    await expect(coordinator.activate(createActivationSnapshot())).resolves.toBe('shared-ready')
    expect(map.addLayer).toHaveBeenCalledOnce()
    expect(container.querySelector('canvas')).toBeNull()

    await coordinator.teardown()
  })

  it('runs a teardown requested inside addLayer synchronously through the real composition', async () => {
    const map = new FakeMap()
    const runtime = new SceneCanvasRuntime()
    const destroyRuntime = vi.spyOn(runtime, 'destroy')
    const shared = createSharedMapSceneRendererComposition((target) => runtime.connectRenderTarget(target))
    const layers = withLayerFactories(shared, {
      createRenderer: () => ({
        init: vi.fn(async () => {}), render: vi.fn(), resize: vi.fn(), resetState: vi.fn(),
        destroy: vi.fn(), context: { extensions: {} },
      }),
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => ({ dispose() {}, resize() {}, present() {}, setDraft() {} }),
    })
    let layer!: SharedMapSceneLayer
    let signal!: AbortSignal
    const releaseMap = vi.fn(() => map.remove())
    const coordinator = new WorkspaceActivationCoordinator({
      container: document.createElement('div'), runtime, camera: runtime.cameraHost,
      composition: { createLayer: (options) => (layer = layers.createLayer(options)) },
      map: {
        createMap: async (abortSignal) => {
          signal = abortSignal
          return map as unknown as WorkspaceActivationMap
        },
        releaseMap,
        getWebGL2Context: () => map.context,
        updateMapContributions: () => {},
        updateBackgroundPresentation: () => {},
        setAttributionCompact: () => {},
        retryBasemap: vi.fn(),
        reconcileLayerStack: () => {},
        watchFailure: () => () => {},
      },
      readOrigin: () => ({ lat: 0, lon: 0 }),
    })
    const addLayer = map.addLayer.getMockImplementation()!
    let teardown!: Promise<void>
    let inside: { phase: string; aborted: boolean } | null = null
    map.addLayer.mockImplementation((spec) => {
      addLayer(spec)
      teardown = coordinator.teardown()
      inside = { phase: layer.diagnostics.phase, aborted: signal.aborted }
    })

    await expect(coordinator.activate(createActivationSnapshot())).resolves.toBe('cancelled')

    expect(inside).toEqual({ phase: 'disposing', aborted: true })
    await expect(teardown).resolves.toBeUndefined()
    expect(layer.diagnostics.phase).toBe('disposed')
    expect(releaseMap).toHaveBeenCalledOnce()
    expect(destroyRuntime).toHaveBeenCalledOnce()
  })
})

/** Waits until the coordinator released the lost map and settled its failure, when Retry is accepted. */
async function failureHandled(map: FakeMap): Promise<void> {
  await vi.waitFor(() => expect(map.remove).toHaveBeenCalledOnce())
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A FakeMap whose camera follows jumpTo, so a rebuilt map shows the camera the runtime gave it. */
class MovableFakeMap extends FakeMap {
  override readonly jumpTo = vi.fn((options?: { center: [number, number]; zoom: number; bearing: number }) => {
    if (options) {
      Object.assign(this.camera, {
        center: { lon: options.center[0], lat: options.center[1] },
        zoom: options.zoom,
        bearingDeg: options.bearing,
      })
    }
    this.emit('move')
  })
}

/**
 * The production composition with a real SceneCanvasRuntime, coordinator and renderer composition; only MapLibre
 * (the map controls) and Pixi (the layer's renderer) are fakes. Each map reports failures like the real controls.
 */
/** The renderer composition with the layer's Pixi factories replaced, as jsdom has no WebGL. */
function withLayerFactories(
  composition: SharedMapSceneRendererComposition,
  factories: Pick<SharedMapSceneLayerOptions, 'createRenderer' | 'createStage' | 'createPresentation'>,
): SharedMapSceneRendererComposition {
  return { createLayer: (options) => composition.createLayer({ ...options, ...factories }) }
}

function realComposition(options: {
  failRuntimeInit?: boolean
  runtimeInit?: Promise<void>
  onMapStateChange?: (state: MapLibreCanvasSurfaceState) => void
} = {}) {
  const maps: MovableFakeMap[] = []
  const ended = new Set<WorkspaceActivationMap>()
  const reports: Array<(error: unknown) => void> = []
  const states: MapLibreCanvasSurfaceState[] = []
  let runtime: SceneCanvasRuntime | null = null
  const container = document.createElement('div')
  Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 300 } })
  const pixi: SharedPixiRenderer = {
    init: vi.fn(async () => {}), render: vi.fn(), resize: vi.fn(), resetState: vi.fn(),
    destroy: vi.fn(), context: { extensions: {} },
  }
  const composition = createWorkspaceRuntimeComposition({
    container,
    appAdapter: createDetachedCanvasRuntimeAppAdapter(),
    targetPresentation: createDetachedSceneRuntimePanelTargetAdapter(),
    mapContributions: { read: () => null },
    onMapStateChange: (state) => {
      states.push(state)
      options.onMapStateChange?.(state)
    },
    readSnapshot: () => createActivationSnapshot(),
  }, {
    createRuntime: (runtimeOptions) => {
      runtime = new SceneCanvasRuntime(runtimeOptions)
      if (options.failRuntimeInit) vi.spyOn(runtime, 'init').mockRejectedValue(new Error('renderer init failed'))
      if (options.runtimeInit) vi.spyOn(runtime, 'init').mockReturnValue(options.runtimeInit)
      return runtime
    },
    createWorkspace: (workspaceOptions) => new WorkspaceActivationCoordinator({
      ...workspaceOptions,
      composition: withLayerFactories(workspaceOptions.composition, {
        createRenderer: () => pixi,
        createStage: () => ({ destroy: vi.fn() }) as never,
        createPresentation: () => ({ dispose() {}, resize() {}, present() {}, setDraft() {} }),
      }),
    }),
    createControls: (controlOptions) => ({
      createMap: async () => {
        const map = new MovableFakeMap()
        maps.push(map)
        controlOptions.contributions.onStateChange?.({ ...IDLE_MAPLIBRE_CANVAS_SURFACE_STATE, status: 'ready' })
        return map as unknown as WorkspaceActivationMap
      },
      // Like WorkspaceMapContributions.dispose: a map publishes its end once, at the reported failure or at release.
      releaseMap: (map, failure) => {
        ;(map as unknown as FakeMap).remove()
        if (ended.has(map)) return
        ended.add(map)
        controlOptions.contributions?.onStateChange?.(failure === undefined
          ? IDLE_MAPLIBRE_CANVAS_SURFACE_STATE
          : { ...IDLE_MAPLIBRE_CANVAS_SURFACE_STATE, status: 'error', retryable: true })
      },
      getWebGL2Context: (map) => (map as unknown as FakeMap).context,
      updateMapContributions: () => {},
      updateBackgroundPresentation: () => {},
      setAttributionCompact: () => {},
      retryBasemap: vi.fn(),
      reconcileLayerStack: () => {},
      // Like WorkspaceMapControls.failAttempt: the error is published before the coordinator hears of it.
      watchFailure: (map, report) => {
        reports.push((error) => {
          if (!ended.has(map)) {
            ended.add(map)
            controlOptions.contributions?.onStateChange?.({ ...IDLE_MAPLIBRE_CANVAS_SURFACE_STATE, status: 'error', retryable: true })
          }
          report(error)
        })
        return () => {}
      },
    }),
  })
  return {
    composition,
    maps,
    states,
    runtime: () => runtime!,
    loseContext: () => reports.at(-1)!(new Error('MapLibre WebGL context was lost.')),
  }
}

function designWithPlant(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Orchard',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [{
      id: 'apple', locked: false, canonical_name: 'Malus domestica', common_name: 'Apple', color: null,
      position: { lon: 0, lat: 0 }, rotation: null, scale: null, notes: null, planted_date: null, quantity: 1,
    }],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-10-03T00:00:00.000Z',
    updated_at: '2026-10-03T00:00:00.000Z',
  }
}
