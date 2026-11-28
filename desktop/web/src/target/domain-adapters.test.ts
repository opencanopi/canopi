import { describe, expect, it } from 'vitest'
import type { BudgetItem } from '../types/design'
import {
  consortiumTarget,
  getBudgetHoverTarget,
  getBudgetSpeciesTarget,
  getConsortiumCanonicalName,
  speciesBudgetTarget,
} from './domain-adapters'

function budgetItem(target: BudgetItem['target']): BudgetItem {
  return {
    target,
    unit_cost: 10,
  }
}

describe('target/domain-adapters', () => {
  it('resolves known budget target kinds for hover and falls back to species for open-set kinds', () => {
    expect(getBudgetHoverTarget(budgetItem({ kind: 'species', canonical_name: 'Malus domestica' }), 'Fallback'))
      .toEqual({ kind: 'species', canonical_name: 'Malus domestica' })
    expect(getBudgetHoverTarget(budgetItem({ kind: 'placed_plant', plant_id: 'p-1' }), 'Fallback'))
      .toEqual({ kind: 'placed_plant', plant_id: 'p-1' })
    expect(getBudgetHoverTarget(budgetItem({ kind: 'zone', zone_id: 'z-1' }), 'Fallback'))
      .toEqual({ kind: 'zone', zone_id: 'z-1' })
    expect(getBudgetHoverTarget(budgetItem({ kind: 'layer', layer_name: 'Canopy' }), 'Fallback'))
      .toEqual({ kind: 'layer', layer_name: 'Canopy' })
    expect(getBudgetHoverTarget(budgetItem({ kind: 'annotation', annotation_id: 'a-1' }), 'Fallback'))
      .toEqual({ kind: 'annotation', annotation_id: 'a-1' })
    expect(getBudgetHoverTarget(budgetItem({ kind: 'group', group_id: 'g-1' }), 'Fallback'))
      .toEqual({ kind: 'group', group_id: 'g-1' })
    expect(getBudgetHoverTarget(budgetItem({ kind: 'irrigation_emitter', emitter_id: 'e-1' }), 'Malus domestica'))
      .toEqual(speciesBudgetTarget('Malus domestica'))
    expect(getBudgetHoverTarget(null, 'Malus domestica'))
      .toEqual(speciesBudgetTarget('Malus domestica'))
  })

  it('extracts species budget targets only for non-empty species lines', () => {
    expect(getBudgetSpeciesTarget(budgetItem({ kind: 'species', canonical_name: 'Malus domestica' })))
      .toEqual(consortiumTarget('Malus domestica'))
    expect(getBudgetSpeciesTarget(budgetItem({ kind: 'species', canonical_name: '' }))).toBeNull()
    expect(getBudgetSpeciesTarget(budgetItem({ kind: 'zone', zone_id: 'z-1' }))).toBeNull()
    expect(getConsortiumCanonicalName({
      target: { kind: 'species', canonical_name: 'Malus domestica' },
      stratum: 'emergent',
      start_phase: 0,
      end_phase: 2,
    })).toBe('Malus domestica')
  })
})
