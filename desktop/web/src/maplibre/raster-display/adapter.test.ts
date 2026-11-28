// maplibre/raster-display/adapter.test.ts
import type { AddProtocolAction } from 'maplibre-gl'
import { describe, expect, it, vi } from 'vitest'
import type { LayerStatus } from '../map-lifetime'
import { createRasterDisplay, type RasterDisplayLayer } from './adapter'
import type { RasterWorkerPool } from './pool'

function makeSingleAssetLayer(id: string, name: string): RasterDisplayLayer {
  return {
    id,
    name,
    assets: [{ url: 'asset://localhost/north.tif', bbox: [0, 0, 1, 1] }],
    bounds: [0, 0, 1, 1],
    colormap: 'viridis',
    reversed: false,
    rescale: [0, 100],
    opacity: 1,
  }
}

function createTestHarness(openCog: ReturnType<typeof vi.fn>) {
  const statuses: Array<{ id: string; status: LayerStatus | null }> = []
  let registered: { id: string; action: AddProtocolAction } | null = null
  const removed: string[] = []
  const sources = new Map<string, Record<string, unknown>>()
  const layers = new Map<string, Record<string, unknown>>()
  const pool = {
    acquire: () => ({
      setRelevance: vi.fn(),
      openCog,
      releaseSources: vi.fn(),
      dispose: vi.fn(),
    }),
  } as unknown as RasterWorkerPool
  const map = {
    addSource: (id: string, source: Record<string, unknown>) => { sources.set(id, source) },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => { sources.delete(id) },
    addLayer: (layer: Record<string, unknown>) => { layers.set(String(layer.id), layer) },
    getLayer: (id: string) => layers.get(id),
    removeLayer: (id: string) => { layers.delete(id) },
  }
  const adapter = createRasterDisplay(map, {
    pool,
    maplibre: {
      addProtocol: (id, action) => { registered = { id, action } },
      removeProtocol: (id) => { removed.push(id) },
    },
    onLayerStatus: (id, status) => { statuses.push({ id, status }) },
  })
  return {
    adapter,
    statuses,
    removed,
    sources,
    layers,
    getRegistered: () => registered,
  }
}

describe('createRasterDisplay', () => {
  it('labels failed single-asset rasters with the item name and a stable reason code when open fails', async () => {
    const rawId = 'lidar-result-1111-gen1-relief'
    const { adapter, statuses } = createTestHarness(
      vi.fn(async () => { throw new Error('HTTP 500 internal COG decoder detail') }),
    )

    adapter.sync([makeSingleAssetLayer(rawId, 'North DEM')], undefined)

    await vi.waitFor(() => {
      expect(statuses).toContainEqual({
        id: rawId,
        status: { kind: 'failed', reason: 'raster-failed', label: 'North DEM' },
      })
    })
    adapter.dispose()
  })

  it('serves ArrayBuffer PNG tiles via MapLibre addProtocol with source maxzoom 22 and draws transparent on per-tile failure', async () => {
    const rawId = 'lidar-result-2222-gen1-elevation'
    const samplePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    let failTile = false
    const { adapter, statuses, removed, sources, layers, getRegistered } = createTestHarness(
      vi.fn(async () => ({
        boundsLonLat: [0, 0, 1, 1],
        renderTilePNG: vi.fn(async () => {
          if (failTile) throw new Error('Corrupt tile block')
          return samplePng
        }),
        renderTileRGBA: vi.fn(async () => null),
      })),
    )

    adapter.sync([makeSingleAssetLayer(rawId, 'South DSM')], undefined)
    const registered = getRegistered()
    expect(registered).not.toBeNull()
    const sourceSpec = [...sources.values()][0]!
    expect(sourceSpec.maxzoom).toBe(22)

    const tileTemplate = (sourceSpec.tiles as string[])[0]!
    const tileUrl = tileTemplate.replace('{z}', '8').replace('{x}', '128').replace('{y}', '127')
    const response = await registered!.action({ url: tileUrl }, new AbortController())
    expect(response.data).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(response.data as ArrayBuffer)).toEqual(samplePng)

    failTile = true
    const fallback = await registered!.action({ url: tileUrl }, new AbortController())
    expect(fallback.data).toBeInstanceOf(ArrayBuffer)
    expect((fallback.data as ArrayBuffer).byteLength).toBeGreaterThan(0)
    expect(statuses.some((entry) => entry.status?.kind === 'failed')).toBe(false)

    adapter.dispose()
    expect(removed).toEqual([registered!.id])
    expect(sources.size).toBe(0)
    expect(layers.size).toBe(0)
  })

  it('short-circuits tile requests after COG open fails until explicit retryLayer', async () => {
    const rawId = 'lidar-result-3333-gen1-storm'
    const samplePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6])
    let shouldFailOpen = true
    const openCog = vi.fn(async () => {
      if (shouldFailOpen) throw new Error('HTTP 500 corrupt COG header')
      return {
        boundsLonLat: [0, 0, 1, 1],
        renderTilePNG: vi.fn(async () => samplePng),
        renderTileRGBA: vi.fn(async () => null),
      }
    })
    const { adapter, statuses, sources, getRegistered } = createTestHarness(openCog)

    adapter.sync([makeSingleAssetLayer(rawId, 'Broken DEM')], undefined)
    await vi.waitFor(() => {
      expect(statuses).toContainEqual({
        id: rawId,
        status: { kind: 'failed', reason: 'raster-failed', label: 'Broken DEM' },
      })
    })
    expect(openCog).toHaveBeenCalledTimes(1)

    const action = getRegistered()!.action
    const template1 = ([...sources.values()][0]!.tiles as string[])[0]!
    const first = await action({ url: template1.replace('{z}', '8').replace('{x}', '128').replace('{y}', '127') }, new AbortController())
    const second = await action({ url: template1.replace('{z}', '8').replace('{x}', '128').replace('{y}', '128') }, new AbortController())
    expect(first.data).toBeInstanceOf(ArrayBuffer)
    expect(second.data).toBeInstanceOf(ArrayBuffer)
    expect(openCog).toHaveBeenCalledTimes(1)

    shouldFailOpen = false
    adapter.retryLayer?.(rawId)
    await vi.waitFor(() => {
      expect(statuses.at(-1)).toEqual({ id: rawId, status: { kind: 'ready' } })
    })
    expect(openCog).toHaveBeenCalledTimes(2)

    const template2 = ([...sources.values()][0]!.tiles as string[])[0]!
    const recovered = await action({ url: template2.replace('{z}', '8').replace('{x}', '128').replace('{y}', '127') }, new AbortController())
    expect(new Uint8Array(recovered.data as ArrayBuffer)).toEqual(samplePng)
    adapter.dispose()
  })

  it('delivers open ready and failed statuses across a mid-open style change', async () => {
    const samplePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 3, 2, 1])
    let resolveOpen!: (value: unknown) => void
    const readyHarness = createTestHarness(vi.fn(() => new Promise((resolve) => { resolveOpen = resolve })))
    const okId = 'lidar-result-4444-gen1-style-ok'
    const baseLayer = makeSingleAssetLayer(okId, 'Mid-open OK')

    readyHarness.adapter.sync([baseLayer], undefined)
    // Style-only update while openCog is still in flight bumps source revision.
    readyHarness.adapter.sync([{ ...baseLayer, colormap: 'terrain', reversed: true, rescale: [5, 95] }], undefined)
    resolveOpen({
      boundsLonLat: [0, 0, 1, 1],
      renderTilePNG: vi.fn(async () => samplePng),
      renderTileRGBA: vi.fn(async () => null),
    })
    await vi.waitFor(() => {
      expect(readyHarness.statuses.at(-1)).toEqual({ id: okId, status: { kind: 'ready' } })
    })
    readyHarness.adapter.dispose()

    let rejectOpen!: (reason: Error) => void
    const failHarness = createTestHarness(vi.fn(() => new Promise((_resolve, reject) => { rejectOpen = reject })))
    const failId = 'lidar-result-5555-gen1-style-fail'
    const failLayer = makeSingleAssetLayer(failId, 'Mid-open Fail')

    failHarness.adapter.sync([failLayer], undefined)
    failHarness.adapter.sync([{ ...failLayer, colormap: 'magma', rescale: [10, 50] }], undefined)
    rejectOpen(new Error('HTTP 503 COG unavailable'))
    await vi.waitFor(() => {
      expect(failHarness.statuses.at(-1)).toEqual({
        id: failId,
        status: { kind: 'failed', reason: 'raster-failed', label: 'Mid-open Fail' },
      })
    })
    failHarness.adapter.dispose()
  })
})
