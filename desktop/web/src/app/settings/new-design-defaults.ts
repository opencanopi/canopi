import type { CanopiFile } from '../../types/design'
import { mutateSettingsProjection } from './projection'
import { newDesignDefaults, type NewDesignDefaults } from './state'

/** Applies Settings › New Designs display defaults (symbol scale, labels) to a newly created Design. */
export function withNewDesignDisplay(
  file: CanopiFile,
  defaults: NewDesignDefaults = newDesignDefaults.peek(),
) {
  const prevExtra = file.extra && typeof file.extra === 'object' ? file.extra : {}
  return {
    ...file,
    extra: {
      ...prevExtra,
      plant_display: {
        symbol_scale: defaults.symbolScale,
        labels: defaults.labels,
      },
    },
  }
}

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
