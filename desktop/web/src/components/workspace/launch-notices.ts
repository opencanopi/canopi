/**
 * components/workspace/launch-notices.ts: the Desktop root's launch and update notices on the one notice row
 * (failures/notices.ts; contracts §18 F3, 2.1-Q290). Invariant: each takes no focus and stays until dismissed: the
 * launch check's available update (2.1-Q164, M211) until dismissed or its install starts this session, and, since the
 * launch check runs once per launch and nothing is stored, again at the next launch until installed (2.1-Q293); the
 * Windows next-launch "Update not installed" (2.1-Q234); "Canopi opens one Design at a time" (2.1-Q228); and
 * "Installing update…" or "Finishing update…" while a window close waits for an update (2.1-Q254), an undismissable
 * status the queue shows ahead of the rest, withdrawn once it settles.
 */
import { effect } from '@preact/signals'
import { openAboutCanopiDialog } from '../../app/about/state'
import { dismissMultiOpenNotice, multiOpenNotice } from '../../app/document-session/launch-file'
import { closeWaitsFor } from '../../app/shell/close-guard'
import type { UpdateController } from '../../app/updates/controller'
import type { UpdateStateKind } from '../../app/updates/state'
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

/** "Update not installed", the one time the host's next-launch marker is read (2.1-Q234): the outcome of the install the
 * user started, so it shows ahead of a store notice raised at boot (2.1-Q304). */
export function raiseUpdateNotInstalledNotice(): void {
  raiseNotice({ key: 'update.not-installed', message: 'update.failure.notInstalledPlain', tone: 'warning', kind: 'outcome' })
}

/** The states in which the offer's install has started, so About (and, while a close waits, the row) says the rest. */
const INSTALL_UNDERWAY: ReadonlySet<UpdateStateKind> = new Set(['installing', 'close_requested', 'installed'])

/** Withdraws the available update once its install starts (2.1-Q293's "installed this session"); returns the dispose. */
export function withdrawUpdateNoticeOnInstall(controller: UpdateController): () => void {
  return effect(() => {
    if (INSTALL_UNDERWAY.has(controller.state.value.kind)) withdrawNotice(UPDATE_AVAILABLE)
  })
}

/** Raises the multi-open and closing notices as their signals say; returns the dispose. */
export function raiseLaunchNotices(): () => void {
  const multiOpen = effect(() => {
    if (multiOpenNotice.value === null) return
    raiseNotice({
      key: 'launch.multi-open',
      message: 'launch.oneDesignAtATime',
      // The result of the launch the user just made, so it shows ahead of a store notice raised at boot (2.1-Q304).
      kind: 'outcome',
      onDismiss: () => {
        const id = multiOpenNotice.peek()
        if (id !== null) dismissMultiOpenNotice(id)
      },
    })
  })
  const closing = effect(() => {
    const waitsFor = closeWaitsFor.value
    withdrawNotice(UPDATE_CLOSING)
    if (waitsFor === null) return
    raiseNotice({ key: UPDATE_CLOSING, message: waitsFor === 'install' ? 'update.installing' : 'update.finishing', undismissable: true })
  })
  return () => {
    multiOpen()
    closing()
  }
}
