import { speciesTarget } from './identity'
import type { PanelTarget, SpeciesPanelTarget } from '../generated/contracts'
import type { BudgetItem, Consortium } from '../types/design'

export function consortiumTarget(canonicalName: string): SpeciesPanelTarget {
  return speciesTarget(canonicalName)
}

export function speciesBudgetTarget(canonicalName: string): SpeciesPanelTarget {
  return speciesTarget(canonicalName)
}

function asPanelTarget(target: BudgetItem['target']): PanelTarget | null {
  if (target.kind === 'species' && typeof target.canonical_name === 'string' && target.canonical_name.length > 0) {
    return target as PanelTarget
  }
  if (target.kind === 'placed_plant' && typeof target.plant_id === 'string') return target as PanelTarget
  if (target.kind === 'zone' && typeof target.zone_id === 'string') return target as PanelTarget
  if (target.kind === 'layer' && typeof target.layer_name === 'string') return target as PanelTarget
  if (target.kind === 'annotation' && typeof target.annotation_id === 'string') return target as PanelTarget
  if (target.kind === 'group' && typeof target.group_id === 'string') return target as PanelTarget
  return null
}

export function getBudgetHoverTarget(item: BudgetItem | null | undefined, canonicalName: string): PanelTarget {
  return (item ? asPanelTarget(item.target) : null) ?? speciesBudgetTarget(canonicalName)
}

export function getBudgetSpeciesTarget(item: BudgetItem): SpeciesPanelTarget | null {
  if (item.target.kind !== 'species') return null
  if (typeof item.target.canonical_name !== 'string' || item.target.canonical_name.length === 0) return null
  return speciesTarget(item.target.canonical_name)
}

export function getConsortiumCanonicalName(consortium: Consortium): string {
  return consortium.target.canonical_name
}
