import { describe, expect, it, vi } from 'vitest'
import { createEmptySpeciesFilter, createSpeciesCatalogWorkbench } from '../app/plant-browser'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../web/browser-app-data'
import { createReducedSpeciesCatalogAdapters } from '../editions/web/reduced-species-catalog'
import {
  createInMemoryReducedSpeciesCatalogReader,
  type ReducedSpeciesCatalogData,
} from './support/in-memory-reduced-species-catalog'
import type { FilterOptions, SpeciesSearchRequest } from '../types/species'

describe('Web Edition reduced Species Catalog adapter', () => {
  it('does not broaden direct one-character searches into blank browsing', async () => {
    const reader = createInMemoryReducedSpeciesCatalogReader(catalogFixture())

    const tooShort = await reader.searchSpecies(searchRequest({
      text: 'm',
      include_total: true,
    }), new Set())
    const blankBrowse = await reader.searchSpecies(searchRequest({ text: '' }), new Set())
    const whitespaceBrowse = await reader.searchSpecies(searchRequest({ text: ' \t ' }), new Set())

    expect(tooShort).toEqual({
      items: [],
      next_cursor: null,
      total_estimate: 0,
    })
    expect(blankBrowse.items).toHaveLength(3)
    expect(whitespaceBrowse.items).toHaveLength(3)
  })

  it('matches all search tokens when they are separated in a stored normalized name', async () => {
    const data = catalogFixture()
    const reader = createInMemoryReducedSpeciesCatalogReader({
      ...data,
      names: data.names.map((name) => name.common_name === 'Pomme commune'
        ? {
            ...name,
            common_name: 'Pomme tres commune',
            normalized_name: 'pomme tres commune',
          }
        : name),
    })

    const result = await reader.searchSpecies(searchRequest({
      text: 'pomme commune',
      locale: 'fr',
    }), new Set())

    expect(result.items).toEqual([
      expect.objectContaining({
        canonical_name: 'Malus domestica',
        matched_common_name: 'Pomme tres commune',
      }),
    ])
  })

  it('projects the exact alternate name ahead of a primary all-token match', async () => {
    const data = catalogFixture()
    const reader = createInMemoryReducedSpeciesCatalogReader({
      ...data,
      names: data.names.map((name) => name.common_name === 'Pommier'
        ? {
            ...name,
            common_name: 'Pomme tres commune',
            normalized_name: 'pomme tres commune',
          }
        : name),
    })

    const result = await reader.searchSpecies(searchRequest({
      text: 'pomme commune',
      locale: 'fr',
    }), new Set())

    expect(result.items[0]).toMatchObject({
      canonical_name: 'Malus domestica',
      common_name: 'Pomme tres commune',
      matched_common_name: 'Pomme commune',
    })
  })

  it('orders and paginates active searches by locale-name relevance', async () => {
    const data = catalogFixture()
    const reader = createInMemoryReducedSpeciesCatalogReader({
      ...data,
      names: [
        ...data.names,
        {
          species_id: 'species-balm',
          language: 'fr',
          common_name: 'Malus',
          normalized_name: 'malus',
          is_primary: false,
          display_order: 1,
        },
      ],
    })

    const firstPage = await reader.searchSpecies(searchRequest({
      text: 'malus',
      locale: 'fr',
      limit: 1,
      include_total: true,
    }), new Set())
    const secondPage = await reader.searchSpecies(searchRequest({
      text: 'malus',
      locale: 'fr',
      cursor: firstPage.next_cursor,
      limit: 1,
    }), new Set())

    expect(firstPage.items.map((item) => item.canonical_name)).toEqual(['Melissa officinalis'])
    expect(firstPage.next_cursor).toBe('offset:1')
    expect(firstPage.total_estimate).toBe(2)
    expect(secondPage.items.map((item) => item.canonical_name)).toEqual(['Malus domestica'])
  })

  it('browses pages and searches canonical or localized common names', async () => {
    const adapters = createReducedSpeciesCatalogAdapters({
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      reader: createInMemoryReducedSpeciesCatalogReader(catalogFixture()),
    })

    const firstPage = await adapters.search(searchRequest({
      limit: 1,
      locale: 'fr',
      include_total: true,
    }))

    expect(firstPage.items.map((item) => item.canonical_name)).toEqual(['Malus domestica'])
    expect(firstPage.items[0]?.common_name).toBe('Pommier')
    expect(firstPage.next_cursor).toBe('offset:1')
    expect(firstPage.total_estimate).toBe(3)

    const nextPage = await adapters.search(searchRequest({
      cursor: firstPage.next_cursor,
      limit: 2,
      locale: 'fr',
    }))

    expect(nextPage.items.map((item) => item.canonical_name)).toEqual([
      'Melissa officinalis',
      'Prunus persica',
    ])
    expect(nextPage.next_cursor).toBeNull()

    const canonicalMatch = await adapters.search(searchRequest({
      text: 'melissa',
      locale: 'fr',
    }))

    expect(canonicalMatch.items.map((item) => item.canonical_name)).toEqual(['Melissa officinalis'])

    const localizedMatch = await adapters.search(searchRequest({
      text: 'peche',
      locale: 'fr',
    }))

    expect(localizedMatch.items.map((item) => item.canonical_name)).toEqual(['Prunus persica'])
    expect(localizedMatch.items[0]).toMatchObject({
      common_name: 'Pecher',
      matched_common_name: 'Pecher',
      height_max_m: null,
      hardiness_zone_min: null,
      hardiness_zone_max: null,
      stratum: null,
      habit: null,
      edibility_rating: null,
    })
  })

  it('uses DuckDB binary ordering and the Species id tie-break while browsing', async () => {
    const template = catalogFixture().species[0]!
    const reader = createInMemoryReducedSpeciesCatalogReader({
      species: [
        { ...template, id: 'lower', slug: 'lower', canonical_name: 'a' },
        { ...template, id: 'z-id', slug: 'upper-z-id', canonical_name: 'A' },
        { ...template, id: 'emoji', slug: 'emoji', canonical_name: '😀' },
        { ...template, id: 'private', slug: 'private', canonical_name: '\uE000' },
        { ...template, id: 'a-id', slug: 'upper-a-id', canonical_name: 'A' },
      ],
      names: [],
      images: [],
    })

    const page = await reader.searchSpecies(searchRequest(), new Set())

    expect(page.items.map((item) => item.slug)).toEqual([
      'upper-a-id',
      'upper-z-id',
      'lower',
      'private',
      'emoji',
    ])
  })

  it('orders localized names by Unicode scalar length and binary text order', async () => {
    const template = catalogFixture().species[0]!
    const reader = createInMemoryReducedSpeciesCatalogReader({
      species: [template],
      names: ['𐀀', 'zz', 'Á', 'a', 'A'].map((commonName) => ({
        species_id: template.id,
        language: 'fr',
        common_name: commonName,
        normalized_name: commonName,
        is_primary: false,
        display_order: 0,
      })),
      images: [],
    })

    const detail = await reader.getSpeciesDetail(template.canonical_name, 'fr')
    const page = await reader.searchSpecies(searchRequest({ locale: 'fr' }), new Set())

    expect(detail?.common_name).toBe('A')
    expect(detail?.common_names).toEqual(['A', 'a', 'Á', '𐀀', 'zz'])
    expect(page.items[0]?.common_name).toBe('A')
  })

  it('never returns a continuation cursor for a zero-sized or exactly exhausted page', async () => {
    const reader = createInMemoryReducedSpeciesCatalogReader(catalogFixture())

    const zeroPage = await reader.searchSpecies(searchRequest({
      limit: 0,
      include_total: true,
    }), new Set())
    const exactPage = await reader.searchSpecies(searchRequest({ limit: 3 }), new Set())

    expect(zeroPage).toEqual({
      items: [],
      next_cursor: null,
      total_estimate: 3,
    })
    expect(exactPage.items).toHaveLength(3)
    expect(exactPage.next_cursor).toBeNull()
  })

  it('filters v1 fields and stores favorites or recently viewed Species in browser app data', async () => {
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const adapters = createReducedSpeciesCatalogAdapters({
      appDataStore,
      reader: createInMemoryReducedSpeciesCatalogReader(catalogFixture()),
    })

    const filterOptions = await adapters.getFilterOptions()

    expect(filterOptions).toMatchObject({
      climate_zones: ['Mediterranean', 'Temperate'],
      habits: ['Forb', 'Herbaceous', 'Tree'],
      life_cycles: ['Perennial'],
      sun_tolerances: [],
      soil_tolerances: [],
      growth_rates: [],
    })

    const mediterranean = await adapters.search(searchRequest({
      filters: {
        ...createEmptySpeciesFilter(),
        climate_zones: ['Mediterranean'],
      },
      locale: 'fr',
    }))

    expect(mediterranean.items.map((item) => item.canonical_name)).toEqual(['Prunus persica'])

    const growthForm = await adapters.search(searchRequest({
      filters: {
        ...createEmptySpeciesFilter(),
        habit: ['Forb'],
      },
      locale: 'fr',
    }))

    expect(growthForm.items.map((item) => item.canonical_name)).toEqual(['Melissa officinalis'])

    await expect(adapters.toggleFavorite('Prunus persica')).resolves.toBe(true)
    await adapters.recordRecentlyViewed('Melissa officinalis')
    await adapters.recordRecentlyViewed('Prunus persica')

    const favorites = await adapters.getFavorites('fr')
    const recent = await adapters.getRecentlyViewed('fr', 1)

    expect(favorites).toEqual([
      expect.objectContaining({
        canonical_name: 'Prunus persica',
        common_name: 'Pecher',
        is_favorite: true,
      }),
    ])
    expect(recent.map((item) => item.canonical_name)).toEqual(['Prunus persica'])
    expect(recent[0]?.is_favorite).toBe(true)

    await expect(adapters.toggleFavorite('Prunus persica')).resolves.toBe(false)
    await expect(adapters.getFavorites('fr')).resolves.toEqual([])
  })

  it('projects reduced Species detail with localized common names and hero image metadata', async () => {
    const adapters = createReducedSpeciesCatalogAdapters({
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      reader: createInMemoryReducedSpeciesCatalogReader(catalogFixture()),
    })

    await expect(adapters.getSpeciesDetail('Malus domestica', 'fr')).resolves.toEqual({
      canonical_name: 'Malus domestica',
      common_name: 'Pommier',
      common_names: ['Pommier', 'Pomme commune'],
      climate_zones: ['Temperate'],
      habit: 'Tree',
      growth_form: 'Tree',
      life_cycles: ['Perennial'],
      image: {
        url: 'https://images.example.test/apple.jpg',
        source: 'Wikimedia Commons',
        source_page_url: 'https://commons.example.test/apple',
        credit: 'Jane Gardener',
        license: 'CC BY-SA 4.0',
      },
    })
  })

  it('lets the Species Catalog Workbench adapter record recently viewed Species on selection', () => {
    const selected: string[] = []
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      loadDynamicFilterOptions: async () => [],
      getFilterOptions: async () => null,
      getFavorites: async () => [],
      getRecentlyViewed: async () => [],
      toggleFavorite: async () => false,
      onSpeciesSelected: (canonicalName) => {
        selected.push(canonicalName)
      },
    })

    workbench.selectSpecies('Malus domestica')

    expect(selected).toEqual(['Malus domestica'])
  })

  it('limits Workbench filter controls to the Web-supported catalog projection', async () => {
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      getSupportedFilterFields: async () => ['climate_zones', 'habit', 'life_cycle'],
      getFilterOptions: async () => ({
        families: [],
        growth_rates: [],
        climate_zones: ['Temperate'],
        habits: ['Tree'],
        life_cycles: ['Perennial'],
        sun_tolerances: ['full_sun'],
        soil_tolerances: [],
      }),
    })

    await workbench.loadFilterOptions()

    expect(workbench.filterStrip.value.controls.map((control) => control.filterKey)).toEqual([
      'climate_zones',
      'habit',
      'life_cycle',
    ])
    expect(workbench.filterStrip.value.controls.map((control) => control.filterKey)).not.toContain('woody')
    expect(workbench.filterStrip.value.controls.map((control) => control.filterKey)).not.toContain('sun_tolerances')
  })

  it('loads reduced Species detail when a Species is selected', async () => {
    const detail = {
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      common_names: ['Apple'],
      climate_zones: ['Temperate'],
      habit: 'Tree',
      growth_form: 'Tree',
      life_cycles: ['Perennial'],
      image: null,
    }
    const getSpeciesDetail = async () => detail
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      getSpeciesDetail,
    })

    workbench.selectSpecies('Malus domestica')

    expect(workbench.detail.value).toMatchObject({
      canonicalName: 'Malus domestica',
      detail: null,
      loading: true,
      error: null,
    })

    await waitForMicrotasks()

    expect(workbench.detail.value).toEqual({
      canonicalName: 'Malus domestica',
      detail,
      loading: false,
      error: null,
      englishName: null,
    })
  })

  it('keeps Species detail selection usable when recently viewed persistence rejects', async () => {
    const detail = {
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      common_names: ['Apple'],
      climate_zones: ['Temperate'],
      habit: 'Tree',
      growth_form: 'Tree',
      life_cycles: ['Perennial'],
      image: null,
    }
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      getSpeciesDetail: async () => detail,
      onSpeciesSelected: async () => {
        throw new Error('storage quota exceeded')
      },
    })

    workbench.selectSpecies('Malus domestica')
    await waitForMicrotasks()

    expect(workbench.detail.value).toEqual({
      canonicalName: 'Malus domestica',
      detail,
      loading: false,
      error: null,
      englishName: null,
    })
  })

  it('retries search and unresolved initial catalog projections together', async () => {
    const search = vi.fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue({ items: [], next_cursor: null, total_estimate: 0 })
    const getFilterOptions = vi.fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue({
        families: [],
        growth_rates: [],
        climate_zones: ['Temperate'],
        habits: [],
        life_cycles: [],
        sun_tolerances: [],
        soil_tolerances: [],
      })
    const getFavorites = vi.fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue([makeSpeciesListItem('Malus domestica')])
    const getRecentlyViewed = vi.fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue([makeSpeciesListItem('Melissa officinalis')])
    const workbench = createSpeciesCatalogWorkbench({
      search,
      getFilterOptions,
      getSupportedFilterFields: async () => ['climate_zones'],
      getFavorites,
      getRecentlyViewed,
      textDebounceMs: 0,
    })
    const unmount = workbench.mount()
    await vi.waitFor(() => {
      expect(workbench.results.value.error).toBe('catalog unavailable')
    })

    workbench.retrySearch()

    await vi.waitFor(() => {
      expect(workbench.results.value.error).toBeNull()
      expect(workbench.filterStrip.value.options?.climate_zones).toEqual(['Temperate'])
      expect(workbench.sidebar.value).toEqual({
        favoriteNames: ['Malus domestica'],
        recentlyViewed: [makeSpeciesListItem('Melissa officinalis')],
        recentlyViewedFailed: false,
        recentlyViewedLoading: false,
      })
      expect(workbench.favorites.value.failed).toBe(false)
    })
    expect(search).toHaveBeenCalledTimes(2)
    expect(getFilterOptions).toHaveBeenCalledTimes(2)
    expect(getFavorites).toHaveBeenCalledTimes(2)
    expect(getRecentlyViewed).toHaveBeenCalledTimes(2)
    unmount()
    workbench.dispose()
  })

  it('retryFavorites shows both lists pending and recovers both on success (canopi-etzh)', async () => {
    const favoritesAnswer = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const recentAnswer = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const getFavorites = vi.fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockImplementationOnce(() => favoritesAnswer.promise)
      .mockResolvedValue([makeSpeciesListItem('Malus domestica')])
    const getRecentlyViewed = vi.fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockImplementationOnce(() => recentAnswer.promise)
      .mockResolvedValue([makeSpeciesListItem('Melissa officinalis')])
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      getFavorites,
      getRecentlyViewed,
      favoritesIncludeRecentlyViewed: true,
      textDebounceMs: 0,
    })
    const unmount = workbench.mount('favorites')
    await vi.waitFor(() => {
      expect(workbench.favorites.value).toMatchObject({ failed: true, loading: false })
      expect(workbench.sidebar.value).toMatchObject({ recentlyViewedFailed: true, recentlyViewedLoading: false })
    })

    workbench.retryFavorites()
    // Both lists are pending while the retry loads.
    expect(workbench.favorites.value.loading).toBe(true)
    expect(workbench.sidebar.value.recentlyViewedLoading).toBe(true)

    favoritesAnswer.resolve([makeSpeciesListItem('Malus domestica')])
    recentAnswer.resolve([makeSpeciesListItem('Melissa officinalis')])
    await vi.waitFor(() => {
      expect(workbench.favorites.value).toMatchObject({ failed: false, loading: false })
      expect(workbench.favorites.value.items.map((item) => item.canonical_name)).toEqual(['Malus domestica'])
      expect(workbench.sidebar.value).toMatchObject({ recentlyViewedFailed: false, recentlyViewedLoading: false })
      expect(workbench.sidebar.value.recentlyViewed.map((item) => item.canonical_name)).toEqual(['Melissa officinalis'])
    })
    unmount()
    workbench.dispose()
  })

  it('does not publish filter metadata that resolves after disposal', async () => {
    const pendingOptions = deferred<FilterOptions | null>()
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      getFilterOptions: () => pendingOptions.promise,
      getSupportedFilterFields: async () => ['climate_zones'],
    })

    const loading = workbench.loadFilterOptions()
    workbench.dispose()
    pendingOptions.resolve({
      families: [],
      growth_rates: [],
      climate_zones: ['Temperate'],
      habits: [],
      life_cycles: [],
      sun_tolerances: [],
      soil_tolerances: [],
    })
    await loading

    expect(workbench.filterStrip.value.options).toBeNull()
  })

  it('reconciles concurrent favorite mutations for different Species independently', async () => {
    const appleToggle = deferred<boolean>()
    const peachToggle = deferred<boolean>()
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      toggleFavorite: (canonicalName) => (
        canonicalName === 'Malus domestica' ? appleToggle.promise : peachToggle.promise
      ),
    })

    const toggleApple = workbench.toggleFavorite('Malus domestica')
    const togglePeach = workbench.toggleFavorite('Prunus persica')
    peachToggle.resolve(true)
    await togglePeach
    appleToggle.resolve(true)
    await toggleApple

    expect(new Set(workbench.sidebar.value.favoriteNames)).toEqual(new Set([
      'Malus domestica',
      'Prunus persica',
    ]))
  })

  it('preserves unrelated local favorites when no authoritative read adapter exists', async () => {
    const persistedNames = new Set<string>()
    const searchItems = [
      makeSpeciesListItem('Malus domestica'),
      makeSpeciesListItem('Prunus persica'),
    ]
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: searchItems, next_cursor: null, total_estimate: 2 }),
      toggleFavorite: async (canonicalName) => {
        if (persistedNames.has(canonicalName)) {
          persistedNames.delete(canonicalName)
          return false
        }
        persistedNames.add(canonicalName)
        return true
      },
      textDebounceMs: 0,
    })
    const unmount = workbench.mount()
    await vi.waitFor(() => expect(workbench.results.value.items).toHaveLength(2))

    await workbench.toggleFavorite('Malus domestica')
    await workbench.toggleFavorite('Prunus persica')
    await workbench.toggleFavorite('Malus domestica')
    await workbench.loadFavorites()
    workbench.retrySearch()
    await waitForMicrotasks()

    expect(workbench.sidebar.value.favoriteNames).toEqual(['Prunus persica'])
    expect(workbench.favorites.value.items.map((item) => item.canonical_name)).toEqual([
      'Prunus persica',
    ])
    unmount()
    workbench.dispose()
  })

  it('projects successful mutations onto search responses that resolve later', async () => {
    const searchResult = deferred<{
      items: ReturnType<typeof makeSpeciesListItem>[]
      next_cursor: null
      total_estimate: number
    }>()
    const workbench = createSpeciesCatalogWorkbench({
      search: () => searchResult.promise,
      toggleFavorite: async () => true,
      textDebounceMs: 0,
    })
    const unmount = workbench.mount()

    await workbench.toggleFavorite('Malus domestica')
    searchResult.resolve({
      items: [makeSpeciesListItem('Malus domestica')],
      next_cursor: null,
      total_estimate: 1,
    })
    await vi.waitFor(() => expect(workbench.results.value.items).toHaveLength(1))

    expect(workbench.results.value.items[0]?.is_favorite).toBe(true)
    unmount()
    workbench.dispose()
  })

  it('projects a committed mutation onto a stale next page that publishes afterward', async () => {
    const nextPage = deferred<{
      items: ReturnType<typeof makeSpeciesListItem>[]
      next_cursor: null
      total_estimate: number
    }>()
    const toggle = deferred<boolean>()
    const toggleFavorite = vi.fn(() => toggle.promise)
    const search = vi.fn((request: SpeciesSearchRequest) => request.cursor
      ? nextPage.promise
      : Promise.resolve({
          items: [makeSpeciesListItem('Malus domestica')],
          next_cursor: 'next',
          total_estimate: 2,
        }))
    const workbench = createSpeciesCatalogWorkbench({
      search,
      toggleFavorite,
      textDebounceMs: 0,
    })
    const unmount = workbench.mount()
    await vi.waitFor(() => expect(workbench.results.value.items).toHaveLength(1))
    const loading = workbench.loadNextPage()
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    const toggling = workbench.toggleFavorite('Prunus persica')
    await vi.waitFor(() => expect(toggleFavorite).toHaveBeenCalledOnce())

    toggle.resolve(true)
    nextPage.resolve({
      items: [makeSpeciesListItem('Prunus persica')],
      next_cursor: null,
      total_estimate: 2,
    })
    await Promise.all([loading, toggling])

    expect(workbench.results.value.items).toHaveLength(2)
    expect(workbench.results.value.items[1]?.is_favorite).toBe(true)
    unmount()
    workbench.dispose()
  })

  it('publishes persisted mutations without waiting for an in-flight authoritative refresh', async () => {
    const reconciliation = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    let nowFavorite = false
    const toggleFavorite = vi.fn(async () => {
      nowFavorite = !nowFavorite
      return nowFavorite
    })
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({
        items: [makeSpeciesListItem('Malus domestica')],
        next_cursor: null,
        total_estimate: 1,
      }),
      getFavorites: () => reconciliation.promise,
      toggleFavorite,
      textDebounceMs: 0,
    })
    const unmount = workbench.mount()
    await vi.waitFor(() => expect(workbench.results.value.items).toHaveLength(1))
    void workbench.loadFavorites()

    await workbench.toggleFavorite('Malus domestica')

    expect(workbench.results.value.items[0]?.is_favorite).toBe(true)
    expect(workbench.sidebar.value.favoriteNames).toEqual(['Malus domestica'])
    expect(workbench.favorites.value.items[0]?.is_favorite).toBe(true)

    await workbench.toggleFavorite('Malus domestica')

    expect(toggleFavorite).toHaveBeenCalledTimes(2)
    expect(workbench.results.value.items[0]?.is_favorite).toBe(false)
    expect(workbench.sidebar.value.favoriteNames).toEqual([])
    expect(workbench.favorites.value.items).toEqual([])
    unmount()
    workbench.dispose()
  })

  it('replays favorite mutations into stale Recently Viewed projections', async () => {
    const staleRecent = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const apple = makeSpeciesListItem('Malus domestica')
    let nowFavorite = false
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [apple], next_cursor: null, total_estimate: 1 }),
      getFavorites: async () => [],
      getRecentlyViewed: () => staleRecent.promise,
      toggleFavorite: async () => {
        nowFavorite = !nowFavorite
        return nowFavorite
      },
      textDebounceMs: 0,
    })
    const unmount = workbench.mount()
    await vi.waitFor(() => expect(workbench.results.value.items).toHaveLength(1))

    const staleReload = workbench.reloadSidebarLists()
    await workbench.toggleFavorite('Malus domestica')
    staleRecent.resolve([apple])
    await staleReload

    expect(workbench.sidebar.value.recentlyViewed[0]?.is_favorite).toBe(true)

    await workbench.toggleFavorite('Malus domestica')

    expect(workbench.sidebar.value.recentlyViewed[0]?.is_favorite).toBe(false)
    unmount()
    workbench.dispose()
  })

  it('does not let a favorite list load supersede an admitted favorite mutation', async () => {
    const toggle = deferred<boolean>()
    const favoriteList = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const toggleFavorite = vi.fn(() => toggle.promise)
    const authoritativeFavorites = [
      makeSpeciesListItem('Malus domestica'),
      makeSpeciesListItem('Melissa officinalis'),
      makeSpeciesListItem('Prunus persica'),
    ].map((item) => ({ ...item, is_favorite: true }))
    const getFavorites = vi.fn()
      .mockImplementationOnce(() => favoriteList.promise)
      .mockResolvedValue(authoritativeFavorites)
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      getFavorites,
      toggleFavorite,
    })

    const mutation = workbench.toggleFavorite('Prunus persica')
    await vi.waitFor(() => expect(toggleFavorite).toHaveBeenCalledOnce())
    const loading = workbench.loadFavorites()
    expect(workbench.favorites.value.loading).toBe(true)
    toggle.resolve(true)
    await mutation
    favoriteList.resolve(authoritativeFavorites)
    await loading

    expect(workbench.favorites.value.items).toEqual(authoritativeFavorites)
    expect(workbench.sidebar.value.favoriteNames).toEqual([
      'Malus domestica',
      'Melissa officinalis',
      'Prunus persica',
    ])
    expect(workbench.favorites.value.loading).toBe(false)
  })

  it('settles favorite loading when an admitted mutation fails during a list load', async () => {
    const toggle = deferred<boolean>()
    const favoriteList = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const toggleFavorite = vi.fn(() => toggle.promise)
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      getFavorites: () => favoriteList.promise,
      toggleFavorite,
    })

    const mutation = workbench.toggleFavorite('Malus domestica')
    await vi.waitFor(() => expect(toggleFavorite).toHaveBeenCalledOnce())
    const loading = workbench.loadFavorites()
    toggle.reject(new Error('favorite persistence failed'))
    await mutation
    favoriteList.resolve([])
    await loading

    expect(workbench.favorites.value.loading).toBe(false)
  })

  it('does not let a sidebar reload supersede an admitted favorite mutation', async () => {
    const toggle = deferred<boolean>()
    const sidebarFavorites = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const toggleFavorite = vi.fn(() => toggle.promise)
    const getFavorites = vi.fn()
      .mockImplementationOnce(() => sidebarFavorites.promise)
      .mockResolvedValue([makeSpeciesListItem('Malus domestica')])
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      getFavorites,
      getRecentlyViewed: async () => [],
      toggleFavorite,
    })

    const mutation = workbench.toggleFavorite('Malus domestica')
    await vi.waitFor(() => expect(toggleFavorite).toHaveBeenCalledOnce())
    const reload = workbench.reloadSidebarLists()
    toggle.resolve(true)
    await mutation
    sidebarFavorites.resolve([])
    await reload

    expect(workbench.sidebar.value.favoriteNames).toEqual(['Malus domestica'])
  })

  it('coalesces a burst of mutations behind one active and one trailing favorites refresh', async () => {
    const activeSnapshot = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const trailingSnapshot = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const getFavorites = vi.fn()
      .mockImplementationOnce(() => activeSnapshot.promise)
      .mockImplementationOnce(() => trailingSnapshot.promise)
    const searchItems = [
      makeSpeciesListItem('Malus domestica'),
      makeSpeciesListItem('Melissa officinalis'),
      makeSpeciesListItem('Prunus persica'),
    ]
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: searchItems, next_cursor: null, total_estimate: 3 }),
      getFavorites,
      toggleFavorite: async () => true,
      textDebounceMs: 0,
    })
    const unmount = workbench.mount()
    await vi.waitFor(() => expect(workbench.results.value.items).toHaveLength(3))
    await vi.waitFor(() => expect(getFavorites).toHaveBeenCalledOnce())

    await Promise.all([
      workbench.toggleFavorite('Malus domestica'),
      workbench.toggleFavorite('Melissa officinalis'),
      workbench.toggleFavorite('Prunus persica'),
    ])

    expect(getFavorites).toHaveBeenCalledOnce()
    activeSnapshot.resolve([])
    await vi.waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(2))
    trailingSnapshot.reject(new Error('latest refresh failed'))
    await vi.waitFor(() => expect(workbench.favorites.value.loading).toBe(false))

    expect(new Set(workbench.sidebar.value.favoriteNames)).toEqual(new Set([
      'Malus domestica',
      'Melissa officinalis',
      'Prunus persica',
    ]))
    expect(new Set(workbench.favorites.value.items.map((item) => item.canonical_name))).toEqual(new Set([
      'Malus domestica',
      'Melissa officinalis',
      'Prunus persica',
    ]))
    expect(getFavorites).toHaveBeenCalledTimes(2)
    expect(workbench.favorites.value.loading).toBe(false)
    unmount()
    workbench.dispose()
  })

  it('uses one freshness order for every favorite-name projection', async () => {
    const favoritePanelItems = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const sidebarItems = deferred<ReturnType<typeof makeSpeciesListItem>[]>()
    const getFavorites = vi.fn()
      .mockImplementationOnce(() => favoritePanelItems.promise)
      .mockImplementationOnce(() => sidebarItems.promise)
    const workbench = createSpeciesCatalogWorkbench({
      search: async () => ({ items: [], next_cursor: null, total_estimate: 0 }),
      getFavorites,
      getRecentlyViewed: async () => [],
    })

    const olderPanelLoad = workbench.loadFavorites()
    const newerSidebarLoad = workbench.reloadSidebarLists()
    sidebarItems.resolve([makeSpeciesListItem('Prunus persica')])
    await newerSidebarLoad
    favoritePanelItems.resolve([makeSpeciesListItem('Malus domestica')])
    await olderPanelLoad

    expect(workbench.sidebar.value.favoriteNames).toEqual(['Prunus persica'])
    expect(workbench.favorites.value.items).toEqual([
      { ...makeSpeciesListItem('Malus domestica'), is_favorite: true },
    ])
    expect(workbench.favorites.value.loading).toBe(false)
  })
})

function searchRequest(overrides: Partial<SpeciesSearchRequest> = {}): SpeciesSearchRequest {
  return {
    text: '',
    filters: createEmptySpeciesFilter(),
    cursor: null,
    limit: 50,
    sort: 'Name',
    locale: 'en',
    include_total: false,
    ...overrides,
  }
}

function catalogFixture(): ReducedSpeciesCatalogData {
  return {
    species: [
      {
        id: 'species-apple',
        slug: 'malus-domestica',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        normalized_canonical_name: 'malus domestica',
        normalized_common_name: 'apple',
        climate_zones: ['Temperate'],
        habit: 'Tree',
        growth_form: 'Tree',
        life_cycles: ['Perennial'],
      },
      {
        id: 'species-balm',
        slug: 'melissa-officinalis',
        canonical_name: 'Melissa officinalis',
        common_name: 'Lemon balm',
        normalized_canonical_name: 'melissa officinalis',
        normalized_common_name: 'lemon balm',
        climate_zones: ['Temperate'],
        habit: 'Herbaceous',
        growth_form: 'Forb',
        life_cycles: ['Perennial'],
      },
      {
        id: 'species-peach',
        slug: 'prunus-persica',
        canonical_name: 'Prunus persica',
        common_name: 'Peach',
        normalized_canonical_name: 'prunus persica',
        normalized_common_name: 'peach',
        climate_zones: ['Mediterranean', 'Temperate'],
        habit: 'Tree',
        growth_form: 'Tree',
        life_cycles: ['Perennial'],
      },
    ],
    names: [
      {
        species_id: 'species-apple',
        language: 'fr',
        common_name: 'Pommier',
        normalized_name: 'pommier',
        is_primary: true,
        display_order: 0,
      },
      {
        species_id: 'species-apple',
        language: 'fr',
        common_name: 'Pomme commune',
        normalized_name: 'pomme commune',
        is_primary: false,
        display_order: 1,
      },
      {
        species_id: 'species-balm',
        language: 'fr',
        common_name: 'Melisse',
        normalized_name: 'melisse',
        is_primary: true,
        display_order: 0,
      },
      {
        species_id: 'species-peach',
        language: 'fr',
        common_name: 'Pecher',
        normalized_name: 'pecher',
        is_primary: true,
        display_order: 0,
      },
    ],
    images: [
      {
        species_id: 'species-apple',
        url: 'https://images.example.test/apple.jpg',
        source: 'Wikimedia Commons',
        source_page_url: 'https://commons.example.test/apple',
        credit: 'Jane Gardener',
        license: 'CC BY-SA 4.0',
      },
    ],
  }
}

function memoryStorage(): BrowserStorageAdapter {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

function makeSpeciesListItem(canonicalName: string) {
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
    is_favorite: false,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitForMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
