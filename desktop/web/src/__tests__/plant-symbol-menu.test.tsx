// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlantSymbolMenu } from '../components/canvas/PlantSymbolMenu'
import { setCurrentCanvasSession } from '../canvas/session'
import { plantSymbolMenuOpen } from '../app/canvas-context-menu/state'
import { currentCanvasSelection } from '../canvas/session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'

describe('PlantSymbolMenu', () => {
  let container: HTMLDivElement
  let querySurface: ReturnType<typeof createTestCanvasQuerySurface>
  const setSelectedPlantSymbol = vi.fn()
  const setPlantSymbolForSpecies = vi.fn()
  const getSelectedPlantSymbolContext = vi.fn()
  const buttonRef = { current: null as HTMLButtonElement | null }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    setSelectedPlantSymbol.mockReset()
    setPlantSymbolForSpecies.mockReset()
    getSelectedPlantSymbolContext.mockReset()
    querySurface = createTestCanvasQuerySurface()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        plantPresentation: {
          setSelectedPlantSymbol,
          setPlantSymbolForSpecies,
        },
      }),
      queries: {
        ...querySurface,
        getSelectedPlantSymbolContext,
      },
    }))
    buttonRef.current = document.createElement('button')
    currentCanvasSelection.value = new Set(['plant-1'])
    plantSymbolMenuOpen.value = true
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    render(null, container)
    container.remove()
    currentCanvasSelection.value = new Set()
    plantSymbolMenuOpen.value = false
    setCurrentCanvasSession(null)
  })

  it('applies a labeled symbol choice to the current plant selection', async () => {
    getSelectedPlantSymbolContext.mockReturnValue({
      plantIds: ['plant-1', 'plant-2'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'canopy',
      inheritedSymbol: 'canopy',
      singleSpeciesDefaultSymbol: null,
      canClearSelectedSymbol: false,
    })

    await act(async () => {
      render(<PlantSymbolMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    expect(document.activeElement).toBe(document.querySelector('[role="option"][aria-selected="true"]'))
    const options = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    options[0]!.focus()
    await act(async () => { options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.activeElement).toBe(options[5])

    const coniferButton = document.querySelector<HTMLButtonElement>('button[aria-label="Conifer"]')
    expect(coniferButton).not.toBeNull()
    expect(coniferButton?.title).toBe('Conifer')
    expect(coniferButton?.textContent).toBe('Conifer')

    await act(async () => {
      coniferButton?.click()
      await Promise.resolve()
    })

    const setSymbolButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Apply to'),
    ) as HTMLButtonElement

    await act(async () => {
      setSymbolButton.click()
      await Promise.resolve()
    })

    expect(setSelectedPlantSymbol).toHaveBeenCalledWith('conifer')
    expect(plantSymbolMenuOpen.value).toBe(false)
  })

  it('offers every symbol in one keyboard grid, grouped by family with localized names', async () => {
    getSelectedPlantSymbolContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'round',
      inheritedSymbol: null,
      singleSpeciesDefaultSymbol: null,
      canClearSelectedSymbol: false,
    })

    await act(async () => {
      render(<PlantSymbolMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const symbolRows = document.querySelectorAll('[role="listbox"]')
    expect(symbolRows).toHaveLength(1)
    expect(symbolRows[0]?.querySelectorAll('[role=option]')).toHaveLength(33)
    const families = [...document.querySelectorAll('[role="group"]')]
    expect(families.map((group) => [group.getAttribute('aria-label'), group.querySelectorAll('[role="option"]').length])).toEqual([
      ['Plant form', 12], ['What it gives', 6], ['What it does', 11], ['Abstract', 4],
    ])
    expect(families[1]?.querySelector('button[aria-label="Nitrogen fixer"]')?.getAttribute('data-symbol')).toBe('pod')
    expect(families[2]?.querySelector('button[aria-label="Pollinator"]')?.getAttribute('data-symbol')).toBe('bee')
    expect(symbolRows[0]?.textContent).toContain('Groundcover')
    expect(symbolRows[0]?.querySelector('button[aria-label="Groundcover"]')).toBeTruthy()
    expect(symbolRows[0]?.querySelector('button[aria-label="Fern"]')).toBeTruthy()

    const fernButton = symbolRows[0]?.querySelector<HTMLButtonElement>('button[aria-label="Fern"]')
    expect(fernButton?.textContent).toBe('Fern')

    await act(async () => {
      fernButton?.click()
      await Promise.resolve()
    })

    const setSymbolButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Apply to'),
    ) as HTMLButtonElement

    await act(async () => {
      setSymbolButton.click()
      await Promise.resolve()
    })

    expect(setSelectedPlantSymbol).toHaveBeenCalledWith('fern')
  })

  it('previews abstract choices with the same keyboard grid and applies only on confirmation', async () => {
    getSelectedPlantSymbolContext.mockReturnValue({
      plantIds: ['plant-1'], singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple', sharedCurrentSymbol: 'canopy',
      sharedEffectiveSymbol: 'canopy', inheritedSymbol: null,
      singleSpeciesDefaultSymbol: null, canClearSelectedSymbol: true,
    })
    await act(async () => { render(<PlantSymbolMenu buttonRef={buttonRef} />, container) })
    expect(document.querySelector('[role="group"][aria-label="Plant form"]')).not.toBeNull()
    expect(document.querySelector('[role="group"][aria-label="Abstract"]')?.querySelectorAll('[role="option"]')).toHaveLength(4)
    const canopy = document.querySelector<HTMLButtonElement>('[aria-label="Canopy tree"]')!
    await act(async () => { canopy.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    const cross = document.querySelector<HTMLButtonElement>('[aria-label="Cross"]')!
    expect(document.activeElement).toBe(cross)
    expect(cross.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelectorAll('[role="option"][tabindex="0"]')).toHaveLength(1)
    expect(setSelectedPlantSymbol).not.toHaveBeenCalled()
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Apply to'))!.click()
    })
    expect(setSelectedPlantSymbol).toHaveBeenCalledWith('cross')
  })

  it('renders option and preview glyphs in normalized SVG frames', async () => {
    getSelectedPlantSymbolContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'round',
      inheritedSymbol: null,
      singleSpeciesDefaultSymbol: null,
      canClearSelectedSymbol: false,
    })

    await act(async () => {
      render(<PlantSymbolMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const previewSvg = document.querySelector('svg[viewBox="-1 -1 2 2"]')
    const coniferSvg = document.querySelector('button[aria-label="Conifer"] svg')

    expect(previewSvg).toBeTruthy()
    expect(coniferSvg).toBeTruthy()
    expect(previewSvg?.getAttribute('viewBox')).toBe('-1 -1 2 2')
    expect(coniferSvg?.getAttribute('viewBox')).toBe('-1 -1 2 2')
  })

  it('updates the selected plant name when localized plant names refresh', async () => {
    let commonName = 'Apple'
    getSelectedPlantSymbolContext.mockImplementation(() => ({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: commonName,
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'round',
      inheritedSymbol: null,
      singleSpeciesDefaultSymbol: null,
      canClearSelectedSymbol: false,
    }))

    await act(async () => {
      render(<PlantSymbolMenu buttonRef={buttonRef} />, container)
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

  it('keeps a shared inherited effective symbol when applying an unchanged multi-species selection', async () => {
    getSelectedPlantSymbolContext.mockReturnValue({
      plantIds: ['plant-1', 'plant-2'],
      singleSpeciesCanonicalName: null,
      singleSpeciesCommonName: null,
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'canopy',
      inheritedSymbol: null,
      singleSpeciesDefaultSymbol: null,
      canClearSelectedSymbol: false,
    })

    await act(async () => {
      render(<PlantSymbolMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const canopyButton = document.querySelector<HTMLButtonElement>('button[aria-label="Canopy tree"]')
    expect(canopyButton?.getAttribute('aria-selected')).toBe('true')
    expect(document.body.textContent).toContain('Inherited: Canopy tree')

    const setSymbolButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Apply to'),
    ) as HTMLButtonElement

    await act(async () => {
      setSymbolButton.click()
      await Promise.resolve()
    })

    expect(setSelectedPlantSymbol).toHaveBeenCalledWith('canopy')
    expect(setSelectedPlantSymbol).not.toHaveBeenCalledWith('round')
  })

  it('describes mixed inherited effective symbols without presenting them as inherited round', async () => {
    getSelectedPlantSymbolContext.mockReturnValue({
      plantIds: ['plant-1', 'plant-2'],
      singleSpeciesCanonicalName: null,
      singleSpeciesCommonName: null,
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'mixed',
      inheritedSymbol: null,
      singleSpeciesDefaultSymbol: null,
      canClearSelectedSymbol: false,
    })

    await act(async () => {
      render(<PlantSymbolMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const roundButton = document.querySelector<HTMLButtonElement>('button[aria-label="Neutral dot"]')
    expect(roundButton?.getAttribute('aria-selected')).toBe('true')
    expect(document.body.textContent).toContain('Mixed symbols')
    expect(document.body.textContent).not.toContain('Inherited: Neutral dot')
  })

  it('applies the selected symbol to all placed instances of the selected species', async () => {
    getSelectedPlantSymbolContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'round',
      inheritedSymbol: 'round',
      singleSpeciesDefaultSymbol: null,
      canClearSelectedSymbol: false,
    })

    await act(async () => {
      render(<PlantSymbolMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const canopyButton = document.querySelector<HTMLButtonElement>('button[aria-label="Canopy tree"]')
    await act(async () => {
      canopyButton?.click()
      await Promise.resolve()
    })

    const setAllButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Set for all Apple'),
    ) as HTMLButtonElement

    await act(async () => {
      setAllButton.click()
      await Promise.resolve()
    })

    expect(setPlantSymbolForSpecies).toHaveBeenCalledWith('Malus domestica', 'canopy')
    expect(plantSymbolMenuOpen.value).toBe(false)
  })

  it('stops the action surface at the two apply buttons', async () => {
    getSelectedPlantSymbolContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentSymbol: 'conifer',
      sharedEffectiveSymbol: 'conifer',
      inheritedSymbol: 'round',
      singleSpeciesDefaultSymbol: 'round',
      canClearSelectedSymbol: true,
    })

    await act(async () => {
      render(<PlantSymbolMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const actionButtons = [...document.querySelectorAll('button')]
      .map((button) => button.textContent?.trim())
      .filter(Boolean)

    expect(actionButtons).toContain('Apply to 1 selected')
    expect(actionButtons).toContain('Set for all Apple')
    expect(document.body.textContent).not.toContain('Sets the default symbol')
    expect(actionButtons.some((label) => label?.includes('Clear symbol'))).toBe(false)
    expect(actionButtons.some((label) => label?.includes('Clear species default'))).toBe(false)
  })

  it('closes on Escape, header close button, and outside pointerup', async () => {
    getSelectedPlantSymbolContext.mockReturnValue({
      plantIds: ['plant-1'],
      singleSpeciesCanonicalName: 'Malus domestica',
      singleSpeciesCommonName: 'Apple',
      sharedCurrentSymbol: 'conifer',
      sharedEffectiveSymbol: 'conifer',
      inheritedSymbol: 'round',
      singleSpeciesDefaultSymbol: 'round',
      canClearSelectedSymbol: false,
    })

    await act(async () => {
      render(<PlantSymbolMenu buttonRef={buttonRef} />, container)
      await Promise.resolve()
    })

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(plantSymbolMenuOpen.value).toBe(false)

    await act(async () => {
      plantSymbolMenuOpen.value = true
      await Promise.resolve()
    })
    const closeButton = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!
    await act(async () => {
      closeButton.click()
      await Promise.resolve()
    })
    expect(plantSymbolMenuOpen.value).toBe(false)

    await act(async () => {
      plantSymbolMenuOpen.value = true
      await Promise.resolve()
    })
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
      await Promise.resolve()
    })
    expect(plantSymbolMenuOpen.value).toBe(false)
  })

})
