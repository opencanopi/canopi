import { LayerPanel } from '../../components/canvas/LayerPanel'
import { LAYER_PANEL_ACTIONS } from '../../app/canvas-layer-presentation/panel-actions'
import { readCanvasLayerPresentation } from '../../app/canvas-layer-presentation/presentation'
import { readCurrentCanvasLayerStatuses, retryCurrentCanvasLayer } from '../../app/canvas-map-surface/host-view'
import { openSettingsDialog } from '../../app/shell/dialogs'
import { currentDesign } from '../../app/document-session/store'

/** Web draws Background (Satellite, Street map or None) and Terrain (Contours, Relief; 2.1-Q25). */
const WEB_REFERENCE_ROWS: ReadonlySet<string> = new Set(['basemap', 'satellite', 'contours', 'hillshade'])

/**
 * Web Layers. The Site data row says how many terrain or height layers the
 * Design keeps and that they need Canopi Desktop; the Design's references to
 * them round-trip unchanged and show again there. Without any, there is no row.
 */
export function WebLayersPanel() {
  const rows = readCanvasLayerPresentation(readCurrentCanvasLayerStatuses()).rows.filter((row) =>
    row.authority === 'scene' || WEB_REFERENCE_ROWS.has(row.id))
  const count = currentDesign.value?.lidar?.entries.length ?? 0
  const actions = {
    ...LAYER_PANEL_ACTIONS,
    openSatelliteSettings: () => openSettingsDialog({ section: 'map' }),
    retryLayer: retryCurrentCanvasLayer,
  }
  return <LayerPanel rows={rows} actions={actions} siteData={{ kind: 'needs-desktop', count }} />
}
