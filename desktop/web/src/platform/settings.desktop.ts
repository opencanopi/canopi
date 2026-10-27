// platform/settings.desktop.ts
//
// Owner of the Desktop settings record: a native host adapter for @tauri-apps/* (tauri-only-in-native-host, ADR 0022;
// §18 F2). Invariant: Tauri is reached only through ipc/ and the platform Desktop adapters.

import type { SettingsPlatformAdapter } from '../app/settings/platform-adapter'
import { getSettings, setSettings } from '../ipc/settings'
import type { Settings } from '../types/settings'

export interface DesktopSettingsPlatformAdapterDeps {
  readonly getSettings: () => Promise<Settings>
  readonly setSettings: (settings: Settings) => Promise<void>
}

const DEFAULT_DEPS: DesktopSettingsPlatformAdapterDeps = {
  getSettings,
  setSettings,
}

export function createDesktopSettingsPlatformAdapter(
  deps: DesktopSettingsPlatformAdapterDeps = DEFAULT_DEPS,
): SettingsPlatformAdapter {
  return {
    load: deps.getSettings,
    save: deps.setSettings,
  }
}

export const desktopSettingsPlatformAdapter = createDesktopSettingsPlatformAdapter()
