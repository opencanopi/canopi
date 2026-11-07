import { createMapLibreEmptyStyle } from './config'
import { reportMapSourceFailure } from './map-errors'
import type { MapLibreApi, MapLibreMapInstance } from './loader'

export interface WorldMapLibreMap extends MapLibreMapInstance {
  addControl(control: unknown, position?: string): void
  fitBounds(bounds: WorldMapBounds, options: { padding: number; maxZoom: number; duration: number }): void
  flyTo(options: {
    center: [number, number]
    zoom?: number
    duration?: number
    essential?: boolean
  }): void
  getZoom(): number
  readonly keyboard: { disableRotation(): void }
  readonly touchZoomRotate: { disableRotation(): void }
}

export interface WorldMapMarker {
  setLngLat(lngLat: [number, number]): WorldMapMarker
  addTo(map: WorldMapLibreMap): WorldMapMarker
  remove(): void
  getElement(): HTMLElement
}

export interface WorldMapBounds {
  extend(lngLat: [number, number]): void
  isEmpty(): boolean
}

interface WorldMapLibreApi extends MapLibreApi {
  NavigationControl?: new (options?: {
    visualizePitch?: boolean
    showCompass?: boolean
    showZoom?: boolean
  }) => unknown
  Marker?: new (options: { element: HTMLElement }) => WorldMapMarker
  LngLatBounds?: new () => WorldMapBounds
}

/**
 * A new World map starts at this whole-world view; the selected template's fly-to and the templates' bounds move it.
 * `transformRequest` is the request seam that authenticates official provider tiles.
 */
export function createWorldMapLibreMap(
  maplibre: MapLibreApi,
  container: HTMLElement,
  transformRequest: (url: string) => { url: string },
): WorldMapLibreMap {
  const map = new maplibre.Map({
    container,
    style: createMapLibreEmptyStyle(),
    center: [0, 14],
    zoom: 1.15,
    // Attribution is owned by the map background's single control.
    attributionControl: false,
    interactive: true,
    pitchWithRotate: false,
    dragRotate: false,
    // North-up and flat: two fingers sliding together would tilt it, and no control resets a tilt.
    touchPitch: false,
    // Shift+drag pans like any drag instead of drawing MapLibre's zoom box (spec §4.17).
    boxZoom: false,
    transformRequest,
  }) as unknown as WorldMapLibreMap

  // MapLibre prints an error event nobody listens to on the console, and a
  // failed official tile's message carries its URL with the Google key and
  // session. Every World map error is passive (tiles, sources), so it is only
  // recorded, redacted, and told no one until 2d's map status (2.1-Q300).
  map.on('error', (event) => reportMapSourceFailure('Passive MapLibre World map error:', event))

  // The World map stays north-up: its keyboard handler keeps arrow pans and
  // +/- zoom, but Shift+arrows neither turn nor tilt it (world-map-surface.test.tsx,
  // "Shift+arrow keys do not turn or tilt the World map").
  map.keyboard.disableRotation()
  // A pinch zooms the map, not the page, on a phone; a twist turns nothing (world-map-surface.test.tsx).
  map.touchZoomRotate.disableRotation()

  try {
    const NavigationControl = (maplibre as WorldMapLibreApi).NavigationControl
    if (NavigationControl) {
      map.addControl(new NavigationControl({
        visualizePitch: false,
        showCompass: false,
        showZoom: true,
      }), 'top-right')
    }
  } catch (error) {
    map.remove()
    throw error
  }

  return map
}

export function createWorldMapMarker(
  maplibre: MapLibreApi,
  element: HTMLElement,
): WorldMapMarker {
  const Marker = (maplibre as WorldMapLibreApi).Marker
  if (!Marker) throw new Error('MapLibre Marker constructor unavailable')
  return new Marker({ element })
}

export function createWorldMapBounds(maplibre: MapLibreApi): WorldMapBounds {
  const LngLatBounds = (maplibre as WorldMapLibreApi).LngLatBounds
  if (!LngLatBounds) throw new Error('MapLibre LngLatBounds constructor unavailable')
  return new LngLatBounds()
}
