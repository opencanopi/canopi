import { toggleLayerRow } from './open-row'
import {
  setCanvasLayerPresentationContourIntervalMeters,
  setCanvasLayerPresentationLocked,
  setCanvasLayerPresentationOpacity,
  setCanvasLayerPresentationVisibility,
} from './presentation'
import { saveGoogleMapsApiKey, setBasemapStyle, setMapBackground, setSoftenBackground } from '../map-layers/actions'
import type { LayerSlotId } from '../../maplibre/map-lifetime'
import { layerStatus } from '../settings/state'

/**
 * Layer actions shared by both editions' Layers panels. Edition-neutral:
 * Desktop-only LiDAR wiring stays in the Desktop Layers panel.
 */
export const LAYER_PANEL_ACTIONS = {
  open: toggleLayerRow,
  visibility: setCanvasLayerPresentationVisibility,
  locked: setCanvasLayerPresentationLocked,
  opacity: setCanvasLayerPresentationOpacity,
  contourInterval: setCanvasLayerPresentationContourIntervalMeters,
  basemapStyle: setBasemapStyle,
  saveGoogleKey: saveGoogleMapsApiKey,
  background: setMapBackground,
  softenBackground: setSoftenBackground,
  retryLayer: (slot: LayerSlotId) => layerStatus.get()?.retryLayer(slot),
} as const
