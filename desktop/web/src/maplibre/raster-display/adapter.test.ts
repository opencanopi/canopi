// maplibre/raster-display/adapter.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { LayerStatus } from '../map-lifetime'
import { createRasterDisplay, type RasterDisplayLayer } from './adapter'
import type { RasterWorkerPool } from './pool'

function makePool(): RasterWorkerPool {
  return {
    acquire: () => ({
      setRelevance: vi.fn(),
      openCog: vi.fn(),
      dispose: vi.fn(),
    }),
  } as unknown as RasterWorkerPool
}

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

describe('createRasterDisplay', () => {
  it('labels failed single-asset rasters with the item name and a stable reason code', async () => {
    const statuses: Array<{ id: string; status: LayerStatus | null }> = []
    const rawId = 'lidar-result-1111-gen1-relief'

    class FakeLayerManager {
      on() {}
      getLayers() { return [] }
      getLayer() { return undefined }
      async addRaster() { throw new Error('HTTP 500 internal COG decoder detail') }
      removeRaster() {}
      setState() {}
      setBeforeId() {}
      reorder() {}
      destroy() {}
    }

    const adapter = createRasterDisplay({}, {
      pool: makePool(),
      loadRasterModule: async () => ({ LayerManager: FakeLayerManager } as never),
      onLayerStatus: (id, status) => { statuses.push({ id, status }) },
    })

    adapter.sync([makeSingleAssetLayer(rawId, 'North DEM')], undefined)

    await vi.waitFor(() => {
      expect(statuses).toContainEqual({
        id: rawId,
        status: { kind: 'failed', reason: 'raster-failed', label: 'North DEM' },
      })
    })
    adapter.dispose()
  })

  it('labels failed rasters with the item name and stable module-load code when the raster module fails to load', async () => {
    const statuses: Array<{ id: string; status: LayerStatus | null }> = []
    const rawId = 'lidar-result-2222-gen1-elevation'

    const adapter = createRasterDisplay({}, {
      pool: makePool(),
      loadRasterModule: async () => { throw new Error('Failed to fetch dynamic module') },
      onLayerStatus: (id, status) => { statuses.push({ id, status }) },
    })

    adapter.sync([makeSingleAssetLayer(rawId, 'South DSM')], undefined)

    await vi.waitFor(() => {
      expect(statuses).toContainEqual({
        id: rawId,
        status: { kind: 'failed', reason: 'module-load', label: 'South DSM' },
      })
    })
    adapter.dispose()
  })
})
