import type { TimelineAction } from '../generated/contracts'
// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  useCalendarWorkbench,
  type CalendarWorkbench,
} from '../app/timeline/calendar-workbench'
import { disposePlanningViewState } from '../app/planning-view/state'
import { calendarAddRequest, requestCalendarAdd } from '../app/timeline/calendar-request'
import { setCurrentCanvasSession } from '../canvas/session'
import { setCanvasSelection } from '../canvas/session-state'
import { MANUAL_TARGET, speciesTarget } from '../target'
import type { CanopiFile } from '../types/design'
import {
  currentDesign,
  designSessionFixture,
  nonCanvasRevision,
} from './support/design-session-state'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface, type TestCanvasQuerySurface } from './support/canvas-query-surface'

function action(overrides: Partial<TimelineAction> = {}): TimelineAction {
  return {
    id: 'same-id',
    action_type: 'planting',
    description: 'Original',
    start_date: '2026-09-12',
    end_date: '2026-09-13',
    recurrence: 'FREQ=YEARLY',
    targets: [speciesTarget('Malus domestica'), { kind: 'zone', zone_id: 'North bed' }],
    depends_on: ['earlier-action'],
    completed: false,
    order: 3,
    ...overrides,
  }
}

function design(name: string, timeline: TimelineAction[] = [action()]): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline,
    budget: [],
    budget_currency: 'EUR',
    extra: {},
    created_at: '',
    updated_at: '',
  }
}

describe('Calendar workbench', () => {
  let container: HTMLDivElement
  let workbench: CalendarWorkbench
  let queries: TestCanvasQuerySurface

  function Harness() {
    workbench = useCalendarWorkbench()
    return null
  }

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    disposePlanningViewState()
    designSessionFixture.file = design('Calendar one')
    designSessionFixture.nonCanvasRevision = 0
    queries = createTestCanvasQuerySurface()
    setCanvasSelection([])
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries }))
    await act(async () => { render(<Harness />, container) })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
    setCanvasSelection([])
  })

  it('preserves mixed targets, recurrence, dependencies, dates, order, and ID on ordinary edits', () => {
    act(() => {
      workbench.openEdit('same-id')
      workbench.updateDraft({ description: 'Revised' })
      expect(workbench.saveEditor()).toBe(true)
    })

    expect(currentDesign.value?.timeline[0]).toEqual(action({ description: 'Revised' }))
    expect(nonCanvasRevision.value).toBe(1)
  })

  it('patches only completion from the row checkbox', () => {
    const before = currentDesign.value!.timeline[0]!
    act(() => workbench.toggleCompleted('same-id', true))
    expect(currentDesign.value?.timeline[0]).toEqual({ ...before, completed: true })
  })

  it('creates a selected single day without an arbitrary end date', () => {
    act(() => {
      workbench.openAdd('2026-09-20')
      workbench.updateDraft({ description: 'New task', targets: [MANUAL_TARGET] })
      expect(workbench.saveEditor()).toBe(true)
    })
    expect(currentDesign.value?.timeline[1]).toMatchObject({
      description: 'New task',
      start_date: '2026-09-20',
      end_date: null,
      recurrence: null,
      depends_on: null,
      targets: [MANUAL_TARGET],
    })
  })

  it('snapshots the live canvas selection when selection targeting is chosen', () => {
    act(() => {
      queries.setSelection([{ kind: 'plant', id: 'first-selection' }])
      setCanvasSelection(['first-selection'])
    })
    act(() => workbench.openAdd('2026-09-20'))

    act(() => {
      queries.setSelection([{ kind: 'plant', id: 'replacement-selection' }])
      setCanvasSelection(['replacement-selection'])
      workbench.setTargetMode('selection')
    })

    expect(workbench.editor?.draft.targets).toEqual([
      { kind: 'placed_plant', plant_id: 'replacement-selection' },
    ])
  })

  it('opens a new action aimed at the map selection or one zone when the right-click menu asks', async () => {
    act(() => {
      queries.setSelection([{ kind: 'plant', id: 'apple-1' }])
      setCanvasSelection(['apple-1'])
    })
    await act(async () => { requestCalendarAdd({ kind: 'selected-plants' }) })

    expect(calendarAddRequest.value).toBeNull()
    expect(workbench.editor).toMatchObject({ mode: 'add', draft: { targetMode: 'selection' } })
    expect(workbench.editor?.draft.targets).toEqual([{ kind: 'placed_plant', plant_id: 'apple-1' }])

    act(() => workbench.cancelEditor())
    await act(async () => { requestCalendarAdd({ kind: 'zone', zoneId: 'North bed' }) })
    expect(workbench.editor?.draft).toMatchObject({ targetMode: 'zone', targets: [{ kind: 'zone', zone_id: 'North bed' }] })
  })

  it('drops a request from another Design session', async () => {
    await act(async () => {
      calendarAddRequest.value = { target: { kind: 'selected-plants' }, sessionIdentity: {} }
    })
    expect(calendarAddRequest.value).toBeNull()
    expect(workbench.editor).toBeNull()
  })

  it('rejects reversed dates and an explicitly empty target mode without writing', () => {
    act(() => {
      workbench.openEdit('same-id')
      workbench.updateDraft({ start_date: '2026-09-20', end_date: '2026-09-10' })
      expect(workbench.saveEditor()).toBe(false)
    })
    expect(workbench.editorError).toBe('date-order')
    expect(nonCanvasRevision.value).toBe(0)

    act(() => {
      workbench.updateDraft({ end_date: '2026-09-20' })
      workbench.setTargetMode('species')
      expect(workbench.saveEditor()).toBe(false)
    })
    expect(workbench.editorError).toBe('empty-targets')
    expect(nonCanvasRevision.value).toBe(0)
  })

  it('deletes the edited saved action through Design Edit', () => {
    act(() => {
      workbench.openEdit('same-id')
      workbench.deleteEditorAction()
    })

    expect(currentDesign.value?.timeline).toEqual([])
    expect(nonCanvasRevision.value).toBe(1)
  })

  it('cannot write an open draft into a replacement Design with a repeated action ID', async () => {
    act(() => {
      workbench.openEdit('same-id')
      workbench.updateDraft({ description: 'Stale draft' })
    })
    await act(async () => {
      designSessionFixture.file = design('Calendar two', [action({ description: 'Successor' })])
    })

    expect(workbench.editor).toBeNull()
    expect(workbench.saveEditor()).toBe(false)
    expect(currentDesign.value?.timeline[0]?.description).toBe('Successor')
  })
})
