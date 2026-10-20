import { resolvePlantSymbolForPlant, type PlantSymbolId, type ScenePersistedState } from './runtime/scene'
import type { PlantDisplay } from './runtime/plant-display'
import { resolvePlantDisplayColor } from './runtime/plant-presentation'
import { isPlantLayerShown } from './runtime/scene-visuals'
import type { SpeciesCacheEntry } from './runtime/species-cache'

export interface PinnedPlantNameLegendEntry {
  readonly label: string
  readonly color: string
  readonly symbol: PlantSymbolId
  readonly count: number
}

export interface PinnedPlantNameLegendSource {
  getSceneSnapshot(): ScenePersistedState
  getLocalizedCommonNames(): ReadonlyMap<string, string | null>
  getSpeciesCache(): ReadonlyMap<string, SpeciesCacheEntry>
}

export function buildPinnedPlantNameLegendEntries(
  source: PinnedPlantNameLegendSource,
  display: PlantDisplay,
): PinnedPlantNameLegendEntry[] {
  const scene = source.getSceneSnapshot()
  // The canvas draws no plant, so no pinned name, on a hidden or fully transparent Plants layer (canopi-knon).
  if (!isPlantLayerShown(scene)) return []

  const localizedNames = source.getLocalizedCommonNames()
  const speciesCache = source.getSpeciesCache()
  const groups = new Map<string, PinnedPlantNameLegendEntry>()

  for (const plant of scene.plants) {
    if (plant.pinnedName !== true) continue

    const label = localizedNames.get(plant.canonicalName) ?? plant.commonName ?? plant.canonicalName
    // The canvas's colour: a plant without its own takes its stratum's from the species entries the runtime loaded.
    const color = resolvePlantDisplayColor(plant, speciesCache, display)
    const symbol = resolvePlantSymbolForPlant(plant, scene.plantSpeciesSymbols)
    const key = `${label}\u0000${symbol}\u0000${color}`
    const existing = groups.get(key)

    if (existing) {
      groups.set(key, { ...existing, count: existing.count + 1 })
      continue
    }

    groups.set(key, { label, color, symbol, count: 1 })
  }

  return [...groups.values()].sort(comparePinnedPlantNameLegendEntries)
}

function comparePinnedPlantNameLegendEntries(
  left: PinnedPlantNameLegendEntry,
  right: PinnedPlantNameLegendEntry,
): number {
  return (
    left.label.localeCompare(right.label)
    || left.symbol.localeCompare(right.symbol)
    || left.color.localeCompare(right.color)
  )
}
