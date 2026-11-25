import type { SettingsPlatformAdapter } from '../../platform/settings'
import {
  browserAppDataStore,
  SETTINGS_STORAGE_KEY,
  type BrowserAppDataStore,
} from '../../web/browser-app-data'
import { StoreRefusedError, StoreUnreadableError } from '../../failures/store-read'
import { writeStoreHealth } from '../../failures/health'
import {
  readSettingsRecord,
  SETTINGS_RECORD_KEY,
  writeSettingsRecord,
} from '../../platform/browser-record'
import { requireStoreFloor } from '../../platform/store-chain'
import { detectPlatform, type InputPlatform } from '../../canvas/runtime/input/platform'
import {
  decodeSettingsRecord,
  regionFromLanguages,
  resolveHostFirstRunPatch,
  runSettingsMigrationChain,
  type SettingsFirstRunEnv,
  type SettingsVersionStep,
} from '../../app/settings/interpreter'
import type { SettingsValues } from '../../app/settings/field-table'
import type { StoreFloor } from '../../generated/store-chain'

/**
 * Frozen v1 -> v2 Web settings chain (ADR 0026:16, 2.1-Q83, 2.1-M540):
 * upgrades a 2.0 `v3:settings` record into the 2.1 `v4:settings` record 2 while
 * inheriting `maxReadable` from `generated/store-chain.ts`.
 */
const WEB_SETTINGS_V1_TO_V2_FLOOR: StoreFloor = {
  ...requireStoreFloor('settings'),
  minReadable: 1,
  current: 2,
  stepCount: 1,
}

const WEB_SETTINGS_V1_TO_V2_STEPS: readonly SettingsVersionStep[] = [
  {
    from: 1,
    operations: [
      { kind: 'drop_field', key: 'satellite_provider' },
      { kind: 'add_field', key: 'unit_system', defaultSpec: { kind: 'from_region' } },
      { kind: 'add_field', key: 'last_open_home', defaultSpec: { kind: 'static', value: null } },
      { kind: 'add_field', key: 'launch_check', defaultSpec: { kind: 'static', value: true } },
    ],
  },
]

/** The settings store; minimal test stubs may omit `readRecord`/`writeRecord`. */
type BrowserSettingsStore =
  Pick<BrowserAppDataStore, 'loadSettings' | 'saveSettings'>
  & Partial<Pick<BrowserAppDataStore, 'readRecord' | 'writeRecord' | 'saveSettingsBeforeReset'>>

/** The system/locale environment the browser runs in, read at each load; a test passes its own. */
type BrowserSettingsEnvProvider = () => SettingsFirstRunEnv
type BrowserOs = () => InputPlatform['os']

function detectBrowserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages
  return navigator.language ? [navigator.language] : []
}

function detectBrowserEnv(): SettingsFirstRunEnv {
  const languages = detectBrowserLanguages()
  const os = typeof navigator === 'undefined' ? 'unknown' : detectPlatform(navigator, {}).os
  return { languages, region: regionFromLanguages(languages), os }
}

function normalizeEnvProvider(
  envOrOs: BrowserSettingsEnvProvider | BrowserOs | undefined,
): BrowserSettingsEnvProvider {
  if (!envOrOs) return detectBrowserEnv
  return () => {
    const result = envOrOs()
    if (typeof result === 'string') {
      const languages = detectBrowserLanguages()
      return { languages, region: regionFromLanguages(languages), os: result }
    }
    return result
  }
}

function writeV4Patch(
  store: BrowserSettingsStore,
  patch: Readonly<Record<string, unknown>> | null,
  full: Readonly<Record<string, unknown>>,
): void {
  const successor = store.readRecord?.(readSettingsRecord)
  if (successor !== undefined && (successor.state === 'newer' || successor.state === 'unreadable')) {
    throw new StoreRefusedError('settings')
  }
  if (store.writeRecord) {
    const base = successor?.state === 'current' ? successor.record : {}
    const merged: Record<string, unknown> = { ...base, ...(patch ?? full) }
    const result = store.writeRecord((storage) => writeSettingsRecord(storage, merged))
    if (!result.ok) throw result.error
    return
  }
  const result = patch ? store.saveSettings(full, patch) : store.saveSettings(full)
  if (!result.ok) throw result.error
}

function buildResetPatch(
  resetFields: readonly (keyof SettingsValues)[],
  values: Readonly<SettingsValues>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of resetFields) patch[key] = values[key]
  return patch
}

export function createBrowserSettingsPlatformAdapter(
  store: BrowserSettingsStore = browserAppDataStore,
  envOrOs?: BrowserSettingsEnvProvider | BrowserOs,
): SettingsPlatformAdapter {
  const readEnv = normalizeEnvProvider(envOrOs)
  let lastResetFields: readonly string[] = []
  let pendingFirstRunStamp: Readonly<Record<string, unknown>> | null = null

  return {
    load: (): SettingsValues => {
      const loaded = loadStoredSettings(store)
      const env = readEnv()
      let recordToDecode = loaded.stored

      if (loaded.source === 'v3' && loaded.stored !== null) {
        const migrated = runSettingsMigrationChain(
          WEB_SETTINGS_V1_TO_V2_FLOOR,
          1,
          loaded.stored,
          WEB_SETTINGS_V1_TO_V2_STEPS,
          env,
        )
        if (migrated.kind === 'current') recordToDecode = migrated.value
      }

      const decoded = decodeSettingsRecord(recordToDecode, env)
      const hasResets = !loaded.newerReadOnly && loaded.stored !== null && decoded.resetFields.length > 0

      if (hasResets) {
        // E2 / 2.1-Q54: keep the original record once before writing back repaired fields (ADR 0026).
        if (loaded.stored) store.saveSettingsBeforeReset?.(loaded.stored)
        lastResetFields = decoded.resetFields
      } else {
        lastResetFields = []
      }

      if (loaded.source === 'v3' && loaded.stored !== null && store.writeRecord) {
        // Write migrated (and repaired) record 2 to v4:settings, leaving v3:settings untouched for 2.0 rollback.
        const repaired = { ...(recordToDecode ?? {}), ...(hasResets ? buildResetPatch(decoded.resetFields, decoded.values) : {}) }
        const written = store.writeRecord((storage) => writeSettingsRecord(storage, repaired))
        if (!written.ok) throw written.error
      } else if (hasResets && loaded.source === 'v4') {
        writeV4Patch(store, buildResetPatch(decoded.resetFields, decoded.values), { ...decoded.values })
      } else if (hasResets && !store.writeRecord) {
        store.saveSettings({ ...decoded.values }, buildResetPatch(decoded.resetFields, decoded.values))
      }

      // 2.1-Q169: on a true first run, stamp `unit_system` once so a later browser language change keeps it.
      pendingFirstRunStamp = loaded.source === 'absent' ? { unit_system: decoded.values.unit_system } : null
      return decoded.values
    },
    takeResetFields: () => {
      const taken = lastResetFields
      lastResetFields = []
      return taken
    },
    takeFirstRunStamp: () => {
      const stamp = pendingFirstRunStamp
      pendingFirstRunStamp = null
      return stamp
    },
    save: async (settings) => {
      writeV4Patch(store, null, { ...settings })
    },
    savePatch: async (patch, settings) => {
      writeV4Patch(store, patch, { ...settings })
    },
    // A record this edition cannot read, or a browser refusing storage, starts on the same first run (2.1-Q309, Q345, Q169).
    firstRunSettings: () => resolveHostFirstRunPatch(readEnv()),
    subscribe: (onExternalChange) => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
      const listener = (event: StorageEvent) => {
        if (event.key === SETTINGS_RECORD_KEY || event.key === SETTINGS_STORAGE_KEY || event.key === null) {
          onExternalChange()
        }
      }
      window.addEventListener('storage', listener)
      return () => window.removeEventListener('storage', listener)
    },
  }
}

export const browserSettingsPlatformAdapter = createBrowserSettingsPlatformAdapter()

interface LoadedBrowserSettings {
  readonly stored: Record<string, unknown> | null
  readonly newerReadOnly: boolean
  readonly source: 'v4' | 'v3' | 'absent'
}

/**
 * Reads 2.1's `v4:settings` record 2 first (writable when current, `newer_read_only` when >2, unavailable when
 * damaged), falling back to 2.0's `v3:settings` for the frozen v1 -> v2 upgrade or `absent` on first run.
 */
function loadStoredSettings(store: BrowserSettingsStore): LoadedBrowserSettings {
  try {
    const record2 = store.readRecord?.(readSettingsRecord)
    if (record2 && record2.state === 'unreadable') throw new StoreUnreadableError('settings', { kind: 'invalid' })
    if (record2 && record2.state === 'newer') {
      writeStoreHealth('settings', { status: { kind: 'newer_read_only' }, notice: null })
      return { stored: record2.record, newerReadOnly: true, source: 'v4' }
    }
    if (record2 && record2.state === 'current') {
      return { stored: record2.record, newerReadOnly: false, source: 'v4' }
    }
    const v3 = store.loadSettings()
    return v3 !== null
      ? { stored: v3, newerReadOnly: false, source: 'v3' }
      : { stored: null, newerReadOnly: false, source: 'absent' }
  } catch (error) {
    if (error instanceof StoreUnreadableError) throw error
    throw new StoreUnreadableError('settings', { kind: 'io', io: 'permission_denied' }, { cause: error })
  }
}
