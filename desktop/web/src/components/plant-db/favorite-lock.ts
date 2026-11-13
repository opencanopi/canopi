import { storeStatus } from '../../failures/health'
import type { StoreOpenStatus } from '../../generated/contracts'
import type { LocaleKey } from '../../generated/locale-keys'
import { t } from '../../i18n'

/**
 * Why the favourite star is off in each state of the store that holds favourites, or null where writes go through; a
 * new state fails typecheck until it says which. Favourites a newer Canopi saved are shown, never changed, with the
 * same reason in both editions (2.1-Q320, Q111). Web species lists that could not be read say what their launch notice
 * says; a Desktop user database that could not open leaves the star live, so its write fails visibly.
 */
const FAVORITE_LOCK: {
  readonly [S in 'web_species_lists' | 'user_db']: { readonly [K in StoreOpenStatus['kind']]: LocaleKey | null }
} = {
  web_species_lists: {
    opening: null,
    migrating: null,
    ready: null,
    recovered: null,
    set_aside_damaged: null,
    newer_read_only: 'plantDb.favoriteNeedsNewer',
    refused_newer: 'plantDb.favoriteNeedsNewer',
    unavailable: 'health.writesRefused.webSpeciesLists',
  },
  user_db: {
    opening: null,
    migrating: null,
    ready: null,
    recovered: null,
    set_aside_damaged: null,
    newer_read_only: 'plantDb.favoriteNeedsNewer',
    refused_newer: 'plantDb.favoriteNeedsNewer',
    unavailable: null,
  },
}

/**
 * Why every favourite star is off, or undefined while the star works. The star stays focusable (aria-disabled, not
 * disabled), so its tooltip shows on hover and focus. Each edition reports only its own store (Web the species lists,
 * Desktop the user database); the other stays opening, which locks nothing.
 */
export function favoriteLockedReason(): string | undefined {
  const key = FAVORITE_LOCK.web_species_lists[storeStatus('web_species_lists').kind]
    ?? FAVORITE_LOCK.user_db[storeStatus('user_db').kind]
  return key ? t(key) : undefined
}
