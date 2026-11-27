// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapLibreSurface, type MapLibreSurfaceContext } from '../maplibre/surface'
import type {
  MapLibreApi,
  MapLibreMapConstructorOptions,
  MapLibreMapInstance,
} from '../maplibre/loader'

type MapEventHandler = (event?: unknown) => void
type MapLibreSurfaceRequest<TMap extends MapLibreMapInstance> = Parameters<MapLibreSurface<TMap>['open']>[1]

class FakeMap implements MapLibreMapInstance {
  readonly jumpTo = vi.fn()
  readonly resize = vi.fn()
  readonly remove = vi.fn()
  readonly on = vi.fn((type: string, listener: MapEventHandler) => {
    const listeners = this.handlers.get(type) ?? new Set()
    listeners.add(listener)
    this.handlers.set(type, listeners)
  })
  readonly off = vi.fn((type: string, listener: MapEventHandler) => {
    this.handlers.get(type)?.delete(listener)
  })
  readonly addSource = vi.fn()
  readonly getSource = vi.fn()
  readonly removeSource = vi.fn()
  readonly addLayer = vi.fn()
  readonly setPaintProperty = vi.fn()
  readonly getLayer = vi.fn()
  readonly removeLayer = vi.fn()
  readonly getLayersOrder = vi.fn(() => [])
  readonly moveLayer = vi.fn()
  readonly handlers = new Map<string, Set<MapEventHandler>>()

  constructor(readonly options: MapLibreMapConstructorOptions) {}

  emit(type: string, event?: unknown): void {
    for (const listener of this.handlers.get(type) ?? []) listener(event)
  }
}

class FakeResizeObserver {
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {}

  emit(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

function createFakeMapLibreApi(maps: FakeMap[]): MapLibreApi {
  class TestMap extends FakeMap {
    constructor(options: MapLibreMapConstructorOptions) {
      super(options)
      maps.push(this)
    }
  }

  return {
    Map: TestMap,
    addProtocol: vi.fn(),
  }
}

function createFakeMap(api: MapLibreApi, target: HTMLElement): FakeMap {
  return new api.Map({
    container: target,
    style: { version: 8, sources: {}, layers: [] },
    interactive: false,
    pitchWithRotate: false,
    dragRotate: false,
    touchZoomRotate: false,
  }) as FakeMap
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('MapLibre surface', () => {
  let container: HTMLDivElement
  let maps: FakeMap[]
  let observers: FakeResizeObserver[]
  let maplibre: MapLibreApi

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    container = document.createElement('div')
    maps = []
    observers = []
    maplibre = createFakeMapLibreApi(maps)
  })

  function createSurface(deps: { logError?: (message?: unknown, ...optionalParams: unknown[]) => void } = {}): MapLibreSurface<FakeMap> {
    return new MapLibreSurface<FakeMap>({
      loadMapLibre: vi.fn(async () => maplibre),
      createResizeObserver: (callback) => {
        const observer = new FakeResizeObserver(callback)
        observers.push(observer)
        return observer
      },
      ...deps,
    })
  }

  it('one surface creates and removes the map, with the listeners and cleanups its request registered', async () => {
    const surface = createSurface()
    const onMove = vi.fn()
    const cleanup = vi.fn()
    const onCreate = vi.fn((context: MapLibreSurfaceContext<FakeMap>) => {
      context.lifetime.on('move', onMove)
      context.lifetime.addCleanup(cleanup)
    })

    const noop = () => {}
    surface.open(container, { createMap: createFakeMap, onCreate, onResize: noop, onCreateError: noop })
    await flushPromises()

    expect(maps).toHaveLength(1)
    expect(maps[0]!.options.container).toBe(container)
    expect(surface.map).toBe(maps[0])
    expect(surface.maplibre).toBe(maplibre)
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ map: maps[0], maplibre }))
    expect(onCreate.mock.calls[0]![0].isCurrent()).toBe(true)
    expect(observers).toHaveLength(1)
    expect(observers[0]!.observe).toHaveBeenCalledWith(container)
    maps[0]!.emit('move')
    expect(onMove).toHaveBeenCalledTimes(1)

    // A new request replaces the map: the first one goes with everything registered on it.
    surface.open(container, { createMap: createFakeMap, onResize: noop, onCreateError: noop })
    await flushPromises()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(maps[0]!.off).toHaveBeenCalledWith('move', onMove)
    expect(maps[0]!.remove).toHaveBeenCalledOnce()
    expect(observers[0]!.disconnect).toHaveBeenCalled()
    expect(onCreate.mock.calls[0]![0].isCurrent()).toBe(false)
    expect(maps).toHaveLength(2)
    expect(surface.map).toBe(maps[1])

    surface.destroy()
    expect(observers[1]!.disconnect).toHaveBeenCalled()
    expect(maps[1]!.remove).toHaveBeenCalledOnce()
    expect(surface.map).toBeNull()
    expect(surface.maplibre).toBeNull()

    // A destroyed surface opens again for the next map.
    surface.open(container, { createMap: createFakeMap, onResize: noop, onCreateError: noop })
    await flushPromises()
    expect(maps).toHaveLength(3)
    expect(surface.map).toBe(maps[2])
    surface.destroy()
  })

  it("a resize calls the request's resize hook with the container's size, not map.resize", async () => {
    const surface = createSurface()
    let size = { width: 640, height: 480 }
    Object.defineProperties(container, {
      clientWidth: { get: () => size.width },
      clientHeight: { get: () => size.height },
    })
    const onResize = vi.fn()

    surface.open(container, { createMap: createFakeMap, onResize, onCreateError: () => {} })
    await flushPromises()
    observers[0]!.emit()

    // The request owns its map's resize (spec §1.1 "Resize"); the surface reports the container's CSS size.
    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize).toHaveBeenCalledWith(expect.objectContaining({ map: maps[0] }), { width: 640, height: 480 })
    expect(maps[0]!.resize).not.toHaveBeenCalled()

    size = { width: 320, height: 200 }
    observers[0]!.emit()
    expect(onResize).toHaveBeenLastCalledWith(expect.objectContaining({ map: maps[0] }), { width: 320, height: 200 })
    expect(onResize).toHaveBeenCalledTimes(2)
    surface.destroy()
  })

  it('removes a map and what its request registered when its setup fails, and a retry creates a new one', async () => {
    const logError = vi.fn()
    const surface = createSurface({ logError })
    const onMove = vi.fn()
    const cleanup = vi.fn()
    const onCreateError = vi.fn()
    const setupError = new Error('post-create setup failed')

    surface.open(container, {
      createMap: createFakeMap,
      onCreate: (context) => {
        context.lifetime.on('move', onMove)
        context.lifetime.addCleanup(cleanup)
        throw setupError
      },
      onResize: () => {},
      onCreateError,
    })
    await flushPromises()

    expect(onCreateError).toHaveBeenCalledWith(setupError)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(maps[0]!.off).toHaveBeenCalledWith('move', onMove)
    expect(observers[0]!.disconnect).toHaveBeenCalled()
    expect(maps[0]!.remove).toHaveBeenCalledOnce()
    expect(surface.map).toBeNull()
    expect(logError).not.toHaveBeenCalled()

    surface.open(container, { createMap: createFakeMap, onResize: () => {}, onCreateError })
    await flushPromises()

    expect(maps).toHaveLength(2)
    expect(surface.map).toBe(maps[1])
  })

  it('still removes a failed map and reports its create error when a cleanup throws', async () => {
    const logError = vi.fn()
    const surface = createSurface({ logError })
    const createError = new Error('post-create setup failed')
    const cleanupError = new Error('cleanup failed')
    const onCreateError = vi.fn()

    surface.open(container, {
      createMap: createFakeMap,
      onCreate: ({ lifetime }) => {
        lifetime.addCleanup(() => { throw cleanupError })
        throw createError
      },
      onResize: () => {},
      onCreateError,
    })
    await flushPromises()

    expect(maps[0]!.remove).toHaveBeenCalled()
    expect(onCreateError).toHaveBeenCalledWith(createError)
    expect(logError).toHaveBeenCalledWith('Failed to clean up MapLibre surface resource:', cleanupError)
    expect(surface.map).toBeNull()
  })

  it('logs a failed map removal after a post-create failure, still removes what its constructor added, and reports the create error', async () => {
    const logError = vi.fn()
    const surface = createSurface({ logError })
    const createError = new Error('post-create setup failed')
    const removeError = new Error('MapLibre removal failed')
    const onCreateError = vi.fn()
    const existingChild = document.createElement('div')
    container.append(existingChild)

    surface.open(container, {
      createMap: (api, target) => {
        target.append(document.createElement('canvas'))
        target.classList.add('maplibregl-map')
        const map = createFakeMap(api, target)
        map.remove.mockImplementation(() => {
          throw removeError
        })
        return map
      },
      onCreate: () => {
        throw createError
      },
      onResize: () => {},
      onCreateError,
    })
    await flushPromises()

    expect(maps[0]!.remove).toHaveBeenCalledOnce()
    expect(onCreateError).toHaveBeenCalledWith(createError)
    expect(logError).toHaveBeenCalledWith(
      'Failed to remove MapLibre map after create failure:',
      removeError,
    )
    expect(Array.from(container.children)).toEqual([existingChild])
    expect(container.classList).not.toContain('maplibregl-map')
    expect(surface.map).toBeNull()
  })

  it('still removes what a map\'s creation added to the container when its removal throws on teardown', async () => {
    const surface = createSurface()
    const removeError = new Error('MapLibre removal failed')
    const existingChild = document.createElement('div')
    container.append(existingChild)

    surface.open(container, {
      createMap: (api, target) => {
        target.append(document.createElement('canvas'))
        target.classList.add('maplibregl-map')
        const map = createFakeMap(api, target)
        map.remove.mockImplementation(() => {
          throw removeError
        })
        return map
      },
      onResize: () => {},
      onCreateError: () => {},
    })
    await flushPromises()
    expect(surface.map).toBe(maps[0])

    expect(() => surface.destroy()).toThrow(removeError)
    expect(Array.from(container.children)).toEqual([existingChild])
    expect(container.classList).not.toContain('maplibregl-map')
    expect(surface.map).toBeNull()
  })

  it('removes a map whose synchronous creation went stale', async () => {
    const surface = createSurface()

    surface.open(container, {
      createMap: (api, target) => {
        surface.destroy()
        return createFakeMap(api, target)
      },
      onResize: () => {},
      onCreateError: () => {},
    })
    await flushPromises()

    expect(maps[0]!.remove).toHaveBeenCalledOnce()
    expect(surface.map).toBeNull()
  })

  it.each([
    // jsdom has no WebGL: the painter throws, and MapLibre removes its own containers (`_cleanupContainer`).
    ['without WebGL', false, undefined, /WebGL|context/i],
    // With a painter, a later constructor step throws and MapLibre leaves its canvas and controls behind.
    ['after its painter was set up', true, [Number.NaN, Number.NaN] as [number, number], /Invalid LngLat/],
  ])('leaves the container as it was when the real MapLibre constructor fails %s, and a retry tries again', async (_case, painter, center, failure) => {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'blob:map-worker' }
    })
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const realMapLibre = await import('maplibre-gl') as unknown as MapLibreApi
    const realMap = realMapLibre.Map as unknown as { prototype: { _setupPainter(): void } }
    if (painter) vi.spyOn(realMap.prototype, '_setupPainter').mockImplementation(() => {})
    const logError = vi.fn()
    const surface = new MapLibreSurface({ loadMapLibre: async () => realMapLibre, logError })
    const existingChild = document.createElement('div')
    container.append(existingChild)
    container.classList.add('existing-class')
    const onCreateError = vi.fn()
    const request: MapLibreSurfaceRequest<MapLibreMapInstance> = {
      createMap: (api, target) => new api.Map({
        container: target,
        style: { version: 8, sources: {}, layers: [] },
        center,
        interactive: false,
        pitchWithRotate: false,
        dragRotate: false,
        touchZoomRotate: false,
      }),
      onResize: () => {},
      onCreateError,
    }

    surface.open(container, request)
    await vi.waitFor(() => expect(onCreateError).toHaveBeenCalledTimes(1))
    expect(String(onCreateError.mock.calls[0]![0])).toMatch(failure)

    expect(Array.from(container.children)).toEqual([existingChild])
    expect(Array.from(container.classList)).toEqual(['existing-class'])
    expect(surface.map).toBeNull()

    surface.open(container, request)
    await vi.waitFor(() => expect(onCreateError).toHaveBeenCalledTimes(2))

    expect(Array.from(container.children)).toEqual([existingChild])
    expect(Array.from(container.classList)).toEqual(['existing-class'])
    expect(surface.map).toBeNull()
    expect(logError).not.toHaveBeenCalled()
  })

  it('does not create a map after its pending load is cancelled', async () => {
    const pendingLoad: { resolveMapLibre: ((api: MapLibreApi) => void) | null } = {
      resolveMapLibre: null,
    }
    const surface = new MapLibreSurface({
      loadMapLibre: () => new Promise((resolve) => {
        pendingLoad.resolveMapLibre = resolve
      }),
    })
    const createMap = vi.fn()

    surface.open(container, { createMap, onResize: () => {}, onCreateError: () => {} })
    surface.destroy()
    pendingLoad.resolveMapLibre?.(maplibre)
    await flushPromises()

    expect(createMap).not.toHaveBeenCalled()
    expect(surface.map).toBeNull()
  })

  it('explicit unregister releases retained ownership, not only the map listener', async () => {
    const surface = createSurface()
    const listeners: MapEventHandler[] = []
    surface.open(container, {
      createMap: createFakeMap,
      onCreate: ({ lifetime }) => {
        // Three on/off cycles (must not retain) and three retained registrations.
        for (let i = 0; i < 3; i++) {
          const listener = () => {}
          listeners.push(listener)
          lifetime.on('moveend', listener)
          lifetime.off('moveend', listener)
        }
        for (let i = 0; i < 3; i++) {
          const listener = () => {}
          listeners.push(listener)
          lifetime.on('moveend', listener)
        }
      },
      onResize: () => {},
      onCreateError: () => {},
    })
    await flushPromises()
    const map = maps[0]!
    // Explicit unregister already removed the first three map listeners.
    expect(map.off).toHaveBeenCalledTimes(3)

    // Teardown must release only the three retained registrations. If off left
    // its cleanup behind, teardown would call map.off six more times instead of three.
    surface.destroy()
    expect(map.off).toHaveBeenCalledTimes(6)
    for (const listener of listeners) {
      expect(map.off).toHaveBeenCalledWith('moveend', listener)
    }
  })

  it('a cleanup unregistering an earlier listener runs once', async () => {
    const surface = createSurface()
    const teardown = vi.fn()
    surface.open(container, {
      createMap: createFakeMap,
      onCreate: ({ lifetime }) => {
        const listener = () => {}
        lifetime.on('moveend', listener)
        lifetime.addCleanup(() => { teardown(); lifetime.off('moveend', listener) })
      },
      onResize: () => {},
      onCreateError: () => {},
    })
    await flushPromises()
    surface.destroy()
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('reports a teardown failure and still releases unrelated resources', async () => {
    const logError = vi.fn()
    const cleanup = vi.fn()
    const error = new Error('cleanup failed')
    const surface = createSurface({ logError })
    surface.open(container, {
      createMap: createFakeMap,
      onCreate: ({ lifetime }) => {
        lifetime.addCleanup(cleanup)
        lifetime.addCleanup(() => { throw error })
      },
      onResize: () => {},
      onCreateError: () => {},
    })
    await flushPromises()
    surface.destroy()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('Failed to clean up MapLibre surface resource:', error)
    surface.destroy()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('a lifetime used after its map is gone holds nothing', async () => {
    const surface = createSurface()
    let lifetime!: MapLibreSurfaceContext<FakeMap>['lifetime']
    surface.open(container, { createMap: createFakeMap, onCreate: (context) => { lifetime = context.lifetime }, onResize: () => {}, onCreateError: () => {} })
    await flushPromises()
    surface.destroy()

    const late = vi.fn()
    const listener = vi.fn()
    lifetime.addCleanup(late)
    lifetime.on('move', listener)
    maps[0]!.emit('move')

    expect(late).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
  })
})
