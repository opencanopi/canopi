import { groupPlantsBySpecies } from '../../canvas/plant-grouping'
import type { PlantSymbolId } from '../../canvas/runtime/scene'
import { isEnglishFallbackName, type SpeciesKeyEntry } from '../../canvas/runtime/species-key'
import { getBudgetHoverTarget, getBudgetSpeciesTarget } from '../../target'
import type { PanelTarget, BudgetItem, PlacedPlant } from '../../types/design'
import type { BudgetSort } from '../planning-view/state'

export interface BudgetPlanningRow {
  readonly canonical: string
  readonly commonName: string
  /** `commonName` is the English catalog name: none exists in the UI language. */
  readonly englishFallback: boolean
  readonly code: string
  readonly appearances: readonly { readonly symbol: PlantSymbolId; readonly color: string }[]
  readonly count: number
  readonly target: PanelTarget
  readonly item: BudgetItem | null
  readonly hasPrice: boolean
  readonly unitCost: number
  readonly subtotal: number
}

export interface BudgetPlanningProjection {
  readonly rows: readonly BudgetPlanningRow[]
  readonly lineItemPriceMap: ReadonlyMap<string, { unit_cost: number }>
  readonly itemByCanonical: ReadonlyMap<string, BudgetItem>
  readonly totalPlants: number
  readonly pricedCount: number
  readonly grandTotal: number
}

export interface BudgetListProjection {
  readonly rows: readonly BudgetPlanningRow[]
  readonly shownSubtotal: number
  readonly restricted: boolean
}

export interface BuildBudgetPlanningProjectionOptions {
  readonly plants: readonly PlacedPlant[]
  /** Names in the UI language, with English fallbacks filled in. */
  readonly localizedNames?: ReadonlyMap<string, string | null>
  readonly englishFallbackNames?: ReadonlyMap<string, string>
  readonly budget: readonly BudgetItem[]
  readonly locale: string
  readonly speciesKey?: readonly SpeciesKeyEntry[]
}

export function buildBudgetPlanningProjection({
  plants,
  localizedNames,
  englishFallbackNames = new Map(),
  budget,
  locale,
  speciesKey = [],
}: BuildBudgetPlanningProjectionOptions): BudgetPlanningProjection {
  const itemByCanonical = new Map<string, BudgetItem>()
  const lineItemPriceMap = new Map<string, { unit_cost: number }>()

  for (const item of budget) {
    const target = getBudgetSpeciesTarget(item)
    if (!target) continue
    itemByCanonical.set(target.canonical_name, item)
    lineItemPriceMap.set(target.canonical_name, {
      unit_cost: item.unit_cost,
    })
  }

  const grouped = groupPlantsBySpecies(plants, localizedNames)
  const identityByCanonical = new Map(speciesKey.map((entry) => [entry.canonicalName, entry]))
  const rows = Array.from(grouped.entries())
    .map(([canonical, value]): BudgetPlanningRow => {
      const item = itemByCanonical.get(canonical) ?? null
      const price = lineItemPriceMap.get(canonical)
      const identity = identityByCanonical.get(canonical)
      const unitCost = price?.unit_cost ?? 0
      const commonName = identity?.commonName ?? value.commonName
      return {
        canonical,
        commonName,
        englishFallback: isEnglishFallbackName(englishFallbackNames, canonical, commonName),
        code: identity?.code ?? '',
        appearances: identity?.appearances ?? [],
        count: value.count,
        target: getBudgetHoverTarget(item, canonical),
        item,
        hasPrice: price !== undefined,
        unitCost,
        subtotal: value.count * unitCost,
      }
    })
    .sort((left, right) => (
      (left.commonName || left.canonical).localeCompare(right.commonName || right.canonical, locale)
    ))

  return {
    rows,
    lineItemPriceMap,
    itemByCanonical,
    totalPlants: rows.reduce((sum, row) => sum + row.count, 0),
    pricedCount: rows.filter((row) => row.hasPrice).length,
    grandTotal: rows.reduce((sum, row) => sum + row.subtotal, 0),
  }
}

export function buildBudgetListProjection(
  projection: BudgetPlanningProjection,
  options: {
    /** Species the finder matched; null when the finder is empty. */
    readonly matches: ReadonlySet<string> | null
    /** Species selected on the map; null when that filter is off. */
    readonly selectedSpecies: ReadonlySet<string> | null
    /** Species passing the Stratum and Form quick filters; null when neither is chosen. */
    readonly quickFilterSpecies?: ReadonlySet<string> | null
    readonly missingPriceOnly: boolean
    readonly sort: BudgetSort
    readonly locale: string
  },
): BudgetListProjection {
  const nameOrder = (left: BudgetPlanningRow, right: BudgetPlanningRow): number => {
    const localized = (left.commonName || left.canonical).localeCompare(
      right.commonName || right.canonical,
      options.locale,
    )
    return localized || left.canonical.localeCompare(right.canonical)
  }
  const rows = projection.rows
    .filter((row) => (
      (!options.missingPriceOnly || !row.hasPrice)
      && (!options.matches || options.matches.has(row.canonical))
      && (!options.selectedSpecies || options.selectedSpecies.has(row.canonical))
      && (!options.quickFilterSpecies || options.quickFilterSpecies.has(row.canonical))
    ))
    .sort((left, right) => {
      if (options.sort === 'highest-total') {
        if (left.hasPrice !== right.hasPrice) return left.hasPrice ? -1 : 1
        if (left.hasPrice && right.hasPrice && left.subtotal !== right.subtotal) {
          return right.subtotal - left.subtotal
        }
      }
      if (options.sort === 'most-plants' && left.count !== right.count) {
        return right.count - left.count
      }
      return nameOrder(left, right)
    })

  return {
    rows,
    shownSubtotal: rows.reduce((sum, row) => sum + (row.hasPrice ? row.subtotal : 0), 0),
    restricted: options.missingPriceOnly || options.matches !== null || options.selectedSpecies !== null,
  }
}
