import { createDuckDbReducedSpeciesCatalogReader } from './duckdb-wasm-catalog'
import {
  createReducedSpeciesCatalogAdapters,
  type ReducedSpeciesCatalogReader,
} from './reduced-species-catalog'
import {
  browserAppDataStore,
  type BrowserAppDataStore,
} from '../../web/browser-app-data'
import {
  createSpeciesCatalogWorkbench,
  type SpeciesCatalogWorkbench,
} from '../../app/plant-browser'

interface OwnedReducedSpeciesCatalogReader extends ReducedSpeciesCatalogReader {
  dispose(): Promise<void>
}

interface BrowserSpeciesCatalogRuntimeOptions {
  readonly appDataStore?: BrowserAppDataStore
  readonly reader?: OwnedReducedSpeciesCatalogReader
}

export interface BrowserSpeciesCatalogRuntime {
  readonly workbench: SpeciesCatalogWorkbench
  dispose(): Promise<void>
}

export function createBrowserSpeciesCatalogRuntime({
  appDataStore = browserAppDataStore,
  reader = createDuckDbReducedSpeciesCatalogReader(),
}: BrowserSpeciesCatalogRuntimeOptions = {}): BrowserSpeciesCatalogRuntime {
  const catalogAdapters = createReducedSpeciesCatalogAdapters({
    appDataStore,
    reader,
  })
  const resolveCommonNames = async (names: readonly string[], locale: string): Promise<Record<string, string>> => {
    const rows = await reader.listSpeciesByCanonicalNames(names, locale, new Set())
    return Object.fromEntries(rows.filter((row) => row.common_name?.trim()).map((row) => [row.canonical_name, row.common_name!]))
  }
  // The Web artifact carries each species' catalog habit on its row.
  const resolveHabits = async (names: readonly string[]): Promise<Record<string, string>> => {
    const rows = await reader.listSpeciesByCanonicalNames(names, 'en', new Set())
    return Object.fromEntries(rows.filter((row) => row.habit?.trim()).map((row) => [row.canonical_name, row.habit!]))
  }
  const workbench = createSpeciesCatalogWorkbench({
    resolveCommonNames,
    resolveHabits,
    // The Web artifact carries no ratings or heights (see the species catalog guide).
    browseSorts: ['Recommended', 'Name'],
    favoritesIncludeRecentlyViewed: true,
    search: catalogAdapters.search,
    loadDynamicFilterOptions: catalogAdapters.loadDynamicFilterOptions,
    getFilterOptions: catalogAdapters.getFilterOptions,
    getSupportedFilterFields: catalogAdapters.getSupportedFilterFields,
    getFavorites: catalogAdapters.getFavorites,
    getRecentlyViewed: catalogAdapters.getRecentlyViewed,
    getSpeciesDetail: catalogAdapters.getSpeciesDetail,
    toggleFavorite: catalogAdapters.toggleFavorite,
    onSpeciesSelected: catalogAdapters.recordRecentlyViewed,
  })
  let disposePromise: Promise<void> | null = null

  return {
    workbench,
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise
      disposePromise = (async () => {
        workbench.dispose()
        await reader.dispose()
      })()
      return disposePromise
    },
  }
}
