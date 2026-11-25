import type { BasemapStyle, SatelliteSource } from '../../generated/contracts'
import { mutateSettingsProjection, type SettingsPersistMode } from '../settings/projection'
import { normalizeMapLayers, type MapBackground, type MapLayersState } from '../settings/state'

export type MapLayerId = 'basemap' | 'satellite' | 'contours' | 'hillshade'

function updateMapLayers(
  update: (state: MapLayersState) => MapLayersState,
  persist: SettingsPersistMode,
): void {
  mutateSettingsProjection((settings) => {
    settings.mapLayers = normalizeMapLayers(update(settings.mapLayers))
  }, { persist })
}

export function setMapLayerVisible(id: MapLayerId, visible: boolean): void {
  updateMapLayers((state) => ({ ...state, [id]: { ...state[id], visible } }), 'immediate')
}

/** Slider-driven, so persistence is queued rather than written per frame. */
export function setMapLayerOpacity(id: MapLayerId, opacity: number): void {
  if (!Number.isFinite(opacity)) return
  updateMapLayers((state) => ({ ...state, [id]: { ...state[id], opacity } }), 'queued')
}

/** View › Background: Satellite, Map or None. Satellite keeps the Basemap setting underneath. */
export function setMapBackground(background: MapBackground): void {
  updateMapLayers((state) => ({
    ...state,
    satellite: { ...state.satellite, visible: background === 'satellite' },
    basemap: {
      ...state.basemap,
      visible: background === 'satellite' ? state.basemap.visible : background === 'basemap',
    },
  }), 'immediate')
}

export function setBasemapStyle(style: BasemapStyle): void {
  updateMapLayers((state) => ({ ...state, basemap: { ...state.basemap, style } }), 'immediate')
}

export function setContourIntervalMeters(intervalMeters: number): void {
  if (!Number.isFinite(intervalMeters) || intervalMeters < 0) return
  updateMapLayers((state) => ({
    ...state,
    contours: { ...state.contours, intervalMeters: Math.round(intervalMeters) },
  }), 'queued')
}

/**
 * Saves the device-local Google key, trimmed; an empty key clears it. The key
 * is a credential: it lives in device settings only, never in a Design,
 * export, diagnostic bundle or log.
 */
export function saveGoogleMapsApiKey(key: string | null): void {
  const trimmed = key?.trim() ?? ''
  mutateSettingsProjection((settings) => {
    settings.googleMapsApiKey = trimmed || null
    // Saving a key chooses it; Remove key (null) is the only way to forget one.
    settings.satelliteSource = trimmed ? 'google_key' : 'free'
  }, { persist: 'immediate' })
}

/** Settings › Map and imagery › Satellite imagery. Never touches a saved key. */
export function setSatelliteSource(source: SatelliteSource): void {
  mutateSettingsProjection((settings) => {
    settings.satelliteSource = source
  }, { persist: 'immediate' })
}

/**
 * Display on the map › Soften background: dims the Basemap or Satellite under
 * the Design so plant symbols stand out. A device setting, like the rest of
 * the map layer store; it never changes plant colours.
 */
export function setSoftenBackground(soften: boolean): void {
  updateMapLayers((state) => ({ ...state, softenBackground: soften }), 'immediate')
}
