// @vitest-environment jsdom

import { render } from 'preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PlantSymbolGlyph } from '../components/canvas/PlantSymbolGlyph'
import { PLANT_SYMBOL_IDS } from '../canvas/runtime/scene'
import { getPlantSymbolArt, plantSymbolPath } from '../canvas/runtime/plant-symbol-recipes'

describe('PlantSymbolGlyph', () => {
  let container: HTMLDivElement
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('draws every symbol from the shared recipe as one opaque currentColor body', () => {
    for (const symbol of PLANT_SYMBOL_IDS) {for (const size of [12, 32]) {
      render(<PlantSymbolGlyph symbol={symbol} size={size} />, container)
      const body = container.querySelector('svg > path')!
      expect(body.getAttribute('d'), symbol).toBe(plantSymbolPath(getPlantSymbolArt(symbol, size).body))
      expect(body.getAttribute('fill')).toBe('currentColor')
      expect(body.getAttribute('fill-opacity')).toBe('1')
      expect(body.getAttribute('fill-rule')).toBe('nonzero')
      expect(body.hasAttribute('fillOpacity')).toBe(false)
    }}
  })

  it('punches cut-outs as true holes by default', () => {
    render(<PlantSymbolGlyph symbol="flower" size={32} />, container)
    const mask = container.querySelector('mask')!
    const body = container.querySelector('svg > path')!
    expect(body.getAttribute('mask')).toBe(`url(#${mask.id})`)
    expect(mask.querySelector('path')?.getAttribute('d')).toBe(plantSymbolPath(getPlantSymbolArt('flower', 32).cutouts))
    expect(container.querySelectorAll('svg > path')).toHaveLength(1)
  })

  it('paints cut-outs in a given colour, as the map does with its outline colour', () => {
    render(<PlantSymbolGlyph symbol="bee" size={32} cutoutColor="#FFFFFF" />, container)
    const [body, cutouts] = [...container.querySelectorAll('svg > path')]
    expect(container.querySelector('mask')).toBeNull()
    expect(body!.hasAttribute('mask')).toBe(false)
    expect(cutouts!.getAttribute('fill')).toBe('#FFFFFF')
  })

  it('keeps sub-pixel cut-outs for the detail size only', () => {
    render(<PlantSymbolGlyph symbol="bamboo" size={12} />, container)
    expect(container.querySelector('mask')).toBeNull()
    render(<PlantSymbolGlyph symbol="bamboo" size={24} />, container)
    expect(container.querySelector('mask')).not.toBeNull()
  })
})
