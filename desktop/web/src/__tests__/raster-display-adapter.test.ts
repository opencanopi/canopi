// @vitest-environment jsdom

import type { AddProtocolAction } from 'maplibre-gl'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_MAP_MAX_ZOOM } from '../geo/workspace-camera-policy'
import {
  createRasterDisplay,
  tileIsRelevant,
  type RasterDisplayLayer,
  type RasterDisplayMap,
} from '../maplibre/raster-display/adapter'
import { RasterWorkerPool } from '../maplibre/raster-display/pool'
import { inProcessLane, serveRasterFixtures, type InProcessLane } from './support/raster-lane'

/** Records MapLibre source/layer mutations the addProtocol adapter makes. */
function createRecordingMap() {
  const calls: string[] = []
  const sources = new Map<string, Record<string, unknown>>()
  const layers = new Map<string, Record<string, unknown>>()
  const order: string[] = []
  const map: RasterDisplayMap = {
    addSource(id, source) {
      calls.push(`addSource ${id}`)
      sources.set(id, source)
    },
    getSource: (id) => sources.get(id),
    removeSource(id) {
      calls.push(`removeSource ${id}`)
      sources.delete(id)
    },
    addLayer(layer, beforeId) {
      const id = String(layer.id)
      calls.push(`addLayer ${id}`)
      layers.set(id, layer)
      const at = beforeId ? order.indexOf(beforeId) : -1
      if (at >= 0) order.splice(at, 0, id)
      else order.push(id)
    },
    getLayer: (id) => layers.get(id),
    getLayersOrder: () => [...order],
    removeLayer(id) {
      calls.push(`removeLayer ${id}`)
      layers.delete(id)
      const at = order.indexOf(id)
      if (at >= 0) order.splice(at, 1)
    },
    moveLayer(id, beforeId) {
      const at = order.indexOf(id)
      if (at < 0) return
      order.splice(at, 1)
      const target = beforeId ? order.indexOf(beforeId) : -1
      if (target >= 0) order.splice(target, 0, id)
      else order.push(id)
    },
    setPaintProperty(layerId, name, value) {
      calls.push(`paint ${layerId} ${name}=${String(value)}`)
    },
  }
  return { map, calls, sources, layers, order }
}

/** A real lane whose replies never come: tests sync/reconcile without decoding COGs. */
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
  const lanes: InProcessLane[] = []
  const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: () => { const lane = idleLane(); lanes.push(lane); return lane } })
  const recorded = createRecordingMap()
  const protocols = new Map<string, AddProtocolAction>()
  const display = createRasterDisplay(recorded.map, {
    pool,
    maplibre: {
      addProtocol: (id, action) => { protocols.set(id, action) },
      removeProtocol: (id) => { protocols.delete(id) },
    },
  })
  return { display, pool, lanes, protocols, ...recorded }
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

describe('Canopi raster display adapter (MapLibre addProtocol)', () => {
  it('registers a MapLibre protocol, adds a raster source with maxzoom 22, and cleans up on dispose', () => {
    const { display, pool, lanes, protocols, sources, layers } = setup()
    expect(protocols.size).toBe(1)
    display.sync([layer('lidar-a-gen1')], 'scene')
    expect(display.layerIds()).toEqual(['lidar-a-gen1'])
    const source = [...sources.values()][0]!
    expect(source.type).toBe('raster')
    expect(source.maxzoom).toBe(22)
    expect(layers.get('lidar-a-gen1')?.minzoom).toBe(0)
    expect(layers.get('lidar-a-gen1')?.maxzoom).toBeUndefined()

    display.dispose()
    expect(protocols.size).toBe(0)
    expect(sources.size).toBe(0)
    expect(layers.size).toBe(0)
    expect(pool.laneCount).toBe(0)
    expect(lanes[0]!.terminated).toBe(true)
  })

  it('keeps opacity paint-only, replaces source on style change, and replaces layer on generation change', () => {
    const { display, calls } = setup()
    display.sync([layer('lidar-a-gen1')], undefined)
    display.sync([layer('lidar-a-gen1', { opacity: 0.4 })], undefined)
    display.sync([layer('lidar-a-gen1', { opacity: 0.4, colormap: 'gray' })], undefined)
    display.sync([layer('lidar-a-gen2', { opacity: 0.4, colormap: 'gray' })], undefined)
    expect(calls).toEqual([
      'addSource canopi-raster-src-lidar-a-gen1-r1',
      'addLayer lidar-a-gen1',
      'paint lidar-a-gen1 raster-opacity=0.4',
      'removeLayer lidar-a-gen1',
      'removeSource canopi-raster-src-lidar-a-gen1-r1',
      'addSource canopi-raster-src-lidar-a-gen1-r2',
      'addLayer lidar-a-gen1',
      'removeLayer lidar-a-gen1',
      'removeSource canopi-raster-src-lidar-a-gen1-r2',
      'addSource canopi-raster-src-lidar-a-gen2-r3',
      'addLayer lidar-a-gen2',
    ])
    display.dispose()
  })

  it('releases the worker sources of a removed layer unless a remaining layer still uses them', () => {
    const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: idleLane })
    const released: string[][] = []
    const acquire = pool.acquire.bind(pool)
    pool.acquire = () => {
      const client = acquire()
      client.releaseSources = (urls) => { released.push([...urls]) }
      return client
    }
    const { map } = createRecordingMap()
    const display = createRasterDisplay(map, { maplibre: { addProtocol: vi.fn(), removeProtocol: vi.fn() }, pool })
    const shared = { url: 'asset://localhost/shared.tif', bbox: [0, 0, 1, 1] as [number, number, number, number] }
    display.sync([layer('lidar-a-gen1'), layer('lidar-c-gen1', { assets: [shared] }), layer('lidar-d-gen1', { assets: [shared] })], undefined)
    display.sync([layer('lidar-a-gen2'), layer('lidar-d-gen1', { assets: [shared] })], undefined)
    expect(released).toEqual([['asset://localhost/lidar-a-gen1.tif']])
    display.dispose()
  })

  it('canopi-ana9: releases a mosaic\'s asset sources like any layer\'s, once no layer on the map reads them', () => {
    const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: idleLane })
    const released: string[][] = []
    const acquire = pool.acquire.bind(pool)
    pool.acquire = () => {
      const client = acquire()
      client.releaseSources = (urls) => { released.push([...urls]) }
      return client
    }
    const { map } = createRecordingMap()
    const display = createRasterDisplay(map, { maplibre: { addProtocol: vi.fn(), removeProtocol: vi.fn() }, pool })
    const top = { url: 'asset://localhost/top.tif', bbox: [0, 0, 1, 1] as [number, number, number, number] }
    const bottom = { url: 'asset://localhost/bottom.tif', bbox: [0.5, 0, 1.5, 1] as [number, number, number, number] }
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

  it('renders a multi-source item with the first asset drawn on top where assets overlap', async () => {
    const red = new Uint8ClampedArray(256 * 256 * 4)
    const blue = new Uint8ClampedArray(256 * 256 * 4)
    // First asset covers pixel 0 (opaque red) and leaves pixel 1 transparent.
    red[0] = 200; red[1] = 10; red[2] = 20; red[3] = 255
    // Second asset covers both pixel 0 and pixel 1 (opaque blue).
    blue[0] = 10; blue[1] = 20; blue[2] = 220; blue[3] = 255
    blue[4] = 10; blue[5] = 20; blue[6] = 220; blue[7] = 255
    let encoded: Uint8ClampedArray | null = null
    const pool = {
      acquire: () => ({
        setRelevance: vi.fn(),
        openCog: vi.fn(async (url: string) => ({
          renderTileRGBA: vi.fn(async () => (url.endsWith('/top.tif') ? red : blue)),
          renderTilePNG: vi.fn(async () => new Uint8Array([1])),
        })),
        rgbaToPng: vi.fn(async (rgba: Uint8ClampedArray) => {
          encoded = rgba.slice()
          return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
        }),
        releaseSources: vi.fn(),
        dispose: vi.fn(),
      }),
    } as unknown as RasterWorkerPool
    let handler: AddProtocolAction | null = null
    const { map, sources } = createRecordingMap()
    const display = createRasterDisplay(map, {
      maplibre: { addProtocol: (_id, action) => { handler = action }, removeProtocol: vi.fn() },
      pool,
    })
    display.sync([layer('lidar-mosaic-gen1', {
      assets: [
        { url: 'asset://localhost/top.tif', bbox: [0, 0, 1, 1] },
        { url: 'asset://localhost/bottom.tif', bbox: [0, 0, 1, 1] },
      ],
    })], undefined)
    const tileTemplate = ([...sources.values()][0]!.tiles as string[])[0]!
    const tileUrl = tileTemplate.replace('{z}', '8').replace('{x}', '128').replace('{y}', '127')
    const result = await handler!({ url: tileUrl }, new AbortController())
    expect(result.data).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(encoded!.slice(0, 8))).toEqual([200, 10, 20, 255, 10, 20, 220, 255])
    display.dispose()
  })

  it('retries a failed raster layer by replacing its source with a fresh revision', () => {
    const { display, calls } = setup()
    display.sync([layer('lidar-a-gen1')], undefined)
    display.retryLayer?.('lidar-a-gen1')
    expect(calls).toEqual([
      'addSource canopi-raster-src-lidar-a-gen1-r1',
      'addLayer lidar-a-gen1',
      'removeLayer lidar-a-gen1',
      'removeSource canopi-raster-src-lidar-a-gen1-r1',
      'addSource canopi-raster-src-lidar-a-gen1-r2',
      'addLayer lidar-a-gen1',
    ])
    display.dispose()
  })
})

describe('zoom range', () => {
  beforeAll(async () => { await import('maplibre-gl') }, 120_000)

  it('keeps a layer drawn at the camera\'s deepest zooms through the real MapLibre style', async () => {
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
      const style = new Style(map, {}) as unknown as {
        _loaded: boolean
        stylesheet: unknown
        getLayer(id: string): { isHidden(zoom: number): boolean } | undefined
        _order: string[]
      }
      style._loaded = true
      style.stylesheet = { version: 8, sources: {}, layers: [] }
      map.style = style as never
      const pool = new RasterWorkerPool({ lanes: 1, budgetBytes: 1024, maxInFlightPerLane: 1, createWorker: idleLane })
      const display = createRasterDisplay(map as never, {
        maplibre: { addProtocol: vi.fn(), removeProtocol: vi.fn() },
        pool,
      })
      display.sync([layer('lidar-a-gen1', {
        assets: [
          { url: 'asset://localhost/top.tif', bbox: [0, 0, 1, 1] },
          { url: 'asset://localhost/bottom.tif', bbox: [0.5, 0, 1.5, 1] },
        ],
      })], undefined)
      expect(style._order).toEqual(['lidar-a-gen1'])
      const drawn = style.getLayer('lidar-a-gen1')!
      for (const zoom of [0, 18, 19, 23.9, 24, 25, 26.9, WORKSPACE_MAP_MAX_ZOOM]) {
        expect(drawn.isHidden(zoom), `hidden at z${zoom}`).toBe(false)
      }
      display.dispose()
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      vi.unstubAllGlobals()
    }
  }, 15_000)
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
    const z = 22
    const x = Math.floor(((-0.43 + 180) / 360) * 2 ** z)
    const rad = (48.3 * Math.PI) / 180
    const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
    expect(tileIsRelevant(deep, { z, x, y })).toBe(true)
    expect(tileIsRelevant(deep, { z, x: x + 50, y })).toBe(false)
    expect(tileIsRelevant(deep, { z: 15, x: x >> 4, y: y >> 4 })).toBe(false)
  })
})
