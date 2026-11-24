// @vitest-environment jsdom

import { render } from 'preact'
import { afterEach, describe, expect, it } from 'vitest'
import { GALLERY_SURFACES, parseGallerySurface } from '../editions/gallery/surface-routing'
import { PlantSymbolSheet } from '../editions/gallery/PlantSymbolSheet'
import { designFixture } from '../editions/gallery/fixtures'
import { PLANT_SYMBOL_IDS } from '../canvas/runtime/scene'
import { PLANT_SYMBOL_FAMILIES } from '../canvas/runtime/plant-symbol-recipes'

describe('UI gallery plant symbol review', () => {
  let container: HTMLDivElement | null = null
  afterEach(() => {
    if (container) render(null, container)
    container?.remove()
    container = null
  })

  it('routes the symbol sheet as a review surface', () => {
    expect(GALLERY_SURFACES.symbols).toBe('Symbol sheet')
    expect(parseGallerySurface('symbols')).toBe('symbols')
  })

  it('shows every symbol by family with its localized name at every review size', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    render(<PlantSymbolSheet />, container)
    const families = [...container.querySelectorAll('[data-symbol-family]')]
    expect(families.map((family) => family.getAttribute('data-symbol-family'))).toEqual(Object.keys(PLANT_SYMBOL_FAMILIES))
    const cells = [...container.querySelectorAll('figure[data-symbol]')]
    expect(cells.map((cell) => cell.getAttribute('data-symbol'))).toEqual([...PLANT_SYMBOL_IDS])
    expect(container.querySelector('figure[data-symbol="pod"] figcaption')?.textContent).toBe('Nitrogen fixer')
    for (const cell of cells) {
      expect([...cell.querySelectorAll('svg')].map((svg) => svg.getAttribute('width'))).toEqual(['48', '24', '16', '12', '16', '12'])
    }
  })

  it('offers a dense planting of all 29 designed symbols for the live canvas', () => {
    const planting = designFixture('planting')
    const symbols = new Set(planting.plants.map((plant) => plant.symbol))
    expect([...symbols].sort()).toEqual(PLANT_SYMBOL_IDS.slice(0, 29).sort())
    expect(planting.plants.length).toBeGreaterThanOrEqual(29 * 8)
  })
})
