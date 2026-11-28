/**
 * platform/page-rules.ts: Owner of frontend search-text folding and normalisation (search-fold-only-in-search-text, ADR 0027, 2.1-Q45, contracts §17, §18 F18).
 * Invariant: delegates to the generated Unicode fold rules from species-search-normalization.ts so every plant list and
 * every non-plant list (Calendar, Start screen, Drafts) folds text identically.
 */

import { normalizeSpeciesSearch } from '../utils/species-search-normalization'

export { normalizeSpeciesSearch }

/** Normalises free text for case-, accent-, and script-insensitive matching. */
export function normalizeSearchText(text: string): string {
  return normalizeSpeciesSearch(text).text
}
