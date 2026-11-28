// The workspace map past MapLibre's tile pyramid. The canvas zooms to WORKSPACE_MAP_MAX_ZOOM (27) but MapLibre's tile ids stop at
// z25; a background layer (the empty style's, and every basemap style's) draws over coveringTiles(transform), which threw
// "z=26 outside of bounds" on every frame and blanked all MapLibre layers. Runs MapLibre's own sources (the test-only
// `maplibre-gl-source` alias, vite.config.ts) with the options createWorkspaceMapLibreMap passes and the camera driver's guard.

import { signal } from '@preact/signals'
import { describe, expect, it } from 'vitest'
import { LngLat as SourceLngLatClass } from 'maplibre-gl-source/geo/lng_lat.ts'
import { MercatorTransform as SourceMercatorTransform } from 'maplibre-gl-source/geo/projection/mercator_transform.ts'
import { coveringTiles as sourceCoveringTiles } from 'maplibre-gl-source/geo/projection/covering_tiles.ts'
import { createNavigationPolicy } from '../geo/view/navigation-policy'
import { createSessionPlane } from '../geo/session-plane'
import { WORKSPACE_MAP_MAX_ZOOM } from '../geo/workspace-camera-policy'
import { createMapLibreCameraDriver, type MapLibreCameraDriverMap } from './camera-driver'
import type { MapLibreApi, MapLibreMapConstructorOptions, MapLibreMapInstance } from './loader'
import { createWorkspaceMapLibreMap } from './workspace-map'

interface SourceTransform {
  readonly zoom: number
  readonly center: { lng: number; lat: number }
  readonly bearing: number
  readonly tileSize: number
  resize(width: number, height: number): void
  setZoom(zoom: number): void
  setCenter(center: unknown): void
  setBearing(bearing: number): void
  setConstrainOverride(constrain: unknown): void
}
const MercatorTransform = SourceMercatorTransform as new (options: { minZoom: number; maxZoom: number; renderWorldCopies: boolean }) => SourceTransform
const LngLat = SourceLngLatClass as new (lng: number, lat: number) => unknown
const coveringTiles = sourceCoveringTiles as (transform: SourceTransform, options: { tileSize: number }) => unknown[]

const SCREEN = { width: 800, height: 600, devicePixelRatio: 1 }

function workspaceMapOptions(): MapLibreMapConstructorOptions {
  let captured: MapLibreMapConstructorOptions | null = null
  const maplibre = {
    Map: class {
      constructor(options: MapLibreMapConstructorOptions) {
        captured = options
      }
    },
    addProtocol() {},
  } as unknown as MapLibreApi
  createWorkspaceMapLibreMap(maplibre, {} as HTMLElement, {
    initialCenter: { lat: 48.8566, lon: 2.3522 },
    background: {} as never,
  }, (url) => ({ url }))
  return captured!
}

/** The workspace map's transform with the camera driver attached, as MapLibre's jumpTo drives it. */
function attachedWorkspaceTransform() {
  const options = workspaceMapOptions()
  const transform = new MercatorTransform({ minZoom: options.minZoom!, maxZoom: options.maxZoom!, renderWorldCopies: false })
  transform.resize(SCREEN.width, SCREEN.height)
  transform.setZoom(18)
  transform.setCenter(new LngLat(2.3522, 48.8566))
  const canvas = { clientWidth: SCREEN.width, clientHeight: SCREEN.height, width: SCREEN.width }
  const map: MapLibreCameraDriverMap = {
    jumpTo(target) {
      if (transform.zoom !== target.zoom) transform.setZoom(target.zoom!)
      transform.setCenter(new LngLat((target.center as [number, number])[0], (target.center as [number, number])[1]))
      if (transform.bearing !== target.bearing) transform.setBearing(target.bearing!)
    },
    flyTo() {},
    stop() {},
    resize() {},
    on() { return map as unknown as MapLibreMapInstance },
    off() { return map as unknown as MapLibreMapInstance },
    getCenter: () => transform.center as never,
    getZoom: () => transform.zoom,
    getBearing: () => transform.bearing,
    getPitch: () => 0,
    setTransformConstrain: (constrain) => {
      transform.setConstrainOverride(constrain)
      return map as unknown as MapLibreMapInstance
    },
    getCanvas: () => canvas as unknown as HTMLCanvasElement,
  } as MapLibreCameraDriverMap
  const plane = createSessionPlane({ lon: 2.3522, lat: 48.8566 })
  const policy = createNavigationPolicy(plane.origin.lat, signal(false))
  const driver = createMapLibreCameraDriver(map, plane, { policy: () => policy })
  expect(driver.failure.peek()).toBeNull()
  return { transform, driver }
}

describe('workspace map past the tile pyramid', () => {
  it.each([26.5, WORKSPACE_MAP_MAX_ZOOM])('zooms to %s and a background layer still finds its tiles', (zoom) => {
    const { transform, driver } = attachedWorkspaceTransform()
    driver.apply({ kind: 'zoom-around', anchorPx: { x: SCREEN.width / 2, y: SCREEN.height / 2 }, factor: 2 ** (zoom - transform.zoom) })

    expect(transform.zoom).toBeCloseTo(zoom, 6)
    // draw_background.ts: coveringTiles(transform, {tileSize: transform.tileSize}) on every frame.
    expect(() => coveringTiles(transform, { tileSize: transform.tileSize })).not.toThrow()
  })
})
