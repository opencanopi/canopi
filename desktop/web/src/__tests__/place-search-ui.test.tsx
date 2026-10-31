// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => vi.fn(async () => [] as unknown))
vi.mock('#geocoding-transport', () => ({ geocodingTransport: transport }))

import { PLACE_SEARCH_ZOOM, requestPlaceSearchFocus } from '../app/geocoding/place-search-ui'
import { resetPlaceSearchPacingForTests } from '../app/geocoding/place-search'
import { installPlaceSearchSession, placeSearch } from '../app/geocoding/place-search-session'
import { designSessionStore } from '../app/document-session/store'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { locale } from '../app/settings/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { sidePanel } from '../app/shell/state'
import { PlaceSearchField } from '../components/canvas/PlaceSearch'
import { SiteOnboarding } from '../components/canvas/SiteOnboarding'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { beforePaint, holdAfterPaint } from './support/before-paint'

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Place search field', () => {
  let container: HTMLDivElement
  const showPlace = vi.fn(() => true)

  beforeEach(() => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.appendChild(container)
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ viewport: { showPlace } }),
    }))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
    placeSearch.clear()
    showPlace.mockClear()
    transport.mockReset()
    transport.mockImplementation(async () => [])
    resetPlaceSearchPacingForTests()
    // An open empty Draft asks "Where is your site?" in place of this field; the next test opens its own.
    designSessionStore.clearCurrentDesign()
  })

  const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!
  const options = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')]

  async function type(text: string) {
    await act(async () => {
      input().focus()
      input().value = text
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function key(name: string) {
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
      await flush()
    })
  }

  it('is a combobox in the title bar that Ctrl K focuses', async () => {
    await act(async () => { render(<PlaceSearchField />, container) })
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().getAttribute('aria-controls')).toBe(container.querySelector('[role="listbox"]')!.id)
    expect(input().getAttribute('aria-keyshortcuts')).toBe('Control+K Meta+K')
    expect(input().placeholder).toBe('Place or coordinates')

    await act(async () => { requestPlaceSearchFocus() })
    expect(document.activeElement).toBe(input())
  })

  it('offers a coordinate row only while the text reads as coordinates, and Enter goes straight there', async () => {
    await act(async () => { render(<PlaceSearchField />, container) })
    await type('Ballon')
    expect(options()).toHaveLength(0)

    await type('48.2201, 0.0351')
    expect(options().map((option) => option.textContent)).toEqual(['48.2201° N, 0.0351° ECoordinates · go straight there'])
    expect(transport).not.toHaveBeenCalled()

    await key('Enter')
    expect(showPlace).toHaveBeenCalledWith(expect.objectContaining({ lat: 48.2201, lon: 0.0351 }), PLACE_SEARCH_ZOOM)
    expect(input().value).toBe('')
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('writes the coordinate row in the locale\'s digits: French reads a decimal comma', async () => {
    await act(async () => { locale.value = 'fr'; await flush() })
    await act(async () => { render(<PlaceSearchField />, container) })
    await type('48.2201, 0.0351')

    expect(options()[0]?.textContent).toBe('48,2201° N, 0,0351° ECoordonnées · y aller directement')
  })

  it('searches on Enter only, shows short labels with their locality, and closes on pick', async () => {
    transport.mockImplementation(async () => [
      { lat: '48.22', lon: '0.035', display_name: 'Ballon-Saint-Mars, Mamers, Sarthe, Pays de la Loire, France métropolitaine, 72290, France' },
      { lat: '48.17', lon: '0.23', display_name: 'Ballon, Le Mans, Sarthe, Pays de la Loire, France' },
    ])
    await act(async () => { render(<PlaceSearchField />, container) })
    await type('Ballon')
    expect(transport).not.toHaveBeenCalled()

    await key('Enter')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(options().map((option) => option.textContent)).toEqual([
      'Ballon-Saint-MarsSarthe, Pays de la Loire, France',
      'BallonSarthe, Pays de la Loire, France',
    ])
    expect(container.textContent).toContain('OpenStreetMap')

    await key('ArrowDown')
    await key('ArrowDown')
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]!.id)
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')

    await key('Enter')
    expect(showPlace).toHaveBeenCalledWith(expect.objectContaining({ lat: 48.17, lon: 0.23 }), PLACE_SEARCH_ZOOM)
    expect(input().value).toBe('')
    expect(options()).toHaveLength(0)
    expect(placeSearch.results.value).toEqual([])
  })

  it('clears the field and its results on Escape, so a new search never appends to the old one', async () => {
    transport.mockImplementation(async () => [{ lat: '48.85', lon: '2.29', display_name: 'Eiffel Tower, Paris, France' }])
    await act(async () => { render(<PlaceSearchField />, container) })
    await type('Eiffel Tower')
    await key('Enter')
    expect(options()).toHaveLength(1)

    await key('Escape')
    expect(input().value).toBe('')
    expect(options()).toHaveLength(0)
    expect(placeSearch.status.value).toBe('idle')

    await type('48.8584, 2.2945')
    expect(input().value).toBe('48.8584, 2.2945')
  })

  it('forgets results when another Design replaces the open one', async () => {
    const uninstall = installPlaceSearchSession()
    try {
      transport.mockImplementation(async () => [{ lat: '47.39', lon: '0.689', display_name: 'Tours, France' }])
      await act(async () => { render(<PlaceSearchField />, container) })
      await type('Tours')
      await key('Enter')
      expect(placeSearch.results.value).toHaveLength(1)

      await act(async () => {
        designSessionStore.replaceCurrentDesignState(emptyDesign('Next'), null, 'Next')
      })

      expect(placeSearch.results.value).toEqual([])
      expect(options()).toHaveLength(0)
    } finally {
      uninstall()
    }
  })
})

describe('New Design site guidance', () => {
  let container: HTMLDivElement
  const showPlace = vi.fn(() => true)

  beforeEach(() => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.appendChild(container)
    sidePanel.value = null
    designSessionStore.replaceCurrentDesignState(emptyDesign('Untitled'), null, 'Untitled')
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ viewport: { showPlace } }),
      queries: createTestCanvasQuerySurface(),
    }))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
    placeSearch.clear()
    showPlace.mockClear()
    sidePanel.value = null
    designSessionStore.clearCurrentDesign()
  })

  it('asks "Where is your site?" for an empty Draft, then shows the Start card and the found place', async () => {
    await act(async () => { render(<SiteOnboarding />, container) })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Where is your site?')
    const field = container.querySelector<HTMLInputElement>('input[role="combobox"]')!
    expect(document.activeElement).toBe(field)

    await act(async () => {
      field.value = '48.2201, 0.0351'
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })

    // The new Design opened at an overview: picking the site flies there.
    expect(showPlace).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 48.2201, lon: 0.0351 }), PLACE_SEARCH_ZOOM, { motion: 'fly' },
    )
    expect(container.querySelector('[data-site-locate]')).toBeNull()
    expect(container.querySelector('[data-start-design]')?.textContent).toContain('Start your Design')
    expect(container.querySelector('[data-found-site]')?.textContent).toContain('48.2201° N, 0.0351° E')

    const openCatalog = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Open plant catalog')!
    await act(async () => { openCatalog.click() })
    expect(sidePanel.value).toBe('plant-db')
    expect(container.querySelector('[data-start-design]')).toBeNull()
  })

  // canopi-f47t.52.228.20: the site search focused its field after paint (Preact 11 useEffect), so an Esc pressed as
  // "Where is your site?" first showed reached the map instead of skipping the question.
  it('canopi-f47t.52.228.20: "Where is your site?" has its field focused as it shows, and an Esc at once skips it', async () => {
    const release = holdAfterPaint()
    try {
      render(<SiteOnboarding />, container)
      await beforePaint()
      const field = container.querySelector<HTMLInputElement>('input[role="combobox"]')!
      expect(document.activeElement, 'the field has focus as it first shows').toBe(field)
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await beforePaint()
      expect(container.querySelector('[data-site-locate]'), 'Esc skipped the question').toBeNull()
    } finally {
      release()
    }
  })

  it('skips to the Start card, and Search again brings the site search back', async () => {
    await act(async () => { render(<SiteOnboarding />, container) })
    const skip = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Skip'))!
    await act(async () => { skip.click() })
    expect(container.querySelector('[data-start-design]')).not.toBeNull()

    const again = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Search again')!
    await act(async () => { again.click() })
    expect(container.querySelector('[data-site-locate]')).not.toBeNull()
  })

  it('stays out of the way for a Design saved to a file', async () => {
    designSessionStore.replaceCurrentDesignState(emptyDesign('Saved'), '/designs/saved.canopi', 'Saved')
    await act(async () => { render(<SiteOnboarding />, container) })
    expect(container.textContent).toBe('')
  })
})

function emptyDesign(name: string): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '',
    updated_at: '',
    extra: {},
  }
}
