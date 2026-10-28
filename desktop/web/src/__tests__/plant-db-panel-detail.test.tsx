// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const workbench = vi.hoisted(() => ({ selected: null as unknown as { value: string | null } }))
vi.mock('../app/plant-browser', async () => {
  const { signal: makeSignal } = await import('@preact/signals')
  workbench.selected = makeSignal<string | null>(null)
  return { speciesCatalogWorkbench: { selectedCanonicalName: workbench.selected, mount: () => () => {} } }
})
vi.mock('../components/plant-db/CatalogBrowser', () => ({ CatalogBrowser: () => <div data-testid="catalog-list" /> }))
vi.mock('../components/plant-db/MoreFiltersPanel', () => ({ MoreFiltersPanel: () => null }))
vi.mock('../components/plant-detail/PlantDetailCard', () => ({ PlantDetailCard: () => <div data-testid="species-detail" /> }))
vi.mock('../components/plant-db/favorite-species-presentation', () => ({ useFavoriteSpeciesDetailNavigation: () => {} }))

import { PlantDbPanel } from '../components/panels/PlantDbPanel'

let container: HTMLDivElement | null = null
afterEach(() => {
  if (container) render(null, container)
  container?.remove()
  container = null
  workbench.selected.value = null
})

describe('the Desktop Plant catalog shows a species detail in place of the list', () => {
  it('hides the list with the hidden attribute while a detail is open and keeps it mounted', async () => {
    container = document.createElement('div')
    document.body.append(container)
    await act(async () => { render(<PlantDbPanel />, container!) })
    const list = () => container!.querySelector('[data-testid="catalog-list"]')!.parentElement!
    expect(list().hidden).toBe(false)

    await act(async () => { workbench.selected.value = 'Corylus avellana' })
    expect(container.querySelector('[data-testid="species-detail"]')).not.toBeNull()
    expect(list().hidden).toBe(true)
    expect(list().hasAttribute('inert')).toBe(true)

    await act(async () => { workbench.selected.value = null })
    expect(list().hidden).toBe(false)
  })

  it('keeps a hidden list laid out but invisible, in its own stylesheet, so Back finds its row', () => {
    // display:none would collapse the virtualised list and drop the row Back returns to.
    for (const sheet of ['../components/plant-db/PlantDb.module.css', '../web/WebSpeciesCatalogPanel.module.css']) {
      const css = readFileSync(new URL(sheet, import.meta.url), 'utf8')
      const hiddenRules = [...css.matchAll(/\.main\[hidden\]\s*\{([^}]*)\}/g)].map((match) => match[1]!)
      expect(hiddenRules.length, sheet).toBeGreaterThan(0)
      for (const rule of hiddenRules) {
        expect(rule, sheet).toMatch(/visibility:\s*hidden/)
        expect(rule, sheet).not.toMatch(/display:\s*none/)
      }
    }
  })
})
