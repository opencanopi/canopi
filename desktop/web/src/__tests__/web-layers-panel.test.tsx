// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebLayersPanel } from '../editions/web/WebLayersPanel'
import { createBrowserWorkspaceMapContributionAdapter } from '../editions/web/browser-workspace-map-contribution-adapter'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { locale } from '../app/settings/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
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

  function mount(siteData: CanopiFile['site_data']): void {
    const file: CanopiFile = {
      version: 10, name: 'Web', description: null, plant_species_colors: {}, plant_species_symbols: {},
      plant_species_codes: {}, layers: [], plants: [], zones: [], annotations: [], measurement_guides: [],
      consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR', created_at: '', updated_at: '',
      extra: {}, site_data: siteData,
    }
    replaceCurrentDesignState(file, null, 'Web')
    act(() => { render(<WebLayersPanel />, container) })
  }

  function entry(id: string, order: number) {
    return { id, name: id, visible: true, opacity: 1, order, ramp: null, reversed: false, range: null }
  }

  it('offers Contours, Relief, and Satellite/Street map/None in Map matching Web contributions, and no Site data row without site data (2.1-Q25, 2.1-Q45)', async () => {
    mount(null)
    expect(container.textContent).not.toContain('Site data')
    expect(container.textContent).toContain('Contour lines')
    expect(container.textContent).toContain('Hillshading')
    const map = container.querySelector('section[aria-labelledby="layers-map"]')!
    expect(Array.from(map.querySelectorAll('input[type="radio"]')).map((input) => (input as HTMLInputElement).value))
      .toEqual(['satellite', 'basemap', 'none'])
    // Every Web terrain row matches a live contribution that Web's adapter actually reads and draws.
    const adapter = createBrowserWorkspaceMapContributionAdapter()
    const runtime = createTestCanvasQuerySurface()
    expect(adapter.loadTerrainSupport).toBeTypeOf('function')
    expect(adapter.createRasterDisplay).toBeUndefined()
    expect(adapter.read(runtime)?.terrain.contoursVisible).toBe(false)
    expect(adapter.read(runtime)?.terrain.hillshadeVisible).toBe(false)
    const toggles = Array.from(map.querySelectorAll('button[aria-pressed]')) as HTMLButtonElement[]
    expect(toggles).toHaveLength(2)
    await act(() => { for (const toggle of toggles) toggle.click() })
    const after = adapter.read(runtime)
    expect(after?.terrain.contoursVisible).toBe(true)
    expect(after?.terrain.hillshadeVisible).toBe(true)
  })

  it('says how many terrain or height layers the Design keeps for Desktop, with no eye and no Site data button', () => {
    mount({ visible: true, entries: [entry('a', 0), entry('s', 1)] })
    const row = container.querySelector('section[aria-label="Site data"]')!
    expect(row.textContent).toBe('Site data2 terrain or height layers in this Design · Needs Canopi Desktop')
    expect(row.querySelector('button')).toBeNull()
    expect(container.querySelector('button[aria-label="Open Site data"]')).toBeNull()
  })

  it('uses the singular for one layer', () => {
    mount({ visible: true, entries: [entry('a', 0)] })
    expect(container.querySelector('section[aria-label="Site data"]')?.textContent)
      .toContain('1 terrain or height layer in this Design · Needs Canopi Desktop')
  })
})
