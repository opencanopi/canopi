import { beforeEach, describe, expect, it } from 'vitest'
import { disposePlanningViewState, readPlanningViewState } from '../app/planning-view/state'
import { designSessionFixture, replaceCurrentDesignState } from './support/design-session-state'
import type { CanopiFile } from '../types/design'

function design(name: string): CanopiFile {
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
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    extra: {},
    created_at: '',
    updated_at: '',
  }
}

beforeEach(() => {
  disposePlanningViewState()
  replaceCurrentDesignState(design('One'), null, 'One')
})

describe('planning view state', () => {
  it('survives unmount-style reads and name updates in one Design session', () => {
    const first = readPlanningViewState()
    first.budgetSearch.value = 'apple'
    first.calendarScrollTop = 240

    designSessionFixture.name = 'Renamed'

    const retained = readPlanningViewState()
    expect(retained).toBe(first)
    expect(retained.budgetSearch.value).toBe('apple')
    expect(retained.calendarScrollTop).toBe(240)
  })

  it('resets all view state when a different Design session replaces it', () => {
    const first = readPlanningViewState()
    first.consortiumSearch.value = 'oak'
    first.calendarExpanded.value = true

    replaceCurrentDesignState(design('Two'), null, 'Two')

    const replacement = readPlanningViewState()
    expect(replacement).not.toBe(first)
    expect(replacement.consortiumSearch.value).toBe('')
    expect(replacement.calendarExpanded.value).toBe(false)
  })
})
