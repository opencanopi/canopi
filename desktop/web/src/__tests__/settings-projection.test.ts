import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BasemapStyle } from '../generated/contracts'
import type { Settings, Theme } from '../types/settings'
import type { SettingsProjectionInstallation } from '../app/settings/projection'
import { snapToGridEnabled } from '../app/canvas-settings/signals'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { sidePanelWidth } from '../app/shell/state'
import {
  locale,
  plantSpacingIntervalM,
  savedStampsFrameHeight,
  theme,
  googleMapsApiKey,
  lastView,
  newDesignDefaults,
  satelliteSource,
  activeGoogleMapsApiKey,
  scrollWheel,
  singleKeyShortcuts,
} from '../app/settings/state'
import {
  flushSettingsProjection,
  hydrateSettingsProjectionForTests,
  installSettingsProjection,
  mutateSettingsProjection,
  resetSettingsProjectionForTests,
  snapshotSettingsProjection,
} from '../app/settings/projection'

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    locale: 'en',
    theme: 'light',
    snap_to_grid: false,
    side_panel_width: null,
    basemap_style: 'liberty',
    basemap_visible: true,
    basemap_opacity: 1,
    satellite_visible: false,
    satellite_opacity: 1,
    contour_visible: false,
    contour_opacity: 1,
    contour_interval: 0,
    hillshade_visible: false,
    hillshade_opacity: 0.55,
    soften_background: false,
    plant_spacing_interval_m: 0.5,
    saved_stamps_frame_height: 220,
    last_view: null,
    used_canvas_tools: [],
    tool_names_visible: null,
    single_key_shortcuts: true,
    scroll_wheel: 'zoom',
    new_design_satellite: false,
    new_design_symbol_scale: 1,
    new_design_labels: 'names',
    satellite_source: null,
    ...overrides,
  }
}

function resetProjectionSignals(): void {
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, reject, resolve }
}

/** A failed load is read again after the projection's bounded pauses (SET-05): run them out, then the load settles. */
async function settleLoadFailure(target: SettingsProjectionInstallation, error: Error): Promise<void> {
  await Promise.all([expect(target.ready).rejects.toBe(error), vi.runAllTimersAsync()])
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

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

  it('persists immediate mutations against the latest normalized snapshot', async () => {
    hydrateSettingsProjectionForTests(baseSettings())

    mutateSettingsProjection((settings) => {
      settings.locale = 'es'
      settings.sidePanel.width = 480
    }, { persist: 'immediate' })
    await Promise.resolve()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'es',
      side_panel_width: 480,
    }))
  })

  it('debounces queued persistence and writes the latest projection', async () => {
    hydrateSettingsProjectionForTests(baseSettings())

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'queued', delayMs: 250 })
    mutateSettingsProjection((settings) => {
      settings.theme = 'dark'
      settings.mapLayers = { ...settings.mapLayers, basemap: { ...settings.mapLayers.basemap, opacity: 0.4 } }
    }, { persist: 'queued', delayMs: 250 })

    vi.advanceTimersByTime(249)
    expect(saveSettings).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    await Promise.resolve()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'fr',
      theme: 'dark',
      basemap_opacity: 0.4,
    }))
  })

  it('flushes queued persistence immediately and waits for durable settlement', async () => {
    const pendingSave = deferred<void>()
    saveSettings.mockImplementationOnce(() => pendingSave.promise)
    hydrateSettingsProjectionForTests(baseSettings())

    mutateSettingsProjection((settings) => {
      settings.mapLayers = { ...settings.mapLayers, contours: { ...settings.mapLayers.contours, intervalMeters: 24 } }
    }, { persist: 'queued', delayMs: 250 })

    let settled = false
    const flush = flushSettingsProjection().then(() => {
      settled = true
    })
    await Promise.resolve()
    vi.runAllTimers()

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      contour_interval: 24,
    }))
    expect(settled).toBe(false)

    pendingSave.resolve()
    await flush

    expect(settled).toBe(true)
  })

  it('updates projection state but does not persist before settings bootstrap', () => {
    installation.dispose()
    resetSettingsProjectionForTests()

    mutateSettingsProjection((settings) => { settings.theme = 'dark' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'it' }, { persist: 'queued', delayMs: 10 })
    vi.runAllTimers()

    expect(theme.value).toBe('dark')
    expect(locale.value).toBe('it')
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('avoids persistence when a mutation leaves the settings snapshot unchanged', () => {
    hydrateSettingsProjectionForTests(baseSettings())

    mutateSettingsProjection((settings) => { settings.locale = 'en' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'queued', delayMs: 250 })
    mutateSettingsProjection((settings) => { settings.locale = 'en' }, { persist: 'queued', delayMs: 250 })
    vi.runAllTimers()

    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('hydrates a synchronous adapter before installation returns', () => {
    installation.dispose()
    resetSettingsProjectionForTests()

    installation = installSettingsProjection({
      load: () => baseSettings({ locale: 'fr', theme: 'dark' }),
      save: saveSettings,
    })

    expect(locale.value).toBe('fr')
    expect(theme.value).toBe('dark')
  })

  it('ignores an asynchronous load after its installation is replaced', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    let resolveSlowLoad!: (settings: Settings) => void
    const slowLoad = new Promise<Settings>((resolve) => {
      resolveSlowLoad = resolve
    })

    const staleInstallation = installSettingsProjection({
      load: () => slowLoad,
      save: saveSettings,
    })
    installation = installSettingsProjection({
      load: () => baseSettings({ locale: 'de' }),
      save: saveSettings,
    })

    resolveSlowLoad(baseSettings({ locale: 'fr' }))
    await staleInstallation.ready

    expect(locale.value).toBe('de')
  })

  it('replays and persists a mutation made while asynchronous settings load', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    const pendingLoad = deferred<Settings>()
    installation = installSettingsProjection({
      load: () => pendingLoad.promise,
      save: saveSettings,
    })

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })

    expect(locale.value).toBe('fr')
    expect(saveSettings).not.toHaveBeenCalled()

    pendingLoad.resolve(baseSettings({ locale: 'de', theme: 'dark' }))
    await installation.ready
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())

    expect(locale.value).toBe('fr')
    expect(theme.value).toBe('dark')
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'fr',
      theme: 'dark',
    }))
  })

  it('makes flush wait for bootstrap before settling an early mutation', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    const pendingLoad = deferred<Settings>()
    installation = installSettingsProjection({
      load: () => pendingLoad.promise,
      save: saveSettings,
    })
    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })

    let flushed = false
    const flush = flushSettingsProjection().then(() => {
      flushed = true
    })
    await Promise.resolve()

    expect(flushed).toBe(false)
    expect(saveSettings).not.toHaveBeenCalled()

    pendingLoad.resolve(baseSettings({ locale: 'de' }))
    await flush

    expect(flushed).toBe(true)
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }))
  })

  it('2.1-Q67: a settings mutation after the adapter load fails stays in memory and is never written', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    const loadError = new Error('settings unavailable')
    installation = installSettingsProjection({
      load: () => Promise.reject(loadError),
      save: saveSettings,
    })

    await settleLoadFailure(installation, loadError)
    mutateSettingsProjection((settings) => { settings.theme = 'dark' }, { persist: 'immediate' })
    await flushSettingsProjection()

    expect(theme.value).toBe('dark')
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('does not persist an unchanged fallback after an ordinary load failure', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    const loadError = new Error('settings unavailable')
    installation = installSettingsProjection({
      load: () => Promise.reject(loadError),
      save: saveSettings,
    })

    await settleLoadFailure(installation, loadError)
    await flushSettingsProjection()

    const replacement = installSettingsProjection({
      load: () => baseSettings({ locale: 'de' }),
      save: saveSettings,
    })
    installation = replacement
    await replacement.ready

    expect(locale.value).toBe('de')
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('does not turn a pre-bootstrap no-op into persistence intent', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    const pendingLoad = deferred<Settings>()
    const loadError = new Error('settings unavailable')
    installation = installSettingsProjection({
      load: () => pendingLoad.promise,
      save: saveSettings,
    })

    mutateSettingsProjection(() => {}, { persist: 'immediate' })
    pendingLoad.reject(loadError)

    await settleLoadFailure(installation, loadError)
    await flushSettingsProjection()

    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('ignores a synchronous load that reentrantly replaces its installation', () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    let replacementInstallation: SettingsProjectionInstallation | null = null

    const staleInstallation = installSettingsProjection({
      load: () => {
        replacementInstallation = installSettingsProjection({
          load: () => baseSettings({ locale: 'de' }),
          save: saveSettings,
        })
        return baseSettings({ locale: 'fr' })
      },
      save: saveSettings,
    })
    installation = replacementInstallation ?? staleInstallation

    expect(locale.value).toBe('de')
  })

  it('uses the normalized hydrated snapshot as the durable no-op baseline', () => {
    hydrateSettingsProjectionForTests(baseSettings({
      basemap_opacity: 4,
      contour_interval: 12.7,
      saved_stamps_frame_height: 80,
    }))

    mutateSettingsProjection(() => {}, { persist: 'immediate' })

    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('serializes writes and coalesces overlapping mutations to the latest snapshot', async () => {
    let resolveFirstSave!: () => void
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve
    })
    saveSettings
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined)

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'es' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'de' }, { persist: 'immediate' })

    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'fr' }))

    resolveFirstSave()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))

    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'de' }))
  })

  it('guards serialization when an adapter save synchronously reenters mutation', async () => {
    const firstSave = deferred<void>()
    let activeSaves = 0
    let maximumActiveSaves = 0
    saveSettings.mockImplementation((settings) => {
      activeSaves += 1
      maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves)
      if (settings.locale === 'fr') {
        mutateSettingsProjection((next) => {
          next.locale = 'de'
        }, { persist: 'immediate' })
      }
      const settlement = settings.locale === 'fr'
        ? firstSave.promise
        : Promise.resolve()
      return settlement.finally(() => {
        activeSaves -= 1
      })
    })

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })

    expect(maximumActiveSaves).toBe(1)
    expect(saveSettings).toHaveBeenCalledTimes(1)

    firstSave.resolve()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))

    expect(maximumActiveSaves).toBe(1)
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'de' }))
  })

  it('settles pending writes before a replacement adapter loads', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    let stored = baseSettings()
    const firstSave = deferred<void>()
    const oldSave = vi.fn(async (settings: Settings) => {
      if (oldSave.mock.calls.length === 1) await firstSave.promise
      stored = settings
    })
    installation = installSettingsProjection({
      load: () => stored,
      save: oldSave,
    })

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.theme = 'dark' }, { persist: 'queued', delayMs: 250 })

    const replacementLoad = vi.fn(() => stored)
    const replacement = installSettingsProjection({
      load: replacementLoad,
      save: saveSettings,
    })
    installation = replacement

    expect(replacementLoad).not.toHaveBeenCalled()
    expect(oldSave).toHaveBeenCalledTimes(1)

    firstSave.resolve()
    await replacement.ready

    expect(oldSave).toHaveBeenCalledTimes(2)
    expect(replacementLoad).toHaveBeenCalledOnce()
    expect(locale.value).toBe('fr')
    expect(theme.value).toBe('dark')
  })

  it('hands a failed predecessor write to the replacement adapter', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    const saveFailure = deferred<void>()
    const error = new Error('old settings storage unavailable')
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stored = baseSettings()
    installation = installSettingsProjection({
      load: () => stored,
      save: () => saveFailure.promise,
    })

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })

    const replacementSave = vi.fn(async (_settings: Settings): Promise<void> => {})
    const replacement = installSettingsProjection({
      load: () => stored,
      save: replacementSave,
    })
    installation = replacement

    saveFailure.reject(error)
    await replacement.ready
    await vi.waitFor(() => expect(replacementSave).toHaveBeenCalledOnce())

    expect(locale.value).toBe('fr')
    expect(replacementSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }))
    expect(logError).toHaveBeenCalledWith('Failed to persist settings:', error)
    logError.mockRestore()
  })

  it('2.1-Q67: a handed-off change is kept in memory, never written, when the replacement load also fails', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    const predecessorSave = deferred<void>()
    const predecessorError = new Error('old settings storage unavailable')
    const replacementLoadError = new Error('replacement settings unavailable')
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    installation = installSettingsProjection({
      load: () => baseSettings(),
      save: () => predecessorSave.promise,
    })

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })

    const replacementSave = vi.fn(async (_settings: Settings): Promise<void> => {})
    const replacement = installSettingsProjection({
      load: () => Promise.reject(replacementLoadError),
      save: replacementSave,
    })
    installation = replacement

    predecessorSave.reject(predecessorError)
    await settleLoadFailure(replacement, replacementLoadError)
    await flushSettingsProjection()

    expect(locale.value).toBe('fr')
    expect(replacementSave).not.toHaveBeenCalled()
    logError.mockRestore()
  })

  it('keeps flush pending until a replacement adapter is durable', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    let stored = baseSettings()
    const oldSaveSettlement = deferred<void>()
    installation = installSettingsProjection({
      load: () => stored,
      save: async (settings) => {
        await oldSaveSettlement.promise
        stored = settings
      },
    })

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    let flushed = false
    const flush = flushSettingsProjection().then(() => {
      flushed = true
    })

    const replacementSaveSettlement = deferred<void>()
    const replacementSave = vi.fn(() => replacementSaveSettlement.promise)
    const replacement = installSettingsProjection({
      load: () => stored,
      save: replacementSave,
    })
    installation = replacement
    mutateSettingsProjection((settings) => { settings.theme = 'dark' }, { persist: 'immediate' })

    oldSaveSettlement.resolve()
    await replacement.ready
    await vi.waitFor(() => expect(replacementSave).toHaveBeenCalledOnce())

    expect(flushed).toBe(false)

    replacementSaveSettlement.resolve()
    await flush

    expect(flushed).toBe(true)
    expect(replacementSave).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'fr',
      theme: 'dark',
    }))
  })

  it('extends an in-flight flush to include a newer queued mutation', async () => {
    const firstSave = deferred<void>()
    const secondSave = deferred<void>()
    saveSettings
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise)

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    let flushed = false
    const flush = flushSettingsProjection().then(() => {
      flushed = true
    })

    mutateSettingsProjection((settings) => { settings.theme = 'dark' }, { persist: 'queued', delayMs: 250 })

    firstSave.resolve()
    await flushMicrotasks()

    expect(saveSettings).toHaveBeenCalledTimes(2)
    expect(flushed).toBe(false)

    secondSave.resolve()
    await flush
    vi.advanceTimersByTime(250)

    expect(flushed).toBe(true)
    expect(saveSettings).toHaveBeenCalledTimes(2)
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      locale: 'fr',
      theme: 'dark',
    }))
  })

  it('stops waiting for an obsolete bootstrap after adapter replacement', async () => {
    installation.dispose()
    resetSettingsProjectionForTests()
    const obsoleteLoad = deferred<Settings>()
    installation = installSettingsProjection({
      load: () => obsoleteLoad.promise,
      save: saveSettings,
    })

    let flushed = false
    const flush = flushSettingsProjection().then(() => {
      flushed = true
    })

    const replacement = installSettingsProjection({
      load: () => baseSettings({ locale: 'de' }),
      save: saveSettings,
    })
    installation = replacement
    await replacement.ready

    await vi.waitFor(() => expect(flushed).toBe(true))
    await flush

    expect(locale.value).toBe('de')
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('persists a return to the durable value when an older write is still in flight', async () => {
    let resolveFirstSave!: () => void
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve
    })
    saveSettings
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined)

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    mutateSettingsProjection((settings) => { settings.locale = 'en' }, { persist: 'immediate' })

    resolveFirstSave()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))

    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'en' }))
  })

  it('retries the latest snapshot after a failed write', async () => {
    const error = new Error('storage unavailable')
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    saveSettings
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined)

    mutateSettingsProjection((settings) => { settings.locale = 'fr' }, { persist: 'immediate' })
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(
      'Failed to persist settings:',
      error,
    ))

    await flushSettingsProjection()
    await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2))

    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'fr' }))
    logError.mockRestore()
  })
})
