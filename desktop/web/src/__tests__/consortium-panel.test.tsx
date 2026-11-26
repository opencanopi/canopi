// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConsortiumPanel } from '../components/panels/ConsortiumPanel'
import { disposePlanningViewState } from '../app/planning-view/state'
import { locale } from '../app/settings/state'
import { sidePanel } from '../app/shell/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { consortiumTarget } from '../target'
import type { CanopiFile, PlacedPlant } from '../types/design'
import { designSessionFixture } from './support/design-session-state'
import { createTestCanvasQuerySurface, type TestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'

function plant(canonicalName: string, commonName: string): PlacedPlant {
  return {
    id: `plant-${canonicalName}`,
    canonical_name: canonicalName,
    common_name: commonName,
    color: null,
    position: { lon: 13, lat: 23 },
    rotation: null,
    canopy_spread_m: null,
    notes: null,
    planted_date: null,
    quantity: 1,
    locked: false,
  }
}

function design(): CanopiFile {
  return {
    version: 7,
    name: 'Consortium panel',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [
      { target: consortiumTarget('Malus domestica'), stratum: 'high', start_phase: 3, end_phase: 6 },
      { target: consortiumTarget('Malus sylvestris'), stratum: 'high', start_phase: 3, end_phase: 4 },
      { target: consortiumTarget('Mentha spicata'), stratum: 'low', start_phase: 0, end_phase: 2 },
      { target: consortiumTarget('Symphytum officinale'), stratum: 'unassigned', start_phase: 0, end_phase: 2 },
    ],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    extra: {},
    created_at: '',
    updated_at: '',
  }
}

describe('Consortium panel', () => {
  let container: HTMLDivElement
  let queries: TestCanvasQuerySurface

  beforeEach(() => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.appendChild(container)
    disposePlanningViewState()
    designSessionFixture.file = design()
    queries = createTestCanvasQuerySurface({
      plants: [
        plant('Malus domestica', 'Pommier cultivé'),
        plant('Malus sylvestris', 'Pommier sauvage'),
        plant('Mentha spicata', 'Menthe verte'),
        plant('Symphytum officinale', 'Consoude officinale'),
      ],
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries }))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
    sidePanel.value = null
  })

  it('shows a stratum × phase table with row and column headers and full phase names', async () => {
    await act(async () => { render(<ConsortiumPanel />, container) })
    const table = container.querySelector('table')!
    expect(table.querySelector('caption')?.textContent).toBe('Species per stratum and succession phase')
    expect([...table.querySelectorAll('th[scope="colgroup"]')].map((th) => th.textContent)).toEqual(['Placenta', 'Secondary', 'Climax'])
    expect([...table.querySelectorAll('tbody th[scope="row"]')].map((th) => th.textContent)).toEqual(['Emergent', 'High', 'Mid', 'Low'])
    const cell = table.querySelector('button[aria-label^="High stratum, Secondary 1"]')!
    expect(cell.getAttribute('aria-label')).toBe('High stratum, Secondary 1 (3–15 years): 2 species')
    expect(container.textContent).toContain('4 species')
  })

  it('keeps the plant finder above the scrolling matrix, like Plants and Budget', async () => {
    await act(async () => { render(<ConsortiumPanel />, container) })
    const finder = container.querySelector('input[type="search"], input[role="searchbox"], input')!
    const table = container.querySelector('table')!
    const scroller = [...container.querySelectorAll('div')].find((div) => div.contains(table) && getComputedStyle(div).overflowY === 'auto')
      ?? table.closest('[class*="scroll"]')!
    expect(scroller.contains(table)).toBe(true)
    expect(scroller.contains(finder)).toBe(false)
  })

  it('marks every cell holding a finder match and lists the matches', async () => {
    await act(async () => { render(<ConsortiumPanel />, container) })
    await search('pomier sauvage')

    const dotted = [...container.querySelectorAll('button[aria-label]')]
      .filter((button) => button.querySelector('[data-match-dot]'))
      .map((button) => button.getAttribute('aria-label'))
    expect(dotted).toEqual([
      'High stratum, Secondary 1 (3–15 years): 2 species, includes a match',
      'High stratum, Secondary 2 (15–25 years): 2 species, includes a match',
    ])
    expect(container.querySelector('p[role="status"]')?.textContent)
      .toBe('Showing results for pommier sauvage · 1 species · found in 2 cells, marked with a dot')
    expect(container.textContent).toContain('Matching “pommier sauvage” · 1 species')
    expect(rowNames()).toEqual(['Pommier sauvage'])
    expect(container.textContent).toContain('Secondary 1 → Secondary 2')

    await act(async () => buttonNamed('Clear').click())
    // Unfiltered, only the first stratum group starts open.
    expect(rowNames()).toEqual(['Pommier cultivé', 'Pommier sauvage'])
    expect(container.querySelector('[data-match-dot]')).toBeNull()
  })

  it('links the species without a stratum and follows the map selection', async () => {
    await act(async () => { render(<ConsortiumPanel />, container) })
    await act(async () => buttonNamed('1 has no stratum yet').click())
    expect(rowNames()).toEqual(['Consoude officinale'])
    await act(async () => buttonNamed('1 has no stratum yet').click())

    await act(async () => buttonNamed('Selected on map').click())
    await act(async () => {
      queries.setSelection([{ kind: 'plant', id: 'plant-Mentha spicata' }])
      queries.bumpSceneRevision()
    })
    expect(rowNames()).toEqual(['Menthe verte'])
    expect(container.querySelectorAll('[data-match-dot]')).toHaveLength(3)
  })

  it('draws each row glyph in the colour the map draws it with', async () => {
    designSessionFixture.file = { ...design(), extra: { plant_display: { color_by: 'stratum' } } }
    const scene = createDefaultScenePersistedState()
    scene.plants = [{
      kind: 'plant',
      id: 'plant-Malus domestica',
      locked: false,
      canonicalName: 'Malus domestica',
      commonName: 'Pommier cultivé',
      color: '#3E8E4E',
      canopySpreadM: null,
      position: { x: 0, y: 0 },
      rotationDeg: null,
      notes: null,
      plantedDate: null,
      quantity: 1,
    }]
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ scene, plants: [plant('Malus domestica', 'Pommier cultivé')] }),
    }))
    await act(async () => { render(<ConsortiumPanel />, container) })

    const glyph = container.querySelector<HTMLElement>('article [aria-hidden="true"] > span[style]')
    // Colour by stratum: the High stratum's colour, not the stored species colour.
    expect(glyph?.style.color).toBe('rgb(0, 158, 115)')
  })

  it('shows the empty state without plants', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: createTestCanvasQuerySurface() }))
    await act(async () => { render(<ConsortiumPanel />, container) })
    expect(container.textContent).toContain('Place plants to see which strata and succession phases your Design covers.')
    await act(async () => buttonNamed('Open plant catalog').click())
    expect(sidePanel.value).toBe('plant-db')
  })

  async function search(value: string): Promise<void> {
    await act(async () => {
      const field = container.querySelector<HTMLInputElement>('input[type="search"]')!
      field.value = value
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function rowNames(): string[] {
    return [...container.querySelectorAll('article button[aria-pressed] strong')].map((node) => node.textContent ?? '')
  }

  function buttonNamed(name: string): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === name)!
  }
})
