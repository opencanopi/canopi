import { isSpeciesTarget, speciesTarget } from './identity'
import type { BudgetItem, Consortium, PanelTarget, SpeciesPanelTarget } from '../generated/contracts'

export function consortiumTarget(canonicalName: string): SpeciesPanelTarget {
  return speciesTarget(canonicalName)
}

export function speciesBudgetTarget(canonicalName: string): SpeciesPanelTarget {
  return speciesTarget(canonicalName)
}

export function getBudgetHoverTarget(item: BudgetItem | null | undefined, canonicalName: string): PanelTarget {
  return item?.target ?? speciesBudgetTarget(canonicalName)
}

export function getBudgetSpeciesTarget(item: BudgetItem): SpeciesPanelTarget | null {
  if (item.category !== 'plants') return null
  return isSpeciesTarget(item.target) ? item.target : null
}

export function getConsortiumCanonicalName(consortium: Consortium): string {
  return consortium.target.canonical_name
}
