import { afterEach, beforeEach, vi } from 'vitest'
import type { Settings } from '../../types/settings'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import {
  installSettingsProjection,
  resetSettingsProjectionForTests,
  type SettingsProjectionInstallation,
} from '../../app/settings/projection'
import {
  createDefaultMapLayersForTests as createDefaultMapLayers,
  lastView, locale, mapLayers, newDesignDefaults, plantSpacingIntervalM,
  savedStampsFrameHeight, scrollWheel, sidePanelWidth, singleKeyShortcuts,
  snapToGridEnabled, theme,
} from '../../app/settings/state'

export function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  }
}

export function resetProjectionSignals(): void {
  lastView.value = null
  locale.value = 'en'
  theme.value = 'light'
  snapToGridEnabled.value = false
  sidePanelWidth.value = null
  mapLayers.value = createDefaultMapLayers()
  plantSpacingIntervalM.value = 0.5
  savedStampsFrameHeight.value = 220
  singleKeyShortcuts.value = true
  scrollWheel.value = 'zoom'
  newDesignDefaults.value = { satellite: false, symbolScale: 1, labels: 'names' }
}

export function setupSettingsProjectionTest() {
  let installation: SettingsProjectionInstallation
  const saveSettings = vi.fn(async (_settings: Settings): Promise<void> => {})

  beforeEach(() => {
    vi.useFakeTimers()
    saveSettings.mockReset().mockResolvedValue(undefined)
    resetSettingsProjectionForTests()
    resetProjectionSignals()
    installation = installSettingsProjection({
      load: () => baseSettings(),
      save: saveSettings,
    })
  })

  afterEach(() => {
    installation.dispose()
    resetSettingsProjectionForTests()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  return {
    saveSettings,
    get installation() {
      return installation
    },
    set installation(next: SettingsProjectionInstallation) {
      installation = next
    },
  }
}
