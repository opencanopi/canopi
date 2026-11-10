/**
 * failures/health-notices.ts: the store notices on the one notice row (contracts §11, design check F3;
 * 2.1-Q285, Q287, Q295, Q296): each root installs it once with its edition's actions. Invariant: a store's state is told
 * once per session, by one notice keyed by StoreId and state, a new code or file under the same kind replacing it; a dismissed one stays dismissed while the state holds; a
 * state that no longer holds withdraws its notice; a one-time StoreNotice is cleared in the model when dismissed, and on a host that outlives the page.
 */
import { effect } from '@preact/signals'
import type { StoreId } from '../generated/contracts'
import { dismissStoreNotice, storeHealth } from './health'
import { noticeForStore, oneTimeNoticePrefix } from './health-presentation'
import { raiseNotice, withdrawNotice } from './notices'
import type { ReportOrigin } from './report'

export interface HealthNoticeActions {
  /** Opens the edition's problem report from a store's state; null where the edition has none yet. */
  readonly report: ((origin: ReportOrigin) => void) | null
  /** Opens the edition's update; null where it has no updater. */
  readonly update: (() => void) | null
  /** Each store's own Try again, where its owner can open it again (settings, 2.1-Q295). */
  readonly retry?: { readonly [S in StoreId]?: () => void }
  /**
   * Tells a host whose health outlives the page that a one-time notice was dismissed, so a reload in the same app run
   * does not tell it again (Desktop's `dismiss_store_notice`; ADR 0021 "says once"); null where the page is the run.
   */
  readonly dismissOnHost?: ((store: StoreId) => Promise<void>) | null
}

/** Raises each store's notice as the health model says; returns the dispose, which withdraws nothing already told. */
export function installHealthNotices(actions: HealthNoticeActions): () => void {
  // The keys told this session per store: a dismissed notice is not raised again while its key holds.
  const told = new Map<StoreId, Set<string>>()
  return effect(() => {
    const health = storeHealth.value
    for (const store of Object.keys(health) as StoreId[]) {
      const entry = health[store]
      if (!entry) continue
      const specs = noticeForStore(store, entry, {
        report: actions.report,
        update: actions.update,
        retry: actions.retry?.[store] ?? null,
        dismissNotice: () => {
          dismissStoreNotice(store)
          // A refused dismissal is already in the ring (ipc/transport.ts); the notice may then show after a reload.
          actions.dismissOnHost?.(store).catch(() => undefined)
        },
      })
      const current = new Set(specs.map((spec) => spec.key))
      const previous = told.get(store) ?? new Set<string>()
      const oneTime = (key: string) => key.startsWith(oneTimeNoticePrefix(store))
      // A status that no longer holds (settings read on Try again, a new code or file under the same kind) leaves the
      // row, its successor raised in its place; a one-time notice is kept until dismissed.
      for (const key of previous) {
        if (!current.has(key) && !oneTime(key)) withdrawNotice(key)
      }
      for (const spec of specs) {
        if (!previous.has(spec.key)) raiseNotice(spec)
      }
      told.set(store, new Set([...[...previous].filter(oneTime), ...current]))
    }
  })
}
