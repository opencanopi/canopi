/**
 * app/map-layers/state.ts: Compatibility re-export barrel for map-layer state and read helpers.
 *
 * The settings-backed `mapLayers` signal, `MapLayersState`, and read helpers live in
 * `app/settings/state.ts` (ADR 0024) and are re-exported here until 2e-3 folds the slice.
 */
import { DEFAULT_SETTINGS } from '../../generated/settings'
import { mapLayers, normalizeMapLayers, type MapLayersState } from '../settings/state'

export function createDefaultMapLayers(): MapLayersState {
  return normalizeMapLayers({
    basemap: { style: DEFAULT_SETTINGS.basemap_style, visible: DEFAULT_SETTINGS.basemap_visible, opacity: DEFAULT_SETTINGS.basemap_opacity },
    satellite: { visible: DEFAULT_SETTINGS.satellite_visible, opacity: DEFAULT_SETTINGS.satellite_opacity },
    contours: { visible: DEFAULT_SETTINGS.contour_visible, opacity: DEFAULT_SETTINGS.contour_opacity, intervalMeters: DEFAULT_SETTINGS.contour_interval },
    hillshade: { visible: DEFAULT_SETTINGS.hillshade_visible, opacity: DEFAULT_SETTINGS.hillshade_opacity },
    softenBackground: DEFAULT_SETTINGS.soften_background,
  })
}

export { mapLayers, type MapLayersState }
