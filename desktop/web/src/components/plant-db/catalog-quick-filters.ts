import type { SpeciesFilter } from '../../types/species'
import type { SpeciesCatalogFilterStripView } from '../../app/plant-browser'
import { toggleArrayValue } from './filter-utils'
import type { LocaleKey } from '../../generated/locale-keys'

/** The minimum edibility rating the "Edible" quick filter asks for. */
const EDIBLE_QUICK_FILTER_MIN = 3

/**
 * The catalog's quick filters: the few an agroforestry designer reaches for first. Each
 * maps onto one filter from the Species Catalog Filter catalog and shows only when the
 * edition's catalog serves that filter (and, for a habit, offers that value).
 */
export interface CatalogQuickFilter {
  readonly id: string
  readonly labelKey: LocaleKey
  pressed(filters: SpeciesFilter): boolean
  toggle(filters: SpeciesFilter): Partial<SpeciesFilter>
}

function habitQuickFilter(value: string, labelKey: LocaleKey): CatalogQuickFilter {
  return {
    id: `habit-${value}`,
    labelKey,
    pressed: (filters) => filters.habit?.includes(value) ?? false,
    toggle: (filters) => ({ habit: toggleArrayValue(filters.habit, value) }),
  }
}

const QUICK_FILTERS: readonly (CatalogQuickFilter & { readonly available: (view: SpeciesCatalogFilterStripView) => boolean })[] = [
  {
    id: 'edible',
    labelKey: 'plantDb.quickEdible',
    available: (view) => view.controls.some((control) => control.filterKey === 'edibility_min'),
    pressed: (filters) => (filters.edibility_min ?? 0) >= EDIBLE_QUICK_FILTER_MIN,
    toggle: (filters) => ({
      edibility_min: (filters.edibility_min ?? 0) >= EDIBLE_QUICK_FILTER_MIN ? null : EDIBLE_QUICK_FILTER_MIN,
    }),
  },
  {
    id: 'nitrogen',
    labelKey: 'plantDb.quickNitrogen',
    available: (view) => view.controls.some((control) => control.filterKey === 'nitrogen_fixer'),
    pressed: (filters) => filters.nitrogen_fixer === true,
    toggle: (filters) => ({ nitrogen_fixer: filters.nitrogen_fixer === true ? null : true }),
  },
  ...([['Tree', 'plantDb.quickTrees'], ['Shrub', 'plantDb.quickShrubs']] as const).map(([value, labelKey]) => ({
    ...habitQuickFilter(value, labelKey),
    available: (view: SpeciesCatalogFilterStripView) => (
      view.controls.some((control) => control.filterKey === 'habit')
      && (view.options?.habits ?? []).includes(value)
    ),
  })),
]

export function catalogQuickFilters(view: SpeciesCatalogFilterStripView): readonly CatalogQuickFilter[] {
  return QUICK_FILTERS.filter((filter) => filter.available(view))
}
