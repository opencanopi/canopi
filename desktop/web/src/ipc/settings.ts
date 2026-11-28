import { invokeTyped, mintOperationId } from './transport'
import type { AppFolder, AppFolderLocations } from '../generated/contracts'

export interface SettingsRecordSnapshot {
  readonly record: Record<string, unknown>
  readonly reset_fields: readonly string[]
  readonly newer_read_only: boolean
}

/** Reads the Desktop settings record 2 snapshot (`settings.json`, 2e-2, ADR 0024/0026). */
export async function getSettingsRecord(): Promise<SettingsRecordSnapshot> {
  return invokeTyped('get_settings_record', undefined, mintOperationId('u'))
}

/** Merges a changed-fields patch into Desktop `settings.json`, preserving unknown keys. */
export async function patchSettingsRecord(patch: Record<string, unknown>): Promise<void> {
  return invokeTyped('patch_settings_record', { patch }, mintOperationId('u'))
}

/** Settings › Files and data: where Drafts and the Data library live. Shown on screen only. */
export async function getAppFolders(): Promise<AppFolderLocations> {
  return invokeTyped('get_app_folders', undefined, mintOperationId('u'))
}

export async function showAppFolder(folder: AppFolder): Promise<void> {
  await invokeTyped('show_app_folder', { folder }, mintOperationId('u'))
}
