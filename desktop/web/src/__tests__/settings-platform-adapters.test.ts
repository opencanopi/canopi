import { describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_BASEMAP_STYLES,
  SETTINGS_LOCALES,
  SETTINGS_THEMES,
} from '../generated/settings'
import type { Settings } from '../types/settings'
import type { SettingsValues } from '../app/settings/field-table'
import { decodeSettingsRecord } from '../app/settings/interpreter'
import { createDesktopSettingsPlatformAdapter } from '../editions/desktop/settings'
import { createBrowserSettingsPlatformAdapter } from '../editions/web/settings'
import {
  createBrowserAppDataStore,
  type BrowserStorageAdapter,
} from '../web/browser-app-data'

const DEFAULT_SETTINGS_VALUES = decodeSettingsRecord(null).values

function settings(overrides: Partial<SettingsValues> = {}): SettingsValues {
  return {
    ...decodeSettingsRecord(null).values,
    ...overrides,
  }
}

function rawSettings(overrides: Partial<SettingsValues> = {}): Record<string, unknown> {
  return { ...settings(overrides) }
}

describe('settings platform adapters', () => {
  it('delegates Desktop settings load and save to the injected transport', async () => {
    const loaded = settings({ locale: 'fr' })
    const getSettings = vi.fn(async () => loaded)
    const setSettings = vi.fn(async (_settings: Settings) => undefined)
    const adapter = createDesktopSettingsPlatformAdapter({
      getSettings,
      setSettings,
      env: () => ({ languages: ['en-GB'], region: 'GB' }),
    })

    await expect(adapter.load()).resolves.toEqual(loaded)
    await expect(adapter.save(loaded)).resolves.toBeUndefined()

    expect(getSettings).toHaveBeenCalledOnce()
    expect(setSettings).toHaveBeenCalledOnce()
    const { unit_system: _u, launch_check: _l, ...expectedWire } = loaded
    expect(setSettings).toHaveBeenCalledWith(expectedWire)
  })

  it('persists last_open_home durably across Desktop adapter relaunch (2b-4, 2.1-Q127)', async () => {
    let stored: Settings = settings({ last_open_home: null })
    const first = createDesktopSettingsPlatformAdapter({
      getSettings: async () => stored,
      setSettings: async (next) => { stored = next },
      env: () => ({ languages: ['en-GB'], region: 'GB' }),
    })
    await first.load()
    await first.save(settings({ last_open_home: 'draft:draft-reopen-1' }))

    const relaunched = createDesktopSettingsPlatformAdapter({
      getSettings: async () => stored,
      setSettings: async (next) => { stored = next },
      env: () => ({ languages: ['en-GB'], region: 'GB' }),
    })
    const reloaded = await relaunched.load()
    expect(reloaded.last_open_home).toBe('draft:draft-reopen-1')
  })

  it('loads the generated Rust default when browser settings are absent', async () => {
    const adapter = createBrowserSettingsPlatformAdapter({
      loadSettings: () => null,
      saveSettings: vi.fn(),
    }, () => ({ languages: ['en-GB'], region: 'GB', os: 'linux' }))

    expect(await adapter.load()).toEqual(DEFAULT_SETTINGS_VALUES)
  })

  it('loads every valid browser settings field', async () => {
    const stored = settings({
      locale: 'fr',
      theme: 'dark',
      snap_to_grid: false,
      side_panel_width: 420,
      saved_stamps_frame_height: 260,
      basemap_style: 'dark',
      basemap_visible: false,
      basemap_opacity: 0.4,
      satellite_visible: true,
      satellite_opacity: 0.7,
      contour_visible: true,
      contour_opacity: 0.6,
      contour_interval: 10,
      hillshade_visible: true,
      hillshade_opacity: 0.3,
      plant_spacing_interval_m: 0.75,
      single_key_shortcuts: false,
      scroll_wheel: 'pan',
      new_design_satellite: true,
      new_design_symbol_scale: 1.5,
      new_design_labels: 'codes',
      satellite_source: 'google_key',
    })
    const adapter = createBrowserSettingsPlatformAdapter({
      loadSettings: () => ({ ...stored }),
      saveSettings: vi.fn(),
    })

    expect(await adapter.load()).toEqual(stored)
  })

  it('accepts every generated Rust settings enum value', async () => {
    for (const locale of SETTINGS_LOCALES) {
      const adapter = createBrowserSettingsPlatformAdapter({
        loadSettings: () => rawSettings({ locale }),
        saveSettings: vi.fn(),
      })
      expect((await adapter.load()).locale).toBe(locale)
    }

    for (const theme of SETTINGS_THEMES) {
      const adapter = createBrowserSettingsPlatformAdapter({
        loadSettings: () => rawSettings({ theme }),
        saveSettings: vi.fn(),
      })
      expect((await adapter.load()).theme).toBe(theme)
    }

    for (const basemapStyle of SETTINGS_BASEMAP_STYLES) {
      const adapter = createBrowserSettingsPlatformAdapter({
        loadSettings: () => rawSettings({ basemap_style: basemapStyle }),
        saveSettings: vi.fn(),
      })
      expect((await adapter.load()).basemap_style).toBe(basemapStyle)
    }
  })

  it('loads browser settings that still carry the retired satellite provider without re-emitting it', async () => {
    const adapter = createBrowserSettingsPlatformAdapter({
      loadSettings: () => ({ satellite_provider: 'eox', satellite_visible: true, satellite_opacity: 0.4 }),
      saveSettings: vi.fn(),
    }, () => ({ languages: ['en-GB'], region: 'GB', os: 'linux' }))

    const loaded = await adapter.load()
    expect(loaded).toEqual(settings({ satellite_visible: true, satellite_opacity: 0.4 }))
    expect(loaded).not.toHaveProperty('satellite_provider')
  })

  it('completes partial locale and theme browser settings with defaults', async () => {
    const adapter = createBrowserSettingsPlatformAdapter({
      loadSettings: () => ({ locale: 'it', theme: 'dark' }),
      saveSettings: vi.fn(),
    }, () => ({ languages: ['en-GB'], region: 'GB', os: 'linux' }))

    expect(await adapter.load()).toEqual(settings({ locale: 'it', theme: 'dark' }))
  })

  it('replaces malformed browser settings fields with Rust defaults', async () => {
    const adapter = createBrowserSettingsPlatformAdapter({
      loadSettings: () => ({
        locale: 'xx',
        theme: 'system',
        snap_to_grid: 'true',
        side_panel_width: -10,
        saved_stamps_frame_height: 2.5,
        bottom_panel_open: 1,
        bottom_panel_timeline_height: '280',
        bottom_panel_budget_height: -1,
        bottom_panel_consortium_height: Number.POSITIVE_INFINITY,
        bottom_panel_tab: 7,
        basemap_style: 'street',
        basemap_visible: 'false',
        basemap_opacity: '0.4',
        satellite_visible: 1,
        satellite_opacity: Number.NaN,
        contour_visible: 1,
        contour_opacity: null,
        contour_interval: 1.5,
        hillshade_visible: 'yes',
        hillshade_opacity: Number.NaN,
        plant_spacing_interval_m: Number.NEGATIVE_INFINITY,
        single_key_shortcuts: 'off',
        scroll_wheel: 'fling',
        new_design_satellite: 1,
        new_design_symbol_scale: '1.5',
        new_design_labels: 'all',
        satellite_source: 'bing',
        unknown_setting: true,
      }),
      saveSettings: vi.fn(),
    }, () => ({ languages: ['en-GB'], region: 'GB', os: 'linux' }))

    expect(await adapter.load()).toEqual(settings())
  })

  it('saves the complete browser settings snapshot through browser app data', async () => {
    const updated = settings({ locale: 'de', snap_to_grid: false })
    const saveSettings = vi.fn(() => ({
      ok: true as const,
      value: { ...updated },
    }))
    const adapter = createBrowserSettingsPlatformAdapter({
      loadSettings: () => null,
      saveSettings,
    })

    await expect(adapter.save(updated)).resolves.toBeUndefined()
    expect(saveSettings).toHaveBeenCalledOnce()
    expect(saveSettings).toHaveBeenCalledWith(updated)
  })

  it('rejects browser settings saves when browser app data reports failure', async () => {
    const storageError = new Error('browser storage unavailable')
    const adapter = createBrowserSettingsPlatformAdapter({
      loadSettings: () => null,
      saveSettings: () => ({ ok: false, error: storageError }),
    })

    await expect(adapter.save(settings())).rejects.toBe(storageError)
  })

  it('preserves unrelated browser app data while saving settings', async () => {
    const store = createBrowserAppDataStore({ storage: memoryStorage() })
    store.setFavoriteSpecies(['Malus domestica'])
    store.saveSavedObjectStamps([{
      id: 'stamp-1',
      name: 'Orchard pair',
      payload: { plants: 2 },
    }])
    const adapter = createBrowserSettingsPlatformAdapter(store)

    await adapter.save(settings({ locale: 'nl' }))

    expect(store.listFavoriteSpecies()).toEqual(['Malus domestica'])
    expect(store.listSavedObjectStamps()).toEqual([{
      id: 'stamp-1',
      name: 'Orchard pair',
      payload: { plants: 2 },
    }])
    expect(await adapter.load()).toEqual(settings({ locale: 'nl' }))
  })
})

function memoryStorage(): BrowserStorageAdapter {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}
