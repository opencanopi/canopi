// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeciesCatalogWorkbench } from '../app/plant-browser/workbench'
import { createTestSpeciesCatalogWorkbench } from './support/species-catalog-workbench'
import type * as FilterStripModule from '../components/plant-db/FilterStrip'
import type * as SettingsStateModule from '../app/settings/state'
import type * as PlantBrowserModule from '../app/plant-browser'

describe('FilterStrip', () => {
  let container: HTMLDivElement
  let FilterStrip: typeof FilterStripModule.FilterStrip
  let locale: typeof SettingsStateModule.locale
  let workbench: SpeciesCatalogWorkbench

  beforeEach(async () => {
    vi.resetModules()
    const settings = await import('../app/settings/state')
    locale = settings.locale
    locale.value = 'en'
    workbench = await createTestSpeciesCatalogWorkbench({
      locale,
      getFilterOptions: async () => ({
        families: [],
        growth_rates: [],
        climate_zones: ['Temperate'],
        habits: ['Tree'],
        life_cycles: ['Annual'],
        sun_tolerances: ['full_sun'],
        soil_tolerances: [],
      }),
    })
    vi.doMock('../app/plant-browser', async () => {
      const actual = await vi.importActual<typeof PlantBrowserModule>('../app/plant-browser')
      return {
        ...actual,
        speciesCatalogWorkbench: workbench,
      }
    })
    ;({ FilterStrip } = await import('../components/plant-db/FilterStrip'))

    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    workbench.clearFilters()
    await workbench.loadFilterOptions()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    workbench.dispose()
    vi.doUnmock('../app/plant-browser')
  })

  it('renders life cycle as a catalog strip behavior and patches the fixed request field', async () => {
    await act(async () => {
      render(<FilterStrip onMoreFilters={vi.fn()} />, container)
    })

    expect(container.textContent).toContain('Life cycle')
    expect(container.textContent).toContain('Annual')

    const annualChip = Array.from(container.querySelectorAll('[role="button"]')).find((button) => (
      button.textContent === 'Annual'
    ))
    expect(annualChip).toBeDefined()

    await act(async () => {
      annualChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(workbench.intent.value.filters.life_cycle).toEqual(['Annual'])
  })
})
