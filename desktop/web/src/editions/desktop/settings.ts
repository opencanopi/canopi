// editions/desktop/settings.ts
//
// Desktop settings record 2 adapter over ipc/settings.ts (tauri-only-in-native-host, ADR 0022; §18 F2).
// Invariant: Tauri is reached only through ipc/ and editions/desktop/.
// Runs through the same TS settings field-table interpreter as Web (ADR 0024, ADR 0026, 2.1-M518).

import type { SettingsPlatformAdapter } from '../../platform/settings'
import {
  getSettingsRecord,
  patchSettingsRecord,
  type SettingsRecordSnapshot,
} from '../../ipc/settings'
import {
  decodeSettingsRecord,
  regionFromLanguages,
  resolveHostFirstRunPatch,
  type SettingsFirstRunEnv,
} from '../../app/settings/interpreter'

export interface DesktopSettingsPlatformAdapterDeps {
  readonly getSettingsRecord: () => Promise<SettingsRecordSnapshot>
  readonly patchSettingsRecord: (patch: Record<string, unknown>) => Promise<void>
  readonly env?: () => SettingsFirstRunEnv
}

function detectDesktopEnv(): SettingsFirstRunEnv {
  const languages = typeof navigator !== 'undefined'
    ? (navigator.languages?.length ? navigator.languages : (navigator.language ? [navigator.language] : []))
    : []
  return { languages, region: regionFromLanguages(languages) }
}

export function createDesktopSettingsPlatformAdapter(
  deps: DesktopSettingsPlatformAdapterDeps = { getSettingsRecord, patchSettingsRecord },
): SettingsPlatformAdapter {
  const readEnv = deps.env ?? detectDesktopEnv
  let lastResetFields: string[] = []
  return {
    load: async () => {
      const snapshot = await deps.getSettingsRecord()
      const decoded = decodeSettingsRecord(snapshot.record, readEnv())
      lastResetFields = Array.from(new Set([...snapshot.reset_fields, ...decoded.resetFields]))
      return decoded.values
    },
    takeResetFields: () => lastResetFields.splice(0),
    save: async (settings) => {
      await deps.patchSettingsRecord({ ...settings })
    },
    savePatch: async (patch) => {
      await deps.patchSettingsRecord({ ...patch })
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
