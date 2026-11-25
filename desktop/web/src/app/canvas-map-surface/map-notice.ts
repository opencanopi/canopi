import type { CanvasSurfaceState } from './canvas-host'
import { mapBackgroundOf } from '../settings/state'
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
  readonly surface: CanvasSurfaceState
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
  surface,
  t,
}: MapNoticeReadModelInput): MapNoticeReadModel {
  const mapSurfaceVisible = hasDesign && mapVisible
  const notice = !hasDesign ? null : readSurfaceNotice(surface, mapVisible, t)
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

function readSurfaceNotice(
  surface: CanvasSurfaceState,
  mapVisible: boolean,
  t: (key: LocaleKey) => string,
): MapNotice | null {
  const notice = (key: LocaleKey, tone: MapNoticeTone, retry = false): MapNotice => ({ text: t(key), tone, retry })
  if (surface.kind === 'unavailable') return notice('canvas.layers.mapUnavailable', 'error')
  if (surface.kind !== 'map') return mapVisible ? notice('canvas.layers.basemapLoading', 'loading') : null
  if (surface.map.kind === 'failed') {
    return surface.retry === 'offered'
      ? notice('canvas.layers.mapStopped', 'error', true)
      : notice('canvas.layers.mapUnavailable', 'error')
  }
  if (!mapVisible) return null
  if (surface.map.kind !== 'ready') return notice('canvas.layers.basemapLoading', 'loading')
  const background = surface.map.layers.get('background')
  if (background?.kind === 'failed') {
    // One sentence for a rejected Google key and a lost connection: the provider keeps no cause (canopi-k94s).
    const satellite = mapBackgroundOf(presentedMapLayers()) === 'satellite'
    return notice(satellite ? 'canvas.layers.satelliteFailed' : 'canvas.layers.basemapFailed', 'error', true)
  }
  if (background?.kind === 'loading') return notice('canvas.layers.basemapLoading', 'loading')
  for (const [slot, status] of surface.map.layers) {
    if (slot !== 'background' && (status.kind === 'failed' || status.kind === 'skipped')) {
      return notice('canvas.layers.layerSkipped', 'ready')
    }
  }
  return null
}
