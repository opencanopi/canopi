// editions/desktop/updates.ts
//
// Desktop updater host ports adapter over ipc/update.ts (tauri-only-in-native-host,
// ipc-only-in-desktop-adapters, ADR 0022, 2.1-M143; contracts §3). Invariant: the Desktop root passes these to App;
// app/updates and the components import no ipc/ module.

import {
  cancelUpdate,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  restartAfterUpdate,
  takeUpdateLaunchNotice,
} from '../../ipc/update'
import {
  getSettingsRecord,
  patchSettingsRecord,
  type SettingsRecordSnapshot,
} from '../../ipc/settings'
import { createUuid } from '../../utils/ids'

/**
 * Reads whether Desktop checks for updates at launch from settings record 2 (`launch_check`,
 * folded from legacy `updater.check_at_launch` on migration in 2e-2; missing defaults to true).
 */
async function getLaunchCheck(
  readRecord: () => Promise<SettingsRecordSnapshot> = getSettingsRecord,
): Promise<boolean> {
  const snapshot = await readRecord()
  return snapshot.record.launch_check !== false
}

/** Stores whether Desktop checks for updates at launch in settings record 2 (`launch_check`). */
async function setLaunchCheck(
  on: boolean,
  writePatch: (patch: Record<string, unknown>) => Promise<void> = patchSettingsRecord,
): Promise<void> {
  await writePatch({ launch_check: on })
}

// Shaped as app/updates' UpdaterPort, checked where main.tsx passes it to App (platform imports no app/ type).
const updater = {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  cancelUpdate,
  restartAfterUpdate,
  getLaunchCheck: () => getLaunchCheck(),
}

/** The host's update commands, the launch-check writer, the Windows next-launch marker and the op-id minter. */
export const desktopUpdatePorts = {
  updater,
  setLaunchCheck: (on: boolean) => setLaunchCheck(on),
  takeLaunchNotice: takeUpdateLaunchNotice,
  mintOperationId: createUuid,
}
