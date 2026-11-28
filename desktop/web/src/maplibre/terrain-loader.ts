import {
  DEM_ENCODING,
  DEM_MAX_ZOOM,
  DEM_TILES_URL,
} from './contours'
import type { MapLibreApi } from './loader'
import type { TerrainProtocolSupport } from './terrain'

const TERRAIN_PROTOCOL_ID = 'canopi-terrain'

let terrainSupportPromise: Promise<TerrainProtocolSupport> | null = null

export async function loadMapLibreTerrainSupport(
  maplibre: Pick<MapLibreApi, 'addProtocol'>,
): Promise<TerrainProtocolSupport> {
  if (!terrainSupportPromise) {
    terrainSupportPromise = import('maplibre-contour')
      .then(({ default: contour }) => {
        const demSource = new contour.DemSource({
          url: DEM_TILES_URL,
          id: TERRAIN_PROTOCOL_ID,
          encoding: DEM_ENCODING,
          maxzoom: DEM_MAX_ZOOM,
          cacheSize: 100,
          timeoutMs: 10_000,
          worker: true,
        })
        demSource.setupMaplibre(maplibre)
        return {
          sharedDemProtocolUrl: demSource.sharedDemProtocolUrl,
          contourProtocolUrl: demSource.contourProtocolUrl.bind(demSource),
        }
      })
      .catch((error) => {
        terrainSupportPromise = null
        throw error
      })
  }

  return terrainSupportPromise
}
