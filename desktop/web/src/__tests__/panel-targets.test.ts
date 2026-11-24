import { describe, expect, it } from 'vitest'
import {
  getBudgetHoverTarget,
  getBudgetSpeciesTarget,
  speciesBudgetTarget,
} from '../target'
import type { BudgetItem } from '../generated/contracts'

function makeBudgetItem(overrides: Partial<BudgetItem> = {}): BudgetItem {
  return {
    target: speciesBudgetTarget('Malus domestica'),
    category: 'plants',
    description: 'Malus domestica',
    quantity: 0,
    unit_cost: 5,
    currency: 'EUR',
    ...overrides,
  }
}

describe('panel target hover helpers', () => {
  it('prefers the existing budget item target for hover', () => {
    const target = { kind: 'placed_plant', plant_id: 'plant-1' } as const
    const item = makeBudgetItem({ target })

    expect(getBudgetHoverTarget(item, 'Malus domestica')).toBe(target)
  })

  it('falls back to a species budget target for grouped plant rows without budget items', () => {
    expect(getBudgetHoverTarget(null, 'Malus domestica')).toEqual(speciesBudgetTarget('Malus domestica'))
  })

  it('only returns species targets for plant budget items', () => {
    expect(getBudgetSpeciesTarget(makeBudgetItem())).toEqual(speciesBudgetTarget('Malus domestica'))
    expect(getBudgetSpeciesTarget(makeBudgetItem({ category: 'materials' }))).toBeNull()
  })
})
