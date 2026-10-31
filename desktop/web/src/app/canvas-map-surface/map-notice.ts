import type { MapLibreCanvasSurfaceState } from '../../maplibre/canvas-surface-state'
import { mapBackgroundOf } from '../map-layers/state'
import { presentedMapLayers } from '../story-presentation/overrides'
import type { LocaleKey } from '../../generated/locale-keys'

type MapNoticeTone = 'loading' | 'ready' | 'error'

export interface MapNoticeReadModel {
  readonly visible: boolean
  readonly mapSurfaceVisible: boolean
  readonly tone: MapNoticeTone
  readonly statusText: string
  /** The notice offers Retry. */
  readonly retry: boolean
}

export interface MapNoticeReadModelInput {
  readonly hasDesign: boolean
  readonly mapVisible: boolean
  readonly mapSurface: MapLibreCanvasSurfaceState
  readonly t: (key: LocaleKey) => string
}

/**
 * Reports the map, basemap and terrain status for the open Design's map canvas. Every notice is a fixed
 * localized sentence, never the engine's error text, so no URL or key can reach it. A map failure shows
 * whatever background rows are visible, because a lost map takes the drawing and editing with it.
 */
export function getMapNoticeReadModel({
  hasDesign,
  mapVisible,
  mapSurface,
  t,
}: MapNoticeReadModelInput): MapNoticeReadModel {
  const mapSurfaceVisible = hasDesign && mapVisible
  const notice = !hasDesign
    ? null
    : mapSurface.status === 'error'
      ? readMapFailure(mapSurface, t)
      : mapVisible
        ? readMapNotice(mapSurface, t)
        : null
  return {
    visible: notice !== null,
    mapSurfaceVisible,
    tone: notice?.tone ?? 'ready', // a hidden notice's tone is never shown
    statusText: notice?.text ?? '',
    retry: notice?.retry ?? false,
  }
}

interface MapNotice {
  readonly text: string
  readonly tone: MapNoticeTone
  readonly retry: boolean
}

/** A map failure, with Retry when the map can be rebuilt. */
function readMapFailure(mapSurface: MapLibreCanvasSurfaceState, t: (key: LocaleKey) => string): MapNotice {
  return mapSurface.retryable
    ? { text: t('canvas.layers.mapStopped'), tone: 'error', retry: true }
    : { text: t('canvas.layers.mapUnavailable'), tone: 'error', retry: false }
}

/**
 * Below a map failure, by rank: a background that couldn't load (the Basemap, or Satellite while it is on, which hides
 * the Basemap: the status is the one the map draws), loading (the map, a Basemap download or Satellite's Google
 * session, so a Retry shows progress and cannot restart it), then a skipped layer or terrain.
 */
function readMapNotice(mapSurface: MapLibreCanvasSurfaceState, t: (key: LocaleKey) => string): MapNotice | null {
  if (mapSurface.basemapStatus === 'failed') {
    // One sentence for a rejected Google key and a lost connection: the provider keeps no cause (canopi-k94s).
    const satellite = mapBackgroundOf(presentedMapLayers()) === 'satellite'
    return { text: t(satellite ? 'canvas.layers.satelliteFailed' : 'canvas.layers.basemapFailed'), tone: 'error', retry: true }
  }
  if (mapSurface.basemapStatus === 'loading') return { text: t('canvas.layers.basemapLoading'), tone: 'loading', retry: false }
  if (mapSurface.status !== 'ready') return { text: t('canvas.layers.basemapLoading'), tone: 'loading', retry: false }
  if (mapSurface.terrainStatus === 'error' || mapSurface.layerSkipped) {
    return { text: t('canvas.layers.layerSkipped'), tone: 'ready', retry: false }
  }
  return null
}
