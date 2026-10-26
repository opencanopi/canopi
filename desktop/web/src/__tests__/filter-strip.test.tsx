// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeciesCatalogWorkbench } from '../app/plant-browser/workbench'
import { createTestSpeciesCatalogWorkbench } from './support/species-catalog-workbench'
import type * as FilterStripModule from '../components/plant-db/FilterStrip'
import type * as SettingsStateModule from '../app/settings/state'
import type * as PlantBrowserModule from '../app/plant-browser'

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

function cssRule(source: string, selector: string): string {
  const match = new RegExp(`${selector.replace('.', '\\.')}\\s*{([^}]*)}`, 's').exec(source)
  expect(match, `${selector} rule should exist`).not.toBeNull()
  return match?.[1] ?? ''
}

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

describe('Species Catalog filter region layout', () => {
  it('lets always-visible choice rows reserve wrapped ribbon height in normal flow', () => {
    const panelSource = readSource('../components/plant-db/CatalogBrowser.tsx')
    const stripSource = readSource('../components/plant-db/FilterStrip.tsx')
    const css = readSource('../components/plant-db/PlantDb.module.css')
    const moreFiltersCss = readSource('../components/plant-db/MoreFiltersPanel.module.css')
    const filterRegionRule = cssRule(css, '.filterRegion')
    const filterStripRule = cssRule(css, '.filterStrip')
    const filterRowRule = cssRule(css, '.filterRow')
    const filterControlRule = cssRule(css, '.filterControl')
    const filterChoiceControlRule = cssRule(css, '.filterChoiceControl')
    const filterActionsRule = cssRule(css, '.filterActions')
    const chipGridRule = cssRule(moreFiltersCss, '.chipGrid')

    expect(panelSource).toContain('className={styles.filterRegion}')
    expect(panelSource.indexOf('<FilterStrip')).toBeLessThan(panelSource.indexOf('<ActiveChips'))

    expect(stripSource).toContain('styles.filterChoiceControl')
    expect(stripSource).not.toContain('styles.filterChoiceChip')
    expect(chipGridRule).toMatch(/display:\s*flex;/)
    expect(chipGridRule).toMatch(/flex-wrap:\s*wrap;/)
    expect(chipGridRule).toMatch(/gap:\s*var\(--space-0-75\);/)
    expect(filterStripRule).toMatch(/display:\s*flex;/)
    expect(filterStripRule).toMatch(/flex-direction:\s*column;/)
    expect(filterStripRule).not.toMatch(/grid-template-columns:/)
    expect(filterRowRule).toMatch(/display:\s*flex;/)
    expect(filterRowRule).not.toMatch(/display:\s*grid;/)
    expect(filterRowRule).not.toMatch(/display:\s*contents;/)
    expect(filterRowRule).not.toMatch(/grid-template-columns:/)
    expect(filterControlRule).toMatch(/flex:\s*1 1 0;/)
    expect(filterControlRule).toMatch(/display:\s*flex;/)
    expect(filterControlRule).toMatch(/flex-wrap:\s*wrap;/)
    expect(filterChoiceControlRule).toMatch(/display:\s*flex;/)
    expect(filterChoiceControlRule).toMatch(/flex-wrap:\s*wrap;/)
    expect(filterChoiceControlRule).toMatch(/gap:\s*var\(--space-0-75\);/)
    expect(filterChoiceControlRule).not.toMatch(/grid-template-columns:/)
    expect(css).not.toContain('.filterChoiceChip')
    expect(filterRegionRule).toMatch(/max-height:\s*min\(45vh,\s*360px\);/)
    expect(filterRegionRule).toMatch(/overflow-y:\s*auto;/)
    expect(filterStripRule).not.toMatch(/max-height:/)
    expect(filterControlRule).not.toMatch(/overflow:\s*(visible|hidden);/)
    expect(filterActionsRule).not.toMatch(/grid-column:/)
  })
})
