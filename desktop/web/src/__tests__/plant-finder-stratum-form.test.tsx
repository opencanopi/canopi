// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { speciesCatalogWorkbench } from '../app/plant-browser'
import { disposePlanningViewState } from '../app/planning-view/state'
import { locale } from '../app/settings/state'
import { sidePanel } from '../app/shell/state'
import { BudgetPanel } from '../components/panels/BudgetPanel'
import { ConsortiumPanel } from '../components/panels/ConsortiumPanel'
import { SpeciesKeyPanel } from '../components/panels/SpeciesKeyPanel'
import { SceneStore } from '../canvas/runtime/scene/store'
import { setCurrentCanvasSession } from '../canvas/session'
import { consortiumTarget } from '../target'
import type { CanopiFile, PlacedPlant } from '../types/design'
import { designSessionFixture } from './support/design-session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'

// Stratum comes from the Design's Consortium; form from the catalog habit.
const SPECIES = [
  { canonicalName: 'Malus domestica', commonName: 'Apple', plants: 2, habit: 'Tree', stratum: 'high' },
  { canonicalName: 'Malus sylvestris', commonName: 'Crab apple', plants: 1, habit: 'Tree', stratum: 'high' },
  { canonicalName: 'Mentha spicata', commonName: 'Mint', plants: 1, habit: 'Herbaceous', stratum: 'low' },
  { canonicalName: 'Vitis vinifera', commonName: 'Grape', plants: 1, habit: 'Climber', stratum: null },
  { canonicalName: 'Symphytum officinale', commonName: 'Comfrey', plants: 1, habit: null, stratum: 'unassigned' },
] as const

const placedPlants: PlacedPlant[] = SPECIES.flatMap((species) => Array.from({ length: species.plants }, (_, index) => ({
  id: `${species.canonicalName}-${index}`,
  canonical_name: species.canonicalName,
  common_name: species.commonName,
  color: null,
  position: { lon: 13, lat: 23 },
  rotation: null,
  scale: null,
  notes: null,
  planted_date: null,
  quantity: 1,
  locked: false,
})))

function design(): CanopiFile {
  return {
    version: 9,
    name: 'Stratum and form',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: SPECIES.flatMap((species) => species.stratum
      ? [{ target: consortiumTarget(species.canonicalName), stratum: species.stratum, start_phase: 0, end_phase: 2 }]
      : []),
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    extra: {},
    created_at: '',
    updated_at: '',
  }
}

describe('Plant finder Stratum and Form quick filters in panels', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.appendChild(container)
    disposePlanningViewState()
    designSessionFixture.file = design()
    vi.spyOn(speciesCatalogWorkbench, 'resolveHabits').mockImplementation(async (names) => Object.fromEntries(
      SPECIES.filter((species) => species.habit && names.includes(species.canonicalName))
        .map((species) => [species.canonicalName, species.habit!]),
    ))
    const store = new SceneStore()
    store.updatePersisted((draft) => {
      draft.plants = placedPlants.map((plant, index) => ({
        id: plant.id,
        canonicalName: plant.canonical_name,
        commonName: plant.common_name,
        kind: 'plant',
        locked: false,
        color: '#3e8e4e',
        position: { x: index * 5, y: 0 },
        stratum: null,
        canopySpreadM: null,
        rotationDeg: 0,
        notes: null,
        plantedDate: null,
        quantity: 1,
      }))
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ scene: store.persisted, plants: placedPlants }),
    }))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
    sidePanel.value = null
    disposePlanningViewState()
    vi.restoreAllMocks()
  })

  async function show(panel: preact.JSX.Element): Promise<void> {
    await act(async () => { render(panel, container) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }

  function menu(label: string): HTMLButtonElement {
    const trigger = [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button[aria-haspopup="listbox"]')]
      .find((button) => button.textContent?.startsWith(label))
    if (!trigger) throw new Error(`Missing ${label} menu`)
    return trigger
  }

  async function options(label: string): Promise<string[]> {
    await act(() => menu(label).click())
    return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent ?? '')
  }

  async function choose(label: string, option: string): Promise<void> {
    if (menu(label).getAttribute('aria-expanded') !== 'true') await act(() => menu(label).click())
    const found = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) => candidate.textContent === option)
    if (!found) throw new Error(`Missing option ${option}`)
    await act(() => found.click())
  }

  const status = () => container.querySelector('p[role="status"]')?.textContent ?? ''
  const rowNames = () => [...container.querySelectorAll('li')].map((row) => row.querySelector('strong')?.textContent)

  // The habits exist only in the spied catalog workbench (the Design holds none), so the Form options and counts show
  // the form is the catalog habit; the workbench is not asked when an earlier test of this file already loaded them.
  it('filters Plants in this Design by Design stratum and catalog form, with counts', async () => {
    await show(<SpeciesKeyPanel />)
    expect(await options('Stratum')).toEqual(['All strata', 'High · 2', 'Low · 1', 'No stratum yet · 2'])
    await choose('Stratum', 'High · 2')
    expect(rowNames()).toEqual(['Apple', 'Crab apple'])
    expect(status()).toBe('2 species · 3 plants')
    expect(menu('Stratum').querySelector('[aria-hidden="true"]')?.textContent).toBe('Stratum: High')
    expect(menu('Stratum').className).toMatch(/menuChipActive/)

    await choose('Stratum', 'All strata')
    expect(await options('Form')).toEqual(['All forms', 'Tree · 2', 'Herbaceous · 1', 'Climber · 1', 'Not recorded · 1'])
    await choose('Form', 'Not recorded · 1')
    expect(rowNames()).toEqual(['Comfrey'])
  })

  it('keeps a chosen filter visible and clearable when the list no longer holds it', async () => {
    const { readPlanningViewState } = await import('../app/planning-view/state')
    readPlanningViewState().plantsQuickFilters.value = { stratum: 'emergent', form: null }
    await show(<SpeciesKeyPanel />)
    expect(menu('Stratum').querySelector('[aria-hidden="true"]')?.textContent).toBe('Stratum: Emergent')
    expect(container.textContent).toContain('No plants match these filters.')
    await act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Clear filters')!.click())
    expect(rowNames()).toHaveLength(5)
  })

  it('narrows Budget to a stratum and a form together', async () => {
    await show(<BudgetPanel />)
    await choose('Stratum', 'No stratum yet · 2')
    await choose('Form', 'Climber · 1')
    expect(rowNames()).toEqual(['Grape'])
    expect(status()).toBe('1 species · 1 plant')
  })

  it('narrows the Consortium list to a form', async () => {
    await show(<ConsortiumPanel />)
    expect(await options('Stratum')).toContain('High · 2')
    await choose('Form', 'Tree · 2')
    const names = [...container.querySelectorAll('article button[aria-pressed] strong')].map((node) => node.textContent)
    expect(names).toEqual(['Apple', 'Crab apple'])
    // Cells holding a filtered species carry the match dot.
    expect(container.querySelectorAll('[data-match-dot]').length).toBeGreaterThan(0)
  })
})
