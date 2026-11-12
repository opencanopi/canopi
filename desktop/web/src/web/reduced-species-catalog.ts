import type {
  DynamicFilterOptions,
  FilterOptions,
  PaginatedResult,
  SpeciesListItem,
  SpeciesSearchRequest,
} from '../types/species'
import type { SpeciesCatalogDetail } from '../app/plant-browser/workbench'
import type { BrowserAppDataStore } from './browser-app-data'
import { StoreRefusedError } from '../failures/store-read'

export type WebSupportedFilterOptionsKey = keyof Pick<
  FilterOptions,
  'climate_zones' | 'habits' | 'life_cycles' | 'sun_tolerances' | 'soil_tolerances' | 'growth_rates'
>

export interface ReducedSpeciesRow {
  readonly id: string
  readonly slug: string
  readonly canonical_name: string
  readonly common_name: string | null
  readonly climate_zones: readonly string[]
  readonly habit: string | null
  readonly growth_form: string | null
  readonly life_cycles: readonly string[]
}

export interface ReducedSpeciesImageRow {
  readonly species_id: string
  readonly url: string
  readonly source: string | null
  readonly source_page_url: string | null
  readonly credit: string | null
  readonly license: string | null
}

export interface ReducedSpeciesCatalogReader {
  searchSpecies(
    request: SpeciesSearchRequest,
    favoriteNames: ReadonlySet<string>,
  ): Promise<PaginatedResult<SpeciesListItem>>
  listSpeciesByCanonicalNames(
    canonicalNames: readonly string[],
    locale: string,
    favoriteNames: ReadonlySet<string>,
  ): Promise<SpeciesListItem[]>
  getSupportedFilterFields(): Promise<readonly string[]>
  getFilterOptions(): Promise<FilterOptions>
  getDynamicFilterOptions(fields: readonly string[], locale: string): Promise<DynamicFilterOptions[]>
  getSpeciesDetail(canonicalName: string, locale: string): Promise<SpeciesCatalogDetail | null>
}

export interface ReducedSpeciesCatalogAdapters {
  search(request: SpeciesSearchRequest): Promise<PaginatedResult<SpeciesListItem>>
  getSupportedFilterFields(): Promise<readonly string[]>
  getFilterOptions(): Promise<FilterOptions>
  loadDynamicFilterOptions(fields: string[], locale: string): Promise<DynamicFilterOptions[]>
  getFavorites(locale: string): Promise<SpeciesListItem[]>
  getRecentlyViewed(locale: string, limit: number): Promise<SpeciesListItem[]>
  getSpeciesDetail(canonicalName: string, locale: string): Promise<SpeciesCatalogDetail | null>
  toggleFavorite(canonicalName: string): Promise<boolean>
  recordRecentlyViewed(canonicalName: string, limit?: number): Promise<void>
}

/**
 * What a failed species-list write throws: a refusing store's `StoreRefusedError` passes through with its silent
 * `store_read_only` code (2.1-M487), so no second failure is worded over the store's one notice; any other failure
 * keeps its English line for logs, the cause attached.
 */
function refusal(error: unknown, english: string): Error {
  return error instanceof StoreRefusedError ? error : new Error(english, { cause: error })
}

interface ReducedSpeciesCatalogAdaptersOptions {
  readonly appDataStore: BrowserAppDataStore
  readonly reader: ReducedSpeciesCatalogReader
}

export function createReducedSpeciesCatalogAdapters({
  appDataStore,
  reader,
}: ReducedSpeciesCatalogAdaptersOptions): ReducedSpeciesCatalogAdapters {
  function favoriteNameSet(): ReadonlySet<string> {
    return new Set(appDataStore.listFavoriteSpecies())
  }

  return {
    search(request) {
      return reader.searchSpecies(request, favoriteNameSet())
    },

    getFilterOptions() {
      return reader.getFilterOptions()
    },

    getSupportedFilterFields() {
      return reader.getSupportedFilterFields()
    },

    loadDynamicFilterOptions(fields, locale) {
      return reader.getDynamicFilterOptions(fields, locale)
    },

    getFavorites(locale) {
      const names = appDataStore.listFavoriteSpecies()
      return reader.listSpeciesByCanonicalNames(names, locale, favoriteNameSet())
    },

    getRecentlyViewed(locale, limit) {
      const names = appDataStore.listRecentlyViewedSpecies().slice(0, limit)
      return reader.listSpeciesByCanonicalNames(names, locale, favoriteNameSet())
    },

    getSpeciesDetail(canonicalName, locale) {
      return reader.getSpeciesDetail(canonicalName, locale)
    },

    async toggleFavorite(canonicalName) {
      const current = appDataStore.listFavoriteSpecies()
      const isFavorite = current.includes(canonicalName)
      const next = isFavorite
        ? current.filter((name) => name !== canonicalName)
        : [canonicalName, ...current]
      const result = appDataStore.setFavoriteSpecies(next)
      if (!result.ok) throw refusal(result.error, 'Failed to persist Web Edition Species favorite.')
      return !isFavorite
    },

    async recordRecentlyViewed(canonicalName, limit = 50) {
      const result = appDataStore.recordRecentlyViewedSpecies(canonicalName, limit)
      if (!result.ok) throw refusal(result.error, 'Failed to persist Web Edition recently viewed Species.')
    },
  }
}
