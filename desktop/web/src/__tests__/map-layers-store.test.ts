import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  setBasemapStyle,
  setContourIntervalMeters,
  setMapLayerOpacity,
  setMapLayerVisible,
} from '../app/map-layers/actions'
import {
  createDefaultMapLayersForTests as createDefaultMapLayers,
  hasVisibleMapLayer,
  mapBackgroundOf,
  mapLayers,
  mapLayersFromSettings,
  mapLayersToSettingsFields,
  normalizeMapLayers,
  type MapLayersState,
} from '../app/settings/state'
import { presentedMapLayers, setStoryPresentationOverrides } from '../app/story-presentation/overrides'
import {
  installSettingsProjection,
  resetSettingsProjectionForTests,
  type SettingsProjectionInstallation,
} from '../app/settings/projection'
import type { BasemapStyle } from '../generated/contracts'
import { DEFAULT_SETTINGS } from '../generated/settings'
import type { Settings } from '../types/settings'

const saveSettings = vi.fn(async (_settings: Settings): Promise<void> => {})
let installation: SettingsProjectionInstallation

beforeEach(() => {
  vi.useFakeTimers()
  saveSettings.mockReset().mockResolvedValue(undefined)
  resetSettingsProjectionForTests()
  mapLayers.value = createDefaultMapLayers()
  installation = installSettingsProjection({
    load: () => ({ ...DEFAULT_SETTINGS }),
    save: saveSettings,
  })
})

afterEach(() => {
  installation.dispose()
  resetSettingsProjectionForTests()
  vi.clearAllTimers()
  vi.useRealTimers()
})

function layers(overrides: {
  basemap?: Partial<MapLayersState['basemap']>
  satellite?: Partial<MapLayersState['satellite']>
  contours?: Partial<MapLayersState['contours']>
  hillshade?: Partial<MapLayersState['hillshade']>
} = {}): MapLayersState {
  const defaults = createDefaultMapLayers()
  return {
    basemap: { ...defaults.basemap, ...overrides.basemap },
    satellite: { ...defaults.satellite, ...overrides.satellite },
    contours: { ...defaults.contours, ...overrides.contours },
    hillshade: { ...defaults.hillshade, ...overrides.hillshade },
    softenBackground: false,
  }
}

describe('map layer store', () => {
  it('starts with a visible Liberty Basemap and hidden Google Satellite', () => {
    expect(mapLayers.value.basemap).toEqual({ style: 'liberty', visible: true, opacity: 1 })
    expect(mapLayers.value.satellite).toEqual({ visible: false, opacity: 1 })
    expect(mapLayers.value.contours.visible).toBe(false)
    expect(mapLayers.value.hillshade.visible).toBe(false)
    expect(mapBackgroundOf(mapLayers.value)).toBe('basemap')
    expect(hasVisibleMapLayer(mapLayers.value)).toBe(true)
  })

  it('persists visibility toggles immediately', async () => {
    setMapLayerVisible('contours', true)
    await Promise.resolve()

    expect(mapLayers.value.contours.visible).toBe(true)
    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ contour_visible: true }))
  })

  it('persists the basemap style choice immediately without a satellite provider', async () => {
    setBasemapStyle('dark')
    await Promise.resolve()
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ basemap_style: 'dark' }))
    expect(saveSettings.mock.lastCall?.[0]).not.toHaveProperty('satellite_provider')
    expect(mapLayers.value.basemap.style).toBe('dark')
  })

  it('queues opacity persistence instead of writing per slider frame', async () => {
    setMapLayerOpacity('basemap', 0.8)
    setMapLayerOpacity('basemap', 0.4)
    setMapLayerOpacity('satellite', 0.6)
    await Promise.resolve()

    expect(mapLayers.value.basemap.opacity).toBe(0.4)
    expect(mapLayers.value.satellite.opacity).toBe(0.6)
    expect(saveSettings).not.toHaveBeenCalled()

    vi.runAllTimers()
    await Promise.resolve()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      basemap_opacity: 0.4,
      satellite_opacity: 0.6,
    }))
  })

  it('queues contour interval persistence and ignores invalid intervals', async () => {
    setContourIntervalMeters(-1)
    setContourIntervalMeters(Number.NaN)
    expect(mapLayers.value.contours.intervalMeters).toBe(DEFAULT_SETTINGS.contour_interval)

    setContourIntervalMeters(12.4)
    await Promise.resolve()
    expect(saveSettings).not.toHaveBeenCalled()

    vi.runAllTimers()
    await Promise.resolve()
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ contour_interval: 12 }))
  })

  it('lets Satellite hide the Basemap and restores it when Satellite is off', () => {
    setMapLayerVisible('satellite', true)

    expect(mapBackgroundOf(mapLayers.value)).toBe('satellite')
    // The Basemap keeps its own visibility; Satellite only covers it.
    expect(mapLayers.value.basemap.visible).toBe(true)

    setMapLayerVisible('satellite', false)

    expect(mapBackgroundOf(mapLayers.value)).toBe('basemap')
    expect(mapLayers.value.basemap.visible).toBe(true)
  })

  it('leaves a hidden Basemap hidden after Satellite turns off', () => {
    setMapLayerVisible('basemap', false)
    setMapLayerVisible('satellite', true)
    expect(mapBackgroundOf(mapLayers.value)).toBe('satellite')

    setMapLayerVisible('satellite', false)

    expect(mapBackgroundOf(mapLayers.value)).toBe('none')
    expect(mapLayers.value.basemap.visible).toBe(false)
  })

  it('derives the background band from Satellite first, then the Basemap', () => {
    expect(mapBackgroundOf(layers({ satellite: { visible: true } }))).toBe('satellite')
    expect(mapBackgroundOf(layers({ basemap: { visible: false }, satellite: { visible: true } }))).toBe('satellite')
    expect(mapBackgroundOf(layers())).toBe('basemap')
    expect(mapBackgroundOf(layers({ basemap: { visible: false } }))).toBe('none')
  })

  it('counts terrain layers as visible map layers', () => {
    const hidden = { basemap: { visible: false } }
    expect(hasVisibleMapLayer(layers(hidden))).toBe(false)
    expect(hasVisibleMapLayer(layers({ ...hidden, contours: { visible: true } }))).toBe(true)
    expect(hasVisibleMapLayer(layers({ ...hidden, hillshade: { visible: true } }))).toBe(true)
    expect(hasVisibleMapLayer(layers({ ...hidden, satellite: { visible: true } }))).toBe(true)
  })

  it('normalizes out-of-range opacity and unknown style', () => {
    const normalized = normalizeMapLayers(layers({
      basemap: { style: 'street' as BasemapStyle, opacity: 3 },
      satellite: { opacity: -1 },
      contours: { opacity: Number.NaN },
      hillshade: { opacity: Number.POSITIVE_INFINITY },
    }))

    expect(normalized.basemap).toEqual({ style: 'liberty', visible: true, opacity: 1 })
    expect(normalized.satellite).toEqual({ visible: false, opacity: 0 })
    expect(normalized.contours.opacity).toBe(1)
    expect(normalized.hillshade.opacity).toBe(DEFAULT_SETTINGS.hillshade_opacity)
  })

  it('normalizes action input before it reaches the store and settings', async () => {
    setMapLayerOpacity('basemap', 0.5)
    setBasemapStyle('bright')
    vi.runAllTimers()
    await Promise.resolve()
    saveSettings.mockClear()

    setMapLayerOpacity('basemap', 7)
    setBasemapStyle('terrain' as BasemapStyle)
    vi.runAllTimers()
    await Promise.resolve()

    expect(mapLayers.value.basemap).toEqual({ style: 'liberty', visible: true, opacity: 1 })
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      basemap_style: 'liberty',
      basemap_opacity: 1,
    }))
  })

  it('2.1-M137: round-trips map-layer fields through the settings slice and overlays a story override without mutating settings', () => {
    const sample = layers({
      basemap: { style: 'dark', visible: false, opacity: 0.35 },
      satellite: { visible: true, opacity: 0.75 },
      contours: { visible: true, opacity: 0.6, intervalMeters: 15 },
      hillshade: { visible: true, opacity: 0.25 },
    })
    const roundTripped = mapLayersFromSettings(mapLayersToSettingsFields({ ...sample, softenBackground: true }))
    expect(roundTripped).toEqual({ ...sample, softenBackground: true })

    expect(presentedMapLayers()).toEqual(mapLayers.value)
    setStoryPresentationOverrides({
      mapLayers: roundTripped,
      siteDataIds: new Set(),
      plantLabels: 'none',
      targets: [],
    })
    try {
      expect(presentedMapLayers()).toEqual(roundTripped)
      expect(mapLayers.value).toEqual(createDefaultMapLayers())
    } finally {
      setStoryPresentationOverrides(null)
    }
    expect(presentedMapLayers()).toEqual(mapLayers.value)
  })
})
