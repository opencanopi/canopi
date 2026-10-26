import { batch, computed, effect, signal, untracked, type ReadonlySignal } from '@preact/signals'
import type {
  DynamicFilterOptions,
  FilterOp,
  FilterOptions,
  SpeciesFilter,
  SpeciesListItem,
} from '../../types/species'
import { locale } from '../settings/state'
import {
  createPlantSearchSession,
  DYNAMIC_OPTIONS_BACKEND_MISMATCH_ERROR,
  isActiveSpeciesSearchText,
  isPlantSearchLoading,
  recordCatalogFailure,
  type DynamicFilterOptionsAdapter,
  type SpeciesBrowseSort,
  type PlantSearchAdapter,
  type PlantSearchIntent,
  type PlantSearchResultState,
  type PlantSearchSupersedeAdapter,
  type PlantSearchStatus,
} from './search-session'
import { plantFilterCatalog, plantFilterModel, type StripControlField } from './plant-filter-model'

export { DYNAMIC_OPTIONS_BACKEND_MISMATCH_ERROR }
export type { SpeciesBrowseSort }

/** Every browse order, in menu order; an edition offers the ones its catalog can serve. */
export const SPECIES_BROWSE_SORTS: readonly SpeciesBrowseSort[] = ['Recommended', 'Name', 'Height', 'Edibility']

type FilterOptionsAdapter = () => Promise<FilterOptions | null>
type SupportedFilterFieldsAdapter = () => Promise<readonly string[] | null>
type FavoriteItemsAdapter = (locale: string) => Promise<SpeciesListItem[]>
type RecentlyViewedAdapter = (locale: string, limit: number) => Promise<SpeciesListItem[]>
type ToggleFavoriteAdapter = (canonicalName: string) => Promise<boolean>
type SpeciesSelectedAdapter = (canonicalName: string) => void | Promise<void>
type SpeciesDetailAdapter = (canonicalName: string, locale: string) => Promise<SpeciesCatalogDetail | null>
type CommonNamesAdapter = (canonicalNames: readonly string[], locale: string) => Promise<Readonly<Record<string, string>>>
type HabitsAdapter = (canonicalNames: readonly string[]) => Promise<Readonly<Record<string, string>>>

const ENGLISH = 'en'
const NO_DISPLAY_NAMES: SpeciesDisplayNames = { names: {}, englishFallbacks: [] }

/** What every plant list, label and export shows for a species in one language. */
export interface SpeciesDisplayNames {
  /** Common Name in the requested language, or the English one for the species in `englishFallbacks`. */
  readonly names: Readonly<Record<string, string>>
  /** Species shown with their English name, marked "(en)", because the language has none; empty in English. */
  readonly englishFallbacks: readonly string[]
}

export type SpeciesDisplayNameResolver = (canonicalNames: readonly string[], locale: string) => Promise<SpeciesDisplayNames>

/**
 * The one "(en)" projection over a Common Names lookup: the language's names,
 * then English for the rest. A failed language lookup fails the projection; a
 * failed English lookup only leaves those species without a fallback.
 */
export function composeSpeciesDisplayNames(resolveCommonNames: CommonNamesAdapter): SpeciesDisplayNameResolver {
  return async (canonicalNames, requestedLocale) => {
    const unique = [...new Set(canonicalNames)].filter(Boolean)
    if (unique.length === 0) return NO_DISPLAY_NAMES
    const names: Record<string, string> = { ...await resolveCommonNames(unique, requestedLocale) }
    const englishFallbacks: string[] = []
    if (requestedLocale.split('-')[0] !== ENGLISH) {
      const missing = unique.filter((name) => !names[name]?.trim())
      const english = missing.length > 0 ? await resolveCommonNames(missing, ENGLISH).catch((): Readonly<Record<string, string>> => ({})) : {}
      for (const name of missing) {
        const value = english[name]?.trim()
        if (value) {
          names[name] = value
          englishFallbacks.push(name)
        }
      }
    }
    return { names, englishFallbacks }
  }
}

export interface SpeciesCatalogFilterStripView {
  readonly options: FilterOptions | null
  readonly filters: SpeciesFilter
  readonly hasActive: boolean
  readonly activeCount: number
  readonly controls: readonly StripControlField[]
}

export interface SpeciesCatalogFavoritesView {
  readonly items: readonly SpeciesListItem[]
  readonly loading: boolean
  /** The last load failed: the panel says the catalog couldn't load, with Retry (`retryFavorites`), not "none yet". */
  readonly failed: boolean
  readonly revision: number
}

export interface SpeciesCatalogDynamicOptionsView {
  readonly cache: Readonly<Record<string, Readonly<Record<string, DynamicFilterOptions>>>>
  readonly pending: Readonly<Record<string, Readonly<Record<string, boolean>>>>
  readonly errors: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export interface SpeciesCatalogSidebarView {
  readonly favoriteNames: readonly string[]
  readonly recentlyViewed: readonly SpeciesListItem[]
  /** The last Recently viewed load failed, as `SpeciesCatalogFavoritesView.failed`. */
  readonly recentlyViewedFailed: boolean
  /** Recently viewed is loading, as `SpeciesCatalogFavoritesView.loading` (its Retry waits). */
  readonly recentlyViewedLoading: boolean
}

export interface SpeciesCatalogDetailImage {
  readonly url: string
  readonly source: string | null
  readonly source_page_url: string | null
  readonly credit: string | null
  readonly license: string | null
}

export interface SpeciesCatalogDetail {
  readonly canonical_name: string
  readonly common_name: string | null
  readonly common_names: readonly string[]
  readonly climate_zones: readonly string[]
  readonly habit: string | null
  readonly growth_form: string | null
  readonly life_cycles: readonly string[]
  readonly image: SpeciesCatalogDetailImage | null
}

export interface SpeciesCatalogDetailView {
  readonly canonicalName: string | null
  readonly detail: SpeciesCatalogDetail | null
  readonly loading: boolean
  readonly error: string | null
  /** The English name shown, marked "(en)", when the species has none in the interface language. */
  readonly englishName?: string | null
}

export interface SpeciesCatalogWorkbench {
  readonly intent: ReadonlySignal<PlantSearchIntent>
  readonly results: ReadonlySignal<PlantSearchResultState>
  readonly selectedCanonicalName: ReadonlySignal<string | null>
  /** Browse orders this edition's catalog serves, in menu order. */
  readonly browseSorts: readonly SpeciesBrowseSort[]
  readonly hasActiveFilters: ReadonlySignal<boolean>
  readonly filterStrip: ReadonlySignal<SpeciesCatalogFilterStripView>
  readonly favorites: ReadonlySignal<SpeciesCatalogFavoritesView>
  readonly dynamicOptions: ReadonlySignal<SpeciesCatalogDynamicOptionsView>
  readonly sidebar: ReadonlySignal<SpeciesCatalogSidebarView>
  readonly detail: ReadonlySignal<SpeciesCatalogDetailView>
  mount(view?: 'catalog' | 'favorites'): () => void
  dispose(): void
  reloadSidebarLists(): Promise<void>
  loadFavorites(): Promise<void>
  /** Loads Favorites and Recently viewed again, after a failure (their Retry). */
  retryFavorites(): void
  loadFilterOptions(): Promise<void>
  setSearchText(text: string): void
  clearSearchText(): void
  retrySearch(): void
  loadNextPage(): Promise<void>
  setBrowseSort(sort: SpeciesBrowseSort): void
  patchFilters(patch: Partial<SpeciesFilter>): void
  clearFilters(): void
  addExtraFilter(field: string, op: FilterOp, values: string[]): void
  removeExtraFilter(field: string): void
  loadDynamicOptions(fields: string[]): Promise<void>
  selectSpecies(canonicalName: string): void
  /** Loads the open species' detail again, after a failure (its Retry). */
  retrySpeciesDetail(): void
  closeSpeciesDetail(): void
  toggleFavorite(canonicalName: string): Promise<void>
  isFavorite(canonicalName: string): boolean
  isSearchLoading(status: PlantSearchStatus): boolean
  isActiveSearchText(text: string): boolean
  /**
   * Best Common Name per species in one catalog language; species without one are
   * absent. Cached per species and language for the workbench's lifetime; a
   * failed lookup is retried next time.
   */
  resolveCommonNames(canonicalNames: readonly string[], locale: string): Promise<Readonly<Record<string, string>>>
  /** The names a list, label or export shows: `resolveCommonNames` with the English fallback, over the same cache. */
  resolveDisplayNames: SpeciesDisplayNameResolver
  /** Catalog habit (`Tree`, `Shrub`, `Herbaceous`, `Climber`) per species; species without one are absent. */
  resolveHabits(canonicalNames: readonly string[]): Promise<Readonly<Record<string, string>>>
  /**
   * One unfiltered first page for `text` in the active locale, outside the catalog view's
   * own search session (so the catalog panel keeps its query and results).
   */
  searchCloseMatches(text: string, limit: number): Promise<readonly SpeciesListItem[]>
}

export interface SpeciesCatalogWorkbenchOptions {
  readonly search?: PlantSearchAdapter
  readonly supersedeSearch?: PlantSearchSupersedeAdapter
  readonly loadDynamicFilterOptions?: DynamicFilterOptionsAdapter
  readonly getFilterOptions?: FilterOptionsAdapter
  readonly getSupportedFilterFields?: SupportedFilterFieldsAdapter
  readonly getFavorites?: FavoriteItemsAdapter
  readonly getRecentlyViewed?: RecentlyViewedAdapter
  readonly toggleFavorite?: ToggleFavoriteAdapter
  readonly getSpeciesDetail?: SpeciesDetailAdapter
  readonly resolveCommonNames?: CommonNamesAdapter
  readonly resolveHabits?: HabitsAdapter
  readonly onSpeciesSelected?: SpeciesSelectedAdapter
  readonly locale?: ReadonlySignal<string>
  /** Browse orders the search adapter serves; defaults to all of them. */
  readonly browseSorts?: readonly SpeciesBrowseSort[]
  readonly favoritesIncludeRecentlyViewed?: boolean
  readonly pageSize?: number
  readonly textDebounceMs?: number
}

const missingSearchAdapter: PlantSearchAdapter = async () => {
  throw new Error('Species Catalog Workbench search adapter is not configured.')
}

const emptyDynamicFilterOptionsAdapter: DynamicFilterOptionsAdapter = async () => []
const emptyFilterOptionsAdapter: FilterOptionsAdapter = async () => null
const emptyFavoriteItemsAdapter: FavoriteItemsAdapter = async () => []
const emptyRecentlyViewedAdapter: RecentlyViewedAdapter = async () => []
const emptyToggleFavoriteAdapter: ToggleFavoriteAdapter = async () => false
const emptySpeciesDetailAdapter: SpeciesDetailAdapter = async () => null
const emptyCommonNamesAdapter: CommonNamesAdapter = async () => ({})
const emptyHabitsAdapter: HabitsAdapter = async () => ({})

export function createSpeciesCatalogWorkbench({
  search = missingSearchAdapter,
  supersedeSearch,
  loadDynamicFilterOptions = emptyDynamicFilterOptionsAdapter,
  getFilterOptions: getFilterOptionsAdapter = emptyFilterOptionsAdapter,
  getSupportedFilterFields: getSupportedFilterFieldsAdapter,
  getFavorites: getFavoritesAdapterOption,
  getRecentlyViewed: getRecentlyViewedAdapter = emptyRecentlyViewedAdapter,
  toggleFavorite: toggleFavoriteAdapter = emptyToggleFavoriteAdapter,
  getSpeciesDetail: getSpeciesDetailAdapter = emptySpeciesDetailAdapter,
  resolveCommonNames: resolveCommonNamesAdapter = emptyCommonNamesAdapter,
  resolveHabits: resolveHabitsAdapter = emptyHabitsAdapter,
  onSpeciesSelected,
  locale: localeSignal = locale,
  browseSorts = SPECIES_BROWSE_SORTS,
  favoritesIncludeRecentlyViewed = false,
  pageSize,
  textDebounceMs,
}: SpeciesCatalogWorkbenchOptions = {}): SpeciesCatalogWorkbench {
  const getFavoritesAdapter = getFavoritesAdapterOption ?? emptyFavoriteItemsAdapter
  const hasAuthoritativeFavoritesAdapter = getFavoritesAdapterOption !== undefined
  const favoriteStateOverrides = new Map<string, boolean>()
  const favoriteMutationItems = new Map<string, SpeciesListItem>()
  const favoriteOverridesRevision = signal(0)

  function projectFavoriteState(item: SpeciesListItem): SpeciesListItem {
    const override = favoriteStateOverrides.get(item.canonical_name)
    return override === undefined || override === item.is_favorite
      ? item
      : { ...item, is_favorite: override }
  }

  function reconcileFavoriteSnapshot(items: readonly SpeciesListItem[]): SpeciesListItem[] {
    const reconciled = items
      .filter((item) => favoriteStateOverrides.get(item.canonical_name) !== false)
      .map((item) => (item.is_favorite ? item : { ...item, is_favorite: true }))
    const presentNames = new Set(reconciled.map((item) => item.canonical_name))
    for (const [canonicalName, nowFavorite] of favoriteStateOverrides) {
      if (!nowFavorite || presentNames.has(canonicalName)) continue
      const mutationItem = favoriteMutationItems.get(canonicalName)
      if (!mutationItem) continue
      reconciled.push({ ...mutationItem, is_favorite: true })
      presentNames.add(canonicalName)
    }
    return reconciled
  }

  const plantSearchSession = createPlantSearchSession({
    search,
    supersedeSearch,
    loadDynamicFilterOptions,
    locale: localeSignal,
    pageSize,
    textDebounceMs,
  })
  const defaultBrowseSort = browseSorts[0]
  if (defaultBrowseSort && !browseSorts.includes(plantSearchSession.intent.peek().browseSort)) {
    plantSearchSession.setBrowseSort(defaultBrowseSort)
  }
  const filterOptions = signal<FilterOptions | null>(null)
  const supportedFilterFields = signal<ReadonlySet<string> | null>(
    getSupportedFilterFieldsAdapter ? new Set() : null,
  )
  const selectedCanonicalName = signal<string | null>(null)
  const detail = signal<SpeciesCatalogDetailView>({
    canonicalName: null,
    detail: null,
    loading: false,
    error: null,
  })
  const favoriteNames = signal<string[]>([])
  const favoriteItems = signal<SpeciesListItem[]>([])
  const favoriteItemsLoading = signal(false)
  const favoriteItemsFailed = signal(false)
  const recentlyViewedFailed = signal(false)
  const recentlyViewedLoading = signal(false)
  const favoriteItemsRevision = signal(0)
  const recentlyViewed = signal<SpeciesListItem[]>([])
  const projectedResults = computed<PlantSearchResultState>(() => {
    void favoriteOverridesRevision.value
    const result = plantSearchSession.results.value
    return {
      ...result,
      items: result.items.map(projectFavoriteState),
    }
  })
  const allStripControls = plantFilterCatalog.stripControls()
  const stripControls = computed(() => {
    const supported = supportedFilterFields.value
    return supported === null
      ? allStripControls
      : allStripControls.filter((control) => supported.has(control.filterKey))
  })

  const hasActiveFilters = computed(() => {
    const intent = plantSearchSession.intent.value
    return plantFilterModel.hasActive(intent.filters, intent.extraFilters)
  })

  const activeFilterCount = computed(() => {
    const intent = plantSearchSession.intent.value
    return plantFilterModel.activeCount(intent.filters, intent.extraFilters)
  })

  const selectedCanonical = computed(() => selectedCanonicalName.value)

  const filterStrip = computed<SpeciesCatalogFilterStripView>(() => ({
    options: filterOptions.value,
    filters: plantSearchSession.intent.value.filters,
    hasActive: hasActiveFilters.value,
    activeCount: activeFilterCount.value,
    controls: stripControls.value,
  }))

  const favorites = computed<SpeciesCatalogFavoritesView>(() => ({
    items: favoriteItems.value,
    loading: favoriteItemsLoading.value,
    failed: favoriteItemsFailed.value,
    revision: favoriteItemsRevision.value,
  }))

  const dynamicOptions = computed<SpeciesCatalogDynamicOptionsView>(() => ({
    cache: plantSearchSession.signals.dynamicOptionsCache.value,
    pending: plantSearchSession.signals.dynamicOptionsPending.value,
    errors: plantSearchSession.signals.dynamicOptionsErrors.value,
  }))

  const sidebar = computed<SpeciesCatalogSidebarView>(() => ({
    favoriteNames: favoriteNames.value,
    recentlyViewed: recentlyViewed.value,
    recentlyViewedFailed: recentlyViewedFailed.value,
    recentlyViewedLoading: recentlyViewedLoading.value,
  }))

  let favoriteItemsGeneration = 0
  let favoriteNamesGeneration = 0
  let sidebarListsGeneration = 0
  let detailGeneration = 0
  let filterMetadataGeneration = 0
  let filterOptionsLoaded = false
  let supportedFilterFieldsLoaded = getSupportedFilterFieldsAdapter === undefined
  let filterMetadataPromise: Promise<void> | null = null
  let favoriteItemsActivePromise: Promise<void> | null = null
  let favoriteItemsQueuedReload: { promise: Promise<void>; resolve: () => void } | null = null
  const favoriteToggleTails = new Map<string, Promise<void>>()
  const catalogUsers = signal(0)
  const favoritesUsers = signal(0)
  const catalogActive = computed(() => catalogUsers.value > 0)
  const viewsActive = computed(() => catalogUsers.value + favoritesUsers.value > 0)
  const recentActive = computed(() => catalogActive.value || (favoritesIncludeRecentlyViewed && favoritesUsers.value > 0))
  let disposeSearchSession: (() => void) | null = null
  let disposed = false

  function startPlantDbController(): void {
    if (disposed || disposeSearchSession) return
    disposeSearchSession = plantSearchSession.start()
  }

  function stopPlantDbController(): void {
    disposeSearchSession?.()
    disposeSearchSession = null
  }

  async function loadFilterOptions(): Promise<void> {
    if (disposed) return
    if (filterOptionsLoaded && supportedFilterFieldsLoaded) return
    const generation = filterMetadataGeneration
    filterMetadataPromise ??= Promise.all([
      loadFilterOptionsProjection(),
      loadSupportedFilterFieldProjection(),
    ]).then(([nextOptions, nextSupportedFields]) => {
      if (disposed || generation !== filterMetadataGeneration) return
      batch(() => {
        filterOptions.value = nextOptions
        if (nextSupportedFields !== null) {
          supportedFilterFields.value = new Set(nextSupportedFields)
        }
      })
    }).finally(() => {
      filterMetadataPromise = null
    })
    return filterMetadataPromise
  }

  async function loadFilterOptionsProjection(): Promise<FilterOptions | null> {
    try {
      const nextOptions = await getFilterOptionsAdapter()
      filterOptionsLoaded = true
      return nextOptions
    } catch {
      // Non-fatal: the filter strip can still render without option rows.
      return null
    }
  }

  async function loadSupportedFilterFieldProjection(): Promise<readonly string[] | null> {
    if (!getSupportedFilterFieldsAdapter) return null
    try {
      const nextSupportedFields = await getSupportedFilterFieldsAdapter()
      supportedFilterFieldsLoaded = true
      return nextSupportedFields
    } catch {
      // Non-fatal for desktop; Web keeps the initially empty supported set.
      return []
    }
  }

  async function toggleFavoriteAction(canonicalName: string): Promise<void> {
    if (disposed) return
    const previous = favoriteToggleTails.get(canonicalName) ?? Promise.resolve()
    const current = previous.then(() => performFavoriteToggle(canonicalName))
    favoriteToggleTails.set(canonicalName, current)
    try {
      await current
    } finally {
      if (favoriteToggleTails.get(canonicalName) === current) {
        favoriteToggleTails.delete(canonicalName)
      }
    }
  }

  async function performFavoriteToggle(canonicalName: string): Promise<void> {
    if (disposed) return
    try {
      const nowFavorite = await toggleFavoriteAdapter(canonicalName)
      if (disposed) return
      favoriteStateOverrides.set(canonicalName, nowFavorite)
      favoriteOverridesRevision.value += 1
      favoriteItemsGeneration += 1
      favoriteNamesGeneration += 1
      const localMutationItem = plantSearchSession.results.value.items.find((item) => (
        item.canonical_name === canonicalName
      )) ?? favoriteItems.value.find((item) => (
        item.canonical_name === canonicalName
      )) ?? recentlyViewed.value.find((item) => (
        item.canonical_name === canonicalName
      ))
      if (localMutationItem) favoriteMutationItems.set(canonicalName, localMutationItem)

      batch(() => {
        favoriteNames.value = reconcileFavoriteNames(
          favoriteNames.value,
          canonicalName,
          nowFavorite,
        )
        favoriteItems.value = reconcileFavoriteItems(
          favoriteItems.value,
          localMutationItem,
          canonicalName,
          nowFavorite,
        )
        recentlyViewed.value = recentlyViewed.value.map(projectFavoriteState)
      })

      plantSearchSession.updateResultItem(canonicalName, (item) => ({
        ...item,
        is_favorite: nowFavorite,
      }))
      if (favoriteItemsActivePromise) void queueFavoriteItemsReload()
      favoriteItemsRevision.value += 1
    } catch {
      // Non-fatal: UI state remains as it was before the attempted toggle.
    }
  }

  async function loadSidebarLists(includeFavorites = true): Promise<void> {
    if (disposed) return
    const generation = ++sidebarListsGeneration
    const favoriteGeneration = includeFavorites ? ++favoriteNamesGeneration : favoriteNamesGeneration
    const currentLocale = localeSignal.value
    recentlyViewedLoading.value = true
    try {
      const [favorites, recent] = await Promise.all([
        includeFavorites && hasAuthoritativeFavoritesAdapter
          ? getFavoritesAdapter(currentLocale).then(reconcileFavoriteSnapshot)
          : Promise.resolve(null),
        getRecentlyViewedAdapter(currentLocale, 50),
      ])
      if (disposed || generation !== sidebarListsGeneration || currentLocale !== localeSignal.value) return
      batch(() => {
        if (favorites && favoriteGeneration === favoriteNamesGeneration) {
          favoriteNames.value = favorites.map((item) => item.canonical_name)
        }
        recentlyViewed.value = recent.map(projectFavoriteState)
        recentlyViewedFailed.value = false
      })
    } catch (error) {
      // Search goes on; Recently viewed says the catalog couldn't load.
      if (disposed || generation !== sidebarListsGeneration || currentLocale !== localeSignal.value) return
      recordCatalogFailure(error)
      recentlyViewedFailed.value = true
    } finally {
      // The newest load ends the pending state; a superseded one leaves it to its successor.
      if (!disposed && generation === sidebarListsGeneration) recentlyViewedLoading.value = false
    }
  }

  function loadFavoriteItems(): Promise<void> {
    if (disposed || !hasAuthoritativeFavoritesAdapter) return Promise.resolve()
    return favoriteItemsActivePromise ? queueFavoriteItemsReload() : startFavoriteItemsLoad()
  }

  function startFavoriteItemsLoad(): Promise<void> {
    favoriteItemsLoading.value = true
    const attempt = runFavoriteItemsLoadAttempt()
    const ownedPromise: Promise<void> = attempt.finally(() => finishFavoriteItemsLoad(ownedPromise))
    favoriteItemsActivePromise = ownedPromise
    return ownedPromise
  }

  function queueFavoriteItemsReload(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (!favoriteItemsQueuedReload) {
      let resolve!: () => void
      const promise = new Promise<void>((next) => {
        resolve = next
      })
      favoriteItemsQueuedReload = { promise, resolve }
    }
    return favoriteItemsQueuedReload.promise
  }

  function finishFavoriteItemsLoad(ownedPromise: Promise<void>): void {
    if (favoriteItemsActivePromise !== ownedPromise) return
    favoriteItemsActivePromise = null
    const queuedReload = favoriteItemsQueuedReload
    favoriteItemsQueuedReload = null
    if (disposed || !queuedReload) {
      if (!disposed) favoriteItemsLoading.value = false
      queuedReload?.resolve()
      return
    }
    const trailing = startFavoriteItemsLoad()
    void trailing.then(queuedReload.resolve, queuedReload.resolve)
  }

  async function runFavoriteItemsLoadAttempt(): Promise<void> {
    const generation = ++favoriteItemsGeneration
    const favoriteGeneration = ++favoriteNamesGeneration
    const requestedLocale = localeSignal.value
    try {
      const items = reconcileFavoriteSnapshot(await getFavoritesAdapter(requestedLocale))
      if (
        disposed
        || generation !== favoriteItemsGeneration
        || requestedLocale !== localeSignal.value
      ) return
      batch(() => {
        favoriteItems.value = items
        if (favoriteGeneration === favoriteNamesGeneration) {
          favoriteNames.value = items.map((item) => item.canonical_name)
        }
        favoriteItemsFailed.value = false
      })
    } catch (error) {
      // The panel says the catalog couldn't load, with Retry; the raw error goes to the diagnostics only.
      if (disposed || generation !== favoriteItemsGeneration || requestedLocale !== localeSignal.value) return
      recordCatalogFailure(error)
      favoriteItemsFailed.value = true
    }
  }

  // One name cache for every plant list, label and export: a species and language
  // resolve once per workbench, and concurrent callers share the lookup in flight.
  const commonNameCache = new Map<string, Map<string, string | null>>()
  const commonNamesInFlight = new Map<string, Promise<void>>()
  const inFlightKey = (requestedLocale: string, canonicalName: string) => `${requestedLocale}\u0000${canonicalName}`

  async function resolveCommonNamesCached(
    canonicalNames: readonly string[],
    requestedLocale: string,
  ): Promise<Record<string, string>> {
    let cache = commonNameCache.get(requestedLocale)
    if (!cache) commonNameCache.set(requestedLocale, cache = new Map())
    const unique = [...new Set(canonicalNames)].filter(Boolean)
    const missing = unique.filter((name) => !cache.has(name) && !commonNamesInFlight.has(inFlightKey(requestedLocale, name)))
    if (missing.length > 0) {
      const lookup = resolveCommonNamesAdapter(missing, requestedLocale)
        .then((resolved) => {
          for (const name of missing) cache.set(name, resolved[name]?.trim() || null)
        })
        .finally(() => {
          for (const name of missing) commonNamesInFlight.delete(inFlightKey(requestedLocale, name))
        })
      for (const name of missing) commonNamesInFlight.set(inFlightKey(requestedLocale, name), lookup)
    }
    await Promise.all(unique.map((name) => commonNamesInFlight.get(inFlightKey(requestedLocale, name))))
    const names: Record<string, string> = {}
    for (const name of unique) {
      const value = cache.get(name)
      if (value) names[name] = value
    }
    return names
  }

  async function resolveEnglishName(canonicalName: string): Promise<string | null> {
    try {
      const names = await resolveCommonNamesCached([canonicalName], ENGLISH)
      return names[canonicalName] ?? null
    } catch {
      // Without an English name the title falls back to the scientific name.
      return null
    }
  }

  async function loadSpeciesDetail(canonicalName: string): Promise<void> {
    if (disposed) return
    const generation = ++detailGeneration
    const requestedLocale = localeSignal.value
    detail.value = {
      canonicalName,
      detail: null,
      loading: true,
      error: null,
    }

    try {
      const nextDetail = await getSpeciesDetailAdapter(canonicalName, requestedLocale)
      if (disposed || generation !== detailGeneration || selectedCanonicalName.value !== canonicalName) return
      const englishName = nextDetail && !nextDetail.common_name?.trim() && requestedLocale.split('-')[0] !== ENGLISH
        ? await resolveEnglishName(canonicalName)
        : null
      if (disposed || generation !== detailGeneration || selectedCanonicalName.value !== canonicalName) return
      detail.value = {
        canonicalName,
        detail: nextDetail,
        loading: false,
        error: null,
        englishName,
      }
    } catch (error) {
      if (disposed || generation !== detailGeneration || selectedCanonicalName.value !== canonicalName) return
      recordCatalogFailure(error)
      detail.value = {
        canonicalName,
        detail: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const disposeViewEffects = [
    effect(() => {
      if (!catalogActive.value) return
      untracked(() => {
        startPlantDbController()
        void loadFilterOptions()
      })
      return stopPlantDbController
    }),
    effect(() => {
      if (!viewsActive.value) return
      void localeSignal.value
      void favoriteItemsRevision.value
      untracked(() => { void loadFavoriteItems() })
    }),
    effect(() => {
      if (!recentActive.value) return
      void localeSignal.value
      untracked(() => { void loadSidebarLists(false) })
    }),
    effect(() => {
      if (!viewsActive.value) return
      void localeSignal.value
      const canonicalName = selectedCanonicalName.value
      if (canonicalName) untracked(() => { void loadSpeciesDetail(canonicalName) })
    }),
  ]

  return {
    intent: plantSearchSession.intent,
    results: projectedResults,
    selectedCanonicalName: selectedCanonical,
    browseSorts,
    hasActiveFilters,
    filterStrip,
    favorites,
    dynamicOptions,
    sidebar,
    detail,

    mount(view = 'catalog') {
      if (disposed) return () => {}
      const users = view === 'catalog' ? catalogUsers : favoritesUsers
      users.value += 1
      let released = false
      return () => {
        if (released || disposed) return
        released = true
        users.value -= 1
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      commonNameCache.clear()
      disposeViewEffects.forEach(dispose => dispose())
      stopPlantDbController()
      plantSearchSession.dispose()
      favoriteItemsGeneration += 1
      favoriteNamesGeneration += 1
      sidebarListsGeneration += 1
      detailGeneration += 1
      filterMetadataGeneration += 1
      favoriteItemsQueuedReload?.resolve()
      favoriteItemsQueuedReload = null
    },

    reloadSidebarLists: loadSidebarLists,
    loadFavorites: loadFavoriteItems,
    loadFilterOptions,

    setSearchText(text) {
      if (disposed) return
      plantSearchSession.setText(text)
    },

    clearSearchText() {
      if (disposed) return
      plantSearchSession.setText('')
    },

    retrySearch() {
      if (disposed) return
      plantSearchSession.retry()
      void loadFilterOptions()
      void loadFavoriteItems()
      void loadSidebarLists(false)
    },

    retryFavorites() {
      if (disposed) return
      void loadFavoriteItems()
      void loadSidebarLists(false)
    },

    loadNextPage() {
      if (disposed) return Promise.resolve()
      return plantSearchSession.loadNextPage()
    },

    setBrowseSort(sort) {
      if (disposed || !browseSorts.includes(sort)) return
      plantSearchSession.setBrowseSort(sort)
    },

    patchFilters(patch) {
      if (disposed) return
      plantSearchSession.patchFilters(patch)
    },

    clearFilters() {
      if (disposed) return
      plantSearchSession.clearFilters()
    },

    addExtraFilter(field, op, values) {
      if (disposed) return
      plantSearchSession.addExtraFilter(field, op, values)
    },

    removeExtraFilter(field) {
      if (disposed) return
      plantSearchSession.removeExtraFilter(field)
    },

    loadDynamicOptions(fields) {
      if (disposed) return Promise.resolve()
      return plantSearchSession.loadDynamicOptions(fields)
    },

    selectSpecies(canonicalName) {
      if (disposed) return
      const alreadySelected = selectedCanonicalName.peek() === canonicalName
      selectedCanonicalName.value = canonicalName
      if (alreadySelected || !viewsActive.peek()) void loadSpeciesDetail(canonicalName)
      try {
        void Promise.resolve(onSpeciesSelected?.(canonicalName))
          // The recorded view is what "Recently viewed" lists, so it reloads once the record lands.
          .then(() => { if (recentActive.peek()) void loadSidebarLists(false) })
          .catch(() => {
            // Non-fatal: selection should still open even if recents persistence fails.
          })
      } catch {
        // Non-fatal: selection should still open even if recents persistence fails.
      }
    },

    retrySpeciesDetail() {
      if (disposed) return
      const canonicalName = selectedCanonicalName.peek()
      if (canonicalName) void loadSpeciesDetail(canonicalName)
    },

    closeSpeciesDetail() {
      if (disposed) return
      detailGeneration += 1
      selectedCanonicalName.value = null
      detail.value = {
        canonicalName: null,
        detail: null,
        loading: false,
        error: null,
      }
    },

    toggleFavorite: toggleFavoriteAction,

    isFavorite(canonicalName) {
      return favoriteNames.value.includes(canonicalName)
    },

    isSearchLoading: isPlantSearchLoading,

    isActiveSearchText: isActiveSpeciesSearchText,

    resolveCommonNames(canonicalNames, requestedLocale) {
      if (disposed || canonicalNames.length === 0) return Promise.resolve({})
      return resolveCommonNamesCached(canonicalNames, requestedLocale)
    },

    resolveDisplayNames: composeSpeciesDisplayNames((canonicalNames, requestedLocale) => {
      if (disposed) return Promise.resolve({})
      return resolveCommonNamesCached(canonicalNames, requestedLocale)
    }),

    resolveHabits(canonicalNames) {
      if (disposed || canonicalNames.length === 0) return Promise.resolve({})
      return resolveHabitsAdapter(canonicalNames)
    },

    async searchCloseMatches(text, limit) {
      if (disposed || !isActiveSpeciesSearchText(text)) return []
      const page = await search({
        text,
        filters: plantFilterModel.toRequestFilters(plantFilterModel.createEmpty(), []),
        cursor: null,
        limit,
        sort: 'Relevance',
        locale: localeSignal.peek(),
        include_total: false,
      })
      return page.items
    },
  }
}

function reconcileFavoriteNames(
  names: readonly string[],
  canonicalName: string,
  nowFavorite: boolean,
): string[] {
  if (!nowFavorite) return names.filter((name) => name !== canonicalName)
  return names.includes(canonicalName) ? [...names] : [...names, canonicalName]
}

function reconcileFavoriteItems(
  items: readonly SpeciesListItem[],
  mutationItem: SpeciesListItem | undefined,
  canonicalName: string,
  nowFavorite: boolean,
): SpeciesListItem[] {
  if (!nowFavorite) return items.filter((item) => item.canonical_name !== canonicalName)
  const existing = items.find((item) => item.canonical_name === canonicalName)
  if (existing) {
    return items.map((item) => (
      item.canonical_name === canonicalName ? { ...item, is_favorite: true } : item
    ))
  }
  return mutationItem
    ? [{ ...mutationItem, is_favorite: true }, ...items]
    : [...items]
}
