import type { SettingsPlatformAdapter } from '../../platform/settings'
import {
  browserAppDataStore,
  SETTINGS_STORAGE_KEY,
  type BrowserAppDataStore,
} from '../../web/browser-app-data'
import { StoreRefusedError, StoreUnreadableError } from '../../failures/store-read'
import { writeStoreHealth } from '../../failures/health'
import { readSettingsRecord } from '../../platform/browser-record'
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

const WEB_SETTINGS_FLOOR: StoreFloor = {
  store: 'settings',
  minReadable: 1,
  current: 1,
  maxReadable: 1,
  stepCount: 0,
}
const WEB_SETTINGS_MIGRATION_STEPS: readonly SettingsVersionStep[] = []

/** The settings store; without `readRecord` it holds no 2.1 settings record. */
type BrowserSettingsStore =
  Pick<BrowserAppDataStore, 'loadSettings' | 'saveSettings'>
  & Partial<Pick<BrowserAppDataStore, 'readRecord' | 'saveSettingsBeforeReset'>>

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
  return {
    languages,
    region: regionFromLanguages(languages),
    os,
  }
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

export function createBrowserSettingsPlatformAdapter(
  store: BrowserSettingsStore = browserAppDataStore,
  envOrOs?: BrowserSettingsEnvProvider | BrowserOs,
): SettingsPlatformAdapter {
  const readEnv = normalizeEnvProvider(envOrOs)
  let lastResetFields: readonly string[] = []
  return {
    load: (): SettingsValues => {
      const { stored, newerReadOnly } = loadStoredSettings(store)
      const env = readEnv()
      let recordToDecode = stored
      if (stored !== null && !newerReadOnly) {
        const migrated = runSettingsMigrationChain(WEB_SETTINGS_FLOOR, WEB_SETTINGS_FLOOR.current, stored, WEB_SETTINGS_MIGRATION_STEPS, env)
        if (migrated.kind === 'current') recordToDecode = migrated.value
      }
      const decoded = decodeSettingsRecord(recordToDecode, env)
      if (!newerReadOnly && stored !== null && decoded.resetFields.length > 0) {
        // E2 / 2.1-Q54: keep the original record once as `settings.before-reset` before any rewrite.
        store.saveSettingsBeforeReset?.(stored)
        lastResetFields = decoded.resetFields
      } else {
        lastResetFields = []
      }
      return decoded.values
    },
    takeResetFields: () => {
      const taken = lastResetFields
      lastResetFields = []
      return taken
    },
    save: async (settings) => {
      const successor = store.readRecord?.(readSettingsRecord)
      if (successor !== undefined && successor.state !== 'absent') throw new StoreRefusedError('settings')
      const result = store.saveSettings({ ...settings })
      if (!result.ok) throw result.error
    },
    savePatch: async (patch, settings) => {
      // Settings 2.1 saved are never written over, nor the 2.0 record beside them: a change applies for this session
      // only (2.1-Q320), refused with the silent store_read_only beside the store's one notice.
      const successor = store.readRecord?.(readSettingsRecord)
      if (successor !== undefined && successor.state !== 'absent') throw new StoreRefusedError('settings')
      const result = store.saveSettings({ ...settings }, patch)
      if (!result.ok) throw result.error
    },
    // A record this edition cannot read, or a browser refusing storage, starts on the same first run (2.1-Q309, Q345, Q169).
    firstRunSettings: () => resolveHostFirstRunPatch(readEnv()),
    subscribe: (onExternalChange) => {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
      const listener = (event: StorageEvent) => {
        if (event.key === SETTINGS_STORAGE_KEY || event.key === null) onExternalChange()
      }
      window.addEventListener('storage', listener)
      return () => window.removeEventListener('storage', listener)
    },
  }
}

export const browserSettingsPlatformAdapter = createBrowserSettingsPlatformAdapter()

/**
 * The stored record, or why it cannot be read as a typed refusal (SET-05 on Web): a record this edition cannot read
 * (the store's own refusal), or the browser refusing storage access, a SecurityError in a locked-down context.
 */
function loadStoredSettings(
  store: BrowserSettingsStore,
): { readonly stored: Record<string, unknown> | null; readonly newerReadOnly: boolean } {
  try {
    // 2.1's settings record 2, when there, is the user's latest choice: its fields are read field by field below, and
    // it is never written or moved aside (2.1-M483, M486); one that does not read makes settings unavailable (SET-05).
    const successor = store.readRecord?.(readSettingsRecord)
    if (successor?.state === 'unreadable') throw new StoreUnreadableError('settings', { kind: 'invalid' })
    if (successor !== undefined && successor.state !== 'absent') {
      writeStoreHealth('settings', { status: { kind: 'newer_read_only' }, notice: null })
      const { version: _version, ...fields } = successor.record
      return { stored: fields, newerReadOnly: true }
    }
    return { stored: store.loadSettings(), newerReadOnly: false }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'SecurityError')) throw error
    throw new StoreUnreadableError('settings', { kind: 'io', io: 'permission_denied' }, { cause: error })
  }
}
