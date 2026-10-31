// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeciesCatalogWorkbench } from '../app/plant-browser/workbench'
import { createTestSpeciesCatalogWorkbench } from './support/species-catalog-workbench'
import type * as ActiveChipsModule from '../components/plant-db/ActiveChips'
import type * as SettingsStateModule from '../app/settings/state'
import type * as PlantBrowserModule from '../app/plant-browser'

describe('ActiveChips', () => {
  let container: HTMLDivElement
  let ActiveChips: typeof ActiveChipsModule.ActiveChips
  let locale: typeof SettingsStateModule.locale
  let workbench: SpeciesCatalogWorkbench

  beforeEach(async () => {
    vi.resetModules()
    const settings = await import('../app/settings/state')
    locale = settings.locale
    locale.value = 'en'
    workbench = await createTestSpeciesCatalogWorkbench({
      locale,
      loadDynamicFilterOptions: async (fields, loc) => fields.map((field) => ({
        field,
        field_type: 'categorical',
        values: [{
          value: 'Shrub',
          label: loc === 'fr' ? 'Arbuste' : 'Shrub',
        }],
        range: null,
      })),
    })
    vi.doMock('../app/plant-browser', async () => {
      const actual = await vi.importActual<typeof PlantBrowserModule>('../app/plant-browser')
      return {
        ...actual,
        speciesCatalogWorkbench: workbench,
      }
    })
    ;({ ActiveChips } = await import('../components/plant-db/ActiveChips'))

    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    workbench.clearFilters()
    workbench.addExtraFilter('growth_form_type', 'In', ['Shrub'])
    await workbench.loadDynamicOptions(['growth_form_type'])
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    workbench.dispose()
    vi.doUnmock('../app/plant-browser')
  })

  it('renders extra categorical chip values using the active locale cache', async () => {
    await act(async () => {
      render(<ActiveChips />, container)
    })

    expect(container.textContent).toContain('Growth form type: Shrub')

    await act(async () => {
      locale.value = 'fr'
      await workbench.loadDynamicOptions(['growth_form_type'])
    })

    expect(container.textContent).toContain('Type de forme')
    expect(container.textContent).toContain('Arbuste')
  })

  it('formats numeric dynamic filters as readable ranges', async () => {
    workbench.clearFilters()
    workbench.addExtraFilter('hardiness_zone_min', 'Between', ['5', '8'])

    await act(async () => {
      render(<ActiveChips />, container)
    })

    expect(container.textContent).toContain('Hardiness zone min: 5–8')
  })

  it('renders and dismisses life cycle chips through the catalog behavior registry', async () => {
    workbench.clearFilters()
    workbench.patchFilters({ life_cycle: ['Annual'] })

    await act(async () => {
      render(<ActiveChips />, container)
    })

    expect(container.textContent).toContain('Annual')

    const dismiss = Array.from(container.querySelectorAll('button')).find((button) => (
      button.getAttribute('aria-label')?.includes('Annual')
    ))
    expect(dismiss).toBeDefined()

    await act(async () => {
      dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(workbench.intent.value.filters.life_cycle).toBeNull()
  })

  it('renders fixed strip chips through catalog descriptors', async () => {
    workbench.clearFilters()
    workbench.patchFilters({
      woody: true,
      edibility_min: 3,
      nitrogen_fixer: true,
    })

    await act(async () => {
      render(<ActiveChips />, container)
    })

    expect(container.textContent).toContain('Woody')
    expect(container.textContent).toContain('Edibility: 3+')
    expect(container.textContent).toContain('N')
    expect(container.textContent).toContain('fixer')
  })
})
