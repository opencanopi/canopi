import {
  MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID,
  MAPLIBRE_SATELLITE_LAYER_ID,
} from '../../maplibre/config'
import { MAPLIBRE_SHARED_SCENE_LAYER_ID } from '../../maplibre/scene-host-layer'
import { panelTargetMapOverlayIds } from '../../maplibre/panel-target-overlay-sync'
import { siteMapOverlayIds } from '../../maplibre/site-overlay'
import { userLocationOverlayIds } from '../../maplibre/user-location-overlay'
import {
  TERRAIN_CONTOUR_LAYER_IDS,
  TERRAIN_HILLSHADE_LAYER_ID,
} from '../../maplibre/terrain'

type MapLayerBand =
  | 'basemap'
  | 'lidar'
  | 'geographic-reference'
  | 'shared-scene'
  | 'interaction-overlay'

export interface MapLayerStackDescriptor {
  readonly id: string
  readonly band: MapLayerBand
}

export interface MapLayerOrderMap {
  getLayersOrder(): string[]
  moveLayer(id: string, beforeId?: string): void
}

const GEOGRAPHIC_REFERENCE_LAYER_IDS = [
  TERRAIN_HILLSHADE_LAYER_ID,
  ...TERRAIN_CONTOUR_LAYER_IDS,
] as const

// The Site data pin, profile line and chart hover ring draw above the panel highlights, and the user location's
// accuracy and dot above them all.
const SITE_OVERLAY_IDS = siteMapOverlayIds()
const INTERACTION_OVERLAY_LAYER_IDS = [
  ...panelTargetMapOverlayIds('selection').layerIds,
  ...panelTargetMapOverlayIds('hover').layerIds,
  ...SITE_OVERLAY_IDS.layerIds,
  ...SITE_OVERLAY_IDS.hover.layerIds,
  ...userLocationOverlayIds().layerIds,
] as const

const MAP_LAYER_BAND_ORDER: Readonly<Record<MapLayerBand, number>> = {
  basemap: 0,
  lidar: 1,
  'geographic-reference': 2,
  'shared-scene': 3,
  'interaction-overlay': 4,
}

/**
 * The app's semantic order only. Individual modules remain responsible for
 * adding, removing, and painting their own layers and sources.
 */
export function createMapLayerStackDescriptors(
  lidarLayerIds: readonly string[],
): MapLayerStackDescriptor[] {
  return [
    { id: MAPLIBRE_BASEMAP_BACKGROUND_LAYER_ID, band: 'basemap' },
    { id: MAPLIBRE_SATELLITE_LAYER_ID, band: 'basemap' },
    ...lidarLayerIds.map((id) => ({ id, band: 'lidar' as const })),
    ...GEOGRAPHIC_REFERENCE_LAYER_IDS.map((id) => ({ id, band: 'geographic-reference' as const })),
    { id: MAPLIBRE_SHARED_SCENE_LAYER_ID, band: 'shared-scene' },
    ...INTERACTION_OVERLAY_LAYER_IDS.map((id) => ({ id, band: 'interaction-overlay' as const })),
  ]
}

/**
 * Restores the relative order of present Canopi layers. It intentionally does
 * not append the highest semantic layer above unmanaged MapLibre layers.
 */
export function reconcileMapLayerStack(
  map: MapLayerOrderMap,
  descriptors: readonly MapLayerStackDescriptor[],
): void {
  validateDescriptors(descriptors)
  const order = [...map.getLayersOrder()]
  const present = descriptors.map((descriptor) => descriptor.id).filter((id) => order.includes(id))

  // Work from the top semantic pair down. Moving only an inverted lower layer
  // before its immediate higher anchor preserves correct and unmanaged order.
  for (let index = present.length - 2; index >= 0; index -= 1) {
    const lowerId = present[index]!
    const higherAnchorId = present[index + 1]!
    const lowerIndex = order.indexOf(lowerId)
    const higherIndex = order.indexOf(higherAnchorId)
    if (lowerIndex < higherIndex) continue

    map.moveLayer(lowerId, higherAnchorId)
    order.splice(lowerIndex, 1)
    order.splice(higherIndex, 0, lowerId)
  }
}

function validateDescriptors(descriptors: readonly MapLayerStackDescriptor[]): void {
  const ids = new Set<string>()
  let previousBandOrder = -1
  for (const descriptor of descriptors) {
    if (!descriptor.id || descriptor.id.trim() !== descriptor.id) {
      throw new Error('Map layer stack descriptors require stable non-empty IDs.')
    }
    if (ids.has(descriptor.id)) {
      throw new Error(`Map layer stack descriptors contain duplicate ID: ${descriptor.id}.`)
    }
    if (
      descriptor.band !== 'basemap'
      && descriptor.band !== 'lidar'
      && descriptor.band !== 'geographic-reference'
      && descriptor.band !== 'shared-scene'
      && descriptor.band !== 'interaction-overlay'
    ) {
      throw new Error(`Map layer stack descriptor has invalid band: ${String(descriptor.band)}.`)
    }
    const bandOrder = MAP_LAYER_BAND_ORDER[descriptor.band]
    if (bandOrder < previousBandOrder) {
      throw new Error('Map layer stack descriptors are not in semantic band order.')
    }
    previousBandOrder = bandOrder
    ids.add(descriptor.id)
  }
}
