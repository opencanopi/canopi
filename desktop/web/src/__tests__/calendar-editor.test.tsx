// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarPanel } from '../components/panels/CalendarPanel'
import { disposePlanningViewState, readPlanningViewState } from '../app/planning-view/state'
import { locale } from '../app/settings/state'
import { sidePanel } from '../app/shell/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { speciesTarget } from '../target'
import type { CanopiFile, PlacedPlant, TimelineAction } from '../types/design'
import { currentDesign, designSessionFixture } from './support/design-session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { dropdownTrigger } from './support/dropdown-trigger'
import { createDefaultScenePersistedState, type ScenePersistedState } from '../canvas/runtime/scene'

const plants: PlacedPlant[] = [
  plant('apple', 'Malus domestica', 'Apple'),
  plant('lavender', 'Lavandula angustifolia', 'English lavender'),
  plant('lavender-2', 'Lavandula angustifolia', 'English lavender'),
  plant('spike', 'Lavandula latifolia', 'Spike lavender'),
]

function plant(id: string, canonicalName: string, commonName: string): PlacedPlant {
  return {
    id,
    canonical_name: canonicalName,
    common_name: commonName,
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

function action(): TimelineAction {
  return {
    id: 'prune-apple',
    action_type: 'pruning',
    description: 'Prune apple\nLeave branch notes intact',
    start_date: '2026-09-08',
    end_date: '2026-09-11',
    recurrence: null,
    targets: [speciesTarget('Malus domestica')],
    depends_on: null,
    completed: false,
    order: 0,
  }
}

function design(): CanopiFile {
  return {
    version: 9,
    name: 'Calendar editor test',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [action()],
    budget: [],
    budget_currency: 'EUR',
    extra: {},
    created_at: '',
    updated_at: '',
  }
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === name)
  if (!result) throw new Error(`Missing button: ${name}`)
  return result
}

function sceneWithApple(): ScenePersistedState {
  return {
    ...createDefaultScenePersistedState(),
    plants: [{
      kind: 'plant',
      id: 'apple',
      locked: false,
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: '#3E8E4E',
      canopySpreadM: null,
      position: { x: 0, y: 0 },
      rotationDeg: null,
      notes: null,
      plantedDate: null,
      quantity: 1,
    }],
  }
}

describe('Calendar action editor', () => {
  let container: HTMLDivElement

  beforeEach(async () => {
    // The calendar opens on the current month and marks today: pin the clock
    // inside the fixture action's month so no test reads the real date.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-15T12:00:00'))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('scrollTo', () => {})
    if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {}
    container = document.createElement('div')
    document.body.appendChild(container)
    locale.value = 'en'
    disposePlanningViewState()
    designSessionFixture.file = design()
    // A new file starts a new session with fresh planning view state, so the
    // month is set after it; set before, it was discarded.
    readPlanningViewState().calendarMonth.value = '2026-09-01'
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({
        plants,
        localizedNames: new Map([
          ['Malus domestica', 'Apple'],
          ['Lavandula angustifolia', 'English lavender'],
        ]),
      }),
    }))
    sidePanel.value = 'calendar'
    await act(async () => { render(<CalendarPanel />, container) })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
    sidePanel.value = null
    disposePlanningViewState()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function openEdit(): Promise<HTMLElement> {
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-calendar-action]')!.click()
    })
    return container.querySelector<HTMLElement>('[role="dialog"]')!
  }

  it('uses the accepted field hierarchy and explicit schedule modes', async () => {
    const editor = await openEdit()
    const text = editor.textContent ?? ''

    expect(container.querySelectorAll('header')).toHaveLength(1)
    expect(document.activeElement).toBe(editor.querySelector('[data-calendar-description]'))
    expect(text.indexOf('Description')).toBeLessThan(text.indexOf('Action type'))
    expect(text.indexOf('Targets')).toBeLessThan(text.indexOf('Completed'))
    const schedule = editor.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Schedule"]')!
    expect(schedule).not.toBeNull()
    expect([...schedule.querySelectorAll('[role="radio"]')].map((radio) => [radio.textContent, radio.getAttribute('aria-checked')]))
      .toEqual([['Range', 'true'], ['One day', 'false'], ['Unscheduled', 'false']])
    expect(editor.querySelector('[data-calendar-date-fields]')?.textContent).toContain('End inclusive')
    const completed = editor.querySelector<HTMLInputElement>('[data-calendar-completed] input[role="switch"]')!
    expect(completed).not.toBeNull()
    expect(completed.checked).toBe(false)
    await act(async () => { completed.click() })
    expect(editor.querySelector<HTMLInputElement>('[data-calendar-completed] input[role="switch"]')!.checked).toBe(true)
    await act(async () => { editor.querySelector<HTMLInputElement>('[data-calendar-completed] input[role="switch"]')!.click() })
    expect(editor.querySelector<HTMLInputElement>('[data-calendar-completed] input[role="switch"]')!.checked).toBe(false)

    await act(async () => { button(editor, 'One day').click() })
    expect(editor.querySelector('[data-calendar-date-fields]')?.textContent).not.toContain('End inclusive')
    expect(button(editor, 'One day').getAttribute('aria-checked')).toBe('true')
    await act(async () => { button(editor, 'Save').click() })
    expect(currentDesign.value?.timeline[0]?.end_date).toBeNull()
    expect(currentDesign.value?.timeline[0]?.completed).toBe(false)
    expect(currentDesign.value?.timeline[0]?.description).toBe('Prune apple\nLeave branch notes intact')

    const reopened = await openEdit()
    await act(async () => { button(reopened, 'Unscheduled').click() })
    expect(reopened.querySelector('[data-calendar-date-fields]')).toBeNull()
    await act(async () => { button(reopened, 'Save').click() })
    expect(currentDesign.value?.timeline[0]).toMatchObject({ start_date: null, end_date: null })
  })

  it('marks a species target shown by its English name in the agenda and the saved targets', async () => {
    render(null, container)
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({
        plants,
        localizedNames: new Map([['Malus domestica', null]]),
        englishFallbackNames: new Map([['Malus domestica', 'Apple']]),
      }),
    }))
    locale.value = 'fr'
    await act(async () => { render(<CalendarPanel />, container) })
    const row = container.querySelector<HTMLElement>('[data-calendar-agenda-action="prune-apple"]')!
    expect(row.querySelector('[lang="en"]')?.textContent).toBe('Apple')
    expect(row.textContent).toContain('(angl.)')
  })

  it('heads the editor with the shared panel header: Back, title and Close', async () => {
    const editor = await openEdit()
    const header = editor.querySelector('header')!
    expect(header.querySelector('h2')?.textContent).toBe('Edit action')
    const back = header.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!
    const close = header.querySelector<HTMLButtonElement>('button[aria-label="Close panel"]')!
    expect(back).not.toBeNull()
    expect(close).not.toBeNull()
    expect(back.compareDocumentPosition(header.querySelector('h2')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await act(async () => { back.click() })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(sidePanel.value).toBe('calendar')
    expect(document.activeElement).toBe(container.querySelector('button[data-calendar-action]'))

    const reopened = await openEdit()
    await act(async () => { reopened.querySelector<HTMLButtonElement>('header button[aria-label="Close panel"]')!.click() })
    expect(sidePanel.value).toBeNull()
  })

  it('offers a multi-line description with a placeholder and names the Whole Design target', async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>('button[data-calendar-add]')!.click() })
    const editor = container.querySelector<HTMLElement>('[role="dialog"]')!
    const description = editor.querySelector<HTMLTextAreaElement>('[data-calendar-description]')!
    expect(description.rows).toBeGreaterThanOrEqual(3)
    expect(description.placeholder).toBe('What needs doing? Add notes on the next lines.')
    expect(dropdownTrigger(editor, 'Targets')?.textContent).toContain('Whole Design')
  })

  it('picks species targets from a multi-select list with the plant finder, keyboard and Add all', async () => {
    const editor = await openEdit()
    const search = editor.querySelector<HTMLInputElement>('input[type="search"]')!
    const list = () => editor.querySelector<HTMLElement>('[role="listbox"]')!
    const option = (name: string) => editor.querySelector<HTMLElement>(`[role="option"][data-calendar-species-option="${name}"]`)!

    expect(list().getAttribute('aria-multiselectable')).toBe('true')
    expect(search.getAttribute('aria-controls')).toBe(list().id)
    expect(editor.textContent).toContain('1 species chosen · 1 plant')
    expect(option('Malus domestica').getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      search.value = 'lavendr'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...list().querySelectorAll('[role="option"]')].map((node) => node.getAttribute('data-calendar-species-option')))
      .toEqual(['Lavandula angustifolia', 'Lavandula latifolia'])
    expect(editor.textContent).toContain('2 species match “lavendr”')

    await act(async () => { button(editor, 'Add all 2').click() })
    expect(option('Lavandula latifolia').getAttribute('aria-selected')).toBe('true')
    expect(editor.textContent).toContain('3 species chosen · 4 plants')

    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.activeElement).toBe(option('Lavandula angustifolia'))
    await act(async () => { option('Lavandula angustifolia').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.activeElement).toBe(option('Lavandula latifolia'))
    await act(async () => { option('Lavandula latifolia').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    expect(option('Lavandula latifolia').getAttribute('aria-selected')).toBe('false')
    await act(async () => { option('Lavandula latifolia').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(option('Lavandula latifolia').getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      search.value = ''
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { option('Malus domestica').click() })
    expect(option('Malus domestica').getAttribute('aria-selected')).toBe('false')
    await act(async () => { button(editor, 'Save').click() })

    expect(currentDesign.value?.timeline[0]?.targets).toEqual([
      speciesTarget('Lavandula angustifolia'),
      speciesTarget('Lavandula latifolia'),
    ])
  })

  it('draws each species glyph in the colour the map draws it with', async () => {
    designSessionFixture.file = {
      ...design(),
      extra: { plant_display: { color_by: 'one_color', one_color: '#AA3355' } },
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ plants, scene: sceneWithApple() }),
    }))
    await act(async () => { render(null, container) })
    readPlanningViewState().calendarMonth.value = '2026-09-01'
    await act(async () => { render(<CalendarPanel />, container) })
    const editor = await openEdit()
    const glyph = editor.querySelector<HTMLElement>('[data-calendar-species-option="Malus domestica"] [aria-hidden="true"] > span[style]')

    expect(glyph?.style.color).toBe('rgb(170, 51, 85)')
  })

  it('moves focus into the editor and restores its trigger on Escape', async () => {
    const trigger = container.querySelector<HTMLButtonElement>('button[data-calendar-add]')!
    await act(async () => { trigger.click() })

    expect(document.activeElement).toBe(container.querySelector('[data-calendar-description]'))
    await act(async () => {
      container.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }))
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(container.querySelector('button[data-calendar-add]'))
  })

  it('keeps date and target popups outside the bounded editor scroll region', async () => {
    const editor = await openEdit()
    const targetTrigger = dropdownTrigger(editor, 'Targets')!

    await act(async () => { targetTrigger.click() })
    const targetMenu = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Targets"]')!
    expect(targetMenu).not.toBeNull()
    expect(editor.contains(targetMenu)).toBe(false)
    const selectionOption = [...targetMenu.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.startsWith('Current selection'))
    expect(selectionOption?.disabled).toBe(true)
    await act(async () => {
      targetMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.activeElement).toBe(targetTrigger)

    const startTrigger = editor.querySelector<HTMLButtonElement>('button[aria-label="Start"]')!
    await act(async () => { startTrigger.click() })
    const dateDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((candidate) => candidate !== editor)!
    expect(dateDialog).not.toBeNull()
    expect(editor.contains(dateDialog)).toBe(false)
    await act(async () => {
      dateDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.activeElement).toBe(startTrigger)
  })

  it('dismisses action type and date popups as part of committing a choice', async () => {
    const editor = await openEdit()
    const typeTrigger = dropdownTrigger(editor, 'Action type')!

    await act(async () => { typeTrigger.click() })
    let typeMenu = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Action type"]')!
    expect(editor.contains(typeMenu)).toBe(false)
    await act(async () => { button(typeMenu, 'Pruning').click() })
    expect(document.querySelector('[role="listbox"][aria-label="Action type"]')).toBeNull()
    expect(document.activeElement).toBe(typeTrigger)

    await act(async () => { typeTrigger.click() })
    typeMenu = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Action type"]')!
    await act(async () => { button(typeMenu, 'Harvest').click() })
    expect(document.querySelector('[role="listbox"][aria-label="Action type"]')).toBeNull()
    expect(document.activeElement).toBe(typeTrigger)

    const startTrigger = editor.querySelector<HTMLButtonElement>('button[aria-label="Start"]')!
    await act(async () => { startTrigger.click() })
    const dateDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((candidate) => candidate !== editor)!
    await act(async () => {
      dateDialog.querySelector<HTMLButtonElement>('button[data-day="9"]')!.click()
    })
    expect([...document.querySelectorAll<HTMLElement>('[role="dialog"]')]).toEqual([editor])
    expect(document.activeElement).toBe(startTrigger)

    const endTrigger = editor.querySelector<HTMLButtonElement>('button[aria-label="End inclusive"]')!
    await act(async () => { endTrigger.click() })
    const endDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((candidate) => candidate !== editor)!
    await act(async () => {
      endDialog.querySelector<HTMLButtonElement>('button[data-day="10"]')!.click()
    })
    expect([...document.querySelectorAll<HTMLElement>('[role="dialog"]')]).toEqual([editor])
    expect(document.activeElement).toBe(endTrigger)
  })

  it('names an unnamed zone by its type and area, never by its id', async () => {
    const unnamed = 'zone-ee08f9f9-634f-4723-bbde-1200610562dc'
    const deleted = 'zone-0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b'
    const scene: ScenePersistedState = {
      ...createDefaultScenePersistedState(),
      zones: [
        {
          kind: 'zone', id: unnamed, name: null, locked: false, zoneType: 'rect', rotationDeg: 0, fillColor: null, notes: null,
          points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 0, y: 10 }],
        },
        {
          kind: 'zone', id: 'zone-herb-spiral', name: 'Herb spiral', locked: false, zoneType: 'ellipse', rotationDeg: 0, fillColor: null, notes: null,
          points: [{ x: 0, y: 0 }, { x: 2, y: 2 }],
        },
      ],
    }
    designSessionFixture.file = {
      ...design(),
      timeline: [{ ...action(), targets: [{ kind: 'zone', zone_id: unnamed }] }, {
        ...action(), id: 'water-deleted', description: 'Water', order: 1, targets: [{ kind: 'zone', zone_id: deleted }],
      }],
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ scene, plants }),
    }))
    readPlanningViewState().calendarMonth.value = '2026-09-01'
    await act(async () => { render(<CalendarPanel />, container) })

    expect(container.textContent).not.toMatch(/zone-[0-9a-f]{8}/)
    expect(container.textContent).toContain('Rectangle zone · 120\u00a0m²')

    const editor = await openEdit()
    const zoneTrigger = dropdownTrigger(editor, 'Zone')!
    expect(zoneTrigger.textContent).toContain('Rectangle zone · 120\u00a0m²')
    await act(async () => { zoneTrigger.click() })
    const zoneMenu = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Zone"]')!
    expect([...zoneMenu.querySelectorAll('button')].map((option) => option.textContent))
      .toEqual(['Choose a zone', 'Rectangle zone · 120\u00a0m²', 'Herb spiral'])
    expect(document.body.textContent).not.toMatch(/zone-[0-9a-f]{8}/)
  })
})
