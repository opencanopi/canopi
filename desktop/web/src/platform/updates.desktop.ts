// platform/updates.desktop.ts
//
// Owner of the Desktop updater's host ports: a native host adapter over ipc/update.ts (ipc-only-in-desktop-adapters,
// 2.1-M143; contracts §3). Invariant: the Desktop root passes these to App; app/updates and the components import no
// ipc/ module.

import {
  cancelUpdate,
  checkForUpdate,
  downloadUpdate,
  getLaunchCheck,
  installUpdate,
  restartAfterUpdate,
  setLaunchCheck,
  takeUpdateLaunchNotice,
} from '../ipc/update'
import { createUuid } from '../utils/ids'

// Shaped as app/updates' UpdaterPort, checked where main.tsx passes it to App (platform imports no app/ type).
const updater = { checkForUpdate, downloadUpdate, installUpdate, cancelUpdate, restartAfterUpdate, getLaunchCheck }

/** The host's update commands, the launch-check key row's writer, the Windows next-launch marker and the op-id minter. */
export const desktopUpdatePorts = {
  updater,
  setLaunchCheck,
  takeLaunchNotice: takeUpdateLaunchNotice,
  mintOperationId: createUuid,
}
