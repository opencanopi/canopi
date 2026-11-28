import { describe, expect, it } from 'vitest'
import type { BasemapStyle } from '../../generated/contracts'
import type { Theme } from '../../types/settings'
import {
  activeGoogleMapsApiKey, googleMapsApiKey, lastOpenHome, lastView, launchCheck, locale, mapLayers,
  newDesignDefaults, plantSpacingIntervalM, satelliteSource, savedStampsFrameHeight, scrollWheel,
  sidePanelWidth, singleKeyShortcuts, snapToGridEnabled, theme, toolNamesVisible, unitSystem, usedCanvasTools,
} from './state'
import {
  hydrateSettingsProjectionForTests,
  mutateSettingsProjection,
} from './projection'
import { baseSettings, setupSettingsProjectionTest } from '../../__tests__/support/settings-projection-harness'

function snapshotSettingsProjection() {
  const layers = mapLayers.peek()
  const nd = newDesignDefaults.peek()
  return {
    locale: locale.peek(),
    theme: theme.peek(),
    unit_system: unitSystem.peek(),
    snap_to_grid: snapToGridEnabled.peek(),
    side_panel_width: sidePanelWidth.peek(),
    saved_stamps_frame_height: savedStampsFrameHeight.peek(),
    basemap_style: layers.basemap.style,
    basemap_visible: layers.basemap.visible,
    basemap_opacity: layers.basemap.opacity,
    satellite_visible: layers.satellite.visible,
    satellite_opacity: layers.satellite.opacity,
    google_maps_api_key: googleMapsApiKey.peek()?.trim() || null,
    satellite_source: satelliteSource.peek(),
    contour_visible: layers.contours.visible,
    contour_opacity: layers.contours.opacity,
    contour_interval: layers.contours.intervalMeters,
    hillshade_visible: layers.hillshade.visible,
    hillshade_opacity: layers.hillshade.opacity,
    soften_background: layers.softenBackground,
    plant_spacing_interval_m: plantSpacingIntervalM.peek(),
    last_view: lastView.peek(),
    last_open_home: lastOpenHome.peek(),
    used_canvas_tools: [...usedCanvasTools.peek()],
    tool_names_visible: toolNamesVisible.peek(),
    single_key_shortcuts: singleKeyShortcuts.peek(),
    scroll_wheel: scrollWheel.peek(),
    new_design_satellite: nd.satellite,
    new_design_symbol_scale: nd.symbolScale,
    new_design_labels: nd.labels,
    launch_check: launchCheck.peek(),
  }
}

const { saveSettings } = setupSettingsProjectionTest()

describe('settings projection', () => {
  it('hydrates, snapshots and normalizes the last view', () => {
    hydrateSettingsProjectionForTests(baseSettings({ last_view: { lon: 2.3522, lat: 48.8566, zoom: 17.5 } }))
    expect(lastView.value).toEqual({ lon: 2.3522, lat: 48.8566, zoom: 17.5 })
    expect(snapshotSettingsProjection().last_view).toEqual({ lon: 2.3522, lat: 48.8566, zoom: 17.5 })

    mutateSettingsProjection((draft) => {
      draft.lastView = { lon: 13, lat: 89, zoom: 4 }
    }, { persist: 'none' })
    expect(lastView.value).toBeNull()

    mutateSettingsProjection((draft) => {
      draft.lastView = { lon: -122.4, lat: 37.8, zoom: Number.NaN }
    }, { persist: 'none' })
    expect(lastView.value).toBeNull()
  })

  it('hydrates platform settings into the frontend projection without persisting', () => {
    hydrateSettingsProjectionForTests(baseSettings({
      locale: 'fr',
      theme: 'dark',
      snap_to_grid: true,
      side_panel_width: 460,
      saved_stamps_frame_height: 280,
      basemap_style: 'bright',
      basemap_visible: false,
      basemap_opacity: 0.35,
      satellite_visible: true,
      satellite_opacity: 0.7,
      contour_visible: true,
      contour_opacity: 0.45,
      contour_interval: 12,
      hillshade_visible: true,
      hillshade_opacity: 0.2,
      soften_background: true,
      plant_spacing_interval_m: 0.75,
    }))

    expect(locale.value).toBe('fr')
    expect(theme.value).toBe('dark')
    expect(snapToGridEnabled.value).toBe(true)
    expect(sidePanelWidth.value).toBe(460)
    expect(savedStampsFrameHeight.value).toBe(280)
    expect(mapLayers.value).toEqual({
      basemap: { style: 'bright', visible: false, opacity: 0.35 },
      satellite: { visible: true, opacity: 0.7 },
      contours: { visible: true, opacity: 0.45, intervalMeters: 12 },
      hillshade: { visible: true, opacity: 0.2 },
      softenBackground: true,
    })
    expect(plantSpacingIntervalM.value).toBe(0.75)
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('snapshots the projection back to the shared Settings contract', () => {
    hydrateSettingsProjectionForTests(baseSettings())

    mutateSettingsProjection((settings) => {
      settings.locale = 'de'
      settings.theme = 'dark'
      settings.snapToGrid = true
      settings.sidePanel.width = 440
      settings.savedStamps.frameHeight = 260
      settings.mapLayers = {
        basemap: { style: 'dark', visible: false, opacity: 0.6 },
        satellite: { visible: true, opacity: 0.8 },
        contours: { visible: true, opacity: 0.3, intervalMeters: 18 },
        hillshade: { visible: true, opacity: 0.25 },
        softenBackground: false,
      }
      settings.plantSpacingIntervalM = 0.25
    }, { persist: 'none' })

    expect(snapshotSettingsProjection()).toEqual({
      locale: 'de',
      theme: 'dark',
      unit_system: 'metric',
      last_open_home: null,
      launch_check: true,
      snap_to_grid: true,
      side_panel_width: 440,
      saved_stamps_frame_height: 260,
      basemap_style: 'dark',
      basemap_visible: false,
      basemap_opacity: 0.6,
      satellite_visible: true,
      satellite_opacity: 0.8,
      contour_visible: true,
      contour_opacity: 0.3,
      contour_interval: 18,
      hillshade_visible: true,
      hillshade_opacity: 0.25,
      soften_background: false,
      plant_spacing_interval_m: 0.25,
      google_maps_api_key: null,
      last_view: null,
      used_canvas_tools: [],
      tool_names_visible: null,
      single_key_shortcuts: true,
      scroll_wheel: 'zoom',
      new_design_satellite: false,
      new_design_symbol_scale: 1,
      new_design_labels: 'names',
      satellite_source: 'free',
    })
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('derives the satellite source from a saved key for an older record, then keeps the choice', () => {
    hydrateSettingsProjectionForTests(baseSettings({ google_maps_api_key: 'device-key', satellite_source: null }))
    expect(satelliteSource.value).toBe('google_key')
    expect(activeGoogleMapsApiKey.value).toBe('device-key')
    hydrateSettingsProjectionForTests(baseSettings({ google_maps_api_key: null, satellite_source: null }))
    expect(satelliteSource.value).toBe('free')

    hydrateSettingsProjectionForTests(baseSettings({ google_maps_api_key: 'device-key', satellite_source: 'free' }))
    expect(satelliteSource.value).toBe('free')
    expect(activeGoogleMapsApiKey.value).toBeNull()
    expect(snapshotSettingsProjection()).toMatchObject({ google_maps_api_key: 'device-key', satellite_source: 'free' })
  })

  it('persists the device-local Google key trimmed, and only on an explicit save', () => {
    hydrateSettingsProjectionForTests(baseSettings({ google_maps_api_key: '  stored-key  ' }))
    // Hydration keeps the stored value reachable rather than dropping it.
    expect(snapshotSettingsProjection().google_maps_api_key).toBe('stored-key')

    mutateSettingsProjection((draft) => {
      draft.googleMapsApiKey = '  edited-key  '
    }, { persist: 'none' })
    // The in-progress edit is not rewritten while the user is still typing it,
    // but the value that would be persisted is trimmed and empty means absent.
    expect(googleMapsApiKey.value).toBe('  edited-key  ')
    expect(snapshotSettingsProjection().google_maps_api_key).toBe('edited-key')

    mutateSettingsProjection((draft) => {
      draft.googleMapsApiKey = '   '
    }, { persist: 'none' })
    expect(snapshotSettingsProjection().google_maps_api_key).toBeNull()

    mutateSettingsProjection((draft) => {
      draft.googleMapsApiKey = null
    }, { persist: 'none' })
    expect(snapshotSettingsProjection().google_maps_api_key).toBeNull()
  })

  it('keeps the Google key out of the design-facing settings it does not belong to', () => {
    hydrateSettingsProjectionForTests(baseSettings({ google_maps_api_key: 'device-key' }))
    // The key is device-local configuration. It travels with Settings, which is
    // never written into a Design, and no layer identity depends on it: the
    // satellite module chooses keyless or official tiles from the key alone.
    const snapshot = snapshotSettingsProjection()
    expect(Object.keys(snapshot)).toContain('google_maps_api_key')
    expect(snapshot.basemap_style).toBe('liberty')
    expect(snapshot).not.toHaveProperty('satellite_provider')
    expect(JSON.stringify(mapLayers.value)).not.toContain('device-key')
  })

  it('projects Keyboard and New Designs settings and clamps the default symbol size', () => {
    hydrateSettingsProjectionForTests(baseSettings({
      single_key_shortcuts: false,
      scroll_wheel: 'zoom',
      new_design_satellite: true,
      new_design_symbol_scale: 9,
      new_design_labels: 'none',
    }))
    expect(singleKeyShortcuts.value).toBe(false)
    expect(newDesignDefaults.value).toEqual({ satellite: true, symbolScale: 2, labels: 'none' })

    mutateSettingsProjection((draft) => {
      draft.singleKeyShortcuts = true
      draft.newDesigns = { ...draft.newDesigns, symbolScale: 0.1, labels: 'codes' }
    }, { persist: 'none' })
    expect(snapshotSettingsProjection()).toMatchObject({
      single_key_shortcuts: true,
      scroll_wheel: 'zoom',
      new_design_satellite: true,
      new_design_symbol_scale: 0.5,
      new_design_labels: 'codes',
    })
  })

  it('projects the Canvas scroll wheel choice both ways and falls back to zoom', () => {
    hydrateSettingsProjectionForTests(baseSettings({ scroll_wheel: 'pan' }))
    expect(scrollWheel.value).toBe('pan')

    mutateSettingsProjection((draft) => { draft.scrollWheel = 'zoom' }, { persist: 'none' })
    expect(snapshotSettingsProjection().scroll_wheel).toBe('zoom')

    mutateSettingsProjection((draft) => { draft.scrollWheel = 'fling' as never }, { persist: 'none' })
    expect(scrollWheel.value).toBe('zoom')
    expect(snapshotSettingsProjection().scroll_wheel).toBe('zoom')
  })

  it('normalizes theme, map layer choices, opacities, and contour interval at the seam', () => {
    hydrateSettingsProjectionForTests(baseSettings({
      theme: 'neon' as Theme,
      basemap_style: 'street' as BasemapStyle,
      basemap_opacity: 2,
      satellite_opacity: Number.NaN,
      contour_opacity: -1,
      contour_interval: 12.7,
      hillshade_opacity: Number.NaN,
      plant_spacing_interval_m: 0,
      side_panel_width: Number.NaN,
      saved_stamps_frame_height: 80,
    }))

    expect(theme.value).toBe('light')
    expect(mapLayers.value.basemap.style).toBe('liberty')
    expect(mapLayers.value.basemap.opacity).toBe(1)
    expect(mapLayers.value.satellite.opacity).toBe(1)
    expect(mapLayers.value.contours.opacity).toBe(0)
    expect(mapLayers.value.contours.intervalMeters).toBe(13)
    expect(mapLayers.value.hillshade.opacity).toBe(0.55)
    expect(plantSpacingIntervalM.value).toBe(0.5)
    expect(sidePanelWidth.value).toBe(null)
    expect(savedStampsFrameHeight.value).toBe(120)

    mutateSettingsProjection((settings) => {
      settings.mapLayers = {
        basemap: { ...settings.mapLayers.basemap, opacity: -2 },
        satellite: { ...settings.mapLayers.satellite, opacity: 5 },
        contours: { ...settings.mapLayers.contours, opacity: Number.POSITIVE_INFINITY, intervalMeters: 7.6 },
        hillshade: { ...settings.mapLayers.hillshade, opacity: 3 },
        softenBackground: false,
      }
      settings.plantSpacingIntervalM = Number.POSITIVE_INFINITY
      settings.sidePanel.width = 120
      settings.savedStamps.frameHeight = Number.POSITIVE_INFINITY
    }, { persist: 'none' })

    expect(snapshotSettingsProjection()).toEqual(expect.objectContaining({
      theme: 'light',
      basemap_style: 'liberty',
      basemap_opacity: 0,
      satellite_opacity: 1,
      contour_opacity: 1,
      contour_interval: 8,
      hillshade_opacity: 1,
      plant_spacing_interval_m: 0.5,
      side_panel_width: 320,
      saved_stamps_frame_height: 220,
    }))
  })
})
