import { describe, expect, it } from 'vitest'
import {
  getBudgetHoverTarget,
  getBudgetSpeciesTarget,
  speciesBudgetTarget,
} from '../target'
import type { BudgetItem } from '../types/design'

function makeBudgetItem(overrides: Partial<BudgetItem> = {}): BudgetItem {
  return {
    target: speciesBudgetTarget('Malus domestica'),
    unit_cost: 5,
    ...overrides,
  }
}

describe('panel target hover helpers', () => {
  it('prefers the existing budget item target for hover', () => {
    const target = { kind: 'placed_plant', plant_id: 'plant-1' } as const
    const item = makeBudgetItem({ target })

    expect(getBudgetHoverTarget(item, 'Malus domestica')).toEqual(target)
  })

  it('falls back to a species budget target for grouped plant rows without budget items', () => {
    expect(getBudgetHoverTarget(null, 'Malus domestica')).toEqual(speciesBudgetTarget('Malus domestica'))
  })

  it('only returns species targets for plant budget items', () => {
    expect(getBudgetSpeciesTarget(makeBudgetItem())).toEqual(speciesBudgetTarget('Malus domestica'))
    expect(getBudgetSpeciesTarget(makeBudgetItem({ target: { kind: 'materials', canonical_name: 'Malus domestica' } }))).toBeNull()
  })
})
