// editions/desktop/settings.ts
//
// Desktop settings record adapter over ipc/settings.ts (tauri-only-in-native-host, ADR 0022; §18 F2).
// Invariant: Tauri is reached only through ipc/ and editions/desktop/.
// Runs through the same TS settings field-table interpreter as Web (ADR 0026, 2.1-M518).

import type { SettingsPlatformAdapter } from '../../platform/settings'
import { getSettings, setSettings } from '../../ipc/settings'
import type { Settings } from '../../types/settings'
import {
  decodeSettingsRecord,
  regionFromLanguages,
  resolveHostFirstRunPatch,
  toV1WireSettings,
  type SettingsFirstRunEnv,
} from '../../app/settings/interpreter'
import type { SettingsValues } from '../../app/settings/field-table'

export interface DesktopSettingsPlatformAdapterDeps {
  readonly getSettings: () => Promise<Settings>
  readonly setSettings: (settings: Settings) => Promise<void>
  readonly env?: () => SettingsFirstRunEnv
}

function detectDesktopEnv(): SettingsFirstRunEnv {
  const languages = typeof navigator !== 'undefined'
    ? (Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : (navigator.language ? [navigator.language] : []))
    : []
  return { languages, region: regionFromLanguages(languages) }
}

const DEFAULT_DEPS: DesktopSettingsPlatformAdapterDeps = {
  getSettings,
  setSettings,
}

export function createDesktopSettingsPlatformAdapter(
  deps: DesktopSettingsPlatformAdapterDeps = DEFAULT_DEPS,
): SettingsPlatformAdapter {
  const readEnv = deps.env ?? detectDesktopEnv
  // Local mirror for 2.1 fields (`unit_system`, `last_open_home`, `launch_check`) until 2e-2 moves Desktop to record 2.
  let cachedExtras: Partial<Pick<SettingsValues, 'unit_system' | 'last_open_home' | 'launch_check'>> = {}
  let lastResetFields: readonly string[] = []

  return {
    load: async (): Promise<SettingsValues> => {
      const raw = await deps.getSettings()
      const merged: Record<string, unknown> = { ...(raw as unknown as Record<string, unknown>), ...cachedExtras }
      const decoded = decodeSettingsRecord(merged, readEnv())
      lastResetFields = decoded.resetFields
      return decoded.values
    },
    takeResetFields: () => {
      const taken = lastResetFields
      lastResetFields = []
      return taken
    },
    save: async (settings) => {
      const source = settings as Partial<SettingsValues>
      if (source.unit_system !== undefined) cachedExtras = { ...cachedExtras, unit_system: source.unit_system }
      if (source.last_open_home !== undefined) cachedExtras = { ...cachedExtras, last_open_home: source.last_open_home }
      if (source.launch_check !== undefined) cachedExtras = { ...cachedExtras, launch_check: source.launch_check }
      await deps.setSettings(toV1WireSettings(settings as SettingsValues))
    },
    savePatch: async (patch, settings) => {
      const source = patch as Partial<SettingsValues>
      if (source.unit_system !== undefined) cachedExtras = { ...cachedExtras, unit_system: source.unit_system }
      if (source.last_open_home !== undefined) cachedExtras = { ...cachedExtras, last_open_home: source.last_open_home }
      if (source.launch_check !== undefined) cachedExtras = { ...cachedExtras, launch_check: source.launch_check }
      await deps.setSettings(toV1WireSettings(settings as SettingsValues))
    },
    firstRunSettings: () => resolveHostFirstRunPatch(readEnv()),
  }
}

export const desktopSettingsPlatformAdapter = createDesktopSettingsPlatformAdapter()

/**
 * The host's subsystem health query, which platform/desktop.ts hands bootstrapShell beside this settings adapter: the
 * shell's two host reads at start come from this one Desktop adapter (ipc/ is imported only by ipc/ and the *.desktop.ts
 * adapters, 2.1-M143). The host's dismissal of a one-time store notice goes to the Desktop root through main.tsx.
 */
export { getHealth as loadDesktopHealth, dismissStoreNoticeOnHost } from '../../ipc/health'
