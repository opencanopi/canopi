// @vitest-environment jsdom

import { render } from 'preact'
import { setCanvasTool } from '../canvas/session-state'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../app/settings/state'
import { sidePanel } from '../app/shell/state'
import type { CatalogDesignSpecies } from '../components/plant-db/design-species'
import type { SpeciesDetail, SpeciesImage } from '../types/species'
import { emptySpeciesDetail } from './support/species-detail'

const ipc = vi.hoisted(() => ({
  getSpeciesDetail: vi.fn(),
  getLocaleCommonNames: vi.fn(async () => []),
  getCommonNames: vi.fn(async (_names: readonly string[], _locale: string): Promise<Record<string, string>> => ({})),
  getSpeciesHabits: vi.fn(async (): Promise<Record<string, string>> => ({})),
  getSpeciesImages: vi.fn(async (): Promise<SpeciesImage[]> => []),
  getCachedImagePath: vi.fn(async (url: string) => `/cache/${encodeURIComponent(url)}`),
}))
const workbench = vi.hoisted(() => ({
  selectedCanonicalName: { value: null as string | null },
  closeSpeciesDetail: vi.fn(),
  isFavorite: vi.fn(() => false),
  toggleFavorite: vi.fn(async () => {}),
}))
const inDesign = vi.hoisted(() => ({ species: new Map<string, CatalogDesignSpecies>() }))
const mapActions = vi.hoisted(() => ({ selectSpeciesPlants: vi.fn(), zoomToSpeciesPlants: vi.fn(() => true), showSpeciesDetailOnMap: vi.fn(), clearSpeciesDetailOnMap: vi.fn() }))

vi.mock('../ipc/species', () => ipc)
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset://${path}` }))
vi.mock('../app/plant-browser', async () => {
  // The detail's "(en)" title comes from the catalog's one projection, here over the mocked lookup.
  const { composeSpeciesDisplayNames } = await vi.importActual<typeof PlantBrowserWorkbenchModule>('../app/plant-browser/workbench')
  return {
    speciesCatalogWorkbench: Object.assign(workbench, {
      resolveDisplayNames: composeSpeciesDisplayNames((names, locale) => ipc.getCommonNames([...names], locale)),
    }),
  }
})
vi.mock('../app/plant-finder/map-matches', () => mapActions)
vi.mock('../components/plant-db/design-species', () => ({ useCatalogDesignSpecies: () => inDesign.species }))

import { PlantDetailCard } from '../components/plant-detail/PlantDetailCard'
import type * as PlantBrowserWorkbenchModule from '../app/plant-browser/workbench'

const APPLE = emptySpeciesDetail('Malus domestica', {
  common_name: 'Apple',
  family: 'Rosaceae',
  habit: 'Tree',
  stratum: 'high',
  succession_stage: 'secondary_ii',
  height_min_m: 4,
  height_max_m: 10,
  width_max_m: 8,
  hardiness_zone_min: 3,
  hardiness_zone_max: 8,
  tolerates_full_sun: true,
  tolerates_semi_shade: true,
  tolerates_full_shade: false,
  tolerates_light_soil: true,
  tolerates_heavy_soil: true,
  soil_ph_min: 5,
  soil_ph_max: 7.5,
  moisture_use: 'Medium',
  drought_tolerance: 'Low',
  growth_rate: 'Medium',
  age_of_maturity_years: 5,
  edibility_rating: 5,
  medicinal_rating: 2,
  other_uses_rating: 4,
  toxicity: 'Seeds contain small amounts of amygdalin.',
  propagated_by_seed: true,
  uses: [{ use_category: 'Edible fruit', use_description: 'Fruit eaten raw or cooked.' }],
})

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('Species detail (Desktop)', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    workbench.selectedCanonicalName.value = null
    inDesign.species = new Map()
    ipc.getSpeciesDetail.mockReset().mockResolvedValue(APPLE)
    ipc.getCommonNames.mockReset().mockResolvedValue({})
    ipc.getSpeciesImages.mockReset().mockResolvedValue([])
    ipc.getSpeciesHabits.mockReset().mockResolvedValue({ 'Malus domestica': 'Tree' })
    workbench.closeSpeciesDetail.mockReset()
    mapActions.selectSpeciesPlants.mockReset()
    mapActions.zoomToSpeciesPlants.mockReset()
    mapActions.showSpeciesDetailOnMap.mockReset()
    mapActions.clearSpeciesDetailOnMap.mockReset()
  })

  afterEach(() => {
    setCanvasTool('select')
    render(null, container)
    container.remove()
    locale.value = 'en'
    sidePanel.value = null
  })

  async function open(detail: SpeciesDetail = APPLE): Promise<void> {
    ipc.getSpeciesDetail.mockResolvedValue(detail)
    await act(async () => {
      render(<PlantDetailCard canonicalName={detail.canonical_name} />, container)
    })
    await act(flush)
  }

  function facts(): Record<string, string> {
    return Object.fromEntries(Array.from(container.querySelectorAll<HTMLElement>('[data-fact]'))
      .map((cell) => [cell.dataset.fact!, cell.querySelector('dd')!.textContent!]))
  }

  function button(name: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name)
    if (!found) throw new Error(`Missing button ${name}`)
    return found
  }

  it('shows the key facts with units, zones and ratings', async () => {
    await open()

    expect(container.querySelector('h2')?.textContent).toBe('Apple')
    expect(container.querySelector('p i[lang="la"]')?.textContent).toBe('Malus domestica')
    expect(container.textContent).toContain('Rosaceae')
    expect(facts()).toEqual({
      habit: 'Tree',
      stratum: 'High',
      height: '4–10 m',
      width: '8 m',
      hardiness: 'USDA 3–8 · to -40°C',
      light: 'Full sun, Semi-shade',
      soil: 'light, heavy · pH 5–7.5',
      moisture: 'Medium',
      drought: 'Low',
      growth: 'Medium · mature at 5 years',
      succession: 'Secondary II',
      edibility: '5 of 5',
      medicinal: '2 of 5',
      otherUses: '4 of 5',
    })
    // Use categories as read-only tags; the sections stay closed until opened.
    expect(Array.from(container.querySelectorAll('li')).map((tag) => tag.textContent)).toEqual(['Edible fruit'])
  })

  it('says "Not recorded" in every fact the catalog lacks, never an empty cell', async () => {
    await open(emptySpeciesDetail('Obscura ignota'))

    const values = Object.values(facts())
    expect(values).toHaveLength(14)
    expect(values.every((value) => value === 'Not recorded')).toBe(true)
    // Sections without recorded data do not render.
    expect(container.querySelector('[data-section]')).toBeNull()
    expect(container.querySelector('h2 i')?.textContent).toBe('Obscura ignota')
  })

  it('formats numbers for the interface language', async () => {
    locale.value = 'fr'
    await open(emptySpeciesDetail('Malus domestica', { common_name: 'Pommier', height_max_m: 12.5, soil_ph_min: 5.5, soil_ph_max: 7 }))

    expect(facts().height).toBe('12,5\u202fm')
    expect(facts().soil).toBe('pH 5,5–7')
  })

  it('marks an English fallback name with the localized English mark when the language has none', async () => {
    locale.value = 'fr'
    ipc.getCommonNames.mockImplementation(async (_names, requested): Promise<Record<string, string>> => requested === 'en' ? { 'Ribes nigrum': 'Blackcurrant' } : {})
    await open(emptySpeciesDetail('Ribes nigrum'))

    const title = container.querySelector('h2')!
    expect(ipc.getCommonNames).toHaveBeenCalledWith(['Ribes nigrum'], 'en')
    expect(title.getAttribute('lang')).toBeNull()
    expect(title.querySelector('[lang="en"]')?.textContent).toBe('Blackcurrant')
    const mark = title.querySelector('[aria-hidden="true"]')!
    expect(mark.textContent).toBe('(angl.)')
    expect(mark.closest('[lang="en"]')).toBeNull()
    expect(container.querySelector('p i[lang="la"]')?.textContent).toBe('Ribes nigrum')
  })

  it('shows no "(en)" mark for a name in the interface language', async () => {
    locale.value = 'fr'
    await open(emptySpeciesDetail('Malus domestica', { common_name: 'Pommier' }))

    expect(container.querySelector('h2')?.textContent).toBe('Pommier')
    expect(ipc.getCommonNames).not.toHaveBeenCalled()
  })

  it('offers Select them and Zoom to them for a species in the open Design', async () => {
    inDesign.species = new Map([['Malus domestica', { code: 'MDO', count: 6, symbol: 'canopy', color: '#B06045' }]])
    await open()

    expect(container.textContent).toContain('6 in this Design')
    expect(container.textContent).toContain('MDO')
    await act(async () => { button('Select them').click() })
    expect(mapActions.selectSpeciesPlants).toHaveBeenCalledWith(['Malus domestica'])
    expect(mapActions.showSpeciesDetailOnMap).toHaveBeenCalledWith('Malus domestica')
    await act(async () => { button('Zoom to them').click() })
    expect(mapActions.zoomToSpeciesPlants).toHaveBeenCalledWith(['Malus domestica'])
    expect(button('Place Apple').disabled).toBe(false)
  })

  it('drops its rings while Place plants is armed, so placing never keeps the species ringed', async () => {
    inDesign.species = new Map([['Malus domestica', { code: 'MDO', count: 6, symbol: 'canopy', color: '#B06045' }]])
    await open()
    expect(mapActions.showSpeciesDetailOnMap).toHaveBeenCalledTimes(1)

    mapActions.showSpeciesDetailOnMap.mockClear()
    await act(async () => { setCanvasTool('plant-stamp') })
    expect(mapActions.clearSpeciesDetailOnMap).toHaveBeenCalled()
    expect(mapActions.showSpeciesDetailOnMap).not.toHaveBeenCalled()

    await act(async () => { setCanvasTool('select') })
    expect(mapActions.showSpeciesDetailOnMap).toHaveBeenCalledWith('Malus domestica')
  })

  it('shows no in-Design actions for a species not in the Design', async () => {
    await open()

    expect(container.textContent).not.toContain('in this Design')
    expect(() => button('Zoom to them')).toThrow()
    expect(button('Place Apple')).toBeTruthy()
  })

  it('moves between photos with the keyboard and names each photo source', async () => {
    ipc.getSpeciesImages.mockResolvedValue([
      { id: '1', species_id: 's', url: 'http://commons.wikimedia.org/wiki/Special:FilePath/Apple.jpg', sort_order: 0 },
      { id: '2', species_id: 's', url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg', sort_order: 1 },
      { id: '3', species_id: 's', url: 'https://example.org/apple.jpg', sort_order: 2 },
    ])
    await open()

    const current = () => container.querySelector('[aria-current="true"]')?.getAttribute('aria-label')
    const attribution = () => container.querySelector('[data-testid="species-photo-attribution"]')?.textContent
    expect(current()).toBe('Photo 1 of 3')
    expect(attribution()).toBe('Photo: Wikimedia Commons · license not recorded')

    const next = button('Next photo')
    await act(async () => { next.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    await act(flush)
    expect(current()).toBe('Photo 2 of 3')
    expect(attribution()).toBe('Photo: iNaturalist · license not recorded')

    await act(async () => { next.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    await act(flush)
    expect(current()).toBe('Photo 3 of 3')
    expect(attribution()).toBe('Photo: example.org · license not recorded')

    await act(async () => { next.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })) })
    await act(flush)
    expect(current()).toBe('Photo 1 of 3')

    await act(async () => { next.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    await act(flush)
    expect(current()).toBe('Photo 3 of 3')
    expect(container.querySelector<HTMLImageElement>('[data-testid="species-photo"]')?.getAttribute('src'))
      .toBe(`asset:///cache/${encodeURIComponent('https://example.org/apple.jpg')}`)
  })

  it('keeps a quiet placeholder for a species without photos', async () => {
    await open()

    expect(container.querySelector('[data-testid="species-photo"]')).toBeNull()
    expect(container.textContent).toContain('No photos available')
  })

  it('focuses Back on open; Back closes the detail and Close closes the panel', async () => {
    const railButton = document.createElement('button')
    railButton.dataset.panel = 'plant-db'
    document.body.appendChild(railButton)
    sidePanel.value = 'plant-db'
    await open()

    const back = container.querySelector<HTMLButtonElement>('[data-detail-back]')!
    expect(document.activeElement).toBe(back)
    await act(async () => { back.click() })
    expect(workbench.closeSpeciesDetail).toHaveBeenCalledTimes(1)

    await act(async () => { button('Close panel').click() })
    expect(sidePanel.value).toBeNull()
    expect(document.activeElement).toBe(railButton)
  })

  it('opens a long section on demand and shows it in full', async () => {
    await open()

    const toggle = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-section="risk"] button'))[0]!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Seeds contain small amounts of amygdalin.')
  })
})
