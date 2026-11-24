import type { TimelineAction } from '../generated/contracts'
// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarPanel } from '../components/panels/CalendarPanel'
import { disposePlanningViewState, readPlanningViewState } from '../app/planning-view/state'
import { locale } from '../app/settings/state'
import { sidePanel } from '../app/shell/state'
import { setCurrentCanvasSession } from '../canvas/session'
import type { CanopiFile } from '../types/design'
import { designSessionFixture } from './support/design-session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'

function action(overrides: Partial<TimelineAction> = {}): TimelineAction {
  return {
    id: 'water', action_type: 'watering', description: 'Water the beds', start_date: '2026-09-08', end_date: null,
    recurrence: null, targets: [], depends_on: null, completed: false, order: 0, ...overrides,
  }
}

function design(timeline: TimelineAction[]): CanopiFile {
  return {
    version: 9, name: 'Calendar empty test', description: null, plant_species_colors: {}, layers: [], plants: [],
    zones: [], annotations: [], consortiums: [], groups: [], timeline, budget: [], budget_currency: 'EUR', extra: {},
    created_at: '', updated_at: '',
  }
}

function buttonNamed(scope: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === name)
}

describe('Calendar empty states', () => {
  let container: HTMLDivElement

  async function mount(timeline: TimelineAction[]): Promise<void> {
    designSessionFixture.file = design(timeline)
    designSessionFixture.nonCanvasRevision = 0
    await act(async () => { render(<CalendarPanel />, container) })
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {}
    container = document.createElement('div')
    document.body.appendChild(container)
    locale.value = 'en'
    disposePlanningViewState()
    readPlanningViewState().calendarMonth.value = '2026-09-01'
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: createTestCanvasQuerySurface({ plants: [] }) }))
    sidePanel.value = 'calendar'
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
    sidePanel.value = null
    disposePlanningViewState()
    vi.unstubAllGlobals()
  })

  it('says there are no actions yet and offers Add action when the Design has none', async () => {
    await mount([])
    const text = container.textContent ?? ''
    expect(text).toContain('No actions yet')
    expect(text).not.toContain('No actions match these filters')
    expect(buttonNamed(container, 'Clear filters')).toBeUndefined()
    const empty = container.querySelector<HTMLElement>('[data-calendar-empty]')!
    await act(async () => { buttonNamed(empty, 'Add action')!.click() })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('offers Clear filters only when chosen filters hide existing actions', async () => {
    await mount([action()])
    expect(container.textContent).not.toContain('No actions match these filters')
    readPlanningViewState().calendarSearch.value = 'prune'
    await act(async () => {})
    expect(container.textContent).toContain('No actions match these filters')
    expect(container.textContent).not.toContain('No actions yet')
    await act(async () => { buttonNamed(container, 'Clear filters')!.click() })
    expect(readPlanningViewState().calendarSearch.value).toBe('')
    expect(container.textContent).not.toContain('No actions match these filters')
  })

  it('points to completed actions when the default filter hides them all', async () => {
    await mount([action({ completed: true })])
    expect(container.textContent).not.toContain('No actions match these filters')
    expect(buttonNamed(container, 'Clear filters')).toBeUndefined()
    expect(container.textContent).toContain('Every action is done')
    await act(async () => { buttonNamed(container, 'Show completed')!.click() })
    expect(readPlanningViewState().calendarCompletion.value).toBe('all')
  })
})
