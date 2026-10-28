import { PLANT_LABEL_MODES, type PlantLabelMode } from '../../canvas/runtime/plant-display'
import type { MenuAction } from '../shell-commands/menus'
import { currentDesign } from '../document-session/store'
import { t } from '../../i18n'
import { setPlantLabels } from './actions'
import { currentPlantDisplay } from './state'
import type { LocaleKey } from '../../generated/locale-keys'

const LABEL_KEYS: Record<PlantLabelMode, LocaleKey> = {
  none: 'menu.view.labelsNone',
  codes: 'menu.view.labelsCodes',
  names: 'menu.view.labelsNames',
}

/** View › Labels ▸: None, Codes, Names as radio items for the open Design. */
export function plantLabelMenuActions(): MenuAction[] {
  const disabled = currentDesign.value === null
  const labels = currentPlantDisplay.value.labels
  return PLANT_LABEL_MODES.map((mode) => ({
    type: 'action',
    id: `view.labels:${mode}`,
    label: t(LABEL_KEYS[mode]),
    disabled,
    check: 'radio',
    checked: labels === mode,
    action: () => {
      setPlantLabels(mode)
    },
  }))
}
