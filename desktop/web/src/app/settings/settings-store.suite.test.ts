/**
 * settings-store.suite.test.ts: Shared behavioural suite for the settings store
 * across both the Desktop runner and the Web runner (`policy/suites.json` id: `settings-store`;
 * ADR 0024, ADR 0026, ADR 0030; 2.1-M518, 2.1-M523, 2.1-Q54, 2.1-Q120, 2.1-Q164, 2.1-Q169, 2.1-Q345).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { resetStoreHealthForTests, storeHealth } from '../../failures/health'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { SettingsPlatformAdapter } from '../../platform/settings'
import { createDesktopSettingsPlatformAdapter } from '../../editions/desktop/settings'
import { createBrowserSettingsPlatformAdapter } from '../../editions/web/settings'
import {
  createBrowserAppDataStore,
  SETTINGS_STORAGE_KEY,
  type BrowserStorageAdapter,
} from '../../web/browser-app-data'
import {
  DEFAULT_SETTINGS_VALUES,
  SETTINGS_FIELDS,
  type SettingsValues,
} from './field-table'
import {
  buildSettingsReportSummary,
  decodeSettingsRecord,
  diffSettingsPatch,
  regionFromLanguages,
  runSettingsMigrationChain,
  type SettingsFirstRunEnv,
  type SettingsVersionStep,
} from './interpreter'
import {
  flushSettingsProjection,
  installSettingsProjection,
  mutateSettingsProjection,
  readSettingsReportSummary,
  resetSettingsProjectionForTests,
} from './projection'

const SETTINGS_BEFORE_RESET_KEY = 'canopi:web-app-data:settings.before-reset'
import {
  googleMapsApiKey,
  lastOpenHome,
  launchCheck,
  locale,
  theme,
  unitSystem,
} from './state'

function createMemoryStorage(): BrowserStorageAdapter & { readonly map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
  }
}

interface RunnerHarness {
  readonly name: 'Desktop' | 'Web'
  readonly adapter: SettingsPlatformAdapter
  readonly readStoredRaw: () => Record<string, unknown> | null
  readonly readBeforeResetRaw: () => Record<string, unknown> | null
}

function createRunnerHarness(
  edition: 'Desktop' | 'Web',
  initial: Record<string, unknown> | null,
  env: SettingsFirstRunEnv = { languages: ['en-GB'], region: 'GB', os: 'linux' },
): RunnerHarness {
  if (edition === 'Web') {
    const storage = createMemoryStorage()
    if (initial !== null) {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ version: 3, settings: initial }))
    }
    const store = createBrowserAppDataStore({ storage })
    const adapter = createBrowserSettingsPlatformAdapter(store, () => env)
    return {
      name: 'Web',
      adapter,
      readStoredRaw: () => store.loadSettings(),
      readBeforeResetRaw: () => {
        const raw = storage.getItem(SETTINGS_BEFORE_RESET_KEY)
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      },
    }
  }

  let stored: Record<string, unknown> = initial
    ? { ...DEFAULT_SETTINGS, ...initial }
    : { ...DEFAULT_SETTINGS, ...(env.languages ? { locale: decodeSettingsRecord(null, env).values.locale } : {}) }
  const adapter = createDesktopSettingsPlatformAdapter({
    getSettings: async () => ({ ...stored } as unknown as SettingsValues),
    setSettings: async (next) => { stored = { ...stored, ...next } },
    env: () => env,
  })
  return {
    name: 'Desktop',
    adapter,
    readStoredRaw: () => ({ ...stored }),
    readBeforeResetRaw: () => null,
  }
}

/** One bad value per field type in `SETTINGS_FIELDS`, plus a valid secret key that must survive reset. */
const BAD_FIELD_CORPUS: Readonly<Record<string, unknown>> = {
  locale: 'xx-invalid',
  theme: 'sepia',
  unit_system: 'furlongs',
  snap_to_grid: 'yes',
  side_panel_width: -50,
  saved_stamps_frame_height: 3.14,
  basemap_style: 'paper',
  basemap_visible: 1,
  basemap_opacity: Number.NaN,
  satellite_visible: 'on',
  satellite_opacity: 'full',
  google_maps_api_key: 'AIza-keep-this-key-intact',
  satellite_source: 'bing',
  contour_visible: 0,
  contour_opacity: null,
  contour_interval: -10,
  hillshade_visible: 'no',
  hillshade_opacity: Number.POSITIVE_INFINITY,
  soften_background: 2,
  plant_spacing_interval_m: 0,
  last_view: { lon: 250, lat: 10, zoom: 5 },
  last_open_home: '   ',
  used_canvas_tools: [1, 2],
  tool_names_visible: 'always',
  single_key_shortcuts: 1,
  scroll_wheel: 'spin',
  new_design_satellite: 'true',
  new_design_symbol_scale: 'big',
  new_design_labels: 'everything',
  launch_check: 'never',
}

afterEach(() => {
  resetSettingsProjectionForTests()
  resetStoreHealthForTests()
})

describe('settings-store shared suite (Desktop & Web runners)', () => {
  it.each(['Desktop', 'Web'] as const)(
    '%s runner: resets only malformed fields, preserves valid secret key, and raises fields_reset notice (2.1-Q54)',
    async (edition) => {
      const harness = createRunnerHarness(edition, BAD_FIELD_CORPUS)
      const installation = installSettingsProjection(harness.adapter)
      await installation.ready

      // Valid secret key survived the per-field reset intact.
      expect(googleMapsApiKey.value).toBe('AIza-keep-this-key-intact')
      // Malformed fields fell back to defaults.
      expect(locale.value).toBe(DEFAULT_SETTINGS.locale)
      expect(theme.value).toBe(DEFAULT_SETTINGS.theme)
      expect(unitSystem.value).toBe('metric')
      expect(lastOpenHome.value).toBeNull()
      expect(launchCheck.value).toBe(true)
      // Store health carries the one-time fields_reset notice.
      expect(storeHealth.value.settings).toEqual({
        status: { kind: 'ready' },
        notice: 'fields_reset',
      })
      if (edition === 'Web') {
        expect(harness.readBeforeResetRaw()).toEqual(JSON.parse(JSON.stringify(BAD_FIELD_CORPUS)))
      }
      installation.dispose()
    },
  )

  it.each(['Desktop', 'Web'] as const)(
    '%s runner: stamps unit_system from region (US -> us_customary, FR -> metric) and persists last_open_home + launch_check (2.1-Q120, Q169, M523)',
    async (edition) => {
      const usHarness = createRunnerHarness(edition, null, { languages: ['en-US'], region: 'US', os: 'linux' })
      const usInstall = installSettingsProjection(usHarness.adapter)
      await usInstall.ready
      expect(unitSystem.value).toBe('us_customary')

      mutateSettingsProjection((draft) => {
        draft.lastOpenHome = 'home:orchard-north'
        draft.launchCheck = false
      })
      await flushSettingsProjection()
      expect(lastOpenHome.value).toBe('home:orchard-north')
      expect(launchCheck.value).toBe(false)
      usInstall.dispose()

      const frHarness = createRunnerHarness(edition, null, { languages: ['fr-FR'], region: 'FR', os: 'linux' })
      const frInstall = installSettingsProjection(frHarness.adapter)
      await frInstall.ready
      expect(unitSystem.value).toBe('metric')
      expect(locale.value).toBe('fr')
      frInstall.dispose()
    },
  )

  it('Web runner: patch writes preserve unknown keys already stored on disk (ADR 0026)', async () => {
    const harness = createRunnerHarness('Web', {
      locale: 'en',
      theme: 'light',
      future_setting_v99: { nested: true },
    })
    const installation = installSettingsProjection(harness.adapter)
    await installation.ready

    mutateSettingsProjection((draft) => {
      draft.theme = 'dark'
    })
    await flushSettingsProjection()

    expect(theme.value).toBe('dark')
    expect(harness.readStoredRaw()).toMatchObject({
      theme: 'dark',
      future_setting_v99: { nested: true },
    })
    installation.dispose()
  })

  it('Web runner: Q345 first-run locale matcher picks browser language without writing storage', async () => {
    const harness = createRunnerHarness('Web', null, { languages: ['fr-FR', 'en-US'], os: 'mac' })
    const installation = installSettingsProjection(harness.adapter)
    await installation.ready

    expect(locale.value).toBe('fr')
    expect(unitSystem.value).toBe('metric')
    // First run never writes until the user changes a setting (2.1-M473).
    expect(harness.readStoredRaw()).toBeNull()
    installation.dispose()
  })
})

describe('settings field table privacy, patch diff, and store-chain migration (2.1-M518, M540)', () => {
  it('declares an explicit privacy classification on every field and excludes secret/omitted fields from problem reports', () => {
    expect(SETTINGS_FIELDS.length).toBe(Object.keys(DEFAULT_SETTINGS_VALUES).length)
    for (const descriptor of SETTINGS_FIELDS) {
      expect(['secret', 'reported', 'omitted']).toContain(descriptor.privacy)
    }

    const withSecret: SettingsValues = {
      ...DEFAULT_SETTINGS_VALUES,
      google_maps_api_key: 'AIzaSy-SUPER-SECRET-KEY',
      last_view: { lon: 2.35, lat: 48.85, zoom: 16 },
      last_open_home: 'home:private-farm',
    }
    const summary = buildSettingsReportSummary(withSecret)
    expect(summary).not.toHaveProperty('google_maps_api_key')
    expect(summary).not.toHaveProperty('last_view')
    expect(summary).not.toHaveProperty('last_open_home')
    expect(JSON.stringify(summary)).not.toContain('AIzaSy-SUPER-SECRET-KEY')
    expect(summary).toMatchObject({
      locale: 'en',
      theme: 'light',
      unit_system: 'metric',
      launch_check: true,
    })

    const liveSummary = readSettingsReportSummary()
    expect(liveSummary).not.toHaveProperty('google_maps_api_key')
  })

  it('extracts region subtags and computes minimal changed-field patches', () => {
    expect(regionFromLanguages(['en-US'])).toBe('US')
    expect(regionFromLanguages(['zh-Hant-TW'])).toBe('TW')
    expect(regionFromLanguages(['fr'])).toBeNull()

    const before = decodeSettingsRecord(null, { languages: ['en-GB'] }).values
    const after: SettingsValues = { ...before, theme: 'dark', last_open_home: 'home:demo' }
    expect(diffSettingsPatch(before, after)).toEqual({
      theme: 'dark',
      last_open_home: 'home:demo',
    })
  })

  it('runs declarative v1 -> v3 settings migration steps synchronously through platform/store-chain.ts', () => {
    const steps: readonly SettingsVersionStep[] = [
      {
        from: 1,
        operations: [
          { kind: 'drop_field', key: 'satellite_provider' },
          { kind: 'map_literal', key: 'basemap_style', mapping: { osm: 'liberty' } },
        ],
      },
      {
        from: 2,
        operations: [
          { kind: 'rename_field', from: 'units', to: 'unit_system' },
          { kind: 'add_field', key: 'unit_system', defaultSpec: { kind: 'from_region' } },
          { kind: 'add_field', key: 'last_open_home', defaultSpec: { kind: 'static', value: null } },
          { kind: 'add_field', key: 'launch_check', defaultSpec: { kind: 'static', value: true } },
        ],
      },
    ]
    const floor = { store: 'settings' as const, minReadable: 1, current: 3, maxReadable: 3, stepCount: 2 }
    const result = runSettingsMigrationChain(
      floor,
      1,
      { locale: 'fr', satellite_provider: 'eox', basemap_style: 'osm' },
      steps,
      { region: 'US' },
    )
    expect(result).toEqual({
      kind: 'current',
      version: 3,
      stepsRun: 2,
      value: {
        locale: 'fr',
        basemap_style: 'liberty',
        unit_system: 'us_customary',
        last_open_home: null,
        launch_check: true,
      },
    })
  })
})
