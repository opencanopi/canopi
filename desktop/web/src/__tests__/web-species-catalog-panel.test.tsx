// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../app/settings/state'
import {
  clearPlantStampSource,
  readPlantStampDragData,
  readPlantStampSource,
} from '../canvas/plant-stamp-source'
import type { PlantSearchResultState } from '../app/plant-browser/search-session'
import type { SpeciesFilter, SpeciesListItem } from '../types/species'

const mockCanvasSession = vi.hoisted(() => {
  const toolSurface = {
    setTool: vi.fn(),
  }
  return {
    toolSurface,
    currentToolCommandSurface: {
      value: toolSurface as typeof toolSurface | null,
      peek() { return this.value },
    },
  }
})

const mockWorkbench = vi.hoisted(() => ({
  intent: { value: { text: '', filters: emptyFilters(), extraFilters: [], sort: 'Recommended', browseSort: 'Recommended', locale: 'en' } },
  hasActiveFilters: { value: false },
  browseSorts: ['Recommended', 'Name'],
  dynamicOptions: { value: { cache: {}, pending: {}, errors: {} } },
  results: {
    value: {
      items: [makeSpeciesListItem('Malus domestica', 'Apple')],
      nextCursor: 'offset:1',
      totalEstimate: 2,
      committedRevision: 1,
      status: 'idle',
      error: null,
    } as PlantSearchResultState,
  },
  filterStrip: {
    value: {
      options: {
        families: [],
        growth_rates: [],
        climate_zones: ['Temperate'],
        habits: ['Tree'],
        life_cycles: ['Perennial'],
        sun_tolerances: [],
        soil_tolerances: [],
      },
      filters: emptyFilters(),
      hasActive: false,
      activeCount: 0,
      controls: supportedFilterControls(),
    },
  },
  favorites: {
    value: {
      items: [makeSpeciesListItem('Prunus persica', 'Peach', true)],
      loading: false,
      revision: 0,
    },
  },
  sidebar: {
    value: {
      favoriteNames: ['Prunus persica'],
      recentlyViewed: [makeSpeciesListItem('Melissa officinalis', 'Lemon balm')],
    },
  },
  detail: {
    value: {
      canonicalName: null,
      detail: null,
      loading: false,
      error: null,
    } as SpeciesCatalogDetailView,
  },
  mount: vi.fn(() => vi.fn()),
  loadFilterOptions: vi.fn(async () => {}),
  reloadSidebarLists: vi.fn(async () => {}),
  loadFavorites: vi.fn(async () => {}),
  setSearchText: vi.fn(),
  patchFilters: vi.fn(),
  clearFilters: vi.fn(),
  retrySearch: vi.fn(),
  selectSpecies: vi.fn(),
  closeSpeciesDetail: vi.fn(),
  toggleFavorite: vi.fn(async () => {}),
  loadNextPage: vi.fn(async () => {}),
  isSearchLoading: vi.fn(() => false),
  isActiveSearchText: vi.fn((text: string) => text.trim().length > 1),
  setBrowseSort: vi.fn(),
  loadDynamicOptions: vi.fn(async () => {}),
  removeExtraFilter: vi.fn(),
  resolveCommonNames: vi.fn(async (_names: readonly string[], _locale: string): Promise<Record<string, string>> => ({})),
}))

vi.mock('@tanstack/virtual-core', () => ({
  // jsdom has no layout: show every row.
  Virtualizer: class {
    constructor(private options: { count: number; onChange?: (instance: unknown) => void }) {}
    setOptions(options: { count: number; onChange?: (instance: unknown) => void }) { this.options = options }
    measure() {}
    _didMount() { return () => {} }
    _willUpdate() { this.options.onChange?.(this) }
    getVirtualItems() {
      return Array.from({ length: this.options.count }, (_, index) => ({ index, key: index, size: 62, start: index * 62 }))
    }
    getTotalSize() { return this.options.count * 62 }
  },
  observeElementRect: vi.fn(),
  observeElementOffset: vi.fn(),
  elementScroll: vi.fn(),
}))

vi.mock('../app/plant-browser', async () => ({
  speciesCatalogWorkbench: Object.assign(mockWorkbench, {
    resolveDisplayNames: (await vi.importActual<typeof PlantBrowserWorkbenchModule>('../app/plant-browser/workbench'))
      .composeSpeciesDisplayNames((names, locale) => mockWorkbench.resolveCommonNames(names, locale)),
  }),
  plantFilterCatalog: (await vi.importActual<typeof PlantFilterModelModule>('../app/plant-browser/plant-filter-model')).plantFilterCatalog,
}))

vi.mock('../canvas/session', () => ({
  currentCanvasToolCommandSurface: mockCanvasSession.currentToolCommandSurface,
  currentCanvasQuerySurface: { value: null, peek: () => null },
  currentCanvasTool: { value: 'select' },
  currentCanvasKeyboardPort: () => null,
  setCurrentCanvasTool: (name: string) => mockCanvasSession.currentToolCommandSurface.value?.setTool(name),
}))

import { WebSpeciesCatalogPanel } from '../web/WebSpeciesCatalogPanel'
import type * as PlantBrowserWorkbenchModule from '../app/plant-browser/workbench'
import type * as PlantFilterModelModule from '../app/plant-browser/plant-filter-model'
import type { SpeciesCatalogDetailView } from '../app/plant-browser/workbench'

describe('Web Edition Species Catalog panel', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    resetWorkbench()
    clearPlantStampSource()
    mockCanvasSession.currentToolCommandSurface.value = mockCanvasSession.toolSurface
    mockCanvasSession.toolSurface.setTool.mockClear()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('keeps Favorites behind a full dock detail with Back available while loading', async () => {
    mockWorkbench.detail.value = { canonicalName: 'Prunus persica', loading: true, error: null, detail: null }
    await act(async () => render(<WebSpeciesCatalogPanel mode="favorites" />, container))
    expect(container.querySelector<HTMLElement>('[data-favorites-main]')?.hidden).toBe(true)
    expect(container.querySelector('button[data-detail-back]')).not.toBeNull()
  })

  it('renders catalog search and supported filters through the Species Catalog Workbench', async () => {
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    expect(container.querySelector('[data-testid="web-species-catalog-panel"]')).not.toBeNull()
    expect(container.querySelector('h2')?.textContent).toBe('Plant catalog')
    expect(mockWorkbench.mount).toHaveBeenCalledOnce()
    expect(mockWorkbench.mount).toHaveBeenCalledWith('catalog')

    const search = requiredElement<HTMLInputElement>('input[aria-label="Search the plant catalog"]')
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Control+F Meta+F')
    await act(async () => {
      search.value = 'apple'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(mockWorkbench.setSearchText).toHaveBeenCalledWith('apple')

    // Filters stay behind "Filters" until asked for; unsupported Desktop filters never show.
    expect(container.textContent).not.toContain('Climate zone')
    const filtersToggle = requiredButton('Filters')
    expect(filtersToggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { filtersToggle.click() })
    expect(filtersToggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Climate zone')
    expect(container.textContent).not.toContain('Woody')
    expect(container.textContent).not.toContain('More filters')

    const climate = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((chip) => chip.textContent === 'Temperate')!
    await act(async () => { climate.click() })
    expect(mockWorkbench.patchFilters).toHaveBeenCalledWith({ climate_zones: ['Temperate'] })

    await act(async () => {
      requiredElement<HTMLButtonElement>('button[aria-label="Details for Apple"]').click()
    })
    expect(mockWorkbench.selectSpecies).toHaveBeenCalledWith('Malus domestica')

    await act(async () => {
      requiredElement<HTMLButtonElement>('[aria-label="Add Apple to favorites"]').click()
    })
    expect(mockWorkbench.toggleFavorite).toHaveBeenCalledWith('Malus domestica')
  })

  it('offers only the browse orders the Web catalog serves', async () => {
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    const sort = requiredElement<HTMLButtonElement>('button[aria-haspopup="listbox"]')
    expect(sort.textContent).toContain('Sort: Recommended')
    await act(async () => { sort.click() })
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
      .map((option) => option.textContent)
    expect(options).toEqual(['Recommended', 'Name'])
  })

  it('renders active Web filters as removable tokens and clears them through Workbench patches', async () => {
    const filters = {
      ...emptyFilters(),
      climate_zones: ['Temperate'],
    }
    mockWorkbench.intent.value = { ...mockWorkbench.intent.value, filters }
    mockWorkbench.hasActiveFilters.value = true
    mockWorkbench.filterStrip.value = {
      ...mockWorkbench.filterStrip.value,
      filters,
      hasActive: true,
      activeCount: 1,
    }

    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    expect(requiredButton('Filters').textContent).toContain('1')
    const remove = requiredElement<HTMLButtonElement>('button[aria-label="Remove filter: Temperate"]')
    await act(async () => { remove.click() })
    expect(mockWorkbench.patchFilters).toHaveBeenCalledWith({ climate_zones: null })

    await act(async () => { requiredButton('Clear filters').click() })
    expect(mockWorkbench.clearFilters).toHaveBeenCalledOnce()
  })

  it('renders browser-local favorites and recently viewed Species', async () => {
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="favorites" />, container)
    })

    expect(container.querySelector('[data-testid="web-species-favorites-panel"]')).not.toBeNull()
    expect(mockWorkbench.mount).toHaveBeenCalledWith('favorites')
    expect(container.textContent).toContain('Peach')
    expect(container.textContent).toContain('Lemon balm')
    expect(container.querySelector('[data-testid="web-species-row-metadata"]')).toBeNull()
  })

  it('shows English names marked "(en)" in Favorites and Recently viewed when the interface language has none', async () => {
    locale.value = 'fr'
    mockWorkbench.favorites.value = {
      items: [makeSpeciesListItem('Prunus persica', null, true)],
      loading: false,
      revision: 0,
    }
    mockWorkbench.sidebar.value = { favoriteNames: ['Prunus persica'], recentlyViewed: [] }
    mockWorkbench.resolveCommonNames.mockImplementation(async (names, requested): Promise<Record<string, string>> => (
      requested === 'en' && names.includes('Prunus persica') ? { 'Prunus persica': 'Peach' } : {}
    ))
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="favorites" />, container)
      await Promise.resolve()
    })
    const row = container.querySelector<HTMLElement>('[data-testid="web-species-row"]')!
    // The English name arrives from the asynchronous resolveCommonNames call.
    await vi.waitFor(() => expect(row.querySelector('[lang="en"]')?.textContent).toBe('Peach'))
    expect(row.textContent).toContain('(angl.)')
    expect(row.querySelector('[lang="la"]')?.textContent).toBe('Prunus persica')
    expect(row.querySelector('[data-testid="web-species-place"]')?.getAttribute('aria-label')).toBe('Placer Peach')
  })

  it('matches accented Favorites and restores focus after full-detail navigation', async () => {
    mockWorkbench.favorites.value = {
      items: [makeSpeciesListItem('Prunus persica', 'Pêcher', true)],
      loading: false,
      revision: 0,
    }
    mockWorkbench.sidebar.value = {
      favoriteNames: ['Prunus persica'],
      recentlyViewed: [makeSpeciesListItem('Prunus persica', 'Pêcher', true)],
    }
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="favorites" />, container)
    })

    const search = requiredElement<HTMLInputElement>('[aria-label="Search favorites"]')
    await act(async () => {
      search.value = 'pecher'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('Pêcher')
    const origins = container.querySelectorAll<HTMLButtonElement>(
      '[data-species-detail="Prunus persica"]',
    )
    expect(origins).toHaveLength(2)
    const origin = origins[1]!

    mockWorkbench.detail.value = {
      canonicalName: 'Prunus persica',
      detail: null,
      loading: true,
      error: null,
    }
    await act(async () => {
      origin.focus()
      origin.click()
      search.value = 'pecher '
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const back = requiredElement<HTMLButtonElement>('[data-detail-back]')
    expect(document.activeElement).toBe(back)

    mockWorkbench.detail.value = {
      canonicalName: null,
      detail: null,
      loading: false,
      error: null,
    }
    await act(async () => {
      back.click()
      search.value = 'pecher'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.activeElement).toBe(origin)
    expect(search.value).toBe('pecher')
  })

  it('renders the common name over the italic scientific name', async () => {
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    const row = requiredElement<HTMLElement>('[data-testid="catalog-species-row"]')
    expect(row.querySelector('strong')?.textContent).toBe('Apple')
    const scientific = row.querySelector('em')!
    expect(scientific.textContent).toBe('Malus domestica')
    expect(scientific.getAttribute('lang')).toBe('la')
  })

  it('does not duplicate Canonical Name when a Species row has no Common Name', async () => {
    mockWorkbench.results.value = {
      ...mockWorkbench.results.value,
      items: [
        {
          ...makeSpeciesListItem('Malus domestica', 'Apple'),
          common_name: null,
        },
      ],
    }

    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    const row = requiredElement<HTMLElement>('[data-testid="catalog-species-row"]')
    expect(row.querySelector('strong')?.textContent).toBe('Malus domestica')
    expect(row.querySelector('em')).toBeNull()
  })

  it('writes desktop Plant Stamp drag payloads from catalog rows', async () => {
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    const row = requiredElement<HTMLElement>('[data-testid="catalog-species-row"]')
    const dataTransfer = fakeDataTransfer()
    expect(row.draggable).toBe(true)

    await act(async () => {
      await dispatchDragStart(row, dataTransfer)
    })

    expect(dataTransfer.effectAllowed).toBe('copy')
    expect(readPlantStampDragData(dataTransfer)).toEqual({
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      stratum: null,
      width_max_m: null,
    })
  })

  it('starts Plant Stamp from a catalog Place action without opening detail', async () => {
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    await act(async () => {
      requiredElement<HTMLButtonElement>('button[aria-label="Place Apple"]').click()
    })

    expect(readPlantStampSource()).toEqual({
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      stratum: null,
      width_max_m: null,
    })
    expect(mockCanvasSession.toolSurface.setTool).toHaveBeenCalledWith('plant-stamp')
    expect(mockWorkbench.selectSpecies).not.toHaveBeenCalled()
    expect(mockWorkbench.toggleFavorite).not.toHaveBeenCalled()
  })

  it('surfaces catalog load failures as the translated message with a retry action', async () => {
    mockWorkbench.results.value = {
      items: [],
      nextCursor: null,
      totalEstimate: 0,
      committedRevision: 1,
      status: 'error',
      error: 'Failed to load Web Edition Species Catalog manifest.',
    }

    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    // The translated message, never the raw error (canopi-etzh; web-species-catalog-load-failure.test.tsx).
    const alert = requiredElement<HTMLElement>('[role="alert"]')
    expect(alert.textContent).toContain('The plant catalog couldn’t load.')
    expect(alert.textContent).not.toContain('Failed to load Web Edition Species Catalog manifest.')

    await act(async () => { requiredButton('Retry').click() })

    expect(mockWorkbench.retrySearch).toHaveBeenCalledOnce()
  })

  it('writes desktop Plant Stamp drag payloads from favorites and recently viewed rows', async () => {
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="favorites" />, container)
    })

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="web-species-row"]'))
    expect(rows).toHaveLength(2)

    const favoriteTransfer = fakeDataTransfer()
    await act(async () => {
      await dispatchDragStart(rows[0]!, favoriteTransfer)
    })
    expect(readPlantStampDragData(favoriteTransfer)?.canonical_name).toBe('Prunus persica')

    const recentTransfer = fakeDataTransfer()
    await act(async () => {
      await dispatchDragStart(rows[1]!, recentTransfer)
    })
    expect(readPlantStampDragData(recentTransfer)?.canonical_name).toBe('Melissa officinalis')
  })

  it('starts Plant Stamp from favorite and recently viewed Place actions', async () => {
    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="favorites" />, container)
    })

    const placeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="web-species-place"]'),
    )
    expect(placeButtons).toHaveLength(2)

    await act(async () => {
      placeButtons[0]!.click()
    })
    expect(readPlantStampSource()?.canonical_name).toBe('Prunus persica')
    expect(mockCanvasSession.toolSurface.setTool).toHaveBeenLastCalledWith('plant-stamp')

    await act(async () => {
      placeButtons[1]!.click()
    })
    expect(readPlantStampSource()?.canonical_name).toBe('Melissa officinalis')
    expect(mockCanvasSession.toolSurface.setTool).toHaveBeenLastCalledWith('plant-stamp')
    expect(mockWorkbench.selectSpecies).not.toHaveBeenCalled()
  })

  it('keeps Place safe when the canvas command surface is unavailable', async () => {
    mockCanvasSession.currentToolCommandSurface.value = null

    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    await act(async () => {
      requiredElement<HTMLButtonElement>('button[aria-label="Place Apple"]').click()
    })

    expect(readPlantStampSource()?.canonical_name).toBe('Malus domestica')
    expect(mockCanvasSession.toolSurface.setTool).not.toHaveBeenCalled()
    expect(mockWorkbench.selectSpecies).not.toHaveBeenCalled()
  })

  it('renders reduced Species detail with a lazy, attributed hero image', async () => {
    mockWorkbench.detail.value = {
      canonicalName: 'Malus domestica',
      detail: {
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        common_names: ['Apple', 'Paradise apple'],
        climate_zones: ['Temperate'],
        habit: 'Tree',
        growth_form: 'Woody perennial',
        life_cycles: ['Perennial'],
        image: {
          url: 'https://images.example.test/apple.jpg',
          source: 'Wikimedia Commons',
          source_page_url: 'https://commons.example.test/apple',
          credit: 'Jane Gardener',
          license: 'CC BY-SA 4.0',
        },
      },
      loading: false,
      error: null,
    }

    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    const image = requiredElement<HTMLImageElement>('[data-testid="species-photo"]')
    expect(image.getAttribute('src')).toBe('https://images.example.test/apple.jpg')
    expect(image.getAttribute('loading')).toBe('lazy')
    expect(container.textContent).toContain('Apple')
    expect(container.textContent).toContain('Malus domestica')
    expect(container.textContent).toContain('Paradise apple')
    expect(container.textContent).toContain('Temperate')
    expect(container.textContent).toContain('Tree')
    expect(container.textContent).toContain('Woody perennial')
    expect(container.textContent).toContain('Perennial')
    const attribution = requiredElement<HTMLElement>('[data-testid="species-photo-attribution"]')
    expect(attribution.textContent).toBe('Photo: Jane Gardener · Wikimedia Commons · CC BY-SA 4.0')
    expect(attribution.querySelector('a')?.getAttribute('href')).toBe('https://commons.example.test/apple')
    expect(attribution.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
    // The Web catalog carries no heights or ratings: only its own facts show.
    expect(Array.from(container.querySelectorAll('[data-fact]')).map((cell) => (cell as HTMLElement).dataset.fact))
      .toEqual(['habit', 'lifeCycle', 'climateZones'])
  })

  it('marks an English fallback title and shows the scientific name under it', async () => {
    locale.value = 'fr'
    mockWorkbench.detail.value = {
      canonicalName: 'Ribes nigrum',
      detail: {
        canonical_name: 'Ribes nigrum',
        common_name: null,
        common_names: [],
        climate_zones: [],
        habit: null,
        growth_form: null,
        life_cycles: [],
        image: null,
      },
      loading: false,
      error: null,
      englishName: 'Blackcurrant',
    }

    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    const title = requiredElement<HTMLHeadingElement>('[data-testid="species-detail"] h2')
    expect(title.textContent).toContain('Blackcurrant')
    expect(title.textContent).toContain('(angl.)')
    expect(container.querySelector('[data-testid="species-detail"] p i[lang="la"]')?.textContent).toBe('Ribes nigrum')
    expect(Array.from(container.querySelectorAll('[data-fact] dd')).map((cell) => cell.textContent))
      .toEqual(['Non renseigné', 'Non renseigné', 'Non renseigné'])
  })

  it('renders a clean fallback when image metadata is missing', async () => {
    mockWorkbench.detail.value = {
      canonicalName: 'Malus domestica',
      detail: {
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        common_names: ['Apple'],
        climate_zones: ['Temperate'],
        habit: 'Tree',
        growth_form: null,
        life_cycles: ['Perennial'],
        image: null,
      },
      loading: false,
      error: null,
    }

    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    expect(container.querySelector('[data-testid="species-photo"]')).toBeNull()
    expect(container.textContent).toContain('No photos available')
  })

  it('renders a clean fallback when the remote hero image fails to load', async () => {
    mockWorkbench.detail.value = {
      canonicalName: 'Malus domestica',
      detail: {
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        common_names: ['Apple'],
        climate_zones: ['Temperate'],
        habit: 'Tree',
        growth_form: null,
        life_cycles: ['Perennial'],
        image: {
          url: 'https://images.example.test/missing-apple.jpg',
          source: null,
          source_page_url: null,
          credit: null,
          license: null,
        },
      },
      loading: false,
      error: null,
    }

    await act(async () => {
      render(<WebSpeciesCatalogPanel mode="catalog" />, container)
    })

    await act(async () => {
      requiredElement<HTMLImageElement>('[data-testid="species-photo"]')
        .dispatchEvent(new Event('error'))
    })

    expect(container.querySelector('[data-testid="species-photo"]')).toBeNull()
    expect(container.textContent).toContain('This photo could not load')
  })

  function requiredButton(name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.trim().startsWith(name))
    if (!button) throw new Error(`Missing button ${name}`)
    return button
  }

  function requiredElement<T extends Element>(selector: string): T {
    const element = container.querySelector<T>(selector)
    if (!element) throw new Error(`Missing element ${selector}`)
    return element
  }
})

function resetWorkbench(): void {
  vi.clearAllMocks()
  mockWorkbench.intent.value = { text: '', filters: emptyFilters(), extraFilters: [], sort: 'Recommended', browseSort: 'Recommended', locale: 'en' }
  mockWorkbench.hasActiveFilters.value = false
  mockWorkbench.results.value = {
    items: [makeSpeciesListItem('Malus domestica', 'Apple')],
    nextCursor: 'offset:1',
    totalEstimate: 2,
    committedRevision: 1,
    status: 'idle',
    error: null,
  }
  mockWorkbench.filterStrip.value = {
    options: {
      families: [],
      growth_rates: [],
      climate_zones: ['Temperate'],
      habits: ['Tree'],
      life_cycles: ['Perennial'],
      sun_tolerances: [],
      soil_tolerances: [],
    },
    filters: emptyFilters(),
    hasActive: false,
    activeCount: 0,
    controls: supportedFilterControls(),
  }
  mockWorkbench.favorites.value = {
    items: [makeSpeciesListItem('Prunus persica', 'Peach', true)],
    loading: false,
    revision: 0,
  }
  mockWorkbench.sidebar.value = {
    favoriteNames: ['Prunus persica'],
    recentlyViewed: [makeSpeciesListItem('Melissa officinalis', 'Lemon balm')],
  }
  mockWorkbench.detail.value = {
    canonicalName: null,
    detail: null,
    loading: false,
    error: null,
  }
  mockWorkbench.mount.mockReturnValue(vi.fn())
  mockWorkbench.resolveCommonNames.mockReset()
  mockWorkbench.resolveCommonNames.mockImplementation(async () => ({}))
  mockWorkbench.isSearchLoading.mockReturnValue(false)
}

function supportedFilterControls() {
  return [
    {
      kind: 'choice',
      filterKey: 'climate_zones',
      labelI18nKey: 'filters.climateZone',
      fallbackLabel: 'Climate zone',
      optionsKey: 'climate_zones',
      valueI18nPrefix: 'filters.climateZone_',
      color: '--color-sun',
      source: 'schema',
    },
    {
      kind: 'choice',
      filterKey: 'habit',
      labelI18nKey: 'filters.field.habit',
      fallbackLabel: 'Habit',
      optionsKey: 'habits',
      valueI18nPrefix: 'filters.habit_',
      color: '--color-family',
      source: 'schema',
    },
    {
      kind: 'choice',
      filterKey: 'life_cycle',
      labelI18nKey: 'filters.lifecycle',
      fallbackLabel: 'Life cycle',
      optionsKey: 'life_cycles',
      valueI18nPrefix: 'filters.lifeCycle_',
      color: '--color-family',
      source: 'adapter',
    },
  ] as const
}

function emptyFilters(): SpeciesFilter {
  return {
    sun_tolerances: null,
    soil_tolerances: null,
    growth_rate: null,
    life_cycle: null,
    edible: null,
    edibility_min: null,
    nitrogen_fixer: null,
    climate_zones: null,
    habit: null,
    woody: null,
    family: null,
    extra: null,
  }
}

function makeSpeciesListItem(
  canonicalName: string,
  commonName: string | null,
  isFavorite = false,
): SpeciesListItem {
  return {
    canonical_name: canonicalName,
    slug: canonicalName.toLowerCase().replace(/\s+/g, '-'),
    common_name: commonName,
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
    climate_zones: ['Temperate'],
    life_cycles: ['Perennial'],
    edibility_rating: null,
    medicinal_rating: null,
    width_max_m: null,
    is_favorite: isFavorite,
  }
}

async function dispatchDragStart(element: HTMLElement, dataTransfer: FakeDataTransfer): Promise<void> {
  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  element.dispatchEvent(event)
  // The drag image is a body-level preview that the row removes on the next frame.
  await vi.waitFor(() => expect(dragPreviews()).toHaveLength(0))
}

function dragPreviews(): Element[] {
  return [...document.body.children].filter((element) => (element as HTMLElement).style.top === '-1000px')
}

interface FakeDataTransfer {
  readonly types: string[]
  effectAllowed?: string
  setData(type: string, value: string): void
  getData(type: string): string
}

function fakeDataTransfer(): FakeDataTransfer {
  const values = new Map<string, string>()
  const types: string[] = []
  return {
    types,
    setData(type: string, value: string) {
      values.set(type, value)
      if (!types.includes(type)) types.push(type)
    },
    getData(type: string) {
      return values.get(type) ?? ''
    },
  }
}
