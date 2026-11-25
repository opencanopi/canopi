// editions/desktop/settings.ts
//
// Desktop settings record adapter over ipc/settings.ts (tauri-only-in-native-host, ADR 0022; §18 F2).
// Invariant: Tauri is reached only through ipc/ and editions/desktop/.
// Runs through the same TS settings field-table interpreter as Web (ADR 0026, 2.1-M518).

import type { SettingsPlatformAdapter } from '../../platform/settings'
import { getSettings, setSettings } from '../../ipc/settings'
import type { Settings } from '../../types/settings'
import { createV1WireSettingsAdapter, type SettingsFirstRunEnv } from '../../app/settings/interpreter'

export interface DesktopSettingsPlatformAdapterDeps {
  readonly getSettings: () => Promise<Settings>
  readonly setSettings: (settings: Settings) => Promise<void>
  readonly env?: () => SettingsFirstRunEnv
}

export function createDesktopSettingsPlatformAdapter(
  deps: DesktopSettingsPlatformAdapterDeps = { getSettings, setSettings },
): SettingsPlatformAdapter {
  return createV1WireSettingsAdapter(deps)
}

export const desktopSettingsPlatformAdapter = createDesktopSettingsPlatformAdapter()

/**
 * The host's subsystem health query, which platform/desktop.ts hands bootstrapShell beside this settings adapter: the
 * shell's two host reads at start come from this one Desktop adapter (ipc/ is imported only by ipc/ and the *.desktop.ts
 * adapters, 2.1-M143). The host's dismissal of a one-time store notice goes to the Desktop root through main.tsx.
 */
export { getHealth as loadDesktopHealth, dismissStoreNoticeOnHost } from '../../ipc/health'
