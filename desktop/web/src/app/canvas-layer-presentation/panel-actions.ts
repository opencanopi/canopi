import { toggleLayerRow } from './open-row'
import {
  setCanvasLayerPresentationContourIntervalMeters,
  setCanvasLayerPresentationLocked,
  setCanvasLayerPresentationOpacity,
  setCanvasLayerPresentationVisibility,
} from './presentation'
import { setBasemapStyle, setMapBackground, setSoftenBackground } from '../map-layers/actions'

/**
 * Layer actions shared by both editions' Layers panels. Edition-neutral:
 * Desktop-only LiDAR wiring stays in the Desktop Layers panel; layer Retry
 * is supplied by each panel from `app/canvas-map-surface/host-view`.
 */
export const LAYER_PANEL_ACTIONS = {
  open: toggleLayerRow,
  visibility: setCanvasLayerPresentationVisibility,
  locked: setCanvasLayerPresentationLocked,
  opacity: setCanvasLayerPresentationOpacity,
  contourInterval: setCanvasLayerPresentationContourIntervalMeters,
  basemapStyle: setBasemapStyle,
  background: setMapBackground,
  softenBackground: setSoftenBackground,
} as const
