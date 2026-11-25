/**
 * app/map-layers/state.ts: Map layers read model and helpers.
 *
 * The settings-backed `mapLayers` signal, `MapLayersState`, and its normalizer
 * live in `app/settings/state.ts` (ADR 0024) and are re-exported here so
 * callers keep their existing import path until 2e-3 folds the slice.
 */
import {
  createDefaultMapLayers,
  mapLayers,
  normalizeMapLayers,
  type MapLayersState,
} from '../settings/state'

export {
  createDefaultMapLayers,
  mapLayers,
  normalizeMapLayers,
  type MapLayersState,
}

/**
 * Soften background multiplies the Basemap or Satellite opacity by this, so
 * the map's light paper shows through and plant symbols stand out.
 */
const SOFTENED_BACKGROUND_OPACITY_FACTOR = 0.4

/** The opacity the background band is drawn with: its own, dimmed when softened. */
export function effectiveBackgroundOpacity(state: MapLayersState, layer: 'basemap' | 'satellite'): number {
  return state[layer].opacity * (state.softenBackground ? SOFTENED_BACKGROUND_OPACITY_FACTOR : 1)
}

/** Which layer paints the background band: Satellite hides the Basemap. */
export type MapBackground = 'satellite' | 'basemap' | 'none'

export function mapBackgroundOf(state: MapLayersState): MapBackground {
  if (state.satellite.visible) return 'satellite'
  return state.basemap.visible ? 'basemap' : 'none'
}

export function hasVisibleMapLayer(state: MapLayersState): boolean {
  return mapBackgroundOf(state) !== 'none' || state.contours.visible || state.hillshade.visible
}

/** Contours and Hillshade in the shape the terrain contribution consumes. */
export function mapTerrainStateOf(state: MapLayersState) {
  return {
    contoursVisible: state.contours.visible,
    contoursOpacity: state.contours.opacity,
    contourIntervalMeters: state.contours.intervalMeters,
    hillshadeVisible: state.hillshade.visible,
    hillshadeOpacity: state.hillshade.opacity,
  }
}
