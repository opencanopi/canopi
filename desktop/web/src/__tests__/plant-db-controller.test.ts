import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DynamicFilterOptions, SpeciesListItem } from '../types/species'
import { installSpeciesCatalogWorkbench as __installCatalog } from '../app/plant-browser'
import { speciesCatalogWorkbench as __desktopCatalog } from '../editions/desktop/species-catalog'
__installCatalog(__desktopCatalog)

const mocks = vi.hoisted(() => ({
  searchSpecies: vi.fn(async () => ({
    items: [],
    next_cursor: null,
    total_estimate: 0,
  })),
  supersedeSpeciesSearch: vi.fn(async () => {}),
  getFilterOptions: vi.fn(async () => null),
  getDynamicFilterOptions: vi.fn(async () => []),
  toggleFavorite: vi.fn(),
  getFavorites: vi.fn(async () => []),
  getRecentlyViewed: vi.fn(async () => []),
}))

vi.mock('../ipc/species', () => ({
  searchSpecies: mocks.searchSpecies,
  supersedeSpeciesSearch: mocks.supersedeSpeciesSearch,
  getFilterOptions: mocks.getFilterOptions,
  getDynamicFilterOptions: mocks.getDynamicFilterOptions,
}))

vi.mock('../ipc/favorites', () => ({
  toggleFavorite: mocks.toggleFavorite,
  getFavorites: mocks.getFavorites,
  getRecentlyViewed: mocks.getRecentlyViewed,
}))

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makePlant(canonicalName: string, isFavorite = false): SpeciesListItem {
  return {
    canonical_name: canonicalName,
    slug: canonicalName.toLowerCase().replace(/\s+/g, '-'),
    common_name: canonicalName,
    common_name_2: null,
    matched_common_name: null,
    is_name_fallback: false,
    family: null,
    genus: null,
    height_max_m: null,
    hardiness_zone_min: null,
    hardiness_zone_max: null,
    growth_rate: null,
    stratum: null,
    habit: null,
    climate_zones: [],
    life_cycles: [],
    edibility_rating: null,
    medicinal_rating: null,
    width_max_m: null,
    is_favorite: isFavorite,
  }
}

beforeEach(() => {
  vi.resetModules()
  mocks.searchSpecies.mockClear()
  mocks.supersedeSpeciesSearch.mockClear()
  mocks.getFilterOptions.mockClear()
  mocks.getDynamicFilterOptions.mockClear()
  mocks.toggleFavorite.mockClear()
  mocks.getFavorites.mockClear()
  mocks.getRecentlyViewed.mockClear()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Species Catalog Workbench lifecycle', () => {
  it('does not execute searches on module import alone', async () => {
    await import('../app/plant-browser')
    expect(mocks.searchSpecies).not.toHaveBeenCalled()
  })

  it('starts searches on mount and stops after dispose', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const dispose = plantDb.speciesCatalogWorkbench.mount()

    await flushMicrotasks()
    expect(mocks.searchSpecies).toHaveBeenCalledTimes(1)

    mocks.searchSpecies.mockClear()
    dispose()
    plantDb.speciesCatalogWorkbench.setSearchText('lin')
    await flushMicrotasks()

    expect(mocks.searchSpecies).not.toHaveBeenCalled()
  })

  it('routes active-to-too-short search supersession through the desktop IPC adapter', async () => {
    vi.useFakeTimers()
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const activeSearch = deferred<Awaited<ReturnType<typeof mocks.searchSpecies>>>()
    const dispose = plantDb.speciesCatalogWorkbench.mount()
    await flushMicrotasks()

    mocks.searchSpecies.mockReturnValueOnce(activeSearch.promise)
    plantDb.speciesCatalogWorkbench.setSearchText('al')
    vi.advanceTimersByTime(150)
    await flushMicrotasks()
    expect(mocks.searchSpecies).toHaveBeenCalledTimes(2)

    plantDb.speciesCatalogWorkbench.setSearchText('a')
    expect(mocks.supersedeSpeciesSearch).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(150)
    await flushMicrotasks()
    activeSearch.resolve({ items: [], next_cursor: null, total_estimate: 0 })
    await flushMicrotasks()
    dispose()
  })

  it('surfaces explicit unavailable errors when search short-circuits in degraded mode', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    ;(mocks.searchSpecies as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Plant database unavailable: bundled plant database is missing'))

    const dispose = plantDb.speciesCatalogWorkbench.mount()
    await flushMicrotasks()

    const results = plantDb.speciesCatalogWorkbench.results.value
    expect(results.error).toBe(
      'Plant database unavailable: bundled plant database is missing',
    )
    expect(plantDb.speciesCatalogWorkbench.isSearchLoading(results.status)).toBe(false)
    dispose()
  })

  it('increments result-set revision on first-page searches but not pagination appends', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    ;(mocks.searchSpecies as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      next_cursor: 'offset:50',
      total_estimate: 0,
    })
    const dispose = plantDb.speciesCatalogWorkbench.mount()

    await flushMicrotasks()
    expect(plantDb.speciesCatalogWorkbench.results.value.committedRevision).toBe(1)

    ;(mocks.searchSpecies as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    })

    await plantDb.speciesCatalogWorkbench.loadNextPage()

    expect(plantDb.speciesCatalogWorkbench.results.value.committedRevision).toBe(1)
    dispose()
  })

  it('caches dynamic filter options per locale', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const appState = await import('../app/settings/state')
    const englishOptions: DynamicFilterOptions[] = [
      {
        field: 'habit',
        field_type: 'categorical',
        values: [{ value: 'Shrub', label: 'Shrub' }],
        range: null,
      },
    ]
    const frenchOptions: DynamicFilterOptions[] = [
      {
        field: 'habit',
        field_type: 'categorical',
        values: [{ value: 'Shrub', label: 'Arbuste' }],
        range: null,
      },
    ]

    ;(mocks.getDynamicFilterOptions as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(englishOptions)
      .mockResolvedValueOnce(frenchOptions)

    appState.locale.value = 'en'
    await plantDb.speciesCatalogWorkbench.loadDynamicOptions(['habit'])
    expect(mocks.getDynamicFilterOptions).toHaveBeenNthCalledWith(1, ['habit'], 'en')
    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.cache.en?.habit?.values?.[0]?.label).toBe('Shrub')

    appState.locale.value = 'fr'
    await plantDb.speciesCatalogWorkbench.loadDynamicOptions(['habit'])
    expect(mocks.getDynamicFilterOptions).toHaveBeenNthCalledWith(2, ['habit'], 'fr')
    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.cache.fr?.habit?.values?.[0]?.label).toBe('Arbuste')

    appState.locale.value = 'en'
    await plantDb.speciesCatalogWorkbench.loadDynamicOptions(['habit'])
    expect(mocks.getDynamicFilterOptions).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent dynamic option requests for the same locale and field', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const appState = await import('../app/settings/state')
    let resolveRequest!: (value: DynamicFilterOptions[]) => void
    const request = new Promise<DynamicFilterOptions[]>((resolve) => {
      resolveRequest = resolve
    })

    ;(mocks.getDynamicFilterOptions as ReturnType<typeof vi.fn>).mockReturnValueOnce(request)

    appState.locale.value = 'fr'
    const first = plantDb.speciesCatalogWorkbench.loadDynamicOptions(['habit'])
    const second = plantDb.speciesCatalogWorkbench.loadDynamicOptions(['habit'])

    expect(mocks.getDynamicFilterOptions).toHaveBeenCalledTimes(1)
    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.pending.fr?.habit).toBe(true)

    resolveRequest([
      {
        field: 'habit',
        field_type: 'categorical',
        values: [{ value: 'Shrub', label: 'Arbuste' }],
        range: null,
      },
    ])

    await first
    await second

    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.pending.fr?.habit).toBeUndefined()
    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.cache.fr?.habit?.values?.[0]?.label).toBe('Arbuste')
  })

  it('records a field-level error when IPC returns no options for a requested field', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const appState = await import('../app/settings/state')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    appState.locale.value = 'en'
    ;(mocks.getDynamicFilterOptions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([])

    await plantDb.speciesCatalogWorkbench.loadDynamicOptions(['habit'])

    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.cache.en?.habit).toBeUndefined()
    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.errors.en?.habit).toBe(
      plantDb.DYNAMIC_OPTIONS_BACKEND_MISMATCH_ERROR,
    )
  })

  it('clears field-level errors after a successful retry', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const appState = await import('../app/settings/state')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    appState.locale.value = 'en'
    ;(mocks.getDynamicFilterOptions as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          field: 'habit',
          field_type: 'categorical',
          values: [{ value: 'Shrub', label: 'Shrub' }],
          range: null,
        },
      ])

    await plantDb.speciesCatalogWorkbench.loadDynamicOptions(['habit'])
    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.errors.en?.habit).toBe(
      plantDb.DYNAMIC_OPTIONS_BACKEND_MISMATCH_ERROR,
    )

    await plantDb.speciesCatalogWorkbench.loadDynamicOptions(['habit'])

    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.errors.en?.habit).toBeUndefined()
    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.cache.en?.habit?.values?.[0]?.label).toBe('Shrub')
  })

  it('records thrown IPC errors per field', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const appState = await import('../app/settings/state')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    appState.locale.value = 'en'
    ;(mocks.getDynamicFilterOptions as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('backend exploded'))

    await plantDb.speciesCatalogWorkbench.loadDynamicOptions(['habit'])

    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.errors.en?.habit).toBe('backend exploded')
    expect(plantDb.speciesCatalogWorkbench.dynamicOptions.value.pending.en?.habit).toBeUndefined()
  })

  it('preserves the first-page total estimate when loading more results', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)

    ;(mocks.searchSpecies as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      next_cursor: 'offset:50',
      total_estimate: 42,
    })

    const dispose = plantDb.speciesCatalogWorkbench.mount()
    await flushMicrotasks()

    ;(mocks.searchSpecies as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    })

    await plantDb.speciesCatalogWorkbench.loadNextPage()

    expect(mocks.searchSpecies).toHaveBeenLastCalledWith(expect.objectContaining({
      text: '',
      filters: expect.any(Object),
      cursor: 'offset:50',
      limit: 50,
      sort: 'Recommended',
      locale: 'en',
      include_total: false,
    }))
    expect(plantDb.speciesCatalogWorkbench.results.value.totalEstimate).toBe(42)
    dispose()
  })

  it('loads favorite items into both detail and badge state', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)

    ;(mocks.getFavorites as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makePlant('Malus domestica', true),
    ])

    await plantDb.speciesCatalogWorkbench.loadFavorites()

    expect(plantDb.speciesCatalogWorkbench.sidebar.value.favoriteNames).toEqual(['Malus domestica'])
    expect(plantDb.speciesCatalogWorkbench.favorites.value.items).toHaveLength(1)
    expect(plantDb.speciesCatalogWorkbench.favorites.value.items[0]?.canonical_name).toBe('Malus domestica')
    expect(plantDb.speciesCatalogWorkbench.favorites.value.loading).toBe(false)
  })

  it('exposes selection and favorites through the Species Catalog Workbench', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)

    plantDb.speciesCatalogWorkbench.selectSpecies('Malus domestica')
    ;(mocks.getFavorites as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makePlant('Malus domestica', true),
    ])
    await plantDb.speciesCatalogWorkbench.loadFavorites()

    expect(plantDb.speciesCatalogWorkbench.selectedCanonicalName.value).toBe('Malus domestica')
    expect(plantDb.speciesCatalogWorkbench.isFavorite('Malus domestica')).toBe(true)

    plantDb.speciesCatalogWorkbench.closeSpeciesDetail()

    expect(plantDb.speciesCatalogWorkbench.selectedCanonicalName.value).toBeNull()
  })

  it('ignores stale favorite-item responses after a locale switch', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const appState = await import('../app/settings/state')
    const english = deferred<SpeciesListItem[]>()
    const french = deferred<SpeciesListItem[]>()

    ;(mocks.getFavorites as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(english.promise)
      .mockReturnValueOnce(french.promise)

    appState.locale.value = 'en'
    const first = plantDb.speciesCatalogWorkbench.loadFavorites()

    appState.locale.value = 'fr'
    const second = plantDb.speciesCatalogWorkbench.loadFavorites()

    english.resolve([
      makePlant('English Favorite', true),
    ])
    await first

    expect(plantDb.speciesCatalogWorkbench.favorites.value.items).toEqual([])

    french.resolve([
      makePlant('French Favorite', true),
    ])
    await second

    expect(plantDb.speciesCatalogWorkbench.favorites.value.items).toEqual([
      makePlant('French Favorite', true),
    ])
    expect(plantDb.speciesCatalogWorkbench.sidebar.value.favoriteNames).toEqual(['French Favorite'])
  })

  it('does not let a stale favorites reload overwrite an optimistic toggle', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const pendingFavorites = deferred<SpeciesListItem[]>()

    ;(mocks.searchSpecies as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [makePlant('Malus domestica', true)],
      next_cursor: null,
      total_estimate: 1,
    })
    const dispose = plantDb.speciesCatalogWorkbench.mount()
    await flushMicrotasks()

    ;(mocks.getFavorites as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makePlant('Malus domestica', true),
    ])
    await plantDb.speciesCatalogWorkbench.loadFavorites()

    ;(mocks.getFavorites as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingFavorites.promise)
    mocks.toggleFavorite.mockResolvedValueOnce(false)

    const refresh = plantDb.speciesCatalogWorkbench.loadFavorites()
    await plantDb.speciesCatalogWorkbench.toggleFavorite('Malus domestica')

    pendingFavorites.resolve([makePlant('Stale Favorite', true)])
    await refresh

    expect(plantDb.speciesCatalogWorkbench.favorites.value.items).toEqual([])
    expect(plantDb.speciesCatalogWorkbench.sidebar.value.favoriteNames).toEqual([])
    expect(plantDb.speciesCatalogWorkbench.results.value.items[0]?.is_favorite).toBe(false)
    expect(plantDb.speciesCatalogWorkbench.favorites.value.loading).toBe(false)
    dispose()
  })

  it('ignores stale sidebar list responses after a locale switch', async () => {
    const plantDb = await import('../app/plant-browser'); plantDb.installSpeciesCatalogWorkbench((await import('../editions/desktop/species-catalog')).speciesCatalogWorkbench)
    const appState = await import('../app/settings/state')
    const englishFavorites = deferred<SpeciesListItem[]>()
    const englishRecent = deferred<SpeciesListItem[]>()
    const frenchFavorites = deferred<SpeciesListItem[]>()
    const frenchRecent = deferred<SpeciesListItem[]>()

    ;(mocks.getFavorites as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(englishFavorites.promise)
      .mockReturnValueOnce(frenchFavorites.promise)
    ;(mocks.getRecentlyViewed as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(englishRecent.promise)
      .mockReturnValueOnce(frenchRecent.promise)

    appState.locale.value = 'en'
    const first = plantDb.speciesCatalogWorkbench.reloadSidebarLists()

    appState.locale.value = 'fr'
    const second = plantDb.speciesCatalogWorkbench.reloadSidebarLists()

    englishFavorites.resolve([makePlant('English Favorite')])
    englishRecent.resolve([makePlant('English Recent')])
    await first

    expect(plantDb.speciesCatalogWorkbench.sidebar.value.favoriteNames).toEqual([])
    expect(plantDb.speciesCatalogWorkbench.sidebar.value.recentlyViewed).toEqual([])

    frenchFavorites.resolve([makePlant('French Favorite')])
    frenchRecent.resolve([makePlant('French Recent')])
    await second

    expect(plantDb.speciesCatalogWorkbench.sidebar.value.favoriteNames).toEqual(['French Favorite'])
    expect(plantDb.speciesCatalogWorkbench.sidebar.value.recentlyViewed).toEqual([
      makePlant('French Recent'),
    ])
  })
})
