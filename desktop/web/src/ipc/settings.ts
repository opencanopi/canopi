import { invokeCommand } from './transport'
import type { AppFolder, AppFolderLocations } from '../generated/contracts'
import type { Settings } from '../types/settings'

export async function getSettings(): Promise<Settings> {
  return invokeCommand('get_settings')
}

export async function setSettings(settings: Settings): Promise<void> {
  return invokeCommand('set_settings', { settings })
}

/** Settings › Files and data: where Drafts and the Data library live. Shown on screen only. */
export async function getAppFolders(): Promise<AppFolderLocations> {
  return invokeCommand('get_app_folders')
}

export async function showAppFolder(folder: AppFolder): Promise<void> {
  return invokeCommand('show_app_folder', { folder })
}
