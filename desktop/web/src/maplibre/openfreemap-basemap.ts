// maplibre/openfreemap-basemap.ts
// Owner of the OpenFreeMap style fetch (fetch-only-in-owners, ADR 0028; §18 F15). Invariant:
// the basemap style is fetched only here, from the origin table's origins.

import type { BasemapStyle } from '../generated/contracts'
import type { MapLibreBasemapStatus } from './canvas-surface-state'
import { mapErrorResourceId } from './map-error-owner'

/*
 * OpenFreeMap style presets adapted from GeoLibre
 * packages/core/src/types.ts (OPENFREEMAP_BASEMAPS) at commit e9df9e2.
 * Copyright (c) 2026 Qiusheng Wu. MIT License; see THIRD_PARTY_NOTICES.
 */
export const OPENFREEMAP_BASEMAPS: Readonly<Record<BasemapStyle, string>> = {
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
  positron: 'https://tiles.openfreemap.org/styles/positron',
  bright: 'https://tiles.openfreemap.org/styles/bright',
  dark: 'https://tiles.openfreemap.org/styles/dark',
}

export const OPENFREEMAP_LAYER_PREFIX = 'ofm:'
export const OPENFREEMAP_SOURCE_PREFIX = 'ofm-'

/** The subset of a MapLibre style this module reads. */
export interface VectorStyleDocument {
  readonly glyphs?: string
  readonly sprite?: string | unknown
  readonly sources: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly layers: readonly VectorStyleLayer[]
}

interface VectorStyleLayer {
  readonly id: string
  readonly type: string
  readonly source?: string
  readonly layout?: Readonly<Record<string, unknown>>
  readonly paint?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

/** The map operations the installer needs; a real MapLibre map satisfies it. */
export interface VectorBasemapMap {
  addSource(id: string, source: Record<string, unknown>): void
  getSource(id: string): unknown
  removeSource(id: string): void
  addLayer(layer: Record<string, unknown>, beforeId?: string): void
  getLayer(id: string): unknown
  removeLayer(id: string): void
  setGlobalStateProperty(name: string, value: unknown): void
  setGlyphs(url: string | null): void
  setSprite(url: string | null): void
}

export interface VectorBasemapPresentation {
  readonly style: BasemapStyle
  readonly visible: boolean
  readonly opacity: number
  readonly locale: string
}

export interface VectorBasemapOptions {
  /** Fetches a style document; injected so tests and editions stay offline-capable. */
  readonly loadStyle?: (url: string) => Promise<VectorStyleDocument>
  /** The first Canopi layer the basemap must stay beneath. */
  readonly beforeLayerId?: () => string | null
  readonly onError?: (error: unknown) => void
  /**
   * `loading` while the shown style downloads, `failed` when it could not be downloaded, `ok` once a style is
   * installed, `idle` when hidden.
   */
  readonly onStatus?: (status: MapLibreBasemapStatus) => void
}

const OPACITY_PAINT_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  background: ['background-opacity'],
  fill: ['fill-opacity'],
  line: ['line-opacity'],
  symbol: ['icon-opacity', 'text-opacity'],
  raster: ['raster-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  'fill-extrusion': ['fill-extrusion-opacity'],
  heatmap: ['heatmap-opacity'],
}

/**
 * The row opacity and the label language live in the map's global state, which the installed layers read: a change
 * is one state write, not a rewrite of every layer.
 */
const OPACITY_STATE = 'canopi:basemap-opacity'
const LOCALE_STATE = 'canopi:basemap-locale'
const OPACITY = ['global-state', OPACITY_STATE]
/** Labels in the app locale (`name:<locale>`), falling back to `name`. */
const LOCALIZED_LABEL = ['coalesce', ['get', ['concat', 'name:', ['global-state', LOCALE_STATE]]], ['get', 'name']]

const styleCache = new Map<string, Promise<VectorStyleDocument>>()

/**
 * How long a style download may take, body included. A captive portal or weak hotspot can hold the request open for
 * minutes; past this it fails, so the notice offers Retry (ADR 0004) and the next request starts over.
 */
const BASEMAP_STYLE_TIMEOUT_MS = 20_000

async function fetchStyle(url: string): Promise<VectorStyleDocument> {
  const cached = styleCache.get(url)
  if (cached) return cached
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BASEMAP_STYLE_TIMEOUT_MS)
  const request = fetch(url, { signal: controller.signal }).then(async (response) => {
    if (!response.ok) throw new Error(`Basemap style request failed (${response.status}).`)
    return await response.json() as VectorStyleDocument
  }).catch((error: unknown) => {
    if (controller.signal.aborted) throw new Error('Basemap style request timed out.')
    throw error
  }).finally(() => clearTimeout(timeout))
  styleCache.set(url, request)
  request.catch(() => styleCache.delete(url))
  return request
}

interface Installed {
  readonly style: BasemapStyle
  readonly sourceIds: readonly string[]
  readonly layerIds: readonly string[]
}

/**
 * Installs one OpenFreeMap vector style onto a live map without `setStyle()`,
 * so the map lifetime, camera and Design edits are untouched. Sources and
 * layers are namespaced; row opacity scales every layer's paint opacity; labels
 * follow the app locale (`name:<locale>`, falling back to `name`), both through
 * the map's global state.
 */
export class VectorBasemap {
  private installed: Installed | null = null
  private desired: VectorBasemapPresentation | null = null
  private generation = 0
  private status: MapLibreBasemapStatus = 'idle'
  /** The installed style's sprite or TileJSON failed to download: only Retry installs it again. */
  private resourceFailed = false
  /**
   * The sprite last set on this map. Every OpenFreeMap style names the same one, so a late failure of it is the
   * installed style's whichever style asked, and is claimed silently while none is installed.
   */
  private sprite: string | null = null
  /**
   * The installed style's sprite request may still be running: set by `setSprite`, cleared once the map is idle
   * (MapLibre is idle only after the sprite settled). A sprite that fails after its response arrived (HTML from a
   * captive portal, a body cut off, an undecodable image) reaches the map with no URL and no source.
   */
  private spriteInFlight = false
  private disposed = false

  constructor(
    private readonly map: VectorBasemapMap,
    private readonly options: VectorBasemapOptions = {},
  ) {}

  get installedStyle(): BasemapStyle | null {
    return this.installed?.style ?? null
  }

  update(presentation: VectorBasemapPresentation): void {
    if (this.disposed) return
    this.desired = presentation
    if (!presentation.visible) {
      this.generation += 1
      this.uninstall()
      this.setStatus('idle')
      return
    }
    const installed = this.installed
    // Opacity and language reach the style on screen, also while another style loads or has failed.
    if (installed) this.applyPresentation(presentation)
    if (installed && installed.style === presentation.style) {
      // The style on screen is the one asked for: a load still running for
      // another style is stale, and an earlier failure no longer applies.
      this.generation += 1
      // Nothing downloads on its own (ADR 0004): a style whose resources failed stays failed until Retry.
      if (!this.resourceFailed) this.setStatus('ok')
      return
    }
    // The settling load reads `desired`, so opacity or locale asked for meanwhile still applies. A repeated request
    // joins the download already running: fetchStyle shares it per URL.
    const generation = ++this.generation
    this.setStatus('loading')
    const load = this.options.loadStyle ?? fetchStyle
    load(OPENFREEMAP_BASEMAPS[presentation.style]).then((document) => {
      if (this.disposed || generation !== this.generation) return
      const desired = this.desired
      if (!desired?.visible || desired.style !== presentation.style) return
      this.uninstall()
      this.install(desired, document)
      this.setStatus('ok')
    }).catch((error: unknown) => {
      if (this.disposed || generation !== this.generation) return
      this.setStatus('failed')
      this.options.onError?.(error)
    })
  }

  /**
   * Claims a map error about this basemap's sprite or TileJSON. Such a failure leaves the basemap blank or without
   * icons, so the installed style is `failed` until Retry; one while no style is installed is claimed silently. A
   * TileJSON failure names a basemap source and no tile, with or without a URL (a captive portal's HTML fails to parse
   * after its response arrived); a single tile's failure is not claimed (nor a glyph range: MapLibre draws its glyphs
   * locally and only warns). A sprite failure names its URL and no source, or, after its response arrived, neither:
   * then it is claimed only in a sprite's failure shapes while the installed style's sprite downloads
   * (`spriteInFlight`). Returns whether it was claimed.
   */
  claimResourceError(event: unknown): boolean {
    if (this.disposed) return false
    const sourceId = mapErrorResourceId(event)
    if (sourceId?.startsWith(OPENFREEMAP_SOURCE_PREFIX)) {
      if (typeof event === 'object' && event !== null && 'tile' in event) return false
      if (this.installed?.sourceIds.includes(sourceId)) this.markFailed()
      return true
    }
    const url = failedRequestUrl(event)
    if (url === null) return this.claimSpriteError(event)
    if (spriteOf(url) !== this.sprite) return false
    if (this.installed) this.markFailed()
    return true
  }

  /** The map went idle, so the installed style's sprite request has settled: a later URL-less error is not the sprite's. */
  noteMapIdle(): void {
    this.spriteInFlight = false
  }

  /**
   * A URL-less, sprite-shaped error (`isSpriteShapedError`) naming no source or layer, while the installed style's
   * sprite downloads, is that sprite's. Any other URL-less error stays a map failure.
   */
  private claimSpriteError(event: unknown): boolean {
    if (!this.spriteInFlight || !this.installed || mapErrorResourceId(event) !== null) return false
    if (!isSpriteShapedError(event)) return false
    this.spriteInFlight = false
    this.markFailed()
    return true
  }

  /** Leaves the sprite window open: a TileJSON failure can arrive before the sprite's own. */
  private markFailed(): void {
    this.resourceFailed = true
    this.setStatus('failed')
  }

  /** Retry: a style whose resources failed is removed, so the next update installs it and downloads them again. */
  discardFailedResources(): void {
    if (this.disposed || !this.resourceFailed) return
    this.resourceFailed = false
    this.uninstall()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.uninstall()
  }

  private setStatus(status: MapLibreBasemapStatus): void {
    if (status === this.status) return
    this.status = status
    this.options.onStatus?.(status)
  }

  private install(presentation: VectorBasemapPresentation, document: VectorStyleDocument): void {
    const prepared = prepareOpenFreeMapStyle(document)
    // install() sets only a string sprite, so only its requests can fail.
    const sprite = typeof document.sprite === 'string' ? document.sprite : null
    this.resourceFailed = false
    if (document.glyphs) this.map.setGlyphs(document.glyphs)
    if (sprite !== null) {
      this.sprite = sprite
      this.map.setSprite(sprite)
      this.spriteInFlight = true
    }
    this.applyPresentation(presentation)
    for (const [id, source] of Object.entries(prepared.sources)) this.map.addSource(id, source)
    const beforeId = this.options.beforeLayerId?.() ?? undefined
    for (const layer of prepared.layers) {
      if (beforeId) this.map.addLayer(layer, beforeId)
      else this.map.addLayer(layer)
    }
    this.installed = {
      style: presentation.style,
      sourceIds: Object.keys(prepared.sources),
      layerIds: prepared.layers.map((layer) => layer.id),
    }
  }

  /**
   * Removes only what the style still holds, as every other map teardown does (terrain, overlays, Satellite, rasters):
   * MapLibre destroys the style when the WebGL context goes (map.style is null, getLayer/getSource answer undefined),
   * and the failure path that follows takes the Basemap down (canopi-f47t.52.228.31).
   */
  private uninstall(): void {
    const installed = this.installed
    if (!installed) return
    this.installed = null
    this.spriteInFlight = false
    for (const id of [...installed.layerIds].reverse()) if (this.map.getLayer(id)) this.map.removeLayer(id)
    for (const id of installed.sourceIds) if (this.map.getSource(id)) this.map.removeSource(id)
  }

  /** MapLibre repaints only for a value that changed. */
  private applyPresentation(presentation: VectorBasemapPresentation): void {
    this.map.setGlobalStateProperty(OPACITY_STATE, presentation.opacity)
    this.map.setGlobalStateProperty(LOCALE_STATE, presentation.locale)
  }
}

interface PreparedVectorStyle {
  readonly sources: Record<string, Record<string, unknown>>
  readonly layers: (Record<string, unknown> & { readonly id: string })[]
}

/** Namespaces one style document, its labels reading the locale and its opacities the row opacity. Pure. */
function prepareOpenFreeMapStyle(document: VectorStyleDocument): PreparedVectorStyle {
  const sources: Record<string, Record<string, unknown>> = {}
  for (const [id, source] of Object.entries(document.sources)) {
    sources[`${OPENFREEMAP_SOURCE_PREFIX}${id}`] = { ...source }
  }
  const layers: (Record<string, unknown> & { readonly id: string })[] = []
  for (const layer of document.layers) {
    const id = `${OPENFREEMAP_LAYER_PREFIX}${layer.id}`
    const paint: Record<string, unknown> = { ...(layer.paint ?? {}) }
    for (const property of OPACITY_PAINT_PROPERTIES[layer.type] ?? []) {
      paint[property] = scaleOpacity(layer.paint?.[property])
    }
    const layout: Record<string, unknown> = { ...(layer.layout ?? {}) }
    if (isNameLabel(layout['text-field'])) layout['text-field'] = LOCALIZED_LABEL
    layers.push({
      ...layer,
      id,
      ...(layer.source ? { source: `${OPENFREEMAP_SOURCE_PREFIX}${layer.source}` } : {}),
      layout,
      paint,
    })
  }
  return { sources, layers }
}

/** The sprite a sprite sheet request belongs to: MapLibre requests `<sprite>[@2x].json|png`, query and hash after. */
function spriteOf(url: string): string {
  return url.replace(/[?#].*$/, '').replace(/(?:@2x)?\.(?:json|png)$/, '')
}

/** The URL a failed MapLibre request names: an AJAXError's `url`, else the URL its message ends with. */
function failedRequestUrl(event: unknown): string | null {
  const error = typeof event === 'object' && event !== null && 'error' in event ? (event as { error: unknown }).error : event
  if (typeof error !== 'object' || error === null) return null
  const { url, message } = error as { url?: unknown; message?: unknown }
  if (typeof url === 'string' && url.length > 0) return url
  return typeof message === 'string' ? /(https?:\/\/\S+)\s*$/.exec(message)?.[1] ?? null : null
}

/** The body-read failures browsers raise as a `TypeError` when a download is cut off (WebKit, Chromium, Firefox). */
const CUT_OFF_BODY = /^(?:Load failed|network error|Failed to fetch|NetworkError\b|Error in body stream|terminated)/i

/**
 * The shapes a sprite takes when it fails after its response arrived (MapLibre `load_sprite.ts`): its JSON is not JSON
 * (`SyntaxError`, a captive portal's HTML), its body was cut off (a network `TypeError`), its image is empty or not an
 * image (MapLibre's "Could not load (sprite) image"), or the browser could not decode it (a `DOMException`).
 */
function isSpriteShapedError(event: unknown): boolean {
  const error = typeof event === 'object' && event !== null && 'error' in event ? (event as { error: unknown }).error : event
  if (typeof error !== 'object' || error === null) return false
  const { name, message } = error as { name?: unknown; message?: unknown }
  const text = typeof message === 'string' ? message : ''
  if (name === 'SyntaxError') return true
  if (name === 'InvalidStateError' || name === 'EncodingError') return true
  if (name === 'TypeError') return CUT_OFF_BODY.test(text)
  return /^Could not load (?:sprite )?image\b/.test(text)
}

function isNameLabel(textField: unknown): boolean {
  return textField !== undefined && JSON.stringify(textField).includes('"name')
}

/**
 * Multiplies an opacity paint value by the row opacity's global state. Zoom curves keep their top-level interpolate/step shape
 * (MapLibre requires it), so only their outputs are scaled. A legacy function, which none of the OpenFreeMap styles
 * uses, cannot hold an expression and keeps its own opacity.
 */
function scaleOpacity(value: unknown): unknown {
  if (value === undefined || value === null) return OPACITY
  if (Array.isArray(value)) {
    const operator = value[0]
    if (operator === 'interpolate' || operator === 'interpolate-hcl' || operator === 'interpolate-lab') {
      return value.map((entry, index) => index >= 4 && (index - 4) % 2 === 0 ? scaleOpacity(entry) : entry)
    }
    if (operator === 'step') {
      return value.map((entry, index) => index >= 2 && index % 2 === 0 ? scaleOpacity(entry) : entry)
    }
  } else if (typeof value === 'object') {
    return value
  }
  return ['*', value, OPACITY]
}
