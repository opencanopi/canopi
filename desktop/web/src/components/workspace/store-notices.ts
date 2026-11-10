/**
 * components/workspace/store-notices.ts: each root's wiring from the one store health model to the notice row
 * (failures/health-notices.ts; canopi-f47t.52.36). Invariant: a root installs it once for its lifetime with the actions
 * its edition has; one it lacks is never drawn (Web has no problem report and reloads to update, so no Update).
 * Settings carry Try again on both editions (SET-05, 2.1-Q295). It imports nothing Desktop-only: the Desktop root
 * passes its problem report and the host's dismissal of a one-time notice; Update opens About, where Desktop updates.
 */
import { openAboutCanopiDialog } from '../../app/about/state'
import { retrySettingsLoad } from '../../app/settings/projection'
import { installHealthNotices } from '../../failures/health-notices'
import type { StoreId } from '../../generated/contracts'

function retrySettings(): void {
  void retrySettingsLoad()
}

/** Raises each store's notice with the root's Report a problem and, where it updates in About, Update; returns the dispose. */
export function installStoreNotices(edition: {
  readonly report: (() => void) | null
  readonly updatesInAbout: boolean
  /** The host's dismissal of a one-time notice, where the host's health outlives the page (Desktop); else null. */
  readonly dismissOnHost: ((store: StoreId) => Promise<void>) | null
}): () => void {
  const update = edition.updatesInAbout ? openAboutCanopiDialog : null
  return installHealthNotices({ report: edition.report, update, retry: { settings: retrySettings }, dismissOnHost: edition.dismissOnHost })
}
