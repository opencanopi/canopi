// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_MAP_MAX_ZOOM } from '../canvas/workspace-camera-policy'
import { createRasterDisplay, tileIsRelevant, type RasterDisplayLayer } from '../maplibre/raster-display/adapter'
import { RasterWorkerPool } from '../maplibre/raster-display/pool'
import { inProcessLane, serveRasterFixtures, type InProcessLane } from './support/raster-lane'

/** Records the public LayerManager calls the adapter makes. */
class FakeLayerManager {
  static instances: FakeLayerManager[] = []
  readonly calls: string[] = []
  readonly states: Record<string, unknown>[] = []
  readonly layers: { id: string; loading: boolean; error: Error | null }[] = []
  destroyed = false
  constructor(readonly map: unknown, readonly options: unknown, readonly deps: Record<string, (...args: unknown[]) => Promise<unknown>>) {
    FakeLayerManager.instances.push(this)
  }
  on() {}
  getLayers() { return this.layers }
  getLayer(id: string) { return this.layers.find((layer) => layer.id === id) }
  async addRaster(url: string, options: { id: string; state?: Record<string, unknown> }) {
    this.calls.push(`add ${options.id} ${url}`)
    if (options.state) this.states.push(options.state)
    this.layers.push({ id: options.id, loading: true, error: null })
    return options.id
  }
  removeRaster(id: string) {
    this.calls.push(`remove ${id}`)
    this.layers.splice(this.layers.findIndex((layer) => layer.id === id), 1)
  }
  setState(id: string, patch: Record<string, unknown>) {
    this.calls.push(`state ${id} ${Object.keys(patch).join(',')}`)
    if ('colormap' in patch) this.states.push(patch)
  }
  setBeforeId() {}
  reorder(id: string, index: number) { this.calls.push(`reorder ${id} ${index}`) }
  destroy() { this.destroyed = true }
}

/** A real lane whose replies never come: the fake manager never draws. */
function idleLane(): InProcessLane {
  const lane = inProcessLane()
  lane.hold()
  return lane
}

beforeEach(() => {
  serveRasterFixtures({})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup() {
  FakeLayerManager.instances = []
  const lanes: InProcessLane[] = []
  const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: () => { const lane = idleLane(); lanes.push(lane); return lane } })
  let release!: () => void
  const loaded = new Promise<void>((resolve) => { release = resolve })
  const display = createRasterDisplay({}, {
    pool,
    loadRasterModule: async () => { await loaded; return { LayerManager: FakeLayerManager } as never },
  })
  return { display, pool, lanes, release: async () => { release(); await loaded; await new Promise((r) => setTimeout(r, 0)) } }
}

function layer(id: string, overrides: Partial<RasterDisplayLayer> = {}): RasterDisplayLayer {
  return {
    id,
    name: id,
    assets: [{ url: `asset://localhost/${id}.tif`, bbox: [0, 0, 1, 1] }],
    bounds: [0, 0, 1, 1],
    opacity: 1,
    rescale: [0, 30],
    colormap: 'terrain',
    reversed: false,
    ...overrides,
  }
}

describe('Canopi raster display adapter', () => {
  it('selects the WASM engine and injects Canopi collaborators through the public deps', async () => {
    const { display, release } = setup()
    display.sync([layer('lidar-a-gen1')], 'scene')
    await release()
    const manager = FakeLayerManager.instances[0]!
    expect(manager.options).toEqual({ engine: 'cog-tiler-wasm' })
    await expect(manager.deps.computeAutoStats!()).rejects.toThrow('statistics come from the library')
    expect(manager.calls).toEqual(['add lidar-a-gen1 asset://localhost/lidar-a-gen1.tif'])
  })

  it('keeps opacity paint-only and replaces a layer whose generation changed', async () => {
    const { display, release } = setup()
    await release()
    display.sync([layer('lidar-a-gen1')], undefined)
    display.sync([layer('lidar-a-gen1', { opacity: 0.4 })], undefined)
    display.sync([layer('lidar-a-gen2', { opacity: 0.4 })], undefined)
    expect(FakeLayerManager.instances[0]!.calls).toEqual([
      'add lidar-a-gen1 asset://localhost/lidar-a-gen1.tif',
      'state lidar-a-gen1 opacity',
      'remove lidar-a-gen1',
      'add lidar-a-gen2 asset://localhost/lidar-a-gen2.tif',
    ])
  })

  it('releases the worker sources of a removed layer unless a remaining layer still uses them', async () => {
    FakeLayerManager.instances = []
    const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: idleLane })
    const released: string[][] = []
    const acquire = pool.acquire.bind(pool)
    pool.acquire = () => {
      const client = acquire()
      client.releaseSources = (urls) => { released.push([...urls]) }
      return client
    }
    const display = createRasterDisplay({}, { pool, loadRasterModule: async () => ({ LayerManager: FakeLayerManager }) as never })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shared = { url: 'asset://localhost/shared.tif', bbox: [0, 0, 1, 1] as [number, number, number, number] }
    display.sync([layer('lidar-a-gen1'), layer('lidar-c-gen1', { assets: [shared] }), layer('lidar-d-gen1', { assets: [shared] })], undefined)
    display.sync([layer('lidar-a-gen2'), layer('lidar-d-gen1', { assets: [shared] })], undefined)
    expect(released).toEqual([['asset://localhost/lidar-a-gen1.tif']])
    display.dispose()
  })

  it('canopi-ana9: releases a mosaic\'s asset sources like any layer\'s, once no layer on the map reads them', async () => {
    FakeLayerManager.instances = []
    const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: idleLane })
    const released: string[][] = []
    const acquire = pool.acquire.bind(pool)
    pool.acquire = () => {
      const client = acquire()
      client.releaseSources = (urls) => { released.push([...urls]) }
      return client
    }
    const display = createRasterDisplay({}, { pool, loadRasterModule: async () => ({ LayerManager: FakeLayerManager }) as never })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const top = { url: 'asset://localhost/top.tif', bbox: [0, 0, 1, 1] as [number, number, number, number] }
    const bottom = { url: 'asset://localhost/bottom.tif', bbox: [0.5, 0, 1.5, 1] as [number, number, number, number] }
    // A mosaic, then the same id with one asset left, then a single layer on a mosaic asset, then nothing.
    display.sync([layer('lidar-b-gen1', { assets: [top, bottom] })], undefined)
    display.sync([layer('lidar-b-gen1', { assets: [top] })], undefined)
    display.sync([layer('lidar-c-gen1', { assets: [bottom] }), layer('lidar-d-gen1')], undefined)
    display.sync([], undefined)
    expect(released).toEqual([
      ['asset://localhost/bottom.tif'],
      ['asset://localhost/top.tif'],
      ['asset://localhost/bottom.tif', 'asset://localhost/lidar-d-gen1.tif'],
    ])
    display.dispose()
  })

  it('renders a multi-source item as one ordered mosaic resolved in memory', async () => {
    const { display, release } = setup()
    await release()
    const item = layer('lidar-b-gen1', {
      assets: [
        { url: 'asset://localhost/top.tif', bbox: [0, 0, 1, 1] },
        { url: 'asset://localhost/bottom.tif', bbox: [0.5, 0, 1.5, 1] },
      ],
    })
    display.sync([item], undefined)
    const manager = FakeLayerManager.instances[0]!
    const url = manager.calls[0]!.split(' ')[2]!
    expect(url).toMatch(/\.json$/)
    const mosaic = await manager.deps.loadMosaic!(url) as { assets: { url: string }[] }
    expect(mosaic.assets.map((asset) => asset.url)).toEqual(['asset://localhost/top.tif', 'asset://localhost/bottom.tif'])
  })

  it('never builds a manager after disposal and releases its worker lanes', async () => {
    const { display, lanes, pool, release } = setup()
    display.sync([layer('lidar-a-gen1')], undefined)
    display.dispose()
    await release()
    expect(FakeLayerManager.instances).toHaveLength(0)
    expect(pool.laneCount).toBe(0)
    expect(lanes[0]!.terminated).toBe(true)
  })

  it('destroys the manager on disposal', async () => {
    const { display, release } = setup()
    await release()
    display.sync([layer('lidar-a-gen1')], undefined)
    display.dispose()
    expect(FakeLayerManager.instances[0]!.destroyed).toBe(true)
  })
})

describe('zoom range', () => {
  it('asks the engine to draw every layer at every camera zoom, on add and on a style change', async () => {
    const { display, release } = setup()
    await release()
    display.sync([layer('lidar-a-gen1')], undefined)
    display.sync([layer('lidar-a-gen1', { colormap: 'gray' })], undefined)
    const states = FakeLayerManager.instances[0]!.states
    expect(states).toHaveLength(2)
    for (const state of states) {
      expect(state.minZoom).toBe(0)
      expect(state.maxZoom).toBeGreaterThan(WORKSPACE_MAP_MAX_ZOOM)
    }
  })

  it('keeps a layer drawn at the camera\'s deepest zooms through the real engine and the real MapLibre style', async () => {
    // MapLibre's style needs workers and ImageData only for messages this test never reads.
    vi.stubGlobal('ImageData', class {})
    vi.stubGlobal('Worker', class { postMessage() {} addEventListener() {} removeEventListener() {} terminate() {} })
    try {
      const { Map: MapLibreMap, Style } = await import('maplibre-gl')
      const map = Object.create(MapLibreMap.prototype) as InstanceType<typeof MapLibreMap> & Record<string, unknown>
      Object.assign(map, {
        _getMapId: () => 1,
        _requestManager: { transformRequest: (url: string) => ({ url }) },
        _update: () => map,
        migrateProjection() {},
        getTerrain: () => null,
        triggerRepaint() {},
        isStyleLoaded: () => true,
        getZoom: () => 26.9,
      })
      const style = new Style(map, {}) as unknown as { _loaded: boolean; stylesheet: unknown; getLayer(id: string): { isHidden(zoom: number): boolean } | undefined; _order: string[] }
      style._loaded = true
      style.stylesheet = { version: 8, sources: {}, layers: [] }
      map.style = style as never
      const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: idleLane })
      const display = createRasterDisplay(map as never, { pool })
      // Two assets make a mosaic, which reaches the map without opening a source in a worker.
      display.sync([layer('lidar-a-gen1', {
        assets: [
          { url: 'asset://localhost/top.tif', bbox: [0, 0, 1, 1] },
          { url: 'asset://localhost/bottom.tif', bbox: [0.5, 0, 1.5, 1] },
        ],
      })], undefined)
      await vi.waitFor(() => expect(style._order).toHaveLength(1), { timeout: 5000 })
      const drawn = style.getLayer(style._order[0]!)!
      for (const zoom of [0, 18, 23.9, 24, 25, 26.9, WORKSPACE_MAP_MAX_ZOOM]) expect(drawn.isHidden(zoom), `hidden at z${zoom}`).toBe(false)
      display.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  }, 15_000)
})

describe('style readiness', () => {
  it('re-applies layers the engine deferred while basemap sources were still loading', async () => {
    FakeLayerManager.instances = []
    const listeners = new Map<string, Set<() => void>>()
    let loaded = false
    const present = new Set<string>()
    const map = {
      on: (type: string, listener: () => void) => { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set) },
      off: (type: string, listener: () => void) => { listeners.get(type)?.delete(listener) },
      isStyleLoaded: () => loaded,
      getLayer: (id: string) => (present.has(id) ? { id } : undefined),
    }
    const emit = (type: string) => { for (const listener of [...(listeners.get(type) ?? [])]) listener() }
    const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: idleLane })
    const display = createRasterDisplay(map, { pool, loadRasterModule: async () => ({ LayerManager: FakeLayerManager }) as never })
    await new Promise((resolve) => setTimeout(resolve, 0))
    display.sync([layer('lidar-a-gen1')], undefined)
    const manager = FakeLayerManager.instances[0]!
    // The engine gates its first map mutation on isStyleLoaded(), which stays
    // false while basemap tiles load, and then waits for a style event that
    // never comes. The adapter nudges it once the map settles.
    // The nudge runs once the event's own task is done.
    const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))
    emit('sourcedata')
    await settle()
    expect(manager.calls.filter((call) => call.startsWith('state'))).toEqual([])
    loaded = true
    emit('idle')
    emit('sourcedata')
    await settle()
    expect(manager.calls.filter((call) => call.startsWith('state'))).toEqual(['state lidar-a-gen1 '])
    present.add('lidar-a-gen1')
    emit('idle')
    await settle()
    expect(manager.calls.filter((call) => call.startsWith('state'))).toHaveLength(1)
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true)
    display.dispose()
  })
})

describe('the nudge and the engine\'s own map mutations', () => {
  it('never re-enters the engine from a map event its own mutation fires (Cut outliers\' second restyle)', async () => {
    FakeLayerManager.instances = []
    const listeners = new Map<string, Set<() => void>>()
    const map = {
      on: (type: string, listener: () => void) => { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set) },
      off: (type: string, listener: () => void) => { listeners.get(type)?.delete(listener) },
      isStyleLoaded: () => true,
      // The engine's restyle removes the layer and its source, then adds them again.
      getLayer: () => (restyling ? undefined : { id: 'lidar-a-gen1' }),
    }
    const emit = (type: string) => { for (const listener of [...(listeners.get(type) ?? [])]) listener() }
    let restyling = false
    let depth = 0
    let deepest = 0
    const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: idleLane })
    const display = createRasterDisplay(map, { pool, loadRasterModule: async () => ({ LayerManager: FakeLayerManager }) as never })
    await new Promise((resolve) => setTimeout(resolve, 0))
    display.sync([layer('lidar-a-gen1')], undefined)
    const manager = FakeLayerManager.instances[0]!
    const setState = manager.setState.bind(manager)
    manager.setState = (id, patch) => {
      depth += 1
      deepest = Math.max(deepest, depth)
      setState(id, patch)
      // MapLibre's removeSource fires 'sourcedata' synchronously, between the engine's remove and its add again.
      restyling = true
      emit('sourcedata')
      restyling = false
      depth -= 1
    }

    // Cut outliers: the data range first, the read range a moment later.
    display.sync([layer('lidar-a-gen1', { rescale: [10, 90] })], undefined)
    display.sync([layer('lidar-a-gen1', { rescale: [12, 88] })], undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(deepest).toBe(1)
    display.dispose()
  })
})

describe('tile relevance', () => {
  const map = {
    getZoom: () => 14.3,
    getBounds: () => ({ getWest: () => -0.44, getSouth: () => 48.29, getEast: () => -0.42, getNorth: () => 48.31 }),
  }
  it('keeps tiles over the viewport and drops tiles far away or at abandoned zooms', () => {
    // z14 tile containing (-0.43, 48.30)
    expect(tileIsRelevant(map, { z: 14, x: 8172, y: 5674 })).toBe(true)
    expect(tileIsRelevant(map, { z: 14, x: 8300, y: 5674 })).toBe(false)
    expect(tileIsRelevant(map, { z: 18, x: 130760, y: 90790 })).toBe(false)
  })

  it('keeps the z22 tiles MapLibre overscales at camera zooms past z24', () => {
    const deep = {
      getZoom: () => 26.5,
      getBounds: () => ({ getWest: () => -0.4301, getSouth: () => 48.2999, getEast: () => -0.4299, getNorth: () => 48.3001 }),
    }
    // z22 tile containing (-0.43, 48.30)
    const x = Math.floor(((-0.43 + 180) / 360) * 2 ** 22)
    const rad = (48.3 * Math.PI) / 180
    const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** 22)
    expect(tileIsRelevant(deep, { z: 22, x, y })).toBe(true)
    expect(tileIsRelevant(deep, { z: 22, x: x + 50, y })).toBe(false)
    expect(tileIsRelevant(deep, { z: 18, x: x >> 4, y: y >> 4 })).toBe(false)
  })
})
