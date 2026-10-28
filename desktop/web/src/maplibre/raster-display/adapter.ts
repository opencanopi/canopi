/**
 * Canopi raster display adapter: one upstream `LayerManager` per live map.
 *
 * This is the only owner of `maplibre-gl-raster` objects. It selects the
 * `cog-tiler-wasm` engine and injects Canopi collaborators through the public
 * `LayerManagerDeps` seam:
 *
 * - `loadCogTiler` returns a client of the shared worker pool, so decoding,
 *   reprojection and colorizing run off the UI thread;
 * - `loadMosaic` resolves an in-memory ordered asset list for a multi-source
 *   library item, instead of fetching a manifest;
 * - `computeAutoStats` is refused: the library supplies one layer-wide stretch,
 *   so speculative main-thread statistics never run.
 *
 * Layer identity is caller-owned and must change with the displayed immutable
 * generation, so a stale tile can never be served for newer data under the
 * same MapLibre source. Opacity is a paint change; visibility, style and asset
 * changes rebuild only the affected layer. The display holds one worker source
 * per URL, open exactly while a layer on the map reads that URL (see
 * `displaySources`). `dispose()` destroys the manager (its MapLibre layers,
 * sources, protocol and listeners) and releases the pool client, which rejects
 * queued work and closes worker sources.
 */
import type { RasterPoolClient, RasterTileRequest, RasterWorkerPool } from './pool'
import { rasterWorkerPool } from './pool'
import { recordRaster } from './diagnostics'
import { mercatorToGeo } from '../../canvas/projection'
import { WORKSPACE_MAP_MAX_ZOOM } from '../../canvas/workspace-camera-policy'
import type * as MaplibreGlRasterModule from 'maplibre-gl-raster'

type RasterModule = typeof MaplibreGlRasterModule
type LayerManager = InstanceType<RasterModule['LayerManager']>
type LayerManagerMap = ConstructorParameters<RasterModule['LayerManager']>[0]

type RasterBounds = readonly [west: number, south: number, east: number, north: number]

interface RasterDisplayAsset {
  /** Range-readable URL of one immutable display COG. */
  readonly url: string
  /** WGS84 footprint used to cull the asset per tile. */
  readonly bbox: RasterBounds
}

export interface RasterDisplayLayer {
  /** MapLibre layer id; must change when the displayed generation changes. */
  readonly id: string
  readonly name: string
  /** Display COGs, first listed on top where they overlap. */
  readonly assets: readonly RasterDisplayAsset[]
  readonly bounds: RasterBounds
  readonly opacity: number
  /** One layer-wide stretch in the stored units. */
  readonly rescale: readonly [number, number]
  readonly colormap: string
  readonly reversed: boolean
}

type RasterDisplayLayerState = 'loading' | 'ready' | 'error'

export interface RasterDisplayOptions {
  /** The engine added, replaced or removed map layers after an async load. */
  readonly onLayersChanged?: () => void
  readonly loadRasterModule?: () => Promise<RasterModule>
  readonly pool?: RasterWorkerPool
}

/** Map surface the adapter reads for viewport relevance. */
export interface RasterDisplayMap {
  getBounds?(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number }
  getZoom?(): number
  getLayersOrder?(): string[]
  getLayer?(id: string): unknown
  isStyleLoaded?(): boolean
  on?(type: 'idle' | 'sourcedata', listener: () => void): void
  off?(type: 'idle' | 'sourcedata', listener: () => void): void
}

export interface RasterDisplay {
  /** Replace the desired layers, bottom first, placed beneath `beforeId`. */
  sync(layers: readonly RasterDisplayLayer[], beforeId: string | undefined): void
  /** Layer ids the manager currently owns, bottom first. */
  layerIds(): string[]
  dispose(): void
}

const MOSAIC_SCHEME = 'canopi-display-mosaic'

/**
 * The deepest tile zoom MapLibre asks a raster source for: the engine adds its
 * sources without a maxzoom, so MapLibre's raster default applies and closer
 * camera zooms overscale these tiles.
 */
const MAPLIBRE_RASTER_SOURCE_MAX_ZOOM = 22

/**
 * Layer zoom range: upstream defaults a layer's maxZoom to 24 and MapLibre hides
 * a layer at `zoom >= maxzoom`, while the camera reaches WORKSPACE_MAP_MAX_ZOOM.
 * Finite, so the style stays serialisable.
 */
const LAYER_MIN_ZOOM = 0
const LAYER_MAX_ZOOM = WORKSPACE_MAP_MAX_ZOOM + 1

interface Applied {
  readonly layer: RasterDisplayLayer
  readonly styleKey: string
  readonly sourceKey: string
}

export function createRasterDisplay(
  map: RasterDisplayMap,
  options: RasterDisplayOptions = {},
): RasterDisplay {
  const client = (options.pool ?? rasterWorkerPool()).acquire()
  client.setRelevance((tile) => tileIsRelevant(map, tile))
  const mosaics = new Map<string, RasterDisplayLayer>()
  /** URLs the layers on the map read; only these have worker sources. */
  let readUrls = new Set<string>()
  const sources = displaySources(client, (url) => readUrls.has(url))
  const applied = new Map<string, Applied>()
  const states = new Map<string, RasterDisplayLayerState>()
  let manager: LayerManager | null = null
  let desired: readonly RasterDisplayLayer[] = []
  let desiredBeforeId: string | undefined
  let disposed = false
  let nudging = false

  /**
   * The engine gates its first map mutation on `isStyleLoaded()`, which is
   * false while any source (the basemap) is still loading, and then waits for
   * a style event that a settled style never emits. Until every desired layer
   * reaches the map, re-apply once the style reports loaded. The re-apply waits for the event's own task to finish:
   * MapLibre fires 'sourcedata' synchronously inside the engine's restyle (between removing a layer's source and adding
   * it again), and re-entering the engine there adds the source twice ("Source … already exists").
   */
  // upstream: W4
  let nudgeQueued = false
  const nudge = () => {
    if (nudgeQueued) return
    nudgeQueued = true
    queueMicrotask(() => {
      nudgeQueued = false
      nudgeNow()
    })
  }
  const nudgeNow = () => {
    if (disposed || !manager) return stopNudging()
    const missing = desired.some((layer) => applied.has(layer.id) && map.getLayer?.(layer.id) == null)
    if (!missing) return stopNudging()
    if (!map.isStyleLoaded?.()) return
    const first = desired.find((layer) => applied.has(layer.id) && map.getLayer?.(layer.id) == null)
    if (first) manager.setState(first.id, {})
  }
  const startNudging = () => {
    if (nudging || !map.on || !map.getLayer) return
    nudging = true
    map.on('idle', nudge)
    map.on('sourcedata', nudge)
  }
  function stopNudging(): void {
    if (!nudging) return
    nudging = false
    map.off?.('idle', nudge)
    map.off?.('sourcedata', nudge)
  }

  const setState = (id: string, next: RasterDisplayLayerState, error?: Error) => {
    if (states.get(id) === next) return
    states.set(id, next)
    recordRaster({ kind: `layer-${next}`, id, detail: error?.message })
  }

  const load = options.loadRasterModule ?? (() => import('maplibre-gl-raster'))
  void load().then((module) => {
    if (disposed) return
    // upstream: W2
    // upstream: W6 (no loadGeoTIFF here: the engine reads COG headers on the UI thread)
    // The published declaration types `loadCogTiler` through a symbol the
    // pinned `cog-tiler-wasm` does not export, so the deps are cast once here.
    const deps = {
      loadCogTiler: async () => sources.module,
      loadMosaic: async (url: string) => mosaicFor(mosaics, url),
      computeAutoStats: () => Promise.reject(new Error('display statistics come from the library')),
    }
    manager = new module.LayerManager(map as unknown as LayerManagerMap, { engine: 'cog-tiler-wasm' }, deps as never)
    manager.on('rasterchange', (event) => {
      recordRaster({ kind: 'rasterchange', id: event.layerId, detail: map.getLayersOrder?.().filter((id) => id.startsWith('lidar-')).join(',') })
      if (!event.layerId) return
      const layer = manager?.getLayer(event.layerId)
      if (!layer) return
      if (layer.error) setState(event.layerId, 'error', layer.error)
      else if (!layer.loading) setState(event.layerId, 'ready')
      options.onLayersChanged?.()
    })
    manager.on('error', (event) => {
      if (event.layerId) setState(event.layerId, 'error', event.error)
    })
    reconcile()
  }, (error: unknown) => {
    if (disposed) return
    for (const layer of desired) setState(layer.id, 'error', error instanceof Error ? error : new Error(String(error)))
  })

  function reconcile(): void {
    const current = manager
    if (!current || disposed) return
    const wanted = new Map(desired.map((layer) => [layer.id, layer]))
    const removedUrls = new Set<string>()
    for (const id of [...applied.keys()]) {
      const next = wanted.get(id)
      const previous = applied.get(id)!
      if (next && previous.sourceKey === sourceKey(next)) continue
      current.removeRaster(id)
      recordRaster({ kind: 'remove', id })
      for (const asset of previous.layer.assets) removedUrls.add(asset.url)
      applied.delete(id)
      mosaics.delete(id)
      states.delete(id)
    }
    // Every desired layer is on the map once this pass ends. The engine only
    // forgets a dropped layer's COG proxies; close the worker sources no layer
    // reads any more.
    readUrls = new Set(desired.flatMap((layer) => layer.assets.map((asset) => asset.url)))
    const unread = [...removedUrls].filter((url) => !readUrls.has(url))
    if (unread.length > 0) sources.release(unread)
    desired.forEach((layer, index) => {
      const previous = applied.get(layer.id)
      const styleKey = styleKeyOf(layer)
      if (!previous) {
        const url = layer.assets.length === 1
          ? layer.assets[0]!.url
          : registerMosaic(mosaics, layer)
        setState(layer.id, 'loading')
        recordRaster({ kind: 'add', id: layer.id, detail: `${layer.assets.length} asset(s)` })
        applied.set(layer.id, { layer, styleKey, sourceKey: sourceKey(layer) })
        current.addRaster(url, {
          id: layer.id,
          name: layer.name,
          zoomTo: false,
          beforeId: desiredBeforeId,
          state: stateFor(layer),
        }).catch((error: unknown) => {
          if (disposed || applied.get(layer.id)?.layer !== layer) return
          setState(layer.id, 'error', error instanceof Error ? error : new Error(String(error)))
        })
      } else {
        if (previous.styleKey !== styleKey) {
          current.setState(layer.id, stateFor(layer))
        } else if (previous.layer.opacity !== layer.opacity) {
          current.setState(layer.id, { opacity: layer.opacity })
        }
        applied.set(layer.id, { layer, styleKey, sourceKey: previous.sourceKey })
        current.setBeforeId(layer.id, desiredBeforeId ?? null)
      }
      const order = current.getLayers().findIndex((candidate) => candidate.id === layer.id)
      if (order !== index && order >= 0) current.reorder(layer.id, index)
    })
    if (desired.length > 0) startNudging()
    options.onLayersChanged?.()
  }

  return {
    sync(layers, beforeId) {
      if (disposed) return
      recordRaster({ kind: 'sync', detail: `${layers.map((layer) => layer.id).join(',')} before ${beforeId ?? '-'}` })
      desired = layers
      desiredBeforeId = beforeId
      reconcile()
    },
    layerIds() {
      return manager ? manager.getLayers().map((layer) => layer.id) : []
    },
    dispose() {
      if (disposed) return
      disposed = true
      stopNudging()
      try {
        manager?.destroy()
      } finally {
        manager = null
        applied.clear()
        mosaics.clear()
        readUrls = new Set()
        states.clear()
        client.dispose()
      }
    },
  }
}

function stateFor(layer: RasterDisplayLayer) {
  return {
    mode: 'single' as const,
    bands: [1],
    colormap: layer.colormap,
    reversed: layer.reversed,
    rescale: [[layer.rescale[0], layer.rescale[1]]] as [number, number][],
    // Each derivative carries its own validity tag; one override value could
    // not describe sources with different NoData markers.
    nodata: 'auto' as const,
    opacity: layer.opacity,
    visible: true,
    minZoom: LAYER_MIN_ZOOM,
    maxZoom: LAYER_MAX_ZOOM,
  }
}

function styleKeyOf(layer: RasterDisplayLayer): string {
  return JSON.stringify([layer.colormap, layer.reversed, layer.rescale])
}

function sourceKey(layer: RasterDisplayLayer): string {
  return JSON.stringify(layer.assets.map((asset) => asset.url))
}

function registerMosaic(mosaics: Map<string, RasterDisplayLayer>, layer: RasterDisplayLayer): string {
  mosaics.set(layer.id, layer)
  return `${MOSAIC_SCHEME}://layer/${encodeURIComponent(layer.id)}.json`
}

/**
 * The display's worker sources: one per URL, opened while `isRead(url)`.
 *
 * `module` is the cog-tiler client the engine loads. Its proxies look up their
 * URL's current source at each render instead of holding one handle, because
 * the engine keeps proxies past their layer: maplibre-gl-raster 0.14.15's
 * `CogTilerEngine._assetSources` (RasterControl chunk, `_openAsset`) caches a
 * mosaic's asset proxies by URL until `destroy()` and reuses them when a mosaic
 * is added again (canopi-ana9, pinned by ana9-mosaic-release.test.ts). A kept
 * proxy whose URL no layer reads renders nothing; once a layer reads the URL
 * again, its next render reopens the source. Layers sharing a URL share its
 * source, so showing and hiding one never opens a second.
 */
// upstream: W1
function displaySources(client: RasterPoolClient, isRead: (url: string) => boolean) {
  const open = new Map<string, ReturnType<RasterPoolClient['openCog']>>()
  const sourceFor = (url: string): ReturnType<RasterPoolClient['openCog']> => {
    if (!isRead(url)) {
      const error = new Error('Raster source is released')
      error.name = 'AbortError'
      return Promise.reject(error)
    }
    let opened = open.get(url)
    if (!opened) {
      const opening = client.openCog(url)
      opening.catch(() => {
        if (open.get(url) === opening) open.delete(url)
      })
      open.set(url, opening)
      opened = opening
    }
    return opened
  }
  const module: RasterPoolClient = {
    ...client,
    async openCog(url) {
      const source = await sourceFor(url)
      return {
        boundsLonLat: source.boundsLonLat,
        renderTilePNG: async (z, x, y, render) => (await sourceFor(url)).renderTilePNG(z, x, y, render),
        renderTileRGBA: async (z, x, y, render) => (await sourceFor(url)).renderTileRGBA(z, x, y, render),
      }
    },
  }
  return {
    module,
    /** Close the sources of URLs no layer reads any more. */
    release(urls: readonly string[]) {
      for (const url of urls) open.delete(url)
      client.releaseSources(urls)
    },
  }
}

function mosaicFor(mosaics: Map<string, RasterDisplayLayer>, url: string) {
  const match = url.match(new RegExp(`^${MOSAIC_SCHEME}://layer/(.+)\\.json$`))
  const layer = match ? mosaics.get(decodeURIComponent(match[1]!)) : undefined
  if (!layer) throw new Error(`Unknown display mosaic ${url}`)
  const [west, south, east, north] = layer.bounds
  return {
    kind: 'mosaicjson' as const,
    assets: layer.assets.map((asset) => ({ url: asset.url, bbox: [...asset.bbox] as [number, number, number, number] })),
    bounds: { west, south, east, north },
    minzoom: null,
    maxzoom: null,
  }
}

/**
 * Whether a queued tile still intersects the live viewport (padded by one
 * tile) at a tile zoom MapLibre could still want. Tiles MapLibre has already
 * abandoned are dropped before they reach a worker.
 */
export function tileIsRelevant(map: RasterDisplayMap, tile: RasterTileRequest): boolean {
  const bounds = map.getBounds?.()
  const cameraZoom = map.getZoom?.()
  if (!bounds || cameraZoom === undefined) return true
  // Past the source's deepest tile zoom MapLibre keeps asking for those tiles.
  const zoom = Math.min(cameraZoom, MAPLIBRE_RASTER_SOURCE_MAX_ZOOM)
  if (tile.z < Math.floor(zoom) - 2 || tile.z > Math.ceil(zoom) + 1) return false
  const n = 2 ** tile.z
  const { lng: tileWest, lat: tileNorth } = mercatorToGeo(tile.x / n, tile.y / n)
  const { lng: tileEast, lat: tileSouth } = mercatorToGeo((tile.x + 1) / n, (tile.y + 1) / n)
  const padX = 360 / n
  const padY = Math.max(tileNorth - tileSouth, 1e-9)
  const west = bounds.getWest() - padX
  const east = bounds.getEast() + padX
  const south = bounds.getSouth() - padY
  const north = bounds.getNorth() + padY
  // Longitudes may be unwrapped past ±180 around world copies; compare modulo.
  const wraps = east - west >= 360
  const overlapsX = wraps || [0, -360, 360].some((shift) => tileEast + shift >= west && tileWest + shift <= east)
  return overlapsX && tileNorth >= south && tileSouth <= north
}
