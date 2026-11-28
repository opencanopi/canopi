import type { CommandName } from '../../generated/command-map'
import type { FilterOptions, DynamicFilterOptions, SpeciesListItem } from '../../generated/contracts'
import { createSpeciesCatalogWorkbench, type SpeciesCatalogWorkbench } from '../../app/plant-browser'
import { galleryCommandTransport } from './command-adapter'

export function createGallerySpeciesCatalogWorkbench(): SpeciesCatalogWorkbench {
  const call = <T,>(command: CommandName, args?: Record<string, unknown>) =>
    galleryCommandTransport(command, args, undefined) as Promise<T>

  return createSpeciesCatalogWorkbench({
    search: (request) => call('search_species', { request }),
    supersedeSearch: () => call('supersede_species_search'),
    loadDynamicFilterOptions: (fields, locale) =>
      call<DynamicFilterOptions[]>('get_dynamic_filter_options', { fields, locale }),
    getFilterOptions: () => call<FilterOptions | null>('get_filter_options'),
    getFavorites: (locale) => call<SpeciesListItem[]>('get_favorites', { locale }),
    getRecentlyViewed: (locale, limit) => call<SpeciesListItem[]>('get_recently_viewed', { locale, limit }),
    toggleFavorite: (canonicalName) => call<boolean>('toggle_favorite', { canonicalName }),
    resolveCommonNames: (canonicalNames, locale) =>
      call<Record<string, string>>('get_common_names', { canonicalNames, locale }),
    resolveHabits: (canonicalNames) =>
      call<Record<string, string>>('get_species_habits', { canonicalNames }),
  })
}
