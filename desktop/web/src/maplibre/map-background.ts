import { untracked } from '@preact/signals'
import type { BasemapStyle } from '../generated/contracts'
import {
  MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
  MAPLIBRE_SATELLITE_LAYER_ID,
} from './config'
import type { BasemapTileAuth } from './basemap-tile-auth'
import {
  OPENFREEMAP_LAYER_PREFIX,
  VectorBasemap,
  type MapLibreBasemapStatus,
  type VectorBasemapMap,
  type VectorStyleDocument,
} from './openfreemap-basemap'
import {
  createSatelliteImagery,
  mapStyleReadiness,
  mountSatelliteLifecycle,
  type SatelliteMountHandle,
  type SatelliteMountOptions,
} from './satellite-bind'
import type { SatelliteConfig } from './satellite-provider'
import type { SatelliteState, SatelliteViewport } from './satellite-provider-session'

/** The background band's inputs, read from the map layer store and settings. It holds no Google key: it is captured for saved-view thumbnails and compared between frames (P46 guards the key's readers). */
export interface MapBackgroundPresentation {
  readonly basemap: {
    readonly style: BasemapStyle
    readonly visible: boolean
    readonly opacity: number
  }
  readonly satellite: {
    readonly visible: boolean
    readonly opacity: number
  }
  readonly locale: string
}

export function captureMapBackgroundPresentation(
  presentation: MapBackgroundPresentation,
): MapBackgroundPresentation {
  return Object.freeze({
    basemap: Object.freeze({ ...presentation.basemap, opacity: unitInterval(presentation.basemap.opacity) }),
    satellite: Object.freeze({ ...presentation.satellite, opacity: unitInterval(presentation.satellite.opacity) }),
    locale: presentation.locale,
  })
}

export function mapBackgroundPresentationsEqual(
  left: MapBackgroundPresentation,
  right: MapBackgroundPresentation,
): boolean {
  return left.locale === right.locale
    && left.basemap.style === right.basemap.style
    && left.basemap.visible === right.basemap.visible
    && left.basemap.opacity === right.basemap.opacity
    && left.satellite.visible === right.satellite.visible
    && left.satellite.opacity === right.satellite.opacity
}

/** Every layer that belongs to the background band. */
function isMapBackgroundLayer(id: string): boolean {
  return id === MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID
    || id === MAPLIBRE_SATELLITE_LAYER_ID
    || id.startsWith(OPENFREEMAP_LAYER_PREFIX)
}

export type MapBackgroundMap = VectorBasemapMap & SatelliteMountOptions['map'] & {
  getLayersOrder(): string[]
  setPaintProperty(id: string, name: string, value: unknown): void
  isStyleLoaded(): boolean | void
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number }
  getZoom(): number
  addControl(control: object, position: 'bottom-right'): unknown
  removeControl(control: object): unknown
  getContainer(): HTMLElement
}

export interface MapBackgroundOptions {
  readonly map: MapBackgroundMap
  readonly maplibre: unknown
  /** The map's credential owner, created with its request transform. */
  readonly tileAuth: BasemapTileAuth
  /**
   * The Satellite configuration (`readSatelliteConfig` in app/settings): the Google key and locale. Required, so no
   * mount silently falls back to keyless imagery; never part of the presentation, which is captured and compared.
   */
  readonly readSatelliteConfig: () => SatelliteConfig
  readonly lifetime: {
    on(type: string, listener: (event?: unknown) => void): void
    off(type: string, listener: (event?: unknown) => void): void
  }
  readonly loadStyle?: (url: string) => Promise<VectorStyleDocument>
  readonly onError?: (error: unknown) => void
  /**
   * The background's download status for the map notice: Satellite's while it is on (`loading` while a Google session
   * opens, `failed` while it can't load, until Retry), else the Basemap's (hidden is `idle`). Reported once per change.
   */
  readonly onBasemapStatus?: (status: MapLibreBasemapStatus) => void
}

export interface MapBackgroundHandle {
  /** Applies the presentation when it differs from the last one; the same one again does nothing (no download). */
  update(presentation: MapBackgroundPresentation): void
  /**
   * Retry: applies the presentation, downloading a Basemap that couldn't load (its style or its resources) again, and
   * starting Satellite that couldn't load over (a new Google session).
   */
  retry(presentation: MapBackgroundPresentation): void
  /**
   * Claims a map error about the Basemap's sprite or TileJSON (VectorBasemap.claimResourceError), which
   * names no layer: the Basemap shows it couldn't load, and the map is not failed.
   */
  claimMapError(event: unknown): boolean
  /**
   * Whether the latest presentation is on the map: the requested Basemap style
   * installed, or the Satellite layer added and ready (not hidden while a Google
   * session opens or renews). Tile loading is not part of it.
   */
  isApplied(): boolean
  /**
   * Folds the credits into MapLibre's (i) button (true) or keeps them
   * expanded (false), for a surface that knows how much room they have.
   * Until it is called, MapLibre folds them only on a map 640 px or narrower.
   */
  setAttributionCompact(compact: boolean): void
  dispose(): void
}

/**
 * The one owner of a map's background band: the OpenFreeMap Basemap or the
 * Satellite imagery (Satellite on hides the Basemap), plus their single
 * attribution control. Used by every map surface, so no surface binds a
 * basemap on its own. Nothing here calls `setStyle()`.
 */
export function mountMapBackground(options: MapBackgroundOptions): MapBackgroundHandle {
  const { map } = options
  const readiness = mapStyleReadiness(map, options.lifetime)
  const beforeLayerId = () => map.getLayersOrder().find((id) => !isMapBackgroundLayer(id)) ?? null
  const attribution = createAttributionOwner(options.maplibre, map)
  // The one status owner: the Basemap's and Satellite's states, reported as one derived status (canopi-k94s).
  let vectorStatus: MapLibreBasemapStatus = 'idle'
  let satelliteState: SatelliteState['state'] = 'idle'
  let reportedStatus: MapLibreBasemapStatus = 'idle'
  // While apply() runs, the Basemap and Satellite pass through states the band never shows (the Basemap hidden under
  // Satellite, Satellite not yet mounted): the status is reported once apply() is done.
  let applying = false
  const reportStatus = () => {
    if (applying || disposed) return
    const next = presentation?.satellite.visible ? satelliteStatus(satelliteState) : vectorStatus
    if (next === reportedStatus) return
    reportedStatus = next
    options.onBasemapStatus?.(next)
  }
  const vector = new VectorBasemap(map, {
    ...(options.loadStyle ? { loadStyle: options.loadStyle } : {}),
    beforeLayerId,
    ...(options.onError ? { onError: options.onError } : {}),
    onStatus: (status) => {
      vectorStatus = status
      reportStatus()
    },
  })
  // MapLibre is idle only once the Basemap's sprite request has settled (VectorBasemap.claimResourceError).
  const onIdle = () => vector.noteMapIdle()
  options.lifetime.on('idle', onIdle)
  let presentation: MapBackgroundPresentation | null = null
  let satellite: SatelliteMountHandle | null = null
  let disposed = false

  const applySatelliteOpacity = () => {
    if (!presentation || !map.getLayer(MAPLIBRE_SATELLITE_LAYER_ID)) return
    map.setPaintProperty(MAPLIBRE_SATELLITE_LAYER_ID, 'raster-opacity', presentation.satellite.opacity)
  }

  const releaseSatellite = () => {
    satellite?.dispose()
    satellite = null
    satelliteState = 'idle'
    attribution.setSatelliteCredit('')
  }

  const apply = () => {
    if (disposed || !presentation) return
    applying = true
    try {
      applyPresentation(presentation)
    } finally {
      applying = false
    }
    reportStatus()
  }

  const applyPresentation = (current: MapBackgroundPresentation) => {
    vector.update({
      style: current.basemap.style,
      visible: current.basemap.visible && !current.satellite.visible,
      opacity: current.basemap.opacity,
      locale: current.locale,
    })
    if (!current.satellite.visible) {
      releaseSatellite()
      return
    }
    if (!satellite) {
      satellite = mountSatelliteLifecycle({
        provider: createSatelliteImagery(options.tileAuth, options.readSatelliteConfig),
        map,
        readViewport: () => readViewport(map),
        styleReady: readiness,
        beforeLayerId,
        afterApply: applySatelliteOpacity,
        replaceSatelliteAttribution: (credit) => attribution.setSatelliteCredit(credit),
        events: options.lifetime as SatelliteMountOptions['events'],
        onState: (state) => {
          satelliteState = state.state
          reportStatus()
        },
      })
      return
    }
    applySatelliteOpacity()
  }

  // At most one pending style-ready wait: it applies whatever presentation is
  // latest when it fires, so later updates need no wait of their own.
  let cancelReadyWait: (() => void) | null = null
  const schedule = () => {
    if (readiness.isReady()) {
      cancelReadyWait?.()
      cancelReadyWait = null
      apply()
      return
    }
    if (cancelReadyWait) return
    cancelReadyWait = readiness.whenReady(() => {
      cancelReadyWait = null
      apply()
    })
  }

  const show = (next: MapBackgroundPresentation) => {
    presentation = captureMapBackgroundPresentation(next)
    schedule()
  }

  return {
    // A surface may send the same presentation again whenever anything else it reads changes (the view, the visible map
    // area); only a change reaches the band, so a Basemap that failed to download stays failed until Retry (ADR 0004).
    // Untracked: a surface may apply its presentation inside its own effect, and starting Satellite reads the Google key
    // and the locale; only the band's settings observer (satellite-bind.ts) follows them.
    update(next) {
      if (disposed || (presentation && mapBackgroundPresentationsEqual(presentation, next))) return
      untracked(() => show(next))
    },
    retry(next) {
      if (disposed) return
      untracked(() => {
        vector.discardFailedResources()
        show(next)
        // Satellite that couldn't load starts over with a new Google session. Imagery that is showing or loading is
        // left alone: a saved-view capture retries on every frame and must not blank it.
        if (satelliteState === 'unavailable') satellite?.update(readViewport(map))
      })
    },
    claimMapError(event) {
      return !disposed && vector.claimResourceError(event)
    },
    isApplied() {
      if (disposed || !presentation || !readiness.isReady()) return false
      // A Satellite layer kept while a new Google session opens is hidden: only ready imagery is applied.
      if (presentation.satellite.visible) return satelliteState === 'ready' && map.getLayer(MAPLIBRE_SATELLITE_LAYER_ID) != null
      if (presentation.basemap.visible) return vector.installedStyle === presentation.basemap.style
      return true
    },
    setAttributionCompact(compact) {
      if (disposed) return
      attribution.setCompact(compact)
    },
    dispose() {
      if (disposed) return
      disposed = true
      options.lifetime.off('idle', onIdle)
      cancelReadyWait?.()
      cancelReadyWait = null
      releaseSatellite()
      vector.dispose()
      attribution.dispose()
    },
  }
}

/** Satellite's provider state as the notice's status: unavailable is a failure Retry can clear. */
function satelliteStatus(state: SatelliteState['state']): MapLibreBasemapStatus {
  switch (state) {
    case 'idle': return 'idle'
    case 'loading': return 'loading'
    case 'ready': return 'ok'
    case 'unavailable': return 'failed'
  }
}

function readViewport(map: MapBackgroundMap): SatelliteViewport {
  const bounds = map.getBounds()
  return { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth(), zoom: map.getZoom() }
}

/**
 * One attribution control per map. It lists every visible source's
 * attribution (the OpenFreeMap TileJSON credit, the terrain sources' credit) and the Google satellite
 * copyright as custom attribution. Options are fixed when MapLibre adds a
 * control, so a new credit or fold remounts it.
 */
function createAttributionOwner(maplibre: unknown, map: MapBackgroundMap) {
  type AttributionControlClass = new (options?: { compact?: boolean; customAttribution?: string | string[] }) => object
  const Control = (maplibre as { AttributionControl?: AttributionControlClass } | null)?.AttributionControl
  let control: object | null = null
  let credit = ''
  // Unset: MapLibre folds the credits into an (i) button only on a map 640 px
  // wide or narrower, so imagery terms stay readable elsewhere.
  let compact: boolean | undefined
  let foldWatch: MutationObserver | null = null
  // A compact control opens showing its credits and folds on the first map
  // drag, which the workspace map never has: fold it as soon as MapLibre makes
  // it compact (at once, or when the first source credits arrive).
  const foldWhenCompact = () => {
    const credits = map.getContainer().querySelector('.maplibregl-ctrl-attrib')
    if (!credits) return
    const fold = () => {
      if (!credits.classList.contains('maplibregl-compact')) return false
      credits.classList.remove('maplibregl-compact-show')
      return true
    }
    if (fold() || typeof MutationObserver === 'undefined') return
    foldWatch = new MutationObserver(() => {
      if (!fold()) return
      foldWatch?.disconnect()
      foldWatch = null
    })
    foldWatch.observe(credits, { attributes: true, attributeFilter: ['class'] })
  }
  const mount = () => {
    if (!Control) return
    control = new Control({
      ...(compact === undefined ? {} : { compact }),
      ...(credit ? { customAttribution: credit } : {}),
    })
    map.addControl(control, 'bottom-right')
    if (compact) foldWhenCompact()
  }
  const unmount = () => {
    foldWatch?.disconnect()
    foldWatch = null
    if (control) map.removeControl(control)
    control = null
  }
  mount()
  return {
    setSatelliteCredit(next: string) {
      if (next === credit) return
      credit = next
      unmount()
      mount()
    },
    setCompact(next: boolean) {
      if (next === compact) return
      compact = next
      unmount()
      mount()
    },
    dispose: unmount,
  }
}

function unitInterval(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}
