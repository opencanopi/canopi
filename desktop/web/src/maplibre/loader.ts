// maplibre/loader.ts
// Owner of the MapLibre worker setup (worker-only-in-owner, ADR 0028; §18 F16). Invariant:
// MapLibre's worker script is chosen and its URL set only here.

import type { AddProtocolAction, MapOptions } from 'maplibre-gl'

/**
 * MapLibre's own constructor options, with an element container. The workspace and snapshot maps pass
 * `trackResize: false` (their camera driver's setScreen is the one resize owner, spec §1.1 "Resize") and a
 * `transformRequest` closing over the map's credential owner, so a session renewal reaches requests without
 * touching the style or the source.
 */
export type MapLibreMapConstructorOptions = MapOptions & { readonly container: HTMLElement }

/** MapLibre's LngLat as the transform constrain receives and returns it. */
export interface MapLibreLngLat {
  readonly lng: number
  readonly lat: number
}

/**
 * MapLibre's TransformConstrainFunction: called with each candidate centre and zoom (also on intermediate states, such as a new
 * zoom at the old centre), it returns the camera the map keeps. It never sees the bearing.
 */
export type MapLibreTransformConstrain = (lngLat: MapLibreLngLat, zoom: number) => { center: MapLibreLngLat; zoom: number }

export interface MapLibreMapInstance {
  jumpTo(options: { center: [number, number]; zoom: number; bearing: number; pitch?: number }): void
  // Animated camera move; honours the platform reduced-motion preference.
  flyTo?(options: { center: [number, number]; zoom: number; bearing: number }): void
  /** Stops a running flight where it is. */
  stop?(): void
  resize(): void
  remove(): void
  on(type: 'load' | 'style.load' | 'error' | 'sourcedata' | 'idle' | 'move' | 'moveend' | 'resize' | 'webglcontextlost' | 'webglcontextrestored', listener: (event?: unknown) => void): void
  off(type: 'load' | 'style.load' | 'error' | 'sourcedata' | 'idle' | 'move' | 'moveend' | 'resize' | 'webglcontextlost' | 'webglcontextrestored', listener: (event?: unknown) => void): void
  getPitch?(): number
  /** Degrees in (−180, 180]. */
  getBearing?(): number
  /** Replaces MapLibre's whole default constrain (zoom range and the world hold); null restores it. */
  setTransformConstrain?(constrain: MapLibreTransformConstrain | null): void
  getZoom?(): number
  getCenter?(): { lng: number; lat: number }
  getCanvas?(): HTMLCanvasElement
  loaded?(): boolean
  isStyleLoaded?(): boolean
  addSource(id: string, source: Record<string, unknown>): void
  getSource(id: string): { setData(data: unknown): void } | undefined
  removeSource(id: string): void
  addLayer(layer: Record<string, unknown>, beforeId?: string): void
  getLayersOrder(): string[]
  moveLayer(id: string, beforeId?: string): void
  setPaintProperty?(layerId: string, name: string, value: unknown): void
  getLayer(id: string): unknown
  removeLayer(id: string): void
}

export interface MapLibreApi {
  Map: new (options: MapLibreMapConstructorOptions) => MapLibreMapInstance
  addProtocol(id: string, protocol: AddProtocolAction): void
}

let mapLibreModulePromise: Promise<MapLibreApi> | null = null

export function loadMapLibreModule(): Promise<MapLibreApi> {
  if (!mapLibreModulePromise) {
    mapLibreModulePromise = Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
    ])
      .then(([module, worker]) => {
        module.setWorkerUrl(worker.default)
        return module as unknown as MapLibreApi
      })
      .catch((error) => {
        mapLibreModulePromise = null
        throw error
      })
  }
  return mapLibreModulePromise
}
