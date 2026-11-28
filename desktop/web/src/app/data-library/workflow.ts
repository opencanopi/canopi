import { effect, untracked } from '@preact/signals'
import { designSessionStore } from '../document-session/store'
import { reconcileEntryNames, settleResultAttachments } from './actions'
import { ensureLidarPolling, lidarLibrary, stopLidarPolling } from './library-store'

/**
 * Desktop-lifetime owner of library polling.
 *
 * Installed once for the Desktop application/workspace, not per panel and not
 * per Design. Imports and analyses are library work: they keep running and
 * settling across panel navigation and Design replacement; results join only
 * the Design session that asked, once they are published. Each snapshot and
 * each Design switch also refreshes the open Design's stored entry names from
 * the library's names (never a Design Edit), so a missing row later shows the
 * name the library last had.
 */
let installed = false
let disposeAttachments: (() => void) | null = null

export function installLidarWorkflow(): void {
  disposeLidarWorkflow()
  installed = true
  // Reads only the snapshot and the session identity, so a Design switch settles pending attachments and refreshes
  // names at once, and a plain Design edit runs neither again.
  disposeAttachments = effect(() => {
    designSessionStore.sessionIdentity.value
    const snapshot = lidarLibrary.value
    untracked(() => {
      settleResultAttachments(snapshot)
      reconcileEntryNames(snapshot)
    })
  })
  // Reopen/application start refreshes immediately and resumes polling if
  // native work is still settling.
  ensureLidarPolling()
}

export function disposeLidarWorkflow(): void {
  if (installed) {
    stopLidarPolling()
    disposeAttachments?.()
    disposeAttachments = null
    installed = false
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeLidarWorkflow()
  })
}
