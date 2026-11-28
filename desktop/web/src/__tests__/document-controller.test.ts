import { beforeEach, describe, expect, it } from 'vitest'
import {
  editCurrentDesign,
  editDesignArray,
  reconcileCurrentDesign,
} from '../app/design-edit/core'
import { speciesBudgetTarget } from '../target'
import {
  designDirty,
  designSessionFixture,
  currentDesign,
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

describe('Design Edit core', () => {
  it('skips dirty revision when mutation returns the same design', () => {
    const design = currentDesign.value!

    const next = editCurrentDesign((current) => current)

    expect(next).toStrictEqual(design)
    expect(designDirty.value).toBe(false)
  })

  it('reconciles derived Design content without recording user intent', () => {
    reconcileCurrentDesign((design) => ({ ...design, name: 'updated' }))

    expect(currentDesign.value?.name).toBe('updated')
    expect(designDirty.value).toBe(false)
  })

  it('avoids dirty revision for no-op array updates', () => {
    editDesignArray('timeline', (timeline) => timeline)

    expect(designDirty.value).toBe(false)
  })

  it('records user intent for changed array updates', () => {
    editDesignArray('budget', () => [{
      target: speciesBudgetTarget('Quercus robur'),
      category: 'plants',
      description: 'Quercus robur',
      quantity: 1,
      unit_cost: 42,
      currency: 'EUR',
    }])

    expect(currentDesign.value?.budget).toHaveLength(1)
    expect(designDirty.value).toBe(true)
  })
})
