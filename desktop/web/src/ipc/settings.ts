import { invokeTyped, mintOperationId } from './transport'
import type { AppFolder, AppFolderLocations } from '../generated/contracts'
import type { Settings } from '../types/settings'

export async function getSettings(): Promise<Settings> {
  return invokeTyped('get_settings', undefined, mintOperationId('u'))
}

export async function setSettings(settings: Settings): Promise<void> {
  return invokeTyped('set_settings', { settings }, mintOperationId('u'))
}

/** Settings › Files and data: where Drafts and the Data library live. Shown on screen only. */
export async function getAppFolders(): Promise<AppFolderLocations> {
  return invokeTyped('get_app_folders', undefined, mintOperationId('u'))
}

export async function showAppFolder(folder: AppFolder): Promise<void> {
  await invokeTyped('show_app_folder', { folder }, mintOperationId('u'))
}

/** Reads an allowlisted opaque string row from the user DB settings table (Stage 2 E1, ADR 0024). */
export async function getSettingRow(key: string): Promise<string | null> {
  return invokeTyped('get_setting_row', { key }, mintOperationId('u'))
}

/** Writes an allowlisted opaque string row to the user DB settings table (Stage 2 E1, ADR 0024). */
export async function setSettingRow(key: string, value: string): Promise<void> {
  await invokeTyped('set_setting_row', { key, value }, mintOperationId('u'))
}
