import { useEffect } from 'preact/hooks'
import { LayerPanel, type SiteDataSummary } from '../canvas/LayerPanel'
import { readCanvasLayerPresentation } from '../../app/canvas-layer-presentation/presentation'
import { LAYER_PANEL_ACTIONS } from '../../app/canvas-layer-presentation/panel-actions'
import { readCurrentCanvasLayerStatuses, retryCurrentCanvasLayer } from '../../app/canvas-map-surface/host-view'
import { openSettingsDialog } from '../../app/shell/dialogs'
import { currentDesign } from '../../app/document-session/store'
import { setSiteDataShown } from '../../app/data-library/actions'
import { openSiteDataPanel } from '../../app/data-library/library-navigation'
import { installLidarLibraryObserver, isMissing, readCurrentLidarPresentation } from '../../app/data-library/library-store'
import { appCommandGraphPanelProjection } from '../../commands/registry'
import { t } from '../../i18n'

/**
 * Desktop Layers: the shared panel with the Site data summary row. Site data
 * has its own panel; Layers keeps the library snapshot current so the summary
 * counts what the map can show.
 */
export function LayersPanel() {
  useEffect(() => installLidarLibraryObserver(), [])
  const actions = {
    ...LAYER_PANEL_ACTIONS,
    openSatelliteSettings: () => openSettingsDialog({ section: 'map' }),
    retryLayer: retryCurrentCanvasLayer,
  }
  return <LayerPanel rows={readCanvasLayerPresentation(readCurrentCanvasLayerStatuses()).rows} actions={actions} siteData={desktopSiteDataSummary()} />
}

function desktopSiteDataSummary(): SiteDataSummary {
  const items = readCurrentLidarPresentation()
  const command = appCommandGraphPanelProjection.value.design.find((candidate) => candidate.panel === 'site-data')
  return {
    kind: 'available',
    count: items.length,
    // `shown` folds the own eye with the summary eye; while the library is loading an entry counts by its own eye.
    shown: items.filter((item) => item.shown && !isMissing(item)).length,
    visible: currentDesign.value?.site_data?.visible ?? true,
    command: {
      label: command?.label ?? t('canvas.layers.siteData'),
      shortcut: command?.shortcut,
      ariaShortcut: command?.ariaShortcut,
    },
    setVisible: setSiteDataShown,
    open: openSiteDataPanel,
  }
}
