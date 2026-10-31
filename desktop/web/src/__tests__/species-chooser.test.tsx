// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../app/settings/state'
import { activePanel, sidePanel } from '../app/shell/state'
import { ToolCard } from '../components/canvas/ToolCard'
import { focusOwner } from '../app/keyboard/focus-owner'
import {
  clearPlantStampSource,
  readPlantStampSource,
  recentPlantStampSources,
  selectPlantStampSource,
} from '../canvas/plant-stamp-source'
import { SceneStore } from '../canvas/runtime/scene/store'
import { setCurrentCanvasSession } from '../canvas/session'
import {
  IDLE_CANVAS_TOOL_GUIDANCE,
  currentCanvasTool,
  setCanvasTool,
  setCanvasToolGuidance,
} from '../canvas/session-state'
import type { SpeciesListItem } from '../types/species'
import { hoveredPanelTargets, selectedPanelTargets } from '../app/panel-targets/state'
import { speciesTarget } from '../target'
import {
  createTestCanvasCommandSurface,
  createTestCanvasDocumentSurface,
  createTestCanvasKeyboardPort,
} from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface, type TestCanvasQuerySurface } from './support/canvas-query-surface'
import type * as PlantBrowserModule from '../app/plant-browser'

const favorites = vi.hoisted(() => ({
  view: null as null | { value: { items: readonly unknown[], loading: boolean, revision: number } },
  load: null as null | ReturnType<typeof vi.fn>,
  englishNames: {} as Record<string, string>,
  habits: { 'Malus domestica': 'Tree', 'Ficus carica': 'Shrub', 'Rubus idaeus': 'Shrub' } as Record<string, string>,
}))
vi.mock('../app/plant-browser', async (importOriginal) => {
  const original = await importOriginal<typeof PlantBrowserModule>()
  const view = signal({ items: [] as readonly unknown[], loading: false, revision: 0 })
  favorites.view = view
  favorites.load = vi.fn(async () => {})
  const resolveCommonNames = async (names: readonly string[], requested: string) => Object.fromEntries(names.flatMap((name) => (
    requested === 'en' && favorites.englishNames[name] ? [[name, favorites.englishNames[name]!]] : []
  )))
  return {
    ...original,
    speciesCatalogWorkbench: new Proxy(original.speciesCatalogWorkbench, {
      get(target, property) {
        if (property === 'favorites') return view
        if (property === 'loadFavorites') return favorites.load
        if (property === 'resolveHabits') {
          return async (names: readonly string[]) => Object.fromEntries(names.flatMap((name) => (
            favorites.habits[name] ? [[name, favorites.habits[name]!]] : []
          )))
        }
        if (property === 'resolveCommonNames') return resolveCommonNames
        if (property === 'resolveDisplayNames') return original.composeSpeciesDisplayNames(resolveCommonNames)
        return Reflect.get(target, property)
      },
    }),
  }
})

function favorite(canonical_name: string, common_name: string | null, width_max_m: number | null = null): SpeciesListItem {
  return {
    canonical_name, common_name, width_max_m, stratum: null, is_favorite: true,
  } as unknown as SpeciesListItem
}

function plant(id: string, canonicalName: string, commonName: string, canopySpreadM: number | null = null) {
  return {
    kind: 'plant' as const, id, canonicalName, commonName, locked: false, color: null, stratum: 'high',
    canopySpreadM, position: { x: 0, y: 0 }, rotationDeg: null, notes: null, plantedDate: null, quantity: 1,
  }
}

describe('Place plants species chooser', () => {
  let container: HTMLDivElement
  let map: HTMLDivElement
  let releaseMap: () => void
  let queries: TestCanvasQuerySurface

  beforeEach(async () => {
    locale.value = 'en'
    container = document.createElement('div')
    map = document.createElement('div')
    map.tabIndex = 0
    document.body.append(container, map)
    // The map host is the focus owner's map region, as CanvasChrome registers it.
    releaseMap = focusOwner.registerRegion('map', map)
    const store = new SceneStore()
    store.updatePersisted((draft) => {
      draft.plants = [
        plant('a1', 'Malus domestica', 'Apple', 6),
        plant('a2', 'Malus domestica', 'Apple', 6),
        plant('f1', 'Ficus carica', 'Fig', 4),
      ]
    })
    queries = createTestCanvasQuerySurface({
      scene: store.persisted,
      localizedNames: new Map([['Malus domestica', 'Pommier'], ['Ficus carica', null]]),
      speciesCache: new Map([
        ['Malus domestica', { canonical_name: 'Malus domestica', stratum: 'high' }],
        ['Ficus carica', { canonical_name: 'Ficus carica', stratum: 'emergent' }],
      ]),
    })
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface(),
      queries,
      documents: createTestCanvasDocumentSurface(),
      keyboard: createTestCanvasKeyboardPort(),
    })
    favorites.view!.value = {
      items: [favorite('Rubus idaeus', 'Raspberry', 1.5), favorite('Ficus carica', 'Fig', 4)],
      loading: false,
      revision: 1,
    }
    await act(() => render(<ToolCard />, container))
    await act(() => {
      setCanvasTool('plant-stamp')
      setCanvasToolGuidance(IDLE_CANVAS_TOOL_GUIDANCE)
    })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    releaseMap()
    map.remove()
    setCanvasTool('select')
    setCanvasToolGuidance(IDLE_CANVAS_TOOL_GUIDANCE)
    clearPlantStampSource()
    recentPlantStampSources.value = []
    favorites.englishNames = {}
    setCurrentCanvasSession(null)
    sidePanel.value = null
    activePanel.value = 'canvas'
  })

  const options = () => [...container.querySelectorAll<HTMLButtonElement>('[data-species-option]')]
  const sections = () => [...container.querySelectorAll('[data-species-section]')].map((section) => [
    section.querySelector('h3')?.textContent,
    [...section.querySelectorAll<HTMLElement>('[data-species-option]')].map((option) => option.dataset.speciesOption),
  ])

  it('offers the species in this Design first, then Favorites, then recent picks', async () => {
    await act(() => {
      recentPlantStampSources.value = [
        { canonical_name: 'Allium cepa', common_name: 'Onion', stratum: null, width_max_m: null },
        { canonical_name: 'Malus domestica', common_name: 'Apple', stratum: null, width_max_m: 6 },
      ]
    })

    expect(container.textContent).toContain('Choose a species to place')
    expect(sections()).toEqual([
      ['In this Design', ['Malus domestica', 'Ficus carica']],
      ['Favorites', ['Rubus idaeus']],
      ['Recent', ['Allium cepa']],
    ])
    expect(options()[0]!.textContent).toContain('Pommier')
    expect(options()[0]!.textContent).toContain('Malus domestica')
  })

  it('marks the English catalog name of a Design species with no name in the UI language', async () => {
    await act(() => {
      locale.value = 'fr'
      queries.setEnglishFallbackNames(new Map([['Ficus carica', 'Common fig']]))
      queries.bumpPlantNamesRevision()
    })

    const fig = options().find((option) => option.dataset.speciesOption === 'Ficus carica')!
    expect(fig.querySelector('[lang="en"]')?.textContent).toBe('Common fig')
    expect([...fig.querySelectorAll('[aria-hidden="true"]')].map((node) => node.textContent)).toContain('(angl.)')
    expect(fig.textContent).toContain('Nom anglais : pas encore de nom dans cette langue')
    const apple = options().find((option) => option.dataset.speciesOption === 'Malus domestica')!
    expect(apple.textContent).not.toContain('(angl.)')
    // Rubus idaeus is a Favorite: the catalog gives no English name for it here.
    const raspberry = options().find((option) => option.dataset.speciesOption === 'Rubus idaeus')!
    expect(raspberry.querySelector('[lang="en"]')).toBeNull()
  })

  it('marks the English catalog name of a Favorite or recent pick with no name in the UI language', async () => {
    // Species no other test lists: the catalog name cache lives as long as the module.
    favorites.englishNames = { 'Sambucus nigra': 'Elder', 'Allium ursinum': 'Wild garlic' }
    await act(async () => {
      locale.value = 'fr'
      favorites.view!.value = { items: [favorite('Sambucus nigra', null, 3)], loading: false, revision: 2 }
      recentPlantStampSources.value = [{ canonical_name: 'Allium ursinum', common_name: null, stratum: null, width_max_m: null }]
    })
    // The English names arrive from an asynchronous catalog lookup.
    await vi.waitFor(() => {
      for (const [canonical, english] of [['Sambucus nigra', 'Elder'], ['Allium ursinum', 'Wild garlic']] as const) {
        const option = options().find((candidate) => candidate.dataset.speciesOption === canonical)!
        expect(option.querySelector('[lang="en"]')?.textContent).toBe(english)
        expect(option.textContent).toContain('(angl.)')
      }
    })
  })

  it('narrows the chooser by Stratum and Form, with counts', async () => {
    const trigger = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')]
      .find((button) => button.textContent?.startsWith(label))!
    await act(() => trigger('Form').click())
    // The counts arrive from an asynchronous catalog lookup.
    await vi.waitFor(() => expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent))
      .toEqual(['All forms', 'Tree · 1', 'Shrub · 2']))
    await act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === 'Shrub · 2')!.click())
    expect(options().map((option) => option.dataset.speciesOption)).toEqual(['Ficus carica', 'Rubus idaeus'])

    await act(() => trigger('Stratum').click())
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent))
      .toEqual(['All strata', 'No stratum yet · 3'])
  })

  it('shows each species with the glyph and colour it has, or would take, on the map', async () => {
    const glyph = (name: string) => options().find((option) => option.dataset.speciesOption === name)!
      .querySelector<HTMLElement>('[data-species-glyph]')!
    // Apple is in the Design; Raspberry, from Favorites, would take the default symbol.
    expect(glyph('Malus domestica').getAttribute('aria-hidden')).toBe('true')
    expect(glyph('Malus domestica').querySelector('svg')?.getAttribute('data-plant-symbol')).toBe('round')
    expect(glyph('Malus domestica').style.color).not.toBe('')
    expect(glyph('Rubus idaeus').querySelector('svg')?.getAttribute('data-plant-symbol')).toBe('round')
  })

  it('the chooser swatch for a Design species shows the cached stratum colour', async () => {
    const fig = options().find((option) => option.dataset.speciesOption === 'Ficus carica')!
    // getStratumColor('emergent'), #1B5E20: the colour the canvas draws a Fig with no colour of its own.
    expect(fig.querySelector<HTMLElement>('[data-species-glyph]')!.style.color).toBe('rgb(27, 94, 32)')
  })

  it('rings a species\' plants with the hover stroke only while its row is pointed at or focused', async () => {
    const apple = options().find((option) => option.dataset.speciesOption === 'Malus domestica')!
    expect(hoveredPanelTargets.value).toEqual([])
    await act(() => { apple.dispatchEvent(new MouseEvent('mouseenter')) })
    expect(hoveredPanelTargets.value).toEqual([speciesTarget('Malus domestica')])
    await act(() => { apple.dispatchEvent(new MouseEvent('mouseleave')) })
    expect(hoveredPanelTargets.value).toEqual([])

    await act(() => { apple.focus() })
    expect(hoveredPanelTargets.value).toEqual([speciesTarget('Malus domestica')])
    // Choosing ends the ring: placing never keeps the species' plants ringed.
    await act(() => apple.click())
    expect(hoveredPanelTargets.value).toEqual([])
    expect(selectedPanelTargets.value).toEqual([])
  })

  it('loads Favorites when none are loaded yet', async () => {
    render(null, container)
    favorites.view!.value = { items: [], loading: false, revision: 0 }
    favorites.load!.mockClear()
    await act(() => render(<ToolCard />, container))

    expect(favorites.load).toHaveBeenCalledTimes(1)
  })

  it('narrows the list with the plant finder matcher', async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(() => {
      input.value = 'rasp'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(options().map((option) => option.dataset.speciesOption)).toEqual(['Rubus idaeus'])
    expect(container.querySelector('mark')?.textContent).toBe('Rasp')
  })

  it('arms Place plants with the chosen species, names it, remembers it and gives the map focus', async () => {
    await act(() => options().find((option) => option.dataset.speciesOption === 'Rubus idaeus')!.click())

    expect(readPlantStampSource()).toEqual({
      canonical_name: 'Rubus idaeus', common_name: 'Raspberry', stratum: null, width_max_m: 1.5,
    })
    expect(recentPlantStampSources.value[0]?.canonical_name).toBe('Rubus idaeus')
    expect(container.querySelector('[role="status"]')!.textContent).toContain('Raspberryclick the map to place one')
    expect(options()).toHaveLength(0)
    expect(document.activeElement).toBe(map)
  })

  it('keeps the spread the Design saved for a Design species', async () => {
    await act(() => options().find((option) => option.dataset.speciesOption === 'Malus domestica')!.click())

    expect(readPlantStampSource()).toEqual({
      canonical_name: 'Malus domestica', common_name: 'Pommier', stratum: 'high', width_max_m: 6,
    })
  })

  it('a Design species with no saved width takes the cached catalog width', async () => {
    const store = new SceneStore()
    store.updatePersisted((draft) => {
      draft.plants = [plant('p1', 'Prunus avium', 'Cherry', null)]
    })
    await act(() => setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface(),
      queries: createTestCanvasQuerySurface({
        scene: store.persisted,
        speciesCache: new Map([['Prunus avium', { canonical_name: 'Prunus avium', stratum: 'high', width_max_m: 6 }]]),
      }),
      documents: createTestCanvasDocumentSurface(),
      keyboard: createTestCanvasKeyboardPort(),
    }))
    await act(() => options().find((option) => option.dataset.speciesOption === 'Prunus avium')!.click())

    expect(readPlantStampSource()?.width_max_m).toBe(6)
  })

  it('opens the full catalog from its link', async () => {
    const link = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Open the full catalog')!
    await act(() => link.click())
    expect(sidePanel.value).toBe('plant-db')
  })

  it('points to the chooser when the map is clicked with no species chosen', async () => {
    await act(() => setCanvasToolGuidance({ ...IDLE_CANVAS_TOOL_GUIDANCE, speciesPrompts: 1 }))

    expect(container.querySelector('[role="status"]')!.textContent).toContain('Choose a species first, then click the map')
    expect(document.activeElement).toBe(container.querySelector('input[type="search"]'))
  })

  it('takes the focus once per run of clicks with no species, so later clicks leave it on the map (a tablet keeps its keyboard closed)', async () => {
    await act(() => setCanvasToolGuidance({ ...IDLE_CANVAS_TOOL_GUIDANCE, speciesPrompts: 1 }))
    expect(document.activeElement).toBe(container.querySelector('input[type="search"]'))

    map.focus()
    await act(() => setCanvasToolGuidance({ ...IDLE_CANVAS_TOOL_GUIDANCE, speciesPrompts: 2 }))
    expect(container.querySelector('[role="status"]')!.textContent).toContain('Choose a species first, then click the map')
    expect(document.activeElement, 'a second click with no species leaves the focus where it was').toBe(map)
  })

  it('reopens the chooser from Change species and closes it with Esc', async () => {
    await act(() => {
      selectPlantStampSource({ canonical_name: 'Ficus carica', common_name: 'Fig', stratum: null, width_max_m: 4 })
    })
    expect(options()).toHaveLength(0)

    const change = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change species')!
    await act(() => change.click())
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    expect(document.activeElement).toBe(input)
    expect(options().length).toBeGreaterThan(0)

    await act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(options()).toHaveLength(0)
    expect(readPlantStampSource()?.canonical_name).toBe('Ficus carica')
    expect(document.activeElement).toBe(map)
  })

  it('closes with Esc from a species option, keeping the tool and its species', async () => {
    await act(() => {
      selectPlantStampSource({ canonical_name: 'Ficus carica', common_name: 'Fig', stratum: null, width_max_m: 4 })
    })
    const change = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Change species')!
    await act(() => change.click())
    const option = options()[0]!
    option.focus()

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(() => { option.dispatchEvent(escape) })

    expect(escape.defaultPrevented).toBe(true)
    expect(options()).toHaveLength(0)
    expect(currentCanvasTool.value).toBe('plant-stamp')
    expect(readPlantStampSource()?.canonical_name).toBe('Ficus carica')
    expect(document.activeElement).toBe(map)
  })

  it('with no species chosen, Esc in the chooser leaves Place plants', async () => {
    // The chooser is the tool's only state while no species is chosen, so one Esc arms Select (U35).
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    input.focus()

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(() => { input.dispatchEvent(escape) })

    expect(escape.defaultPrevented).toBe(true)
    expect(currentCanvasTool.value).toBe('select')
    expect(container.querySelector('input[type="search"]')).toBeNull()
    expect(readPlantStampSource()).toBeNull()
    expect(document.activeElement).toBe(map)
  })

  it('leaves an Esc that is part of an IME composition to the IME', async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    input.focus()
    const composing = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
    await act(() => { input.dispatchEvent(composing) })
    // WebKit sends the key that ends a composition with keyCode 229.
    const committing = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    Object.defineProperty(committing, 'keyCode', { value: 229 })
    await act(() => { input.dispatchEvent(committing) })

    expect(composing.defaultPrevented).toBe(false)
    expect(committing.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
  })
})
