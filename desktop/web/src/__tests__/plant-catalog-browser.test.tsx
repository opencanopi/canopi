// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeciesCatalogWorkbench } from '../app/plant-browser/workbench'
import type { PaginatedResult, SpeciesListItem, SpeciesSearchRequest } from '../types/species'
import { createTestSpeciesCatalogWorkbench, makeSpeciesListItem } from './support/species-catalog-workbench'
import type * as CatalogBrowserModule from '../components/plant-db/CatalogBrowser'
import type * as SettingsStateModule from '../app/settings/state'
import type * as PlantFinderFocusModule from '../app/plant-finder/focus'
import type * as PlantBrowserModule from '../app/plant-browser'

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

vi.mock('../components/plant-db/design-species', () => ({
  useCatalogDesignSpecies: () => new Map([
    ['Malus domestica', { code: 'MDO', count: 6, symbol: 'apple', color: '#B06045' }],
  ]),
}))

const flush = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve()
}

// Intl uses narrow no-break spaces as French group separators.
const englishNames: Record<string, string> = { 'Malus domestica': 'Apple' }

const spaces = (text: string | null | undefined) => (text ?? '').replace(/\s/g, ' ')

function apple(): SpeciesListItem {
  return {
    ...makeSpeciesListItem('Malus domestica'),
    common_name: 'Apple',
    habit: 'Tree',
    height_max_m: 8,
    hardiness_zone_min: 4,
    hardiness_zone_max: 8,
    edibility_rating: 5,
    is_favorite: true,
  }
}

describe('Plant catalog browser', () => {
  let container: HTMLDivElement
  let workbench: SpeciesCatalogWorkbench
  let requests: SpeciesSearchRequest[]
  let respond: (request: SpeciesSearchRequest) => PaginatedResult<SpeciesListItem>
  let CatalogBrowser: typeof CatalogBrowserModule.CatalogBrowser
  let locale: typeof SettingsStateModule.locale
  let focusOpenPlantFinder: typeof PlantFinderFocusModule.focusOpenPlantFinder

  beforeEach(async () => {
    vi.resetModules()
    requests = []
    respond = () => ({ items: [apple(), makeSpeciesListItem('Aa achalensis')], next_cursor: null, total_estimate: 175473 })
    const settings = await import('../app/settings/state')
    locale = settings.locale
    locale.value = 'en'
    workbench = await createTestSpeciesCatalogWorkbench({
      locale,
      search: async (request) => {
        requests.push(request)
        return respond(request)
      },
      resolveCommonNames: async (names, requested) => Object.fromEntries(names.flatMap((name) => (
        requested === 'en' && englishNames[name] ? [[name, englishNames[name]!]] : []
      ))),
      getFilterOptions: async () => ({
        families: [],
        growth_rates: [],
        climate_zones: ['Temperate'],
        habits: ['Tree', 'Shrub'],
        life_cycles: ['Perennial'],
        sun_tolerances: [],
        soil_tolerances: [],
      }),
    })
    vi.doMock('../app/plant-browser', async () => ({
      ...await vi.importActual<typeof PlantBrowserModule>('../app/plant-browser'),
      speciesCatalogWorkbench: workbench,
    }))
    ;({ CatalogBrowser } = await import('../components/plant-db/CatalogBrowser'))
    ;({ focusOpenPlantFinder } = await import('../app/plant-finder/focus'))
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    workbench.mount('catalog')
    await workbench.loadFilterOptions()
    await act(async () => {
      render(<CatalogBrowser onMoreFilters={vi.fn()} searchScope="common names in English, scientific names, families and uses" />, container)
      await flush()
    })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    workbench.dispose()
    vi.doUnmock('../app/plant-browser')
  })

  const button = (name: string) => {
    const found = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim().startsWith(name))
    if (!found) throw new Error(`Missing button ${name}`)
    return found
  }
  const status = () => container.querySelector('[role="status"]')?.textContent ?? ''

  it('browses in the recommended order and counts species for the interface language', async () => {
    expect(requests[0]).toMatchObject({ text: '', sort: 'Recommended', include_total: true })
    expect(status()).toBe('175,473 species')

    await act(async () => { locale.value = 'fr'; await flush() })
    expect(spaces(status())).toBe('175 473 espèces')

    respond = () => ({ items: [apple()], next_cursor: null, total_estimate: 1 })
    await act(async () => { locale.value = 'en'; await flush() })
    expect(status()).toBe('1 species')
  })

  it('shows species rows: glyph, common over italic scientific name, facts, code, Place and star', () => {
    const rows = container.querySelectorAll('[data-testid="catalog-species-row"]')
    expect(rows).toHaveLength(2)
    const row = rows[0]!
    expect(row.querySelector('strong')?.textContent).toBe('Apple')
    expect(row.querySelector('em[lang="la"]')?.textContent).toBe('Malus domestica')
    expect(row.textContent).toContain('Tree · 8 m · USDA 4–8 · Edible 5/5')
    expect(row.textContent).toContain('MDO')
    expect(row.querySelector('[data-plant-symbol="apple"]')).not.toBeNull()
    expect(row.querySelector('button[aria-label="Place Apple"]')).not.toBeNull()
    expect(row.querySelector('button[aria-label="Remove Apple from favorites"]')?.getAttribute('aria-pressed')).toBe('true')
    // A species without a common name shows its scientific name alone, with its habit glyph.
    const bare = rows[1]!
    expect(bare.querySelector('strong')?.textContent).toBe('Aa achalensis')
    expect(bare.querySelector('em')).toBeNull()
    expect(bare.querySelector('[data-plant-symbol="round"]')).not.toBeNull()
    expect(container.textContent).toContain('Codes appear on species already in this Design.')
  })

  it('shows the English name marked "(en)" for a species with no name in the interface language', async () => {
    respond = () => ({ items: [{ ...apple(), common_name: null, is_name_fallback: true }], next_cursor: null, total_estimate: 1 })
    await act(async () => { locale.value = 'fr'; await flush() })
    const row = container.querySelector('[data-testid="catalog-species-row"]')!
    // The English name follows the catalog's projection: the language's lookup, then English.
    await vi.waitFor(() => expect(row.querySelector('strong [lang="en"]')?.textContent).toBe('Apple'))
    expect(row.querySelector('strong')?.textContent).toContain('(angl.)')
    expect(row.querySelector('em[lang="la"]')?.textContent).toBe('Malus domestica')
    expect(row.querySelector('button[aria-label="Placer Apple"]')).not.toBeNull()

    await act(async () => { locale.value = 'en'; await flush() })
    expect(container.querySelector('[data-testid="catalog-species-row"] strong [lang="en"]')).toBeNull()
  })

  it('keeps filters behind "Filters" and shows active ones as removable tokens', async () => {
    expect(container.textContent).not.toContain('Climate zone')
    const trees = button('Trees')
    expect(trees.getAttribute('aria-pressed')).toBe('false')

    await act(async () => { trees.click(); await flush() })
    expect(workbench.intent.value.filters.habit).toEqual(['Tree'])
    expect(requests.at(-1)?.filters.habit).toEqual(['Tree'])
    expect(button('Trees').getAttribute('aria-pressed')).toBe('true')
    expect(button('Filters').textContent).toContain('1')
    expect(container.querySelector('button[aria-label="Remove filter: Tree"]')).not.toBeNull()

    await act(async () => { button('Filters').click() })
    expect(button('Filters').getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Climate zone')
    expect(container.textContent).toContain('More filters')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove filter: Tree"]')!.click()
      await flush()
    })
    expect(workbench.intent.value.filters.habit).toBeNull()

    await act(async () => { button('Edible').click(); await flush() })
    expect(workbench.intent.value.filters.edibility_min).toBe(3)
    await act(async () => { button('Clear filters').click(); await flush() })
    expect(workbench.intent.value.filters.edibility_min).toBeNull()
  })

  it('sorts a browse by name, height or edibility and ranks a search by relevance', async () => {
    const sort = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!
    expect(sort.textContent).toContain('Sort: Recommended')
    await act(async () => { sort.click() })
    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    expect(options.map((option) => option.textContent)).toEqual(['Recommended', 'Name', 'Height', 'Edibility'])
    await act(async () => { options[2]!.click(); await flush() })
    expect(requests.at(-1)).toMatchObject({ sort: 'Height' })

    respond = () => ({ items: [apple()], next_cursor: 'offset:1', total_estimate: 0 })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search the plant catalog"]')!
    await act(async () => {
      input.value = 'apple'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    })
    expect(requests.at(-1)).toMatchObject({ text: 'apple', sort: 'Relevance', include_total: false })
    expect(status()).toBe('1+ species')
    expect(container.querySelector('button[aria-haspopup="listbox"]')).toBeNull()
    expect(container.querySelector('mark')?.textContent).toBe('Apple')

    respond = () => ({ items: [apple()], next_cursor: null, total_estimate: 0 })
    await act(async () => {
      input.value = 'apples'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    })
    expect(container.textContent).toContain('Searched common names in English, scientific names, families and uses.')

    await act(async () => {
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    })
    expect(requests.at(-1)).toMatchObject({ text: '', sort: 'Height' })
  })

  it('says why the list is empty and offers to clear filters', async () => {
    respond = () => ({ items: [], next_cursor: null, total_estimate: 0 })
    await act(async () => { button('Trees').click(); await flush() })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search the plant catalog"]')!
    await act(async () => {
      input.value = 'Malus'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    })
    expect(container.textContent).toContain('No species match “Malus” with this filter.')
    const clear = Array.from(container.querySelectorAll('button')).filter((candidate) => candidate.textContent === 'Clear filters')
    await act(async () => { clear.at(-1)!.click(); await flush() })
    expect(workbench.intent.value.filters.habit).toBeNull()
  })

  it('takes Ctrl F while the catalog is open', () => {
    expect(focusOpenPlantFinder()).toBe(true)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search the plant catalog')
  })
})

describe('Species Catalog Workbench browse orders', () => {
  it('offers only the orders its catalog serves and ignores the others', async () => {
    const workbench = await createTestSpeciesCatalogWorkbench({ browseSorts: ['Recommended', 'Name'] })
    try {
      expect(workbench.browseSorts).toEqual(['Recommended', 'Name'])
      workbench.setBrowseSort('Height')
      expect(workbench.intent.value.browseSort).toBe('Recommended')
      workbench.setBrowseSort('Name')
      expect(workbench.intent.value.browseSort).toBe('Name')
    } finally {
      workbench.dispose()
    }
  })

  it('starts on the first order an edition serves when it cannot serve Recommended', async () => {
    const workbench = await createTestSpeciesCatalogWorkbench({ browseSorts: ['Name'] })
    try {
      expect(workbench.intent.value.browseSort).toBe('Name')
    } finally {
      workbench.dispose()
    }
  })
})
