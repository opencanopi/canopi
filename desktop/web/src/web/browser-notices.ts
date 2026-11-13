/**
 * web/browser-notices.ts: the Web Edition's notices on the one notice row (failures/notices.ts, contracts §18 F3,
 * 2.1-Q290): the launch's Earlier data, an action's outcome (a GeoJSON import or export, a Design that cannot be
 * opened, a Draft download that failed, a Draft opened read-only while 2.1's Drafts could not be listed) and the New version: Reload offer. Invariant: each is locale keys, never words;
 * an action's outcome shows at the front of the row, older notices waiting behind it (2.1-Q304), and replaces the one
 * before it under the same key; the release offer yields to every later notice (2.1-M182) and, while Reload writes the Design first, reads Saving… with neither Reload nor Dismiss taking a click
 * (2.1-Q83, Q187, M179). With no Design open it promises no save first (canopi-eon8.15).
 */
import { effect, signal, type ReadonlySignal } from '@preact/signals'
import type { DesignOpenFailureNotice } from '../app/document-session/open-failure'
import type { GeoJsonNotice } from '../app/geojson/workflow'
import { raiseNotice, withdrawNotice, type NoticeSpec } from '../failures/notices'

type ActionNotice = Pick<NoticeSpec, 'tone' | 'title' | 'message' | 'params' | 'detail' | 'action'>

/** Shows an action's outcome at the front of the row, replacing the outcome shown before it under the same key. */
function showOutcome(key: string, notice: ActionNotice): void {
  withdrawNotice(key)
  raiseNotice({ key, ...notice, kind: 'outcome' })
}

export function presentBrowserGeoJsonNotice(notice: GeoJsonNotice): void {
  showOutcome('web.geojson', notice)
}

export function presentBrowserDesignOpenFailure(notice: DesignOpenFailureNotice): void {
  showOutcome('web.open-failure', notice)
}

/** A Draft gone from this browser (another tab, or the browser cleared it) could not be downloaded. */
export function presentBrowserDraftDownloadFailure(): void {
  showOutcome('web.draft-download', { tone: 'error', title: 'webStorage.downloadFailedTitle', message: 'webStorage.downloadFailedMessage' })
}

/** A listed Draft gone from this browser by the time it opens (2.1 or another tab deleted it): opened nothing. */
export function presentBrowserDraftOpenFailure(): void {
  showOutcome('web.open-failure', { tone: 'error', title: 'start.cantOpenTitle', message: 'webStorage.downloadFailedMessage' })
}

const DRAFT_UNCHECKED = 'web.draft-unchecked'

/**
 * An old-key Draft opened read-only while 2.1's Draft listing could not be read: it may be a copy 2.1 replaced, so the
 * notice offers its Download a copy (2.1-Q334).
 */
export function presentBrowserDraftUncheckedNotice(download: () => void): void {
  showOutcome(DRAFT_UNCHECKED, {
    tone: 'warning', message: 'webStorage.uncheckedReadOnly', action: { label: 'webShell.downloadCopy', run: download },
  })
}

/** That view's session ended: its notice goes with it. */
export function withdrawBrowserDraftUncheckedNotice(): void {
  withdrawNotice(DRAFT_UNCHECKED)
}

/** Browser data from before Canopi 2.0 stays in place, unread (ADR 0021): told once, at the launch that finds it. */
export function raiseEarlierDataNotice(): void {
  raiseNotice({ key: 'web.earlier-data', title: 'health.localDataNotOpenedTitle', message: 'health.localDataNotOpened' })
}

const RELEASE_NOTICE = 'web.release'

/**
 * Raises New version: Reload while `waiting` names a release and withdraws it once none waits; returns the dispose.
 * `reload` writes the Design first and resolves false when the user cancels its save problem.
 */
export function installReleaseNotice({ waiting, designOpen, reload, dismiss, onError }: {
  readonly waiting: ReadonlySignal<unknown>
  readonly designOpen: () => boolean
  readonly reload: () => Promise<boolean>
  readonly dismiss: () => void
  readonly onError: (error: unknown) => void
}): () => void {
  const reloading = signal(false)
  // A withdrawal is this module's own doing, not the user's Dismiss: the watch keeps the release.
  let withdrawing = false
  const withdraw = () => {
    withdrawing = true
    try {
      withdrawNotice(RELEASE_NOTICE)
    } finally {
      withdrawing = false
    }
  }
  const run = () => {
    if (reloading.peek()) return
    reloading.value = true
    reload().then((reloaded) => {
      if (!reloaded) reloading.value = false
    }, (error: unknown) => {
      reloading.value = false
      onError(error)
    })
  }
  const stop = effect(() => {
    if (waiting.value === null) {
      withdraw()
      return
    }
    raiseNotice({
      key: RELEASE_NOTICE,
      title: 'webRelease.title',
      message: 'webRelease.message',
      messageNow: () => (designOpen() ? 'webRelease.message' : 'webRelease.messageNoDesign'),
      action: { label: 'notice.reload', run, busy: { label: 'saveStatus.saving', now: () => reloading.value } },
      kind: 'offer',
      onDismiss: () => {
        if (!withdrawing) dismiss()
      },
    })
  })
  return () => {
    stop()
    withdraw()
  }
}
