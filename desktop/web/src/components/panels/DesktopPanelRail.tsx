import { appCommandGraphPanelProjection } from '../../commands/registry'
import { t } from '../../i18n'
import { PanelRail } from '../shared/PanelRail'

/** Desktop panel rail over the command graph; stays mounted on Start screen for Catalog and Favorites (2.1-Q130). */
export function DesktopPanelRail() {
  const projection = appCommandGraphPanelProjection.value
  return <PanelRail label={t('panelRail.label')} groups={[projection.design, projection.planning]} designChrome />
}
