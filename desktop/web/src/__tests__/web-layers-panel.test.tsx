// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebLayersPanel } from '../editions/web/WebLayersPanel'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { locale } from '../app/settings/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { replaceCurrentDesignState } from './support/design-session-state'
import type { CanopiFile } from '../types/design'

describe('Web Layers', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    locale.value = 'en'
    mapLayers.value = createDefaultMapLayers()
    setCurrentCanvasSession(null)
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  function mount(lidar: CanopiFile['lidar']): void {
    const file: CanopiFile = {
      version: 9, name: 'Web', description: null, plant_species_colors: {}, plant_species_symbols: {},
      plant_species_codes: {}, layers: [], plants: [], zones: [], annotations: [], measurement_guides: [],
      consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR', created_at: '', updated_at: '',
      extra: {}, lidar,
    }
    replaceCurrentDesignState(file, null, 'Web')
    act(() => { render(<WebLayersPanel />, container) })
  }

  function entry(id: string, kind: 'Source' | 'Derived', order: number) {
    return { kind, id, name: id, visible: true, opacity: 1, order, ramp: null, reversed: false, range: null }
  }

  it('offers Satellite, Street map or None in Map, and no Site data row without site data', () => {
    mount(null)
    expect(container.textContent).not.toContain('Site data')
    expect(container.textContent).not.toContain('Contour lines')
    expect(container.textContent).not.toContain('Hillshading')
    expect(container.querySelector('button[aria-haspopup="menu"]')).toBeNull()
    const map = container.querySelector('section[aria-labelledby="layers-map"]')!
    expect(Array.from(map.querySelectorAll('input[type="radio"]')).map((input) => (input as HTMLInputElement).value))
      .toEqual(['satellite', 'basemap', 'none'])
  })

  it('says how many terrain or height layers the Design keeps for Desktop, with no eye and no Site data button', () => {
    mount({ visible: true, entries: [entry('a', 'Source', 0), entry('s', 'Derived', 1)] })
    const row = container.querySelector('section[aria-label="Site data"]')!
    expect(row.textContent).toBe('Site data2 terrain or height layers in this Design · Needs Canopi Desktop')
    expect(row.querySelector('button')).toBeNull()
    expect(container.querySelector('button[aria-label="Open Site data"]')).toBeNull()
  })

  it('uses the singular for one layer', () => {
    mount({ visible: true, entries: [entry('a', 'Source', 0)] })
    expect(container.querySelector('section[aria-label="Site data"]')?.textContent)
      .toContain('1 terrain or height layer in this Design · Needs Canopi Desktop')
  })
})
