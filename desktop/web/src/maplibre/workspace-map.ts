import { createMapLibreEmptyStyle, MAPLIBRE_MAP_MAX_ZOOM } from './config'
import type { MapLibreApi, MapLibreMapInstance } from './loader'
import { WORKSPACE_MAP_MIN_ZOOM } from '../geo/workspace-camera-policy'
import type { MapBackgroundPresentation } from './map-background'

export interface WorkspaceMapSnapshot {
  /** Where the map starts; the camera owner positions it on attach. */
  readonly initialCenter: { readonly lat: number; readonly lon: number }
  readonly background: MapBackgroundPresentation
}

/**
 * Creates only the local map shell. Remote raster sources are intentionally
 * added by the workspace controls after `style.load` admits this map.
 */
export function createWorkspaceMapLibreMap(
  maplibre: MapLibreApi,
  container: HTMLElement,
  snapshot: WorkspaceMapSnapshot,
  transformRequest: (url: string) => { url: string },
): MapLibreMapInstance {
  return new maplibre.Map({
    container,
    style: createMapLibreEmptyStyle(),
    center: [snapshot.initialCenter.lon, snapshot.initialCenter.lat],
    bearing: 0,
    minZoom: WORKSPACE_MAP_MIN_ZOOM,
    maxZoom: MAPLIBRE_MAP_MAX_ZOOM,
    renderWorldCopies: false,
    // The camera driver's setScreen resizes the map; MapLibre never resizes itself behind it.
    trackResize: false,
    canvasContextAttributes: { antialias: true },
    // Attribution is owned by the basemap mount's single control.
    attributionControl: false,
    interactive: false,
    pitchWithRotate: false,
    dragRotate: false,
    touchZoomRotate: false,
    transformRequest,
  })
}
