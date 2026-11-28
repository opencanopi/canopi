import { beforeEach, describe, expect, it } from 'vitest'
import { addTimelineAction, deleteTimelineAction, updateTimelineAction } from '../app/design-edit'
import {
  designDirty,
  designSessionFixture,
  currentDesign,
  resetDirtyBaselines,
} from './support/design-session-state'

beforeEach(() => {
  designSessionFixture.file = {
    version: 9,
    name: 'test',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '',
    updated_at: '',
    extra: {},
  }
})

describe('Design Edit Timeline Actions', () => {
  it('adds actions with incrementing order', () => {
    addTimelineAction({
      id: 'a',
      start_date: '2026-04-01',
      end_date: '2026-04-02',
      action_type: 'plant',
      description: 'first',
      completed: false,
      recurrence: null,
      targets: [],
      depends_on: null,
    })
    addTimelineAction({
      id: 'b',
      start_date: '2026-04-03',
      end_date: '2026-04-04',
      action_type: 'water',
      description: 'second',
      completed: false,
      recurrence: null,
      targets: [],
      depends_on: null,
    })

    expect(currentDesign.value?.timeline.map((action) => action.order)).toEqual([0, 1])
    expect(designDirty.value).toBe(true)
  })

  it('does not dirty when an update is a no-op', () => {
    addTimelineAction({
      id: 'a',
      start_date: '2026-04-01',
      end_date: '2026-04-02',
      action_type: 'plant',
      description: 'first',
      completed: false,
      recurrence: null,
      targets: [],
      depends_on: null,
    })
    resetDirtyBaselines()

    updateTimelineAction('a', { description: 'first' })

    expect(designDirty.value).toBe(false)
  })

  it('deletes actions and marks the document dirty', () => {
    addTimelineAction({
      id: 'a',
      start_date: '2026-04-01',
      end_date: '2026-04-02',
      action_type: 'plant',
      description: 'first',
      completed: false,
      recurrence: null,
      targets: [],
      depends_on: null,
    })
    resetDirtyBaselines()

    deleteTimelineAction('a')

    expect(currentDesign.value?.timeline).toEqual([])
    expect(designDirty.value).toBe(true)
  })
})
