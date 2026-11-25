import { mutateSettingsProjection } from './projection'
import { newDesignDefaults, type NewDesignDefaults } from './state'

/**
 * Settings › New Designs › Open on satellite, applied when a Design is
 * created. Off keeps the background last used; the background is a device
 * setting, so an opened Design never changes it.
 */
export function applyNewDesignBackground(defaults: NewDesignDefaults = newDesignDefaults.peek()): void {
  if (!defaults.satellite) return
  mutateSettingsProjection((s) => {
    s.mapLayers = { ...s.mapLayers, satellite: { ...s.mapLayers.satellite, visible: true } }
  })
}
