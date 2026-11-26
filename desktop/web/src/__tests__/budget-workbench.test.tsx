// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BudgetPanel } from '../components/panels/BudgetPanel'
import { setCurrentCanvasSession } from '../canvas/session'
import {
  designSessionFixture,
  currentDesign,
} from './support/design-session-state'
import { locale } from '../app/settings/state'
import { validateBudgetPriceDraft } from '../app/budget/workbench'
import { budgetPriceRequest, requestBudgetPrice } from '../app/budget/price-request'
import { readPlanningViewState } from '../app/planning-view/state'
import type { CanopiFile, PlacedPlant } from '../types/design'
import { speciesBudgetTarget } from '../target'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'

function makeDesign(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'Budget workbench test',
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

describe('Budget Item workbench', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    designSessionFixture.file = makeDesign()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({
        plants: [makePlant('Malus domestica', 'Apple')],
      }),
    }))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
  })

  it('parses locale decimals and zero prices without conflating them with an empty draft', () => {
    expect(validateBudgetPriceDraft('0')).toEqual({ valid: true, value: 0 })
    expect(validateBudgetPriceDraft('0.00')).toEqual({ valid: true, value: 0 })
    expect(validateBudgetPriceDraft('3,90', 'fr')).toEqual({ valid: true, value: 3.9 })
    expect(validateBudgetPriceDraft('3.90', 'fr')).toEqual({ valid: true, value: 3.9 })
    expect(validateBudgetPriceDraft('1 250,5', 'fr')).toEqual({ valid: true, value: 1250.5 })
    expect(validateBudgetPriceDraft('')).toEqual({ valid: false })
    expect(validateBudgetPriceDraft('  ')).toEqual({ valid: false })
    expect(validateBudgetPriceDraft('-2')).toEqual({ valid: false })
    expect(validateBudgetPriceDraft('3,90')).toEqual({ valid: false })
  })

  it('focuses a species’ unit cost when the right-click menu asks, showing its row through the filters', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({
        plants: [makePlant('Malus domestica', 'Apple'), makePlant('Pyrus communis', 'Pear')],
      }),
    }))
    await act(async () => { render(<BudgetPanel />, container) })
    const view = readPlanningViewState()
    await act(async () => { view.budgetSearch.value = 'Apple' })
    expect(rowNames()).toEqual(['Apple'])

    await act(async () => { requestBudgetPrice('Pyrus communis') })

    expect(budgetPriceRequest.value).toBeNull()
    expect(rowNames()).toEqual(['Apple', 'Pear'])
    expect(document.activeElement).toBe(priceInput('Pear'))
    await type(priceInput('Pear'), '12')
    await act(async () => {
      priceInput('Pear').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(currentDesign.value?.budget[0]).toMatchObject({ target: speciesBudgetTarget('Pyrus communis'), unit_cost: 12 })
  })

  it('labels each unit cost field and commits a zero price on blur', async () => {
    await act(async () => { render(<BudgetPanel />, container) })

    const input = priceInput('Apple')
    expect(input.value).toBe('')
    await act(async () => { input.focus() })
    await type(input, '0')
    await act(async () => { input.blur() })

    expect(currentDesign.value?.budget).toHaveLength(1)
    expect(currentDesign.value?.budget[0]).toMatchObject({
      target: speciesBudgetTarget('Malus domestica'),
      unit_cost: 0,
    })
    expect(currentDesign.value?.budget_currency).toBe('EUR')
    expect(priceInput('Apple').value).toBe('0.00')
    expect(container.textContent).toContain('€0.00')
  })

  it('shows and accepts locale decimals in French', async () => {
    locale.value = 'fr'
    designSessionFixture.file = makeDesign({
      budget: [{ target: speciesBudgetTarget('Malus domestica'), unit_cost: 3.9 }],
    })
    await act(async () => { render(<BudgetPanel />, container) })

    const input = priceInput('Apple')
    expect(input.value).toBe('3,90')
    await act(async () => { input.focus() })
    await type(input, '4,5')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

    expect(currentDesign.value?.budget[0]?.unit_cost).toBe(4.5)
    expect(priceInput('Apple').value).toBe('4,50')
  })

  it('keeps a price with more than two decimals when the field is only focused and left', async () => {
    designSessionFixture.file = makeDesign({
      budget: [{ target: speciesBudgetTarget('Malus domestica'), unit_cost: 0.125 }],
    })
    await act(async () => { render(<BudgetPanel />, container) })
    const designBefore = currentDesign.value

    const input = priceInput('Apple')
    expect(input.value).toBe('0.125')
    await act(async () => { input.focus() })
    await act(async () => { input.blur() })
    await act(async () => { priceInput('Apple').focus() })
    await act(async () => {
      priceInput('Apple').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(currentDesign.value?.budget[0]?.unit_cost).toBe(0.125)
    expect(currentDesign.value).toBe(designBefore)
  })

  it('keeps accepting typing in a still-focused field after Enter on the last row or Escape', async () => {
    await act(async () => { render(<BudgetPanel />, container) })
    const input = priceInput('Apple')
    await act(async () => { input.focus() })
    await type(input, '4.50')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(currentDesign.value?.budget[0]?.unit_cost).toBe(4.5)

    // Focus stays in the last row's field; a correction must still be taken.
    await type(priceInput('Apple'), '4.05')
    expect(priceInput('Apple').value).toBe('4.05')
    await act(async () => { priceInput('Apple').blur() })
    expect(currentDesign.value?.budget[0]?.unit_cost).toBe(4.05)

    await act(async () => { priceInput('Apple').focus() })
    await type(priceInput('Apple'), '9')
    await act(async () => { priceInput('Apple').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(priceInput('Apple').value).toBe('4.05')
    await type(priceInput('Apple'), '6')
    expect(priceInput('Apple').value).toBe('6')
    await act(async () => { priceInput('Apple').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(currentDesign.value?.budget[0]?.unit_cost).toBe(6)
  })

  it('rejects an invalid draft and lets Escape restore the saved price', async () => {
    await act(async () => { render(<BudgetPanel />, container) })
    const input = priceInput('Apple')

    await act(async () => { input.focus() })
    await type(input, '-2')
    await act(async () => { input.dispatchEvent(new FocusEvent('blur', { bubbles: true })) })
    expect(currentDesign.value?.budget).toEqual([])
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('nonnegative')
    expect(input.getAttribute('aria-invalid')).toBe('true')

    await type(input, '7')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    })
    expect(currentDesign.value?.budget).toEqual([])
    expect(priceInput('Apple').value).toBe('')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('moves to the next row after Enter and ignores the previous field blur', async () => {
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({
        plants: [
          makePlant('Malus domestica', 'Apple'),
          makePlant('Prunus avium', 'Cherry'),
        ],
      }),
    }))
    await act(async () => { render(<BudgetPanel />, container) })
    const apple = priceInput('Apple')
    await act(async () => { apple.focus() })
    await type(apple, '4')
    await act(async () => {
      apple.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(currentDesign.value?.budget).toHaveLength(1)
    expect(currentDesign.value?.budget[0]?.unit_cost).toBe(4)
    expect(document.activeElement).toBe(priceInput('Cherry'))
    await act(async () => { apple.dispatchEvent(new FocusEvent('blur', { bubbles: true })) })
    expect(currentDesign.value?.budget).toHaveLength(1)
  })

  it('finds rows by name or code, filters missing prices and follows the map selection', async () => {
    designSessionFixture.file = makeDesign({
      budget: [{ target: speciesBudgetTarget('Malus domestica'), unit_cost: 5 }],
    })
    const queries = createTestCanvasQuerySurface({
      plants: [
        makePlant('Malus domestica', 'Apple'),
        makePlant('Prunus avium', 'Cherry'),
      ],
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries }))
    await act(async () => { render(<BudgetPanel />, container) })
    expect(rowNames()).toEqual(['Apple', 'Cherry'])

    const finder = container.querySelector<HTMLInputElement>('input[type="search"]')!
    expect(finder.getAttribute('aria-keyshortcuts')).toBe('Control+F Meta+F')
    await type(finder, 'chery')
    expect(rowNames()).toEqual(['Cherry'])
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Showing results for cherry · 1 species · 1 plant')
    expect(container.querySelector('mark')?.textContent).toBe('Cherry')
    await type(finder, '')

    const missing = buttonNamed('Missing a price · 1')
    await act(async () => { missing.click() })
    expect(missing.getAttribute('aria-pressed')).toBe('true')
    expect(rowNames()).toEqual(['Cherry'])
    await act(async () => { missing.click() })

    const meter = container.querySelector<HTMLButtonElement>('button[aria-label^="1 of 2 species priced"]')!
    await act(async () => { meter.click() })
    expect(rowNames()).toEqual(['Cherry'])
    await act(async () => { meter.click() })

    const selected = buttonNamed('Selected on map')
    await act(async () => { selected.click() })
    expect(container.textContent).toContain('No species match these filters')
    await act(async () => {
      queries.setSelection([{ kind: 'plant', id: 'plant-Malus domestica' }])
      queries.bumpSceneRevision()
    })
    expect(rowNames()).toEqual(['Apple'])
    expect(buttonNamed('Selected on map · 1').getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('1 species · 1 plant selected on the map')
    expect(readPlanningViewState().budgetSelectedOnMap.value).toBe(true)
  })

  it('cancels a draft when another Design replaces the session', async () => {
    await act(async () => { render(<BudgetPanel />, container) })
    const staleInput = priceInput('Apple')
    await act(async () => { staleInput.focus() })
    await type(staleInput, '9')
    await act(async () => {
      designSessionFixture.file = makeDesign({ name: 'Replacement budget' })
    })
    await act(async () => {
      staleInput.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
    })

    expect(currentDesign.value?.name).toBe('Replacement budget')
    expect(currentDesign.value?.budget).toEqual([])
  })

  function priceInput(name: string): HTMLInputElement {
    return container.querySelector<HTMLInputElement>(`li input[aria-label$=" ${name}"]`)!
  }

  function rowNames(): string[] {
    return Array.from(container.querySelectorAll('li button strong')).map((node) => node.textContent ?? '')
  }

  function buttonNamed(name: string): HTMLButtonElement {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === name)!
  }

  async function type(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
})
