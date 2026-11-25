/**
 * settings-store.suite.test.ts: Shared behavioural suite for the settings store
 * across both the Desktop runner and the Web runner (`policy/suites.json` id: `settings-store`;
 * ADR 0024, ADR 0026, ADR 0030; 2.1-M518, 2.1-M523, 2.1-Q54, 2.1-Q83, 2.1-Q120, 2.1-Q164, 2.1-Q169, 2.1-Q345, 2.1-Q361).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetStoreHealthForTests, storeHealth } from '../../failures/health'
import { noticeForStore } from '../../failures/health-presentation'
import { capabilitiesForEdition } from '../../generated/edition-capabilities'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import { SETTINGS_RECORD_KEY } from '../../platform/browser-record'
import type { SettingsPlatformAdapter } from '../../platform/settings'
import { createDesktopSettingsPlatformAdapter } from '../../editions/desktop/settings'
import { createBrowserSettingsPlatformAdapter } from '../../editions/web/settings'
import {
  createBrowserAppDataStore,
  SETTINGS_STORAGE_KEY,
  type BrowserStorageAdapter,
} from '../../web/browser-app-data'
import {
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
import {
  googleMapsApiKey,
  lastOpenHome,
  launchCheck,
  locale,
  scrollWheel,
  theme,
  unitSystem,
} from './state'

const SETTINGS_BEFORE_RESET_KEY = 'canopi:web-app-data:settings.before-reset'

function memoryStorage(initial: Record<string, string> = {}): BrowserStorageAdapter {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
  }
}

/** Shared corpus of valid + malformed fields exercised by both Desktop and Web runners. */
const BAD_FIELD_CORPUS: Record<string, unknown> = {
  locale: 'xx-invalid',
  theme: 'dark',
  unit_system: 'furlongs',
  snap_to_grid: true,
  basemap_style: 'unknown-style',
  basemap_opacity: 'not-a-number',
  plant_spacing_interval_m: -5,
  google_maps_api_key: 'AIzaSy-secret-kept-intact',
  last_open_home: '   ',
  launch_check: 'yes',
}

interface SettingsRunnerHarness {
  readonly edition: 'Desktop' | 'Web'
  readonly adapter: SettingsPlatformAdapter
  readonly storage: BrowserStorageAdapter | null
  readStoredV4Raw(): Record<string, unknown> | null
  readStoredV3Raw(): Record<string, unknown> | null
  readBeforeResetRaw(): Record<string, unknown> | null
}

function createRunnerHarness(
  edition: 'Desktop' | 'Web',
  initialRecord: Record<string, unknown> | null,
  env: SettingsFirstRunEnv = { languages: ['en-GB'], region: 'GB', os: 'linux' },
  initialKey: 'v4' | 'v3' = 'v4',
): SettingsRunnerHarness {
  if (edition === 'Web') {
    const initial: Record<string, string> = {}
    if (initialRecord !== null) {
      if (initialKey === 'v4') {
        initial[SETTINGS_RECORD_KEY] = JSON.stringify({ version: 2, ...initialRecord })
      } else {
        initial[SETTINGS_STORAGE_KEY] = JSON.stringify({ version: 3, settings: initialRecord })
      }
    }
    const storage = memoryStorage(initial)
    const store = createBrowserAppDataStore({ storage, session: memoryStorage() })
    const adapter = createBrowserSettingsPlatformAdapter(store, () => env)
    return {
      edition,
      adapter,
      storage,
      readStoredV4Raw: () => {
        const text = storage.getItem(SETTINGS_RECORD_KEY)
        return text ? (JSON.parse(text) as Record<string, unknown>) : null
      },
      readStoredV3Raw: () => {
        const text = storage.getItem(SETTINGS_STORAGE_KEY)
        if (!text) return null
        return (JSON.parse(text) as { settings?: Record<string, unknown> | null }).settings ?? null
      },
      readBeforeResetRaw: () => {
        const text = storage.getItem(SETTINGS_BEFORE_RESET_KEY)
        return text ? (JSON.parse(text) as Record<string, unknown>) : null
      },
    }
  }

  let stored: Record<string, unknown> = initialRecord
    ? { version: 2, ...initialRecord }
    : { version: 2, ...decodeSettingsRecord(null, env).values }
  let beforeReset: Record<string, unknown> | null = null
  const makeDesktopAdapter = () =>
    createDesktopSettingsPlatformAdapter({
      getSettingsRecord: async () => {
        const decoded = decodeSettingsRecord(stored, env)
        if (decoded.resetFields.length > 0) {
          if (beforeReset === null) beforeReset = { ...stored }
          stored = { ...stored, ...decoded.values, version: 2 }
        }
        return {
          record: { ...stored },
          reset_fields: [...decoded.resetFields],
          newer_read_only: false,
        }
      },
      patchSettingsRecord: async (patch) => {
        stored = { ...stored, ...patch, version: 2 }
      },
      env: () => env,
    })
  const adapter = makeDesktopAdapter()
  return {
    edition,
    adapter,
    storage: null,
    readStoredV4Raw: () => ({ ...stored }),
    readStoredV3Raw: () => null,
    readBeforeResetRaw: () => (beforeReset ? { ...beforeReset } : null),
  }
}

afterEach(() => {
  resetSettingsProjectionForTests()
  resetStoreHealthForTests()
})

describe('settings-store shared suite (Desktop and Web runners)', () => {
  it.each(['Desktop', 'Web'] as const)(
    '%s runner: resets only malformed fields, keeps valid ones, and raises fields_reset naming the fields (2.1-Q54, Q361)',
    async (edition) => {
      const harness = createRunnerHarness(edition, BAD_FIELD_CORPUS)
      const installation = installSettingsProjection(harness.adapter)
      await installation.ready

      expect(theme.value).toBe('dark')
      expect(googleMapsApiKey.value).toBe('AIzaSy-secret-kept-intact')
      expect(locale.value).toBe('en')
      expect(unitSystem.value).toBe('metric')
      expect(lastOpenHome.value).toBeNull()
      expect(launchCheck.value).toBe(true)

      expect(storeHealth.value.settings).toEqual({
        status: { kind: 'ready' },
        notice: 'fields_reset',
      })
      const [notice] = noticeForStore('settings', storeHealth.value.settings!, {
        report: null,
        update: null,
        dismissNotice: () => {},
      })
      expect(notice?.params?.fields).toContain('locale')
      expect(notice?.params?.fields).toContain('unit_system')
      expect(notice?.params?.fields).toContain('last_open_home')
      expect(notice?.params?.fields).toContain('launch_check')

      expect(harness.readBeforeResetRaw()).toMatchObject(BAD_FIELD_CORPUS)
      expect(harness.readStoredV4Raw()).toMatchObject({
        version: 2,
        theme: 'dark',
        locale: 'en',
        unit_system: 'metric',
        last_open_home: null,
        launch_check: true,
      })
      installation.dispose()
    },
  )

  it('Web runner: two loads of a bad record keep one before-reset copy, repair storage on load 1, and raise fields_reset once (ADR 0026)', async () => {
    const harness = createRunnerHarness('Web', BAD_FIELD_CORPUS)
    const first = installSettingsProjection(harness.adapter)
    await first.ready
    expect(storeHealth.value.settings?.notice).toBe('fields_reset')
    const firstBackup = harness.readBeforeResetRaw()
    expect(firstBackup).toMatchObject(BAD_FIELD_CORPUS)
    first.dispose()

    // Second load on the same storage sees the repaired v4 record: no second notice, original backup untouched.
    resetStoreHealthForTests()
    const store2 = createBrowserAppDataStore({ storage: harness.storage!, session: memoryStorage() })
    const adapter2 = createBrowserSettingsPlatformAdapter(store2, () => ({ languages: ['en-GB'], region: 'GB', os: 'linux' }))
    const second = installSettingsProjection(adapter2)
    await second.ready

    expect(storeHealth.value.settings).toEqual({ status: { kind: 'ready' }, notice: null })
    expect(harness.readBeforeResetRaw()).toEqual(firstBackup)
    second.dispose()
  })

  it.each(['Desktop', 'Web'] as const)(
    '%s runner: derives unit_system from region and persists last_open_home + launch_check (2.1-Q120, Q169, M523, 2e-2)',
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
      expect(usHarness.readStoredV4Raw()).toMatchObject({
        version: 2,
        unit_system: 'us_customary',
        last_open_home: 'home:orchard-north',
        launch_check: false,
      })
      usInstall.dispose()

      const frHarness = createRunnerHarness(edition, null, { languages: ['fr-FR'], region: 'FR', os: 'linux' })
      const frInstall = installSettingsProjection(frHarness.adapter)
      await frInstall.ready
      expect(unitSystem.value).toBe('metric')
      expect(locale.value).toBe('fr')
      frInstall.dispose()
    },
  )

  it('Web runner: Q169 stamps unit_system once on first run so a later browser language change preserves it', async () => {
    const harness = createRunnerHarness('Web', null, { languages: ['en-US'], region: 'US', os: 'linux' })
    const first = installSettingsProjection(harness.adapter)
    await first.ready
    await flushSettingsProjection()

    expect(unitSystem.value).toBe('us_customary')
    expect(harness.readStoredV4Raw()).toMatchObject({ version: 2, unit_system: 'us_customary' })
    first.dispose()

    // Second launch in French keeps the stamped US customary unit system.
    const store2 = createBrowserAppDataStore({ storage: harness.storage!, session: memoryStorage() })
    const adapter2 = createBrowserSettingsPlatformAdapter(store2, () => ({ languages: ['fr-FR'], region: 'FR', os: 'linux' }))
    const second = installSettingsProjection(adapter2)
    await second.ready
    expect(unitSystem.value).toBe('us_customary')
    second.dispose()
  })

  it('Web runner: upgrades a 2.0 v3:settings record into v4:settings record 2 via the frozen v1->v2 step without touching v3 (ADR 0026, Q83)', async () => {
    const harness = createRunnerHarness(
      'Web',
      { locale: 'de', theme: 'dark', satellite_provider: 'eox' },
      { languages: ['en-US'], region: 'US', os: 'linux' },
      'v3',
    )
    const installation = installSettingsProjection(harness.adapter)
    await installation.ready

    expect(locale.value).toBe('de')
    expect(theme.value).toBe('dark')
    expect(unitSystem.value).toBe('us_customary')
    expect(harness.readStoredV4Raw()).toMatchObject({
      version: 2,
      locale: 'de',
      theme: 'dark',
      unit_system: 'us_customary',
      last_open_home: null,
      launch_check: true,
    })
    expect(harness.readStoredV4Raw()).not.toHaveProperty('satellite_provider')
    // 2.0 rollback record under v3:settings is untouched.
    expect(harness.readStoredV3Raw()).toEqual({ locale: 'de', theme: 'dark', satellite_provider: 'eox' })
    installation.dispose()
  })

  it('Web runner: patch writes to v4:settings preserve unknown keys already stored on disk (ADR 0026)', async () => {
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
    expect(harness.readStoredV4Raw()).toMatchObject({
      version: 2,
      theme: 'dark',
      future_setting_v99: { nested: true },
    })
    installation.dispose()
  })

  it('Web runner: Q345/Q169 first-run stamp persists locale, unit_system, and mac scroll_wheel across relaunch and language change', async () => {
    const harness = createRunnerHarness('Web', null, { languages: ['fr-FR', 'en-US'], region: 'FR', os: 'mac' })
    const first = installSettingsProjection(harness.adapter)
    await first.ready
    await flushSettingsProjection()

    expect(locale.value).toBe('fr')
    expect(unitSystem.value).toBe('metric')
    expect(scrollWheel.value).toBe('pan')
    expect(harness.readStoredV4Raw()).toMatchObject({
      version: 2,
      locale: 'fr',
      unit_system: 'metric',
      scroll_wheel: 'pan',
    })
    first.dispose()

    // Second launch in the same environment preserves locale, unit_system, and scroll_wheel.
    const store2 = createBrowserAppDataStore({ storage: harness.storage!, session: memoryStorage() })
    const adapter2 = createBrowserSettingsPlatformAdapter(store2, () => ({ languages: ['fr-FR', 'en-US'], region: 'FR', os: 'mac' }))
    const second = installSettingsProjection(adapter2)
    await second.ready
    expect(locale.value).toBe('fr')
    expect(unitSystem.value).toBe('metric')
    expect(scrollWheel.value).toBe('pan')
    second.dispose()

    // Third launch after a browser language/OS change keeps all three stamped values.
    const store3 = createBrowserAppDataStore({ storage: harness.storage!, session: memoryStorage() })
    const adapter3 = createBrowserSettingsPlatformAdapter(store3, () => ({ languages: ['en-US'], region: 'US', os: 'linux' }))
    const third = installSettingsProjection(adapter3)
    await third.ready
    expect(locale.value).toBe('fr')
    expect(unitSystem.value).toBe('metric')
    expect(scrollWheel.value).toBe('pan')
    third.dispose()
  })
})

describe('settings field table privacy, capability filtering, patch diff, and store-chain migration (2.1-M518, M540)', () => {
  it('canopi-f47t.52.173: declares privacy on every field, excludes secret/omitted fields, and respects edition capabilities in live problem reports', () => {
    const defaults = decodeSettingsRecord(null).values
    expect(SETTINGS_FIELDS.length).toBe(Object.keys(defaults).length)
    for (const descriptor of SETTINGS_FIELDS) {
      expect(['secret', 'reported', 'omitted']).toContain(descriptor.privacy)
    }

    const withSecret: SettingsValues = {
      ...defaults,
      google_maps_api_key: 'AIzaSy-SUPER-SECRET-KEY',
      last_view: { lon: 2.35, lat: 48.85, zoom: 16 },
      last_open_home: 'home:private-farm',
    }
    const desktopSummary = buildSettingsReportSummary(withSecret, capabilitiesForEdition('desktop', 'linux'))
    expect(desktopSummary).not.toHaveProperty('google_maps_api_key')
    expect(desktopSummary).not.toHaveProperty('last_view')
    expect(desktopSummary).not.toHaveProperty('last_open_home')
    expect(JSON.stringify(desktopSummary)).not.toContain('AIzaSy-SUPER-SECRET-KEY')
    expect(desktopSummary).toMatchObject({
      locale: 'en',
      theme: 'light',
      unit_system: 'metric',
      launch_check: true,
    })

    // Web lacks `app-updater`, so `launch_check` is omitted from Web's report summary.
    const webSummary = buildSettingsReportSummary(withSecret, capabilitiesForEdition('web', 'linux'))
    expect(webSummary).not.toHaveProperty('launch_check')

    const liveWebSummary = readSettingsReportSummary(capabilitiesForEdition('web', 'linux'))
    expect(liveWebSummary).not.toHaveProperty('google_maps_api_key')
    expect(liveWebSummary).not.toHaveProperty('launch_check')
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
    const floor = { store: 'settings' as const, minReadable: 1, current: 3, maxReadable: null, stepCount: 2 }
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

  it('N7: ignores cross-tab storage events while a queued persist timer is pending', async () => {
    vi.useFakeTimers()
    try {
      const listeners: Array<() => void> = []
      const load = vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS })
      const savePatch = vi.fn().mockResolvedValue(undefined)
      const installation = installSettingsProjection({
        load,
        save: vi.fn().mockResolvedValue(undefined),
        savePatch,
        subscribe: (cb) => { listeners.push(cb); return () => { listeners.length = 0 } },
      })
      await installation.ready
      expect(load).toHaveBeenCalledTimes(1)

      mutateSettingsProjection((draft) => { draft.theme = 'dark' }, { persist: 'queued', delayMs: 160 })
      for (const cb of listeners) cb()
      expect(load).toHaveBeenCalledTimes(1)
      expect(theme.peek()).toBe('dark')

      await vi.advanceTimersByTimeAsync(160)
      expect(savePatch).toHaveBeenCalledTimes(1)
      installation.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
