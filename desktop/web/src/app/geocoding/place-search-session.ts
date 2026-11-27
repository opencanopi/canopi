import { effect, untracked } from '@preact/signals'
import { currentLocale } from '../../i18n'
import { editionPorts } from '../../platform/edition-ports'
import { designSessionStore } from '../document-session/store'
import { createPlaceSearchController, type PlaceSearchController } from './place-search'

export type { PlaceSearchResult } from './place-search'
export { parseCoordinates } from './place-search'

/** The app's one place search, bound lazily to the edition's geocoding transport (Stage 2 A1). */
export const placeSearch: PlaceSearchController = createPlaceSearchController({
  transport: (url, signal) => editionPorts().geocoding(url, signal),
  locale: currentLocale,
})

/** Forget the place search results; the field's text belongs to the field. */
function dismissPlaceSearch(): void {
  placeSearch.clear()
}

let disposeActiveSession: (() => void) | null = null

/**
 * A place search belongs to the Design it was opened for: replacing the
 * Design clears its results. Installed once per edition bootstrap.
 */
export function installPlaceSearchSession(): () => void {
  disposeActiveSession?.()
  let identity = designSessionStore.sessionIdentity.peek()
  const stop = effect(() => {
    const next = designSessionStore.sessionIdentity.value
    if (next === identity) return
    identity = next
    untracked(dismissPlaceSearch)
  })
  const dispose = (): void => {
    stop()
    if (disposeActiveSession === dispose) disposeActiveSession = null
  }
  disposeActiveSession = dispose
  return dispose
}

function disposePlaceSearchSession(): void {
  disposeActiveSession?.()
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposePlaceSearchSession()
    placeSearch.dispose()
  })
}
