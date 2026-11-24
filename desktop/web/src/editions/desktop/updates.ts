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
import { getSettingRow, setSettingRow } from '../../ipc/settings'
import { createUuid } from '../../utils/ids'

const UPDATER_CHECK_AT_LAUNCH_KEY = 'updater.check_at_launch'

/**
 * Reads whether Desktop checks for updates at launch from the allowlisted `updater.check_at_launch`
 * key row (Stage 2 E1, ADR 0024, 2.1-M538; missing defaults to true; 2e folds into settings record 2).
 */
async function getLaunchCheck(
  readRow: (key: string) => Promise<string | null> = getSettingRow,
): Promise<boolean> {
  const stored = await readRow(UPDATER_CHECK_AT_LAUNCH_KEY)
  return stored !== 'false'
}

/** Stores whether Desktop checks for updates at launch via the opaque settings row command. */
async function setLaunchCheck(
  on: boolean,
  writeRow: (key: string, value: string) => Promise<void> = setSettingRow,
): Promise<void> {
  await writeRow(UPDATER_CHECK_AT_LAUNCH_KEY, on ? 'true' : 'false')
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

/** The host's update commands, the launch-check key row's writer, the Windows next-launch marker and the op-id minter. */
export const desktopUpdatePorts = {
  updater,
  setLaunchCheck: (on: boolean) => setLaunchCheck(on),
  takeLaunchNotice: takeUpdateLaunchNotice,
  mintOperationId: createUuid,
}
