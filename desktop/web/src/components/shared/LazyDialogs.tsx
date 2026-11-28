// components/shared/LazyDialogs.tsx
// On-demand dynamic-import wrappers for dialogs that are closed at startup so desktop chunk: index
// stays comfortably below its ceiling without raising bundle budgets (2b-3, #454 C1).

import { useEffect, useState } from 'preact/hooks'
import { aboutCanopiDialogOpen } from '../../app/about/state'
import { problemReportDialogOpen } from '../../app/problem-report/state'
import { keyboardShortcutsDialogOpen, settingsDialogOpen } from '../../app/shell/dialogs'
import type { UpdateController } from '../../app/updates/controller'
import type { InputPlatform } from '../../canvas/runtime/input/platform'
import { reportFailure } from '../../failures/report'
import type { AppFolder, AppFolderLocations } from '../../generated/contracts'
import type { MenuDefinition } from './KeyboardShortcutsDialog'
import type { LaunchCheckPort } from './launch-check-port'

export { openProblemReport } from '../../app/problem-report/submission'
export { createLaunchCheckPort, type LaunchCheckPort } from './launch-check-port'

export interface SettingsFoldersAdapter {
  load(): Promise<AppFolderLocations>
  show(folder: AppFolder): Promise<void>
}

function useLazyModule<T>(open: boolean, loader: () => Promise<T>): T | null {
  const [mod, setMod] = useState<T | null>(null)
  useEffect(() => {
    if (!open || mod !== null) return
    let live = true
    void loader()
      .then((loaded) => {
        if (live && loaded) setMod(() => loaded)
      })
      .catch((error: unknown) => {
        if (live) reportFailure(error, { shown: 'none', source: 'lazy-dialog' })
      })
    return () => { live = false }
  }, [open, mod, loader])
  return mod
}

const loadSettingsDialog = () => import('./SettingsDialog')
const loadProblemReportDialog = () => import('./ProblemReportDialog')
const loadAboutCanopiDialog = () => import('./AboutCanopiDialog')
const loadKeyboardShortcutsDialog = () => import('./KeyboardShortcutsDialog')

export function LazySettingsDialog({
  folders,
  launchCheckPort,
}: {
  readonly folders?: SettingsFoldersAdapter
  readonly launchCheckPort?: LaunchCheckPort
}) {
  const open = settingsDialogOpen.value
  const mod = useLazyModule(open, loadSettingsDialog)
  if (!open || !mod) return null
  const { SettingsDialog, LaunchCheckSwitch } = mod
  return (
    <SettingsDialog
      folders={folders}
      updates={launchCheckPort ? <LaunchCheckSwitch port={launchCheckPort} /> : undefined}
    />
  )
}

export function LazyProblemReportDialog() {
  const open = problemReportDialogOpen.value
  const mod = useLazyModule(open, loadProblemReportDialog)
  if (!open || !mod) return null
  const { ProblemReportDialog } = mod
  return <ProblemReportDialog />
}

export function LazyAboutCanopiDialog({
  controller,
  downloadPage,
}: {
  readonly controller?: UpdateController
  readonly downloadPage?: string
}) {
  const open = aboutCanopiDialogOpen.value
  const mod = useLazyModule(open, loadAboutCanopiDialog)
  if (!open || !mod) return null
  const { AboutCanopiDialog, AboutUpdates } = mod
  return (
    <AboutCanopiDialog
      {...(controller && downloadPage ? { updates: <AboutUpdates controller={controller} downloadPage={downloadPage} /> } : {})}
    />
  )
}

export function LazyKeyboardShortcutsDialog({
  menus,
  platform,
  linuxPinchNote,
}: {
  readonly menus: readonly MenuDefinition[]
  readonly platform: InputPlatform
  readonly linuxPinchNote: boolean
}) {
  const open = keyboardShortcutsDialogOpen.value
  const mod = useLazyModule(open, loadKeyboardShortcutsDialog)
  if (!open || !mod) return null
  const { KeyboardShortcutsDialog } = mod
  return <KeyboardShortcutsDialog menus={menus} platform={platform} linuxPinchNote={linuxPinchNote} />
}
