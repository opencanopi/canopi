import type { PlacedPlant } from '../types/design'

/**
 * Group placed plants by canonical name, resolving display names through
 * the localized names map with fallback to common_name then canonical_name.
 *
 * Shared by Planning Projection and other species-level read models.
 */
export function groupPlantsBySpecies(
  plants: readonly PlacedPlant[],
  localizedNames?: ReadonlyMap<string, string | null>,
): Map<string, { commonName: string; count: number }> {
  const grouped = new Map<string, { commonName: string; count: number }>()
  for (const plant of plants) {
    const existing = grouped.get(plant.canonical_name)
    if (existing) {
      existing.count += 1
      if (!existing.commonName && plant.common_name) existing.commonName = plant.common_name
    } else {
      const localized = localizedNames?.get(plant.canonical_name)
      grouped.set(plant.canonical_name, {
        commonName: localized ?? plant.common_name ?? plant.canonical_name,
        count: 1,
      })
    }
  }
  return grouped
}
