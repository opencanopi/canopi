// maplibre/user-location-overlay.ts
//
// Show my location's dot and accuracy polygon on the map (canopi-f47t.53; U54 Q11, Q16; design check A2): a pure contract
// from the device reading to one GeoJSON source and its layers in the interaction-overlay band, the Site data overlay's
// pattern. MapLibre's GeolocateControl is reference only: its accuracy circle is a screen-space marker, so here the
// accuracy is a 64-gon on the ground. The source carries only the ground (the dot's and the polygon's lon/lat): never the
// time, the accuracy figure or the stale flag. Drawn by WorkspaceMapContributions.setUserLocation, outside the drain.

import { USER_LOCATION_VISUAL } from '../canvas/runtime/scene-visuals'
import { createSessionPlane } from '../geo/session-plane'
import { clearMapOverlay, syncMapOverlay, type MapLibreOverlayMap } from './panel-target-overlay-sync'

/**
 * The device reading, from the location session (app/my-location/session.ts): where the device is, how far off the fix may
 * be (metres), when it was taken (ms since the epoch) and whether it is stale (the last fix, kept while the browser
 * reports the position unavailable or timed out). It is the user's whereabouts: it lives in the session and on the map
 * only, never in a Design, Draft, export, snapshot, log or diagnostics (plan P52, P53).
 */
export interface UserLocationReading {
  readonly lon: number
  readonly lat: number
  readonly accuracy: number
  readonly timestamp: number
  readonly stale: boolean
}

type UserLocationRole = 'accuracy' | 'dot'

interface UserLocationFeature {
  readonly type: 'Feature'
  readonly geometry:
    | { readonly type: 'Point'; readonly coordinates: readonly [number, number] }
    | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly (readonly [number, number])[])[] }
  readonly properties: { readonly role: UserLocationRole }
}

interface UserLocationLayer {
  readonly id: string
  readonly source: string
  readonly type: 'fill' | 'circle'
  readonly filter: readonly unknown[]
  readonly paint: Readonly<Record<string, string | number>>
}

interface UserLocationOverlayContract {
  readonly source: {
    readonly id: string
    readonly type: 'geojson'
    readonly data: { readonly type: 'FeatureCollection'; readonly features: readonly UserLocationFeature[] }
  }
  readonly layers: readonly UserLocationLayer[]
  readonly hasRenderableFeatures: boolean
}

/** The ids the map seam registers at the top of the interaction-overlay band, back to front. */
export function userLocationOverlayIds() {
  return {
    sourceId: 'user-location-source',
    layerIds: ['user-location-accuracy', 'user-location-ring', 'user-location-core'] as const,
  }
}

const ACCURACY_POLYGON_SIDES = 64
const CORE_RADIUS_PX = 6
const RING_RADIUS_PX = 9
/** A stale core is an outline this wide in the cream ring. */
const STALE_OUTLINE_PX = 2

function roleFilter(role: UserLocationRole): readonly unknown[] {
  return ['==', ['get', 'role'], role]
}

/** A closed ring of `ACCURACY_POLYGON_SIDES` vertices `radius` true WGS84 ground metres around [lon, lat]. */
function accuracyRing(lon: number, lat: number, radius: number): (readonly [number, number])[] {
  const plane = createSessionPlane({ lon, lat })
  const ring = Array.from({ length: ACCURACY_POLYGON_SIDES }, (_, index): readonly [number, number] => {
    const angle = (index / ACCURACY_POLYGON_SIDES) * 2 * Math.PI
    const point = plane.toGeo({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) })
    return [point.lon, point.lat]
  })
  return [...ring, ring[0]!]
}

export function userLocationOverlayContract(reading: UserLocationReading | null): UserLocationOverlayContract {
  const ids = userLocationOverlayIds()
  const features: UserLocationFeature[] = []
  if (reading && Number.isFinite(reading.lon) && Number.isFinite(reading.lat)) {
    const { lon, lat, accuracy } = reading
    if (Number.isFinite(accuracy) && accuracy > 0) {
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [accuracyRing(lon, lat, accuracy)] }, properties: { role: 'accuracy' } })
    }
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { role: 'dot' } })
  }
  const stale = reading?.stale === true
  const [accuracy, ring, core] = ids.layerIds
  return {
    source: { id: ids.sourceId, type: 'geojson', data: { type: 'FeatureCollection', features } },
    layers: [
      {
        id: accuracy,
        source: ids.sourceId,
        type: 'fill',
        filter: roleFilter('accuracy'),
        paint: { 'fill-color': USER_LOCATION_VISUAL.core, 'fill-opacity': USER_LOCATION_VISUAL.accuracyOpacity },
      },
      {
        id: ring,
        source: ids.sourceId,
        type: 'circle',
        filter: roleFilter('dot'),
        paint: { 'circle-radius': RING_RADIUS_PX, 'circle-color': USER_LOCATION_VISUAL.ring },
      },
      {
        id: core,
        source: ids.sourceId,
        type: 'circle',
        filter: roleFilter('dot'),
        paint: {
          'circle-radius': stale ? CORE_RADIUS_PX - STALE_OUTLINE_PX / 2 : CORE_RADIUS_PX,
          'circle-color': USER_LOCATION_VISUAL.core,
          'circle-opacity': stale ? 0 : 1,
          'circle-stroke-color': USER_LOCATION_VISUAL.core,
          'circle-stroke-width': stale ? STALE_OUTLINE_PX : 0,
        },
      },
    ],
    hasRenderableFeatures: features.length > 0,
  }
}

/** Draws the reading with one setData on its own source once the layers are in; null clears them. */
export function syncUserLocationOverlay(map: MapLibreOverlayMap, reading: UserLocationReading | null): void {
  syncMapOverlay(map, userLocationOverlayContract(reading))
}

export function clearUserLocationOverlay(map: MapLibreOverlayMap): void {
  clearMapOverlay(map, userLocationOverlayIds())
}
