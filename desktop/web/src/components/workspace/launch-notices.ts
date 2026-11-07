/**
 * components/workspace/launch-notices.ts: Owner of the Desktop root's launch and update notices on the one notice row
 * (failures/notices.ts; contracts §18 F3, 2.1-Q290). Invariant: each takes no focus and stays until dismissed: the
 * launch check's available update (2.1-Q164, M211) until dismissed or installed this session, and, since the launch
 * check runs once per launch and nothing is stored, again at the next launch until installed (2.1-Q293); the Windows
 * next-launch "Update not installed" (2.1-Q234); "Canopi opens one Design at a time" (2.1-Q228); and "Installing
 * update…" or "Finishing update…" while a window close waits for an update (2.1-Q254), withdrawn once it settles.
 */
import { effect } from '@preact/signals'
import { openAboutCanopiDialog } from '../../app/about/state'
import { dismissMultiOpenNotice, multiOpenNotice } from '../../app/document-session/launch-file'
import { closeWaitsFor } from '../../app/shell/close-guard'
import type { UpdateController } from '../../app/updates/controller'
import { raiseNotice, withdrawNotice } from '../../failures/notices'
import type { UpdateOffer } from '../../generated/contracts'

const UPDATE_AVAILABLE = 'update.available'
const UPDATE_CLOSING = 'update.closing'

/** "Canopi {version} is available", whose action opens About, where the download starts (2.1-Q235). */
export function raiseUpdateNotice(offer: UpdateOffer): void {
  raiseNotice({
    key: UPDATE_AVAILABLE,
    message: 'update.available',
    params: { version: offer.version },
    action: { label: 'about.title', run: openAboutCanopiDialog },
  })
}

/** "Update not installed", the one time the host's next-launch marker is read (2.1-Q234). */
export function raiseUpdateNotInstalledNotice(): void {
  raiseNotice({ key: 'update.not-installed', message: 'update.failure.notInstalledPlain', tone: 'warning' })
}

/** Withdraws the available update once the controller has installed it; returns the dispose. */
export function withdrawUpdateNoticeOnInstall(controller: UpdateController): () => void {
  return effect(() => {
    if (controller.state.value.kind === 'installed') withdrawNotice(UPDATE_AVAILABLE)
  })
}

/** Raises the multi-open and closing notices as their signals say; returns the dispose. */
export function raiseLaunchNotices(): () => void {
  const multiOpen = effect(() => {
    if (multiOpenNotice.value === null) return
    raiseNotice({
      key: 'launch.multi-open',
      message: 'launch.oneDesignAtATime',
      onDismiss: () => {
        const id = multiOpenNotice.peek()
        if (id !== null) dismissMultiOpenNotice(id)
      },
    })
  })
  const closing = effect(() => {
    const waitsFor = closeWaitsFor.value
    withdrawNotice(UPDATE_CLOSING)
    if (waitsFor !== null) raiseNotice({ key: UPDATE_CLOSING, message: waitsFor === 'install' ? 'update.installing' : 'update.finishing' })
  })
  return () => {
    multiOpen()
    closing()
  }
}
