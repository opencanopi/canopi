// @vitest-environment jsdom

// The phone's context bar (canopi-f47t.54, stream D, answers 18 and 22-26): what it shows, by priority. Its place in the
// panel sheet and its taps are checked in the browser (e2e/canvas/phone-chrome.spec.ts).
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanopiFile } from '../types/design'
import type { ToolId } from '../canvas/runtime/interaction-types'
import { locale } from '../app/settings/state'
import { PhoneContextBar } from '../components/canvas/PhoneContextBar'
import { ToolOptions } from '../components/canvas/ToolCard'
import { phoneLayout, phoneToolOptions } from '../app/shell/phone-layout'
import { PLANT_LABELS_CHIP_MS } from '../components/canvas/PlantLabelsChip'
import { plantFinderMapMatches } from '../app/plant-finder/map-matches'
import { setPlantLabels } from '../app/plant-display/actions'
import { designSessionFixture, replaceCurrentDesignState } from './support/design-session-state'
import { setCurrentCanvasSession } from '../canvas/session'
import { SceneStore } from '../canvas/runtime/scene/store'
import {
  currentCanvasSelection,
  IDLE_CANVAS_TOOL_GUIDANCE,
  setCanvasToolGuidance,
  type CanvasPlantRowGuidance,
  type CanvasToolGuidance,
} from '../canvas/session-state'
import {
  createTestCanvasCommandSurface,
  createTestCanvasDocumentSurface,
  createTestCanvasKeyboardPort,
} from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface, type TestCanvasQuerySurface } from './support/canvas-query-surface'

describe('Phone context bar', () => {
  let container: HTMLDivElement
  let queries: TestCanvasQuerySurface

  beforeEach(async () => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.append(container)
    const store = new SceneStore()
    store.updatePersisted((draft) => {
      draft.plants = ['apple-1', 'apple-2'].map((id, index) => ({
        id, canonicalName: 'Malus domestica', commonName: 'Apple', kind: 'plant', locked: false, color: null,
        symbol: 'tree', position: { x: index * 4, y: 0 }, canopySpreadM: null, rotationDeg: 0, notes: null,
        plantedDate: null, quantity: 1,
      }))
    })
    queries = createTestCanvasQuerySurface({ scene: store.persisted, plantLabelCoverage: { labelled: 2, inView: 2 } })
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface(),
      queries,
      documents: createTestCanvasDocumentSurface(),
      keyboard: createTestCanvasKeyboardPort(),
    })
    await act(() => render(<PhoneContextBar />, container))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCanvasToolGuidance(IDLE_CANVAS_TOOL_GUIDANCE)
    phoneToolOptions.value = null
    phoneLayout.value = null
    currentCanvasSelection.value = new Set()
    plantFinderMapMatches.value = null
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
  })

  async function selectApple(): Promise<void> {
    await act(() => {
      queries.setSelection([{ kind: 'plant', id: 'apple-1' }])
      currentCanvasSelection.value = new Set(['apple-1'])
    })
  }

  async function choose(tool: ToolId, guidance: Partial<CanvasToolGuidance> = {}): Promise<void> {
    await act(() => {
      queries.setActiveTool(tool)
      setCanvasToolGuidance({ ...IDLE_CANVAS_TOOL_GUIDANCE, ...guidance })
    })
  }

  const card = () => container.querySelector<HTMLElement>('[data-tool-card]')
  const chip = () => container.querySelector<HTMLElement>('[data-selection-chip]')
  const highlight = () => container.querySelector<HTMLElement>('[role="group"][aria-label="Plants highlighted on the map"]')
  const labels = () => container.querySelector<HTMLElement>('[data-plant-labels-chip]')

  it('shows nothing under Select or Pan with nothing else to show, keeping the card\'s live region for the next tool', async () => {
    for (const tool of ['select', 'hand'] as const) {
      await choose(tool)
      expect(card(), `${tool}: no card`).toBeNull()
      expect(container.querySelector('[role="status"][aria-live="polite"]'), `${tool}: the card's live region stays mounted`).not.toBeNull()
      expect(container.textContent).toBe('')
    }
  })

  it('shows the armed tool\'s card in the bar for any other tool', async () => {
    for (const tool of ['plant-spacing', 'polygon', 'profile', 'rectangle'] as const) {
      await choose(tool)
      expect(card()?.dataset.toolCard, tool).toBe(tool)
      expect(card()?.dataset.placement, `${tool}: the card is the bar's`).toBe('bar')
    }
  })

  it('shows a tool as one row: its name, a short status, the row\'s check button and Options, its fields in the options', async () => {
    const PATH: CanvasPlantRowGuidance = {
      phase: 'row', plantName: 'Apple', glyph: { symbol: 'berry', color: '#ab5268' }, interval: '2 m', intervalValid: true,
      count: 7, density: 'normal', focusRequest: 1, points: 3, closed: false, mode: 'interval', countText: '',
      countValid: true, length: '14 m', loopSpacing: null, touch: true,
    }
    const options = document.createElement('div')
    document.body.append(options)
    await act(() => { phoneLayout.value = 'portrait' })
    await choose('polygon')
    const shown = () => [...card()!.querySelectorAll('b, span, button')].filter((node) => node.children.length === 0
      && node.getAttribute('role') !== 'tooltip' && !node.closest('[role="tooltip"]')).map((node) => node.textContent)
    expect(shown()).toEqual(['Polygon zone', 'Click to add corners. Click the first corner, double-click or press Enter to finish.', 'Options'])
    expect(card()!.querySelector('[data-tool-options-button]')?.getAttribute('aria-expanded')).toBe('false')

    await choose('plant-spacing', { gesture: true, plantRow: PATH })
    expect(card()!.querySelector('[data-plant-spacing-generated-count]')?.textContent).toBe('7 generated · 2 m')
    expect(card()!.querySelector('[data-plant-row-finish]')?.getAttribute('aria-label')).toBe('Plant the row')
    expect(card()!.querySelector('input'), 'no field in the bar').toBeNull()
    // The name and the subject are announced; the count, which moves with the pointer, is not.
    expect(card()!.querySelector('[role="status"]')?.textContent).toBe('Plant a row')

    await act(() => { card()!.querySelector<HTMLButtonElement>('[data-tool-options-button]')!.click() })
    expect(phoneToolOptions.value).toBe('half')
    await act(() => render(<ToolOptions />, options))
    expect(options.querySelector('[data-plant-spacing-interval-input]')).not.toBeNull()
    expect(options.querySelectorAll('[data-plant-row-mode]')).toHaveLength(2)
    expect(options.querySelector('[data-plant-row-length]')?.textContent).toBe('Length 14 m')
    expect(options.textContent).toContain('tap to add points, double tap plants')
    expect(options.querySelector('[aria-live="polite"]'), 'the options announce nothing').toBeNull()

    // A spacing the row cannot plant with: the bar says so, and its check button opens the options.
    await act(() => { phoneToolOptions.value = null })
    await choose('plant-spacing', { gesture: true, plantRow: { ...PATH, interval: '0', intervalValid: false, count: null } })
    expect(card()!.querySelector('[data-plant-row-invalid]')?.textContent).toBe('Check the spacing')
    await act(() => { card()!.querySelector<HTMLButtonElement>('[data-plant-row-finish]')!.click() })
    expect(phoneToolOptions.value).toBe('half')
    render(null, options)
    options.remove()
  })

  it('opens Place plants\' chooser as the tool\'s options at half while no species is chosen, and closes them with the tool', async () => {
    await choose('plant-stamp')
    expect(phoneToolOptions.value, 'arming Place plants with no species opens its chooser').toBe('half')
    await choose('polygon')
    expect(phoneToolOptions.value, 'another tool closes them').toBeNull()
    await choose('plant-stamp')
    await act(() => { phoneToolOptions.value = null })
    await choose('plant-stamp', { speciesPrompts: 1 })
    expect(phoneToolOptions.value, 'a tap on the map with no species opens them again').toBe('half')
    await act(() => { phoneToolOptions.value = null })
    await choose('plant-stamp', { speciesPrompts: 2 })
    expect(phoneToolOptions.value, 'and each tap after it').toBe('half')
    await choose('select')
    expect(phoneToolOptions.value).toBeNull()

    await act(() => {
      queries.setActiveTool('plant-stamp', {
        kind: 'species',
        species: { canonical_name: 'Malus domestica', common_name: 'Apple', stratum: null, width_max_m: null },
      })
      setCanvasToolGuidance(IDLE_CANVAS_TOOL_GUIDANCE)
    })
    expect(phoneToolOptions.value, 'with a species chosen Place plants places at once').toBeNull()
  })

  it('closes the tool\'s options in overview, where the bar shows its notice and has no Options', async () => {
    await choose('polygon')
    await act(() => { phoneToolOptions.value = 'half' })
    await act(() => queries.setPlacement({ x: 0, y: 0, scale: 0.01 }))
    expect(phoneToolOptions.value, 'zoomed out to the overview').toBeNull()
    await choose('plant-stamp')
    expect(phoneToolOptions.value, 'Place plants armed in overview keeps them closed').toBeNull()
    await act(() => queries.setPlacement({ x: 0, y: 0, scale: 10 }))
    expect(phoneToolOptions.value, 'out of the overview, Place plants with no species is its chooser again').toBe('half')
  })

  it('closes the tool\'s options when the bar goes, as the Design closes', async () => {
    await choose('plant-stamp')
    expect(phoneToolOptions.value).toBe('half')
    await act(() => render(null, container))
    expect(phoneToolOptions.value).toBeNull()
  })

  it('shows the selection under Select or Pan, on one line in the bar, and never with a tool\'s card', async () => {
    await selectApple()
    for (const tool of ['select', 'hand'] as const) {
      await choose(tool)
      expect(chip()?.dataset.selectionChip, `${tool}: the selection chip is the bar's`).toBe('bar')
      expect(card(), `${tool}: no card`).toBeNull()
    }
    // A selection kept while a drawing tool is armed is not summarised: the card is the one context.
    await choose('plant-spacing')
    expect(card()?.dataset.toolCard).toBe('plant-spacing')
    expect(chip()).toBeNull()
    await choose('select')
    expect(chip()?.dataset.selectionChip, 'back under Select the selection shows again').toBe('bar')
  })

  it('shows the highlighted plants when no card or selection does, and gives way to them', async () => {
    await act(() => { plantFinderMapMatches.value = { query: 'apple', canonicalNames: ['Malus domestica'] } })
    expect(highlight()?.textContent).toContain('2 plants match')
    await selectApple()
    expect(chip()).not.toBeNull()
    expect(highlight(), 'the selection is the one context').toBeNull()
    await act(() => {
      queries.setSelection([])
      currentCanvasSelection.value = new Set()
    })
    await choose('polygon')
    expect(card()?.dataset.toolCard).toBe('polygon')
    expect(highlight(), 'the card is the one context').toBeNull()
    await choose('select')
    expect(highlight()).not.toBeNull()
  })

  it('shows the labels chip after the labels change only when nothing else holds the bar, its window running meanwhile', async () => {
    vi.useFakeTimers()
    try {
      replaceCurrentDesignState(emptyDesign(), null, 'Display')
      await act(() => setPlantLabels('codes'))
      expect(labels()?.textContent).toBe('Codes shown for 2 of 2 plants in view')
      await choose('polygon')
      expect(labels(), 'the card is the one context').toBeNull()
      await choose('select')
      expect(labels(), 'back under Select, in its window').not.toBeNull()
      await act(() => { vi.advanceTimersByTime(PLANT_LABELS_CHIP_MS) })
      expect(labels()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('in overview shows its notice alone, whatever the tool', async () => {
    await choose('polygon')
    await act(() => queries.setPlacement({ x: 0, y: 0, scale: 0.01 }))
    expect(container.querySelector('[data-overview-notice]')).not.toBeNull()
    expect(card()).toBeNull()
  })
})

function emptyDesign(): CanopiFile {
  return {
    version: 9, name: 'Display', description: null, plant_species_colors: {}, plant_species_symbols: {}, plant_species_codes: {},
    layers: [], plants: [], zones: [], annotations: [], measurement_guides: [], consortiums: [], groups: [], timeline: [],
    budget: [], budget_currency: 'EUR', views: [], stories: [], created_at: '', updated_at: '', extra: {},
  }
}
