import type { PlacedPlant } from '../../types/design'
import type { PlantSymbolId } from '../../canvas/runtime/scene'
import { isEnglishFallbackName, type SpeciesKeyEntry } from '../../canvas/runtime/species-key'
import type { LocaleKey } from '../../generated/locale-keys'

export type ActionType = 'planting' | 'pruning' | 'harvest' | 'watering' | 'fertilising' | 'other'
export const ACTION_TYPES: readonly ActionType[] = ['planting', 'pruning', 'harvest', 'watering', 'fertilising', 'other']
/** Each action type's shown name. */
export const ACTION_TYPE_LABEL_KEYS = {
  planting: 'canvas.timeline.type_planting',
  pruning: 'canvas.timeline.type_pruning',
  harvest: 'canvas.timeline.type_harvest',
  watering: 'canvas.timeline.type_watering',
  fertilising: 'canvas.timeline.type_fertilising',
  other: 'canvas.timeline.type_other',
} as const satisfies Record<ActionType, LocaleKey>

export interface TimelineSpeciesOption {
  readonly canonical_name: string
  readonly display_name: string
  /** The common name, or null when only the scientific name is known. */
  readonly common_name: string | null
  /** `common_name` is the English catalog name: none exists in the UI language. */
  readonly english_fallback: boolean
  readonly code: string
  readonly plant_count: number
  readonly appearance: { readonly symbol: PlantSymbolId; readonly color: string } | null
}

export function buildTimelineSpeciesOptions(
  plants: readonly PlacedPlant[],
  localizedNames: ReadonlyMap<string, string | null> | undefined,
  locale: string,
  speciesKey: readonly SpeciesKeyEntry[] = [],
  englishFallbackNames: ReadonlyMap<string, string> = new Map(),
): TimelineSpeciesOption[] {
  const identity = new Map(speciesKey.map((entry) => [entry.canonicalName, entry]))
  const byName = new Map<string, TimelineSpeciesOption>()

  for (const plant of plants) {
    const existing = byName.get(plant.canonical_name)
    if (existing) {
      byName.set(plant.canonical_name, { ...existing, plant_count: existing.plant_count + 1 })
      continue
    }
    const commonName = localizedNames?.get(plant.canonical_name) ?? plant.common_name ?? null
    const entry = identity.get(plant.canonical_name)
    byName.set(plant.canonical_name, {
      canonical_name: plant.canonical_name,
      display_name: commonName ?? plant.canonical_name,
      common_name: commonName,
      english_fallback: isEnglishFallbackName(englishFallbackNames, plant.canonical_name, commonName),
      code: entry?.code ?? '',
      plant_count: 1,
      appearance: entry?.appearances[0] ?? null,
    })
  }

  const result = [...byName.values()]
  result.sort((left, right) => left.display_name.localeCompare(right.display_name, locale))
  return result
}
