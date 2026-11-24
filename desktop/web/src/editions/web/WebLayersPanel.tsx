import { LayerPanel } from '../../components/canvas/LayerPanel'
import { LAYER_PANEL_ACTIONS } from '../../app/canvas-layer-presentation/panel-actions'
import { readCanvasLayerPresentation } from '../../app/canvas-layer-presentation/presentation'
import { currentDesign } from '../../app/document-session/store'

/** Web has no local terrain or LiDAR: its map rows are the Background (Satellite, Street map or None). */
const WEB_REFERENCE_ROWS: ReadonlySet<string> = new Set(['basemap', 'satellite'])

/**
 * Web Layers. The Site data row says how many terrain or height layers the
 * Design keeps and that they need Canopi Desktop; the Design's references to
 * them round-trip unchanged and show again there. Without any, there is no row.
 */
export function WebLayersPanel() {
  const rows = readCanvasLayerPresentation().rows.filter((row) =>
    row.authority === 'scene' || WEB_REFERENCE_ROWS.has(row.id))
  const count = currentDesign.value?.lidar?.entries.length ?? 0
  return <LayerPanel rows={rows} actions={LAYER_PANEL_ACTIONS} siteData={{ kind: 'needs-desktop', count }} />
}
