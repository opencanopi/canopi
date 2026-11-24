import type { BasemapStyle, SavedView, SavedViewBackground } from '../../generated/contracts'
import { SETTINGS_BASEMAP_STYLES } from '../../generated/settings'
import { captureMapBackgroundPresentation, type MapBackgroundPresentation } from '../../maplibre/map-background'
import { effectiveBackgroundOpacity, mapBackgroundOf, type MapLayersState } from './state'

// The one translation between a saved view and the map layers, in both
// directions, and the one reading of map layers as the background band. A
// presented story step, a saved view's thumbnail and the workspace map all draw
// through it, so a layer a view gains (water, say) is added here once.

type SavedViewMapLayers = Pick<SavedView['visible_layers'], 'background' | 'terrain'>

/** What a saved view shows, laid over the user's own map layers: their opacities, contour interval, softening and, when the view's style is unknown, style. */
export function mapLayersOfView(view: Pick<SavedView, 'visible_layers'>, layers: MapLayersState): MapLayersState {
  const { background, terrain } = view.visible_layers
  return {
    ...layers,
    basemap: {
      ...layers.basemap,
      visible: background.kind === 'basemap',
      ...(background.kind === 'basemap' && isBasemapStyle(background.style) ? { style: background.style } : {}),
    },
    satellite: { ...layers.satellite, visible: background.kind === 'satellite' },
    contours: { ...layers.contours, visible: terrain.contours },
    hillshade: { ...layers.hillshade, visible: terrain.hillshade },
  }
}

/** The map layers a saved view records: the background band's one visible layer and the terrain rows. */
export function viewMapLayersOf(layers: MapLayersState): SavedViewMapLayers {
  return {
    background: savedViewBackgroundOf(layers),
    terrain: { contours: layers.contours.visible, hillshade: layers.hillshade.visible },
  }
}

/**
 * The background band as the map draws these layers in this locale; Soften
 * background dims the band itself, not the plants above. The presentation
 * holds no Google key: it is captured for thumbnails and compared between
 * frames, so the key stays with the satellite imagery's own settings.
 */
export function backgroundPresentationOf(layers: MapLayersState, locale: string): MapBackgroundPresentation {
  return captureMapBackgroundPresentation({
    basemap: { style: layers.basemap.style, visible: layers.basemap.visible, opacity: effectiveBackgroundOpacity(layers, 'basemap') },
    satellite: { visible: layers.satellite.visible, opacity: effectiveBackgroundOpacity(layers, 'satellite') },
    locale,
  })
}

function savedViewBackgroundOf(layers: MapLayersState): SavedViewBackground {
  switch (mapBackgroundOf(layers)) {
    case 'satellite':
      return { kind: 'satellite' }
    case 'basemap':
      return { kind: 'basemap', style: layers.basemap.style }
    case 'none':
      return { kind: 'none' }
  }
}

/** Whether a saved view's basemap style name is one the settings know; a retired style keeps the user's. */
function isBasemapStyle(style: string): style is BasemapStyle {
  return (SETTINGS_BASEMAP_STYLES as readonly string[]).includes(style)
}
