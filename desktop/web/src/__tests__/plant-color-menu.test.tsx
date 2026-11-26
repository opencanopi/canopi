// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlantColorMenu } from '../components/canvas/PlantColorMenu'
import { setCurrentCanvasSession } from '../canvas/session'
import { plantColorMenuOpen } from '../canvas/plant-color-menu-state'
import { currentCanvasSelection } from '../canvas/session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createLiveTestCanvasRuntimeHost } from './support/live-canvas-runtime'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'

describe('PlantColorMenu', () => {
  let container: HTMLDivElement
  let querySurface: ReturnType<typeof createTestCanvasQuerySurface>
  const setSelectedPlantColor = vi.fn()
  const setPlantColorForSpecies = vi.fn()
  const ensureSpeciesCacheEntries = vi.fn().mockResolvedValue(false)
  const getSelectedPlantColorContext = vi.fn()
  const buttonRef = { current: null as HTMLButtonElement | null }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    setSelectedPlantColor.mockReset()
    setPlantColorForSpecies.mockReset()
    ensureSpeciesCacheEntries.mockClear()
    getSelectedPlantColorContext.mockReset()
    querySurface = createTestCanvasQuerySurface()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        plantPresentation: {
          setSelectedPlantColor,
          setPlantColorForSpecies,
          ensureSpeciesCacheEntries,
        },
      }),
      queries: {
        ...querySurface,
        getSelectedPlantColorContext,
      },
    }))
    buttonRef.current = document.createElement('button')
    currentCanvasSelection.value = new Set(['plant-1'])
    plantColorMenuOpen.value = true
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    render(null, container)
    container.remove()
    currentCanvasSelection.value = new Set()
    plantColorMenuOpen.value = false
    setCurrentCanvasSession(null)
  })

  it.each(['cancel', 'blur', 'close', 'unmount'] as const)('releases an interrupted color drag on %s', async (end) => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentColor: '#C8A51E',
      suggestedColor: null,
      singleSpeciesDefaultColor: null,
    })
    await act(async () => render(<PlantColorMenu buttonRef={buttonRef} />, container))
    const more = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Custom color'))!
    await act(async () => more.click())
    const square = document.querySelector<HTMLElement>('[aria-label="Saturation and lightness"]')!
    vi.spyOn(square, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100))
    const remove = vi.spyOn(document, 'removeEventListener')
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const pointer = (type: string, pointerId = 1) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 70, clientY: 20 })
      Object.defineProperty(event, 'pointerId', { value: pointerId })
      return event
    }
    await act(async () => { square.dispatchEvent(pointer('pointerdown')) })
    // Another pointer ending must not cancel the owner's drag.
    await act(async () => { document.dispatchEvent(pointer('pointerup', 2)) })
    expect(remove).not.toHaveBeenCalledWith('pointermove', expect.any(Function))
    await act(async () => {
      if (end === 'cancel') document.dispatchEvent(pointer('pointercancel'))
      else if (end === 'blur') window.dispatchEvent(new Event('blur'))
      else if (end === 'close') plantColorMenuOpen.value = false
      else render(null, container)
    })
    expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('pointerup', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('pointercancel', expect.any(Function))
    expect(removeWindow).toHaveBeenCalledWith('blur', expect.any(Function))
    expect(setSelectedPlantColor).not.toHaveBeenCalled()
  })

  it('previews the species suggestion without applying until confirmed', async () => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentColor: '#123ABC',
      suggestedColor: '#C8A51E',
      singleSpeciesDefaultColor: null,
    })
    await act(async () => render(<PlantColorMenu buttonRef={buttonRef} />, container))
    const suggestion = [...document.querySelectorAll('button')].find(button =>
      button.textContent?.includes('Suggested'),
    )
    expect(suggestion).toBeDefined()
    await act(async () => suggestion!.click())
    expect(setSelectedPlantColor).not.toHaveBeenCalled()
    const apply = [...document.querySelectorAll('button')].find(button =>
      button.textContent?.includes('Apply to'),
    )!
    await act(async () => apply.click())
    expect(setSelectedPlantColor).toHaveBeenCalledWith('#C8A51E')
  })

  it('adjusts custom color with the keyboard without applying it', async () => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1'], singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple', sharedCurrentColor: '#C8A51E',
      suggestedColor: null, singleSpeciesDefaultColor: null,
    })
    await act(async () => render(<PlantColorMenu buttonRef={buttonRef} />, container))
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Custom color')!.click() })
    const hue = document.querySelector<HTMLElement>('[aria-label="Hue"]')!
    expect(hue.getAttribute('role')).toBe('slider')
    const input = document.querySelector<HTMLInputElement>('[aria-label="Custom hex"]')!
    const before = input.value
    await act(async () => { hue.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(input.value).not.toBe(before)
    expect(setSelectedPlantColor).not.toHaveBeenCalled()
    expect(setPlantColorForSpecies).not.toHaveBeenCalled()
  })

  it('applies a selected palette color to the current plant selection', async () => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1', 'plant-2'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentColor: null,
      suggestedColor: '#C8A51E',
      singleSpeciesDefaultColor: null,
    })

    await act(async () => {
      render(<PlantColorMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const swatches = document.querySelectorAll('button[aria-selected]')
    const setColorButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Apply to'),
    ) as HTMLButtonElement

    await act(async () => {
      ;(swatches[1] as HTMLButtonElement).click()
      await Promise.resolve()
    })

    await act(async () => {
      setColorButton.click()
      await Promise.resolve()
    })

    expect(setSelectedPlantColor).toHaveBeenCalledWith('#C44230')
    expect(plantColorMenuOpen.value).toBe(false)
  })

  it('updates the selected plant name when localized plant names refresh', async () => {
    let commonName = 'Apple'
    getSelectedPlantColorContext.mockImplementation(() => ({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: commonName,
      sharedCurrentColor: null,
      suggestedColor: '#C8A51E',
      singleSpeciesDefaultColor: null,
    }))

    await act(async () => {
      render(<PlantColorMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Apple')

    commonName = 'Pommier'
    await act(async () => {
      querySurface.bumpPlantNamesRevision()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Pommier')
    expect(document.body.textContent).not.toContain('Apple')
  })

  it('applies the selected color to all placed instances of the selected species', async () => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentColor: null,
      suggestedColor: '#C8A51E',
      singleSpeciesDefaultColor: null,
    })

    await act(async () => {
      render(<PlantColorMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const setAllButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Set for all'),
    ) as HTMLButtonElement

    await act(async () => {
      setAllButton.click()
      await Promise.resolve()
    })

    expect(setPlantColorForSpecies).toHaveBeenCalledWith('Malus domestica', '#C8A51E')
    expect(plantColorMenuOpen.value).toBe(false)
  })

  it('stops the action surface at the two apply buttons', async () => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentColor: '#C8A51E',
      suggestedColor: '#C8A51E',
      singleSpeciesDefaultColor: '#C8A51E',
    })

    await act(async () => {
      render(<PlantColorMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const actionButtons = [...document.querySelectorAll('button')]
      .map((button) => button.textContent?.trim())
      .filter(Boolean)

    expect(actionButtons).toContain('Apply to 1 selected')
    expect(actionButtons).toContain('Set for all Apple')
    expect(document.body.textContent).not.toContain('Sets the default color')
    expect(actionButtons.some((label) => label?.includes('Clear color'))).toBe(false)
    expect(actionButtons.some((label) => label?.includes('Clear species default'))).toBe(false)
  })

  it('hides the species-wide action for mixed-species selections', async () => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1', 'plant-2'],
      singleSpeciesCanonicalName: null,
      singleSpeciesCommonName: null,
      sharedCurrentColor: 'mixed',
      suggestedColor: null,
      singleSpeciesDefaultColor: null,
    })

    await act(async () => {
      render(<PlantColorMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    expect(
      [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Set for all')),
    ).toBe(false)
  })

  it('opens the custom picker directly without an empty swatch', async () => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentColor: null,
      suggestedColor: '#C8A51E',
      singleSpeciesDefaultColor: null,
    })

    await act(async () => {
      render(<PlantColorMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const emptySwatch = document.querySelector('button[aria-label="No custom color selected"]') as HTMLButtonElement
    expect(emptySwatch).toBeNull()

    const moreColorsButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Custom color'),
    ) as HTMLButtonElement

    await act(async () => {
      moreColorsButton.click()
      await Promise.resolve()
    })

    expect(document.querySelector('[aria-label="Saturation and lightness"]')).not.toBeNull()
  })

  it('keeps curated choices independent of the custom disclosure', async () => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentColor: null,
      suggestedColor: '#C8A51E',
      singleSpeciesDefaultColor: null,
    })

    await act(async () => {
      render(<PlantColorMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const swatches = document.querySelectorAll('button[aria-selected]')
    await act(async () => {
      ;(swatches[1] as HTMLButtonElement).click()
      await Promise.resolve()
    })

    const emptySwatch = document.querySelector('button[aria-label="No custom color selected"]') as HTMLButtonElement
    expect(emptySwatch).toBeNull()
  })

  it('rejects invalid hex and applies a valid custom color', async () => {
    getSelectedPlantColorContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentColor: null,
      suggestedColor: '#C8A51E',
      singleSpeciesDefaultColor: null,
    })

    await act(async () => {
      render(<PlantColorMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const moreColorsButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Custom color'),
    ) as HTMLButtonElement

    await act(async () => {
      moreColorsButton.click()
      await Promise.resolve()
    })

    const input = document.querySelector('input[placeholder="#C44230"]') as HTMLInputElement
    await act(async () => {
      input.value = 'invalid'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const applyActions = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(button =>
      button.textContent?.includes('Apply to') || button.textContent?.includes('Set for all'),
    )
    expect(applyActions).toHaveLength(2)
    expect(applyActions.every(button => button.disabled)).toBe(true)
    await act(async () => {
      input.value = '#123ABC'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(input.value).toBe('#123ABC')

    const setColorButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Apply to'),
    ) as HTMLButtonElement

    await act(async () => {
      setColorButton.click()
      await Promise.resolve()
    })

    expect(setSelectedPlantColor).toHaveBeenCalledWith('#123ABC')
  })

})

describe('PlantColorMenu on a live Scene', () => {
  const design: CanopiFile = {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Orchard',
    description: null,
    plant_species_colors: { 'Malus domestica': '#112233' },
    layers: [{ name: 'plants', visible: true, locked: false, opacity: 1 }],
    plants: [{
      id: 'plant-1', canonical_name: 'Malus domestica', common_name: 'Apple', color: null,
      position: { lon: 0, lat: 0 }, rotation: null, canopy_spread_m: null, notes: null, planted_date: null, quantity: 1, locked: false,
    }],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
    extra: {},
  }

  afterEach(() => {
    plantColorMenuOpen.value = false
    setCurrentCanvasSession(null)
    vi.unstubAllGlobals()
  })

  it('the open menu shows the species colour after undo', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const host = createLiveTestCanvasRuntimeHost()
    const { commands, documents } = host.surfaces
    const shownColor = () => document.querySelector('[role="dialog"]')?.textContent?.match(/#[0-9A-F]{6}/i)?.[0]?.toUpperCase()
    try {
      documents.loadDocument(design)
      setCurrentCanvasSession(host.surfaces)
      commands.sceneEdits.selectAll()
      plantColorMenuOpen.value = true
      await act(async () => render(<PlantColorMenu buttonRef={{ current: null }} />, container))
      expect(shownColor()).toBe('#112233')

      // Another surface (the species key) changes the species colour while the menu stays open.
      await act(async () => { commands.plantPresentation.setPlantColorForSpecies('Malus domestica', '#C44230') })
      expect(shownColor()).toBe('#C44230')
      await act(async () => { commands.history.undo() })
      expect(shownColor()).toBe('#112233')
    } finally {
      render(null, container)
      container.remove()
      await host.destroy()
    }
  })
})
