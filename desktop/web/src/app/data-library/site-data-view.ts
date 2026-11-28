// app/lidar/site-data-view.ts
//
// Owns the Site data panel's view state for one Design session (canopi-f47t.42, spec §1.10): the open item, the collapsed
// rows, the filter text and the scroll position. It survives the dock unmounting the panel (Ctrl 1, Ctrl 2) and starts
// fresh with a new Design session, as `planning-view/state.ts` does for the planning panels. None of it is stored. The pin
// and the profile are not view state: they end when the panel closes (`site-transients.ts`).

import { batch, signal, type Signal } from '@preact/signals'
import { designSessionStore } from '../document-session/store'
import { selectPanel } from '../shell/state'
import { readCurrentLidarPresentation } from './library-store'

export interface SiteDataView {
  readonly sessionIdentity: object
  /** The one item whose settings show under its row; null when every row is closed. */
  readonly openItem: Signal<string | null>
  /** Collapsed rows: item ids, and `analysis:<definitionId>` for an analysis group line. Expanded by default. */
  readonly collapsed: Signal<ReadonlySet<string>>
  readonly filter: Signal<string>
  /** The list's scroll position, restored when the panel mounts again. */
  scrollTop: number
  /** The item the list scrolls into view (`nearest`) once it is drawn; a new object for each request. */
  readonly reveal: Signal<{ readonly id: string } | null>
}

let owner: SiteDataView | null = null

/** The view state of one Design session: the same object for as long as that session is open. */
export function siteDataViewFor(sessionIdentity: object): SiteDataView {
  if (owner?.sessionIdentity === sessionIdentity) return owner
  owner = {
    sessionIdentity,
    openItem: signal(null),
    collapsed: signal(new Set()),
    filter: signal(''),
    scrollTop: 0,
    reveal: signal(null),
  }
  return owner
}

/**
 * Shows one item of this Design in Site data: opens the panel, expands the rows and analysis group lines above it, opens
 * the item and asks the list to scroll it into view.
 */
export function showInSiteData(id: string): void {
  const view = siteDataViewFor(designSessionStore.sessionIdentity.peek())
  const items = new Map(readCurrentLidarPresentation().map((item) => [item.id, item]))
  const expand = new Set<string>()
  const seen = new Set<string>()
  for (let item = items.get(id); item && !seen.has(item.id); item = item.parentId ? items.get(item.parentId) : undefined) {
    seen.add(item.id)
    if (item.id !== id) expand.add(item.id)
    if (item.definitionId) expand.add(`analysis:${item.definitionId}`)
  }
  batch(() => {
    selectPanel('site-data')
    view.collapsed.value = new Set([...view.collapsed.peek()].filter((key) => !expand.has(key)))
    view.openItem.value = id
    view.reveal.value = { id }
  })
}
