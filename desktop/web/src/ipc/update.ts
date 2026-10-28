import { Channel, invoke } from '@tauri-apps/api/core'
import type { UpdateDownload, UpdateOffer, UpdateProgress } from '../generated/contracts'

/**
 * The Desktop updater's commands (contracts §3 Updater, 2.1-M241). Each rejects with an `UpdateFailure`; the webview
 * holds no `updater:*` permission, so these are the only way in (2.1-Q240).
 */

/** Checks the channel for a newer release for this installer: the offer, or null. */
export async function checkForUpdate(): Promise<UpdateOffer | null> {
  return invoke('update_check')
}

/** Downloads and verifies the offered update, reporting progress; `link_only` when it cannot replace itself. */
export async function downloadUpdate(onProgress: (progress: UpdateProgress) => void): Promise<UpdateDownload> {
  const progress = new Channel<UpdateProgress>()
  progress.onmessage = onProgress
  return invoke('update_download', { progress })
}

/** Installs the verified update; a failure leaves the Design open. */
export async function installUpdate(): Promise<void> {
  return invoke('update_install')
}

/** Cancels the running check or download, which then rejects as cancelled. */
export async function cancelUpdate(): Promise<void> {
  return invoke('update_cancel')
}

/** Restarts into the updated Canopi with the Design at `designPath` open; null (a Draft) opens the start screen. */
export async function restartAfterUpdate(designPath: string | null): Promise<void> {
  return invoke('update_restart', { designPath })
}

/** Whether Canopi checks for an update at launch. */
export async function getLaunchCheck(): Promise<boolean> {
  return invoke('update_launch_check_get')
}

export async function setLaunchCheck(on: boolean): Promise<void> {
  return invoke('update_launch_check_set', { on })
}

/** Whether this launch follows a Windows update that did not install: true once. */
export async function takeUpdateLaunchNotice(): Promise<boolean> {
  return invoke('update_take_launch_notice')
}
