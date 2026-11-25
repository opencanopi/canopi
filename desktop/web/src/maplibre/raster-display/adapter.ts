/**
 * Canopi raster display adapter: MapLibre `addProtocol` over the shared
 * `cog-tiler-wasm` worker pool (2.1-M543, ADR 0004).
 *
 * Each live map registers its own protocol (`canopi-raster-<n>`), adds one
 * MapLibre raster source (`maxzoom: 22`, 2.1-M553) and raster layer per visible
 * library item, and serves PNG tile `ArrayBuffer`s decoded off the UI thread by `RasterWorkerPool`. Multi-asset items composite
 * intersecting COGs in order (first listed on top, `paintUnder`) before
 * encoding to PNG.
 *
 * Layer identity is caller-owned and must change with the displayed immutable
 * generation, so a stale tile can never be served for newer data under the
 * same MapLibre source. Opacity is a paint-only change; style changes (ramp,
 * reverse, rescale) replace the source with a new revision while keeping open
 * worker sources; asset changes replace the layer and release any URLs no
 * remaining layer reads. `dispose()` removes owned layers and sources,
 * unregisters the protocol, and releases the pool client.
 */
import type { AddProtocolAction } from 'maplibre-gl'
import type { MapLibreApi } from '../loader'
import type { RasterPoolClient, RasterTileRequest, RasterWorkerPool } from './pool'
import type { RasterRenderOptions } from './protocol'
import { rasterWorkerPool } from './pool'
import { recordRaster } from './diagnostics'
import { RASTER_DISPLAY_SOURCE_PREFIX } from '../map-error-owner'
import { reportMapSourceFailure } from '../map-errors'
import type { LayerStatus } from '../map-lifetime'
import { mercatorToGeo } from '../../geo/projection'

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

export interface RasterDisplayOptions {
  /** MapLibre protocol registration API (`addProtocol` / `removeProtocol`). */
  readonly maplibre: Pick<MapLibreApi, 'addProtocol' | 'removeProtocol'>
  /** The adapter added, replaced or removed map layers. */
  readonly onLayersChanged?: () => void
  /** Per-layer status changes (`LayerStatus`, null when the layer is removed; MAP-02). */
  readonly onLayerStatus?: (id: string, status: LayerStatus | null) => void
  readonly pool?: RasterWorkerPool
}

/** Map surface the adapter reads and mutates for raster sources and layers. */
export interface RasterDisplayMap {
  getBounds?(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number }
  getZoom?(): number
  getLayersOrder?(): string[]
  getLayer?(id: string): unknown
  addSource?(id: string, source: Record<string, unknown>): void
  getSource?(id: string): unknown
  removeSource?(id: string): void
  addLayer?(layer: Record<string, unknown>, beforeId?: string): void
  removeLayer?(id: string): void
  moveLayer?(id: string, beforeId?: string): void
  setPaintProperty?(layerId: string, name: string, value: unknown): void
}

export interface RasterDisplay {
  /** Replace the desired layers, bottom first, placed beneath `beforeId`. */
  sync(layers: readonly RasterDisplayLayer[], beforeId: string | undefined): void
  /** Layer ids the adapter currently owns, bottom first. */
  layerIds(): string[]
  /** Retries a single failed raster layer on the live map (MAP-02). */
  retryLayer?(id: string): void
  dispose(): void
}

/**
 * Fixed MapLibre raster source maxzoom (2.1-M553 refining 2.1-M543):
 * preserves base's z22 resolution and W9 overzoom; layer `maxzoom` stays
 * omitted so MapLibre overscales cleanly through WORKSPACE_MAP_MAX_ZOOM.
 */
const MAPLIBRE_RASTER_SOURCE_MAX_ZOOM = 22

/**
 * Layer minzoom: maxzoom is omitted on the layer (source-only maxzoom,
 * 2.1-M543 / 2.1-M553) so MapLibre keeps the layer visible and overscales tiles
 * at all camera zooms through WORKSPACE_MAP_MAX_ZOOM.
 */
const LAYER_MIN_ZOOM = 0

const TILE_SIZE = 256

/** Minimal valid 1×1 transparent RGBA PNG returned for empty or out-of-bounds tiles. */
const EMPTY_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

function emptyPngBuffer(): ArrayBuffer {
  return EMPTY_PNG_BYTES.slice().buffer
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer
  }
  return bytes.slice().buffer
}

function abortError(message = 'Raster tile request aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

interface Applied {
  readonly layer: RasterDisplayLayer
  readonly styleKey: string
  readonly sourceKey: string
  readonly revision: number
  readonly openToken: number
  readonly sourceId: string
}

const protocolSequence = { next: 0 }

function nextProtocolName(): string {
  protocolSequence.next += 1
  return `canopi-raster-${protocolSequence.next}`
}

export function createRasterDisplay(
  map: RasterDisplayMap,
  options: RasterDisplayOptions,
): RasterDisplay {
  const protocol = nextProtocolName()
  const client = (options.pool ?? rasterWorkerPool()).acquire()
  client.setRelevance((tile) => tileIsRelevant(map, tile))
  /** URLs the layers on the map read; only these have worker sources. */
  let readUrls = new Set<string>()
  const sources = displaySources(client, (url) => readUrls.has(url))
  const applied = new Map<string, Applied>()
  const states = new Map<string, LayerStatus>()
  const reportedTileFailure = new Set<string>()
  let desired: readonly RasterDisplayLayer[] = []
  let desiredBeforeId: string | undefined
  let revisionSequence = 0
  let openTokenSequence = 0
  let disposed = false

  const setState = (id: string, next: LayerStatus, error?: Error) => {
    const label = desired.find((layer) => layer.id === id)?.name
      ?? applied.get(id)?.layer.name
    const status: LayerStatus = next.kind === 'failed' && label ? { ...next, label } : next
    const prev = states.get(id)
    if (
      prev
      && prev.kind === status.kind
      && (status.kind !== 'failed' || (prev.kind === 'failed' && prev.reason === status.reason && prev.label === status.label))
    ) {
      return
    }
    states.set(id, status)
    const diagKind = status.kind === 'failed' ? 'layer-error' : status.kind === 'ready' ? 'layer-ready' : 'layer-loading'
    recordRaster({ kind: diagKind, id, detail: error?.message })
    if (status.kind === 'failed') {
      reportMapSourceFailure('Raster display layer failed:', { sourceId: id, error: error ?? new Error(status.reason) })
    }
    options.onLayerStatus?.(id, status)
  }

  const checkAborted = (signal: AbortSignal) => {
    if (disposed || signal.aborted) throw abortError()
  }

  async function renderSingleAsset(
    url: string,
    z: number,
    x: number,
    y: number,
    render: RasterRenderOptions,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const source = await sources.open(url)
    checkAborted(signal)
    const png = await source.renderTilePNG(z, x, y, render)
    checkAborted(signal)
    return png.byteLength > 0 ? toArrayBuffer(png) : emptyPngBuffer()
  }

  async function renderMosaic(
    hitting: readonly RasterDisplayAsset[],
    z: number,
    x: number,
    y: number,
    render: RasterRenderOptions,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const opened = await Promise.all(hitting.map((asset) => sources.open(asset.url)))
    checkAborted(signal)
    const composite = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
    let anyOpaque = false
    for (const source of opened) {
      const rgba = await source.renderTileRGBA(z, x, y, render)
      checkAborted(signal)
      if (!rgba?.length) continue
      const result = paintUnder(composite, rgba)
      if (result.painted) anyOpaque = true
      if (result.complete) break
    }
    if (!anyOpaque) return emptyPngBuffer()
    const png = await client.rgbaToPng(composite, TILE_SIZE, TILE_SIZE)
    checkAborted(signal)
    return png.byteLength > 0 ? toArrayBuffer(png) : emptyPngBuffer()
  }

  const handleTile: AddProtocolAction = async (params, abortController) => {
    const { signal } = abortController
    checkAborted(signal)
    const parsed = parseTileUrl(protocol, params.url)
    const entry = parsed ? applied.get(parsed.layerId) : undefined
    if (!parsed || !entry || entry.revision !== parsed.revision) return { data: emptyPngBuffer() }
    if (states.get(parsed.layerId)?.kind === 'failed') return { data: emptyPngBuffer() }

    const tileBounds = tileBoundsLonLat(parsed.z, parsed.x, parsed.y)
    const hitting = entry.layer.assets.filter((asset) => bboxIntersects(asset.bbox, tileBounds))
    if (hitting.length === 0 || hitting.every((asset) => sources.hasFailed(asset.url))) {
      return { data: emptyPngBuffer() }
    }

    const render = renderOptionsFor(entry.layer)
    try {
      const data = hitting.length === 1
        ? await renderSingleAsset(hitting[0]!.url, parsed.z, parsed.x, parsed.y, render, signal)
        : await renderMosaic(hitting, parsed.z, parsed.x, parsed.y, render, signal)
      return { data }
    } catch (error) {
      if (disposed || signal.aborted || isAbortError(error)) throw abortError()
      // Open failures are already reported once on the layer by addLayerEntry;
      // avoid spamming per-tile errors while panning/zooming over a failed COG.
      if (states.get(parsed.layerId)?.kind === 'failed' || hitting.some((asset) => sources.hasFailed(asset.url))) {
        return { data: emptyPngBuffer() }
      }
      // Match base per-tile behaviour: log the tile failure once per layer open and draw
      // a transparent tile rather than permanently marking a healthy layer failed from one bad tile.
      const err = error instanceof Error ? error : new Error(String(error))
      recordRaster({ kind: 'layer-error', id: parsed.layerId, detail: err.message })
      const reportKey = `${parsed.layerId}:${entry.openToken}`
      if (!reportedTileFailure.has(reportKey)) {
        reportedTileFailure.add(reportKey)
        reportMapSourceFailure('Raster display tile failed:', { sourceId: parsed.layerId, error: err })
      }
      return { data: emptyPngBuffer() }
    }
  }

  options.maplibre.addProtocol(protocol, handleTile)

  function tileUrlFor(layerId: string, revision: number): string {
    return `${protocol}://${encodeURIComponent(layerId)}/${revision}/{z}/{x}/{y}`
  }

  function removeFromMap(layerId: string, sourceId: string): void {
    if (map.getLayer?.(layerId)) map.removeLayer?.(layerId)
    if (map.getSource?.(sourceId)) map.removeSource?.(sourceId)
  }

  function addToMap(layer: RasterDisplayLayer, sourceId: string, revision: number): void {
    if (!map.addSource || !map.addLayer) return
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [tileUrlFor(layer.id, revision)],
      tileSize: TILE_SIZE,
      bounds: [...layer.bounds],
      minzoom: 0,
      maxzoom: MAPLIBRE_RASTER_SOURCE_MAX_ZOOM,
    })
    const anchor = desiredBeforeId && map.getLayer?.(desiredBeforeId) ? desiredBeforeId : undefined
    map.addLayer({
      id: layer.id,
      type: 'raster',
      source: sourceId,
      minzoom: LAYER_MIN_ZOOM,
      paint: {
        'raster-opacity': layer.opacity,
        'raster-fade-duration': 0,
      },
    }, anchor)
  }

  function removeStaleLayers(wanted: Map<string, RasterDisplayLayer>): void {
    const removedUrls = new Set<string>()
    for (const [id, previous] of [...applied.entries()]) {
      const next = wanted.get(id)
      if (next && previous.sourceKey === sourceKey(next)) continue
      removeFromMap(id, previous.sourceId)
      recordRaster({ kind: 'remove', id })
      for (const asset of previous.layer.assets) removedUrls.add(asset.url)
      reportedTileFailure.delete(`${id}:${previous.openToken}`)
      applied.delete(id)
      if (states.delete(id)) options.onLayerStatus?.(id, null)
    }
    readUrls = new Set(desired.flatMap((layer) => layer.assets.map((asset) => asset.url)))
    const unread = [...removedUrls].filter((url) => !readUrls.has(url))
    if (unread.length > 0) sources.release(unread)
  }

  function addLayerEntry(layer: RasterDisplayLayer, styleKey: string): void {
    const revision = ++revisionSequence
    const openToken = ++openTokenSequence
    const sourceId = `${RASTER_DISPLAY_SOURCE_PREFIX}${layer.id}-r${revision}`
    setState(layer.id, { kind: 'loading' })
    recordRaster({ kind: 'add', id: layer.id, detail: `${layer.assets.length} asset(s)` })
    applied.set(layer.id, { layer, styleKey, sourceKey: sourceKey(layer), revision, openToken, sourceId })
    addToMap(layer, sourceId, revision)
    void Promise.all(layer.assets.map((asset) => sources.open(asset.url))).then(() => {
      if (disposed || applied.get(layer.id)?.openToken !== openToken) return
      setState(layer.id, { kind: 'ready' })
      options.onLayersChanged?.()
    }, (error: unknown) => {
      if (disposed || applied.get(layer.id)?.openToken !== openToken || isAbortError(error)) return
      const err = error instanceof Error ? error : new Error(String(error))
      setState(layer.id, { kind: 'failed', reason: 'raster-failed' }, err)
    })
  }

  function syncLayer(layer: RasterDisplayLayer): void {
    const previous = applied.get(layer.id)
    const styleKey = styleKeyOf(layer)
    if (!previous) {
      addLayerEntry(layer, styleKey)
      return
    }
    if (previous.styleKey !== styleKey) {
      const revision = ++revisionSequence
      const sourceId = `${RASTER_DISPLAY_SOURCE_PREFIX}${layer.id}-r${revision}`
      removeFromMap(layer.id, previous.sourceId)
      applied.set(layer.id, {
        layer,
        styleKey,
        sourceKey: previous.sourceKey,
        revision,
        openToken: previous.openToken,
        sourceId,
      })
      addToMap(layer, sourceId, revision)
      return
    }
    if (previous.layer.opacity !== layer.opacity && map.getLayer?.(layer.id)) {
      map.setPaintProperty?.(layer.id, 'raster-opacity', layer.opacity)
    }
    applied.set(layer.id, { ...previous, layer })
  }

  function reconcile(): void {
    if (disposed) return
    removeStaleLayers(new Map(desired.map((layer) => [layer.id, layer])))
    for (const layer of desired) syncLayer(layer)
    if (map.moveLayer) {
      const anchor = desiredBeforeId && map.getLayer?.(desiredBeforeId) ? desiredBeforeId : undefined
      for (const layer of desired) {
        if (map.getLayer?.(layer.id)) map.moveLayer(layer.id, anchor)
      }
    }
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
      return desired.filter((layer) => applied.has(layer.id)).map((layer) => layer.id)
    },
    retryLayer(id) {
      if (disposed) return
      const previous = applied.get(id)
      if (!previous) return
      removeFromMap(id, previous.sourceId)
      sources.clearFailed(previous.layer.assets.map((asset) => asset.url))
      reportedTileFailure.delete(`${id}:${previous.openToken}`)
      applied.delete(id)
      states.delete(id)
      reconcile()
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        for (const [id, entry] of applied) removeFromMap(id, entry.sourceId)
      } finally {
        options.maplibre.removeProtocol?.(protocol)
        applied.clear()
        reportedTileFailure.clear()
        readUrls = new Set()
        states.clear()
        client.dispose()
      }
    },
  }
}

function renderOptionsFor(layer: RasterDisplayLayer): RasterRenderOptions {
  return {
    bidx: [1],
    colormap: layer.colormap,
    reversed: layer.reversed,
    rescale: [[layer.rescale[0], layer.rescale[1]]],
  }
}

function styleKeyOf(layer: RasterDisplayLayer): string {
  return JSON.stringify([layer.colormap, layer.reversed, layer.rescale])
}

function sourceKey(layer: RasterDisplayLayer): string {
  return JSON.stringify(layer.assets.map((asset) => asset.url))
}

function parseTileUrl(protocol: string, url: string): { layerId: string; revision: number; z: number; x: number; y: number } | null {
  const prefix = `${protocol}://`
  if (!url.startsWith(prefix)) return null
  const parts = url.slice(prefix.length).split('/')
  if (parts.length !== 5) return null
  const layerId = decodeURIComponent(parts[0]!)
  const revision = Number(parts[1])
  const z = Number(parts[2])
  const x = Number(parts[3])
  const y = Number(parts[4])
  if (!Number.isInteger(revision) || !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return null
  return { layerId, revision, z, x, y }
}

function tileBoundsLonLat(z: number, x: number, y: number): RasterBounds {
  const n = 2 ** z
  const { lng: west, lat: north } = mercatorToGeo(x / n, y / n)
  const { lng: east, lat: south } = mercatorToGeo((x + 1) / n, (y + 1) / n)
  return [west, south, east, north]
}

function bboxIntersects(a: RasterBounds, b: RasterBounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

/**
 * Composites `src` underneath `dst`: fills only fully transparent destination
 * pixels, so the first asset listed keeps every pixel two assets cover.
 */
function paintUnder(dst: Uint8ClampedArray, src: Uint8Array | Uint8ClampedArray): { complete: boolean; painted: boolean } {
  let complete = true
  let painted = false
  for (let i = 3; i < dst.length; i += 4) {
    if (dst[i] !== 0) continue
    if (src[i] === 0) {
      complete = false
      continue
    }
    dst[i - 3] = src[i - 3]!
    dst[i - 2] = src[i - 2]!
    dst[i - 1] = src[i - 1]!
    dst[i] = src[i]!
    painted = true
  }
  return { complete, painted }
}

/** @testonly */
export function paintUnderForTests(
  dst: Uint8ClampedArray,
  src: Uint8Array | Uint8ClampedArray,
): { complete: boolean; painted: boolean } {
  return paintUnder(dst, src)
}

/**
 * The display's worker sources: one per URL, opened while `isRead(url)`.
 * Layers sharing a URL share its source, so showing and hiding one never opens
 * a second.
 */
function displaySources(client: RasterPoolClient, isRead: (url: string) => boolean) {
  const open = new Map<string, ReturnType<RasterPoolClient['openCog']>>()
  const failed = new Set<string>()
  const openUrl = (url: string): ReturnType<RasterPoolClient['openCog']> => {
    if (!isRead(url)) return Promise.reject(abortError('Raster source is released'))
    let opened = open.get(url)
    if (!opened) {
      const opening = client.openCog(url)
      opening.catch(() => {
        if (open.get(url) === opening) failed.add(url)
      })
      open.set(url, opening)
      opened = opening
    }
    return opened
  }
  return {
    open: openUrl,
    hasFailed: (url: string) => failed.has(url),
    /** Forget failed opens so an explicit Retry can reopen these URLs. */
    clearFailed(urls: readonly string[]) {
      for (const url of urls) {
        if (!failed.delete(url)) continue
        open.delete(url)
      }
    },
    /** Close the sources of URLs no layer reads any more. */
    release(urls: readonly string[]) {
      for (const url of urls) {
        open.delete(url)
        failed.delete(url)
      }
      client.releaseSources(urls)
    },
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
  const [tileWest, tileSouth, tileEast, tileNorth] = tileBoundsLonLat(tile.z, tile.x, tile.y)
  const n = 2 ** tile.z
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
