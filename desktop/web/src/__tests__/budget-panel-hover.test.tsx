// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BudgetPanel } from '../components/panels/BudgetPanel'
import { setCurrentCanvasSession } from '../canvas/session'
import { locale } from '../app/settings/state'
import { hoveredPanelTargets } from '../app/panel-targets/state'
import { designSessionFixture } from './support/design-session-state'
import { speciesBudgetTarget } from '../target'
import type { CanopiFile, PlacedPlant } from '../types/design'
import {
  createTestCanvasQuerySurface,
  type TestCanvasQuerySurface,
} from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createDefaultScenePersistedState, type ScenePersistedState } from '../canvas/runtime/scene'

function makeDesign(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'Budget hover test',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    extra: {},
    created_at: '2026-04-08T00:00:00.000Z',
    updated_at: '2026-04-08T00:00:00.000Z',
    ...overrides,
  }
}

function makePlant(canonicalName: string, commonName: string): PlacedPlant {
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

function sceneWithApple(): ScenePersistedState {
  return {
    ...createDefaultScenePersistedState(),
    plants: [{
      kind: 'plant',
      id: 'apple',
      locked: false,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#3E8E4E',
      canopySpreadM: null,
      position: { x: 0, y: 0 },
      rotationDeg: null,
      notes: null,
      plantedDate: null,
      quantity: 1,
    }],
  }
}

describe('BudgetPanel hover bridge', () => {
  let container: HTMLDivElement
  let querySurface: TestCanvasQuerySurface

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    hoveredPanelTargets.value = []
    designSessionFixture.file = makeDesign({
      budget_currency: 'EUR',
      budget: [
        {
          target: speciesBudgetTarget('Malus domestica'),
          unit_cost: 5,
        },
      ],
    })
    querySurface = createTestCanvasQuerySurface({
      plants: [makePlant('Malus domestica', 'Apple')],
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: querySurface }))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
    hoveredPanelTargets.value = []
  })

  it('emits and clears hovered panel targets for budget rows', async () => {
    await act(async () => {
      render(<BudgetPanel />, container)
    })

    const row = container.querySelector('li')
    expect(row).not.toBeNull()

    await act(async () => {
      row!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    })
    expect(hoveredPanelTargets.value).toEqual([speciesBudgetTarget('Malus domestica')])

    await act(async () => {
      row!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    })
    expect(hoveredPanelTargets.value).toEqual([])
  })

  it('draws each row glyph in the colour the map draws it with', async () => {
    designSessionFixture.file = {
      ...makeDesign(),
      extra: { plant_display: { color_by: 'one_color', one_color: '#AA3355' } },
    }
    querySurface = createTestCanvasQuerySurface({ scene: sceneWithApple(), plants: [makePlant('Malus domestica', 'Apple')] })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: querySurface }))
    await act(async () => {
      render(<BudgetPanel />, container)
    })

    const glyph = container.querySelector<HTMLElement>('li [aria-hidden="true"] > span[style]')
    expect(glyph?.style.color).toBe('rgb(170, 51, 85)')
  })

  it('refreshes localized species names when switching to a cached locale', async () => {
    querySurface = createTestCanvasQuerySurface({
      plants: [makePlant('Malus domestica', 'Fallback Apple')],
      localizedNames: new Map([
        ['Malus domestica', locale.value === 'fr' ? 'Pommier' : 'Apple'],
      ]),
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: querySurface }))

    await act(async () => {
      render(<BudgetPanel />, container)
    })

    expect(container.textContent).toContain('Apple')

    await act(async () => {
      locale.value = 'fr'
      querySurface.setLocalizedNames(new Map([
        ['Malus domestica', 'Pommier'],
      ]))
    })

    expect(container.textContent).toContain('Pommier')
    expect(container.textContent).not.toContain('Apple')
  })

  it('marks the English catalog name of a species with no name in the UI language', async () => {
    locale.value = 'fr'
    querySurface = createTestCanvasQuerySurface({
      plants: [makePlant('Malus domestica', 'Pommier stocké')],
      localizedNames: new Map([['Malus domestica', null]]),
      englishFallbackNames: new Map([['Malus domestica', 'Apple']]),
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: querySurface }))

    await act(async () => {
      render(<BudgetPanel />, container)
    })

    const row = container.querySelector('li')!
    expect(row.querySelector('[lang="en"]')?.textContent).toBe('Apple')
    expect(row.querySelector('strong [aria-hidden="true"]')?.textContent).toBe('(angl.)')
    expect(row.textContent).not.toContain('Pommier stocké')

    await act(async () => {
      locale.value = 'en'
      querySurface.setLocalizedNames(new Map([['Malus domestica', 'Apple']]))
      querySurface.setEnglishFallbackNames(new Map())
      querySurface.bumpPlantNamesRevision()
    })
    expect(container.querySelector('li [lang="en"]')).toBeNull()
    expect(container.textContent).not.toContain('(en)')
  })
})
