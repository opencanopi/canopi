import { Channel, invokeCommand } from './transport'
import type { UpdateDownload, UpdateOffer, UpdateProgress } from '../generated/contracts'

/**
 * The Desktop updater's commands (contracts §3 Updater, 2.1-M241). Each rejects with an `UpdaterFailure`; the webview
 * holds no `updater:*` permission, so these are the only way in (2.1-Q240). A check or download carries the caller's
 * operation id (a fresh `crypto.randomUUID()` per request), the one its cancel names: the cancel stops it even when it
 * reaches the host before the op does.
 */

/** Checks the channel for a newer release for this installer: the offer, or null. */
export async function checkForUpdate(operation: string): Promise<UpdateOffer | null> {
  return invokeCommand('update_check', { operation })
}

/** Downloads and verifies the offered update, reporting progress; `link_only` when it cannot replace itself. */
export async function downloadUpdate(operation: string, onProgress: (progress: UpdateProgress) => void): Promise<UpdateDownload> {
  const progress = new Channel<UpdateProgress>()
  progress.onmessage = onProgress
  return invokeCommand('update_download', { operation, progress })
}

/** Installs the verified update; a failure leaves the Design open. The Windows installer relaunches with the Design at
 * `designPath` open; null (a Draft) opens the start screen. */
export async function installUpdate(designPath: string | null): Promise<void> {
  return invokeCommand('update_install', { designPath })
}

/** Cancels the check or download `operation` names, which then rejects as cancelled. */
export async function cancelUpdate(operation: string): Promise<void> {
  return invokeCommand('update_cancel', { operation })
}

/** Restarts into the updated Canopi with the Design at `designPath` open; null (a Draft) opens the start screen. */
export async function restartAfterUpdate(designPath: string | null): Promise<void> {
  return invokeCommand('update_restart', { designPath })
}

/** Whether Canopi checks for an update at launch. */
export async function getLaunchCheck(): Promise<boolean> {
  return invokeCommand('update_launch_check_get')
}

export async function setLaunchCheck(on: boolean): Promise<void> {
  return invokeCommand('update_launch_check_set', { on })
}

/** Whether this launch follows a Windows update that did not install: true once. */
export async function takeUpdateLaunchNotice(): Promise<boolean> {
  return invokeCommand('update_take_launch_notice')
}
