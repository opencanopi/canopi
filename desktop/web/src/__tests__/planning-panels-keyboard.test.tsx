// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { CalendarPanel } from '../components/panels/CalendarPanel'
import { ConsortiumPanel } from '../components/panels/ConsortiumPanel'
import { disposePlanningViewState, readPlanningViewState } from '../app/planning-view/state'
import { sidePanel } from '../app/shell/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { consortiumTarget, MANUAL_TARGET } from '../target'
import type { CanopiFile, PlacedPlant } from '../types/design'
import { designSessionFixture } from './support/design-session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { dropdownTrigger } from './support/dropdown-trigger'

function design(): CanopiFile {
  return {
    version: 9,
    name: 'Planning keyboard test',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [{
      target: consortiumTarget('Malus domestica'),
      stratum: 'high',
      start_phase: 0,
      end_phase: 2,
    }],
    groups: [],
    timeline: [{
      id: 'calendar-action',
      action_type: 'pruning',
      description: 'Prune apple',
      start_date: '2026-09-08',
      end_date: null,
      recurrence: null,
      targets: [MANUAL_TARGET],
      depends_on: null,
      completed: false,
      order: 0,
    }],
    budget: [],
    budget_currency: 'EUR',
    extra: {},
    created_at: '',
    updated_at: '',
  }
}

function plant(): PlacedPlant {
  return {
    id: 'plant-apple',
    canonical_name: 'Malus domestica',
    common_name: 'Apple',
    color: null,
    position: { lon: 13, lat: 23 },
    rotation: null,
    canopy_spread_m: null,
    notes: null,
    planted_date: null,
    quantity: 1,
    locked: false,
  }
}

describe('planning panel keyboard hierarchy', () => {
  let container: HTMLDivElement
  let railButton: HTMLButtonElement

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('scrollTo', () => {})
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {}
    }
    document.body.innerHTML = ''
    railButton = document.createElement('button')
    container = document.createElement('div')
    document.body.append(railButton, container)
    disposePlanningViewState()
    designSessionFixture.file = design()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ plants: [plant()] }),
    }))
  })

  afterEach(() => {
    render(null, container)
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
    sidePanel.value = null
    vi.unstubAllGlobals()
  })

  it('uses roving date focus and selects dates with the keyboard', async () => {
    const view = readPlanningViewState()
    view.calendarMonth.value = '2026-09-01'
    sidePanel.value = 'calendar'
    await act(async () => { render(<CalendarPanel />, container) })

    const septemberEight = container.querySelector<HTMLButtonElement>('button[data-calendar-date="2026-09-08"]')!
    septemberEight.focus()
    await act(async () => {
      septemberEight.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect((document.activeElement as HTMLElement).dataset.calendarDate).toBe('2026-09-09')

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect((document.activeElement as HTMLElement).dataset.calendarDate).toBe('2026-09-06')

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(view.calendarSelectedDate.value).toBe('2026-09-06')
  })

  it('restores one operable date-grid tab stop after toolbar month navigation', async () => {
    // Today takes the tab stop when it is visible, so keep it out of both grids.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-15T12:00:00'))
    onTestFinished(() => { vi.useRealTimers() })
    const view = readPlanningViewState()
    view.calendarMonth.value = '2026-09-01'
    sidePanel.value = 'calendar'
    await act(async () => { render(<CalendarPanel />, container) })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Next month"]')!.click()
    })

    const tabStops = [...container.querySelectorAll<HTMLButtonElement>('button[data-calendar-date]')]
      .filter((date) => date.tabIndex === 0)
    expect(tabStops).toHaveLength(1)
    expect(tabStops[0]?.dataset.calendarDate).toBe('2026-10-01')
  })

  it('shows every action active on a selected inclusive range date exactly once', async () => {
    const rangeDesign = design()
    rangeDesign.timeline[0] = { ...rangeDesign.timeline[0]!, end_date: '2026-09-11' }
    designSessionFixture.file = rangeDesign
    const view = readPlanningViewState()
    view.calendarMonth.value = '2026-09-01'
    sidePanel.value = 'calendar'
    await act(async () => { render(<CalendarPanel />, container) })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-calendar-date="2026-09-09"]')!.click()
    })

    const selectedAgenda = container.querySelector<HTMLElement>(
      '[data-agenda-date="2026-09-09"][data-selected-date="true"]',
    )
    expect(selectedAgenda?.textContent).toContain('Prune apple')
    expect(container.querySelectorAll('[data-calendar-agenda-action="calendar-action"]')).toHaveLength(1)
  })

  it('cancels a Calendar editor, then reduces and closes in Escape order', async () => {
    const view = readPlanningViewState()
    view.calendarMonth.value = '2026-09-01'
    view.calendarExpanded.value = true
    sidePanel.value = 'calendar'
    railButton.dataset.panel = 'calendar'
    await act(async () => { render(<CalendarPanel />, container) })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-calendar-add]')!.click()
    })
    await act(async () => {
      container.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(container.querySelector('button[data-calendar-add]'))

    await act(async () => {
      container.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(view.calendarExpanded.value).toBe(false)

    await act(async () => {
      container.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(sidePanel.value).toBeNull()
    expect(document.activeElement).toBe(railButton)
  })

  it('cancels a Consortium row editor before closing its dock', async () => {
    sidePanel.value = 'consortium'
    railButton.dataset.panel = 'consortium'
    await act(async () => { render(<ConsortiumPanel />, container) })
    const editButton = container.querySelector<HTMLButtonElement>('button[data-consortium-edit]')!
    await act(async () => { editButton.click() })

    await act(async () => {
      container.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(container.querySelector('button[data-consortium-edit]'))
    expect(sidePanel.value).toBe('consortium')

    await act(async () => {
      container.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(sidePanel.value).toBeNull()
    expect(document.activeElement).toBe(railButton)
  })

  it('selects Consortium editor values from an unclipped floating menu', async () => {
    sidePanel.value = 'consortium'
    await act(async () => { render(<ConsortiumPanel />, container) })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-consortium-edit]')!.click()
    })
    const trigger = dropdownTrigger(container, 'Stratum')!

    await act(async () => { trigger.click() })
    const menu = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Stratum"]')!
    expect(menu.parentElement).toBe(document.body)
    const current = menu.querySelector<HTMLButtonElement>('button[aria-selected="true"]')!
    await act(async () => { current.click() })

    expect(document.querySelector('[role="listbox"][aria-label="Stratum"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
