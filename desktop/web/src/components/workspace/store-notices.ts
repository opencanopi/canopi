/**
 * components/workspace/store-notices.ts: each root's wiring from the one store health model to the notice row
 * (failures/health-notices.ts; canopi-f47t.52.36). Invariant: a root installs it once for its lifetime with the actions
 * its edition has; one it lacks is never drawn. Both roots pass their problem report (Web downloads it), which takes the
 * store's origin so the report lists that store's state first (2.1-Q286); only Desktop has Update, which opens About,
 * and the host's dismissal of a one-time notice (Web reloads to update, and its page is the run). Settings carry Try
 * again on both editions (SET-05, 2.1-Q295). It imports nothing Desktop-only.
 */
import { openAboutCanopiDialog } from '../../app/about/state'
import { retrySettingsLoad } from '../../app/settings/projection'
import { installHealthNotices, type HealthNoticeActions } from '../../failures/health-notices'
import type { StoreId } from '../../generated/contracts'

/** Raises each store's notice with the root's Report a problem and, where it updates in About, Update; returns the dispose. */
export function installStoreNotices(edition: {
  /** Opens the problem report from a store's origin, which the report lists first. */
  readonly report: HealthNoticeActions['report']
  readonly updatesInAbout: boolean
  /** The host's dismissal of a one-time notice, where the host's health outlives the page (Desktop); else null. */
  readonly dismissOnHost: ((store: StoreId) => Promise<void>) | null
}): () => void {
  const update = edition.updatesInAbout ? openAboutCanopiDialog : null
  return installHealthNotices({ report: edition.report, update, retry: { settings: retrySettingsLoad }, dismissOnHost: edition.dismissOnHost })
}
