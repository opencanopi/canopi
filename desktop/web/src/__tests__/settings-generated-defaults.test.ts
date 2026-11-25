import { describe, expect, it } from 'vitest'

import { DEFAULT_SAVED_STAMPS_FRAME_HEIGHT } from '../app/settings/field-table'
import {
  locale,
  plantSpacingIntervalM,
  savedStampsFrameHeight,
  scrollWheel,
  sidePanelWidth,
  singleKeyShortcuts,
  theme,
  snapToGridEnabled,
} from '../app/settings/state'
import { mapLayers } from '../app/map-layers/state'
import { DEFAULT_SETTINGS } from '../generated/settings'

describe('generated settings defaults', () => {
  it('initialize every settings-backed projection signal', () => {
    expect(locale.value).toBe(DEFAULT_SETTINGS.locale)
    expect(theme.value).toBe(DEFAULT_SETTINGS.theme)
    expect(plantSpacingIntervalM.value).toBe(DEFAULT_SETTINGS.plant_spacing_interval_m)
    expect(sidePanelWidth.value).toBe(DEFAULT_SETTINGS.side_panel_width)
    expect(savedStampsFrameHeight.value).toBe(
      DEFAULT_SETTINGS.saved_stamps_frame_height ?? DEFAULT_SAVED_STAMPS_FRAME_HEIGHT,
    )
    expect(snapToGridEnabled.value).toBe(DEFAULT_SETTINGS.snap_to_grid)
    expect(singleKeyShortcuts.value).toBe(DEFAULT_SETTINGS.single_key_shortcuts)
    expect(scrollWheel.value).toBe(DEFAULT_SETTINGS.scroll_wheel)
    expect(mapLayers.value).toEqual({
      basemap: {
        style: DEFAULT_SETTINGS.basemap_style,
        visible: DEFAULT_SETTINGS.basemap_visible,
        opacity: DEFAULT_SETTINGS.basemap_opacity,
      },
      satellite: {
        visible: DEFAULT_SETTINGS.satellite_visible,
        opacity: DEFAULT_SETTINGS.satellite_opacity,
      },
      contours: {
        visible: DEFAULT_SETTINGS.contour_visible,
        opacity: DEFAULT_SETTINGS.contour_opacity,
        intervalMeters: DEFAULT_SETTINGS.contour_interval,
      },
      hillshade: {
        visible: DEFAULT_SETTINGS.hillshade_visible,
        opacity: DEFAULT_SETTINGS.hillshade_opacity,
      },
      softenBackground: DEFAULT_SETTINGS.soften_background,
    })
  })
})
