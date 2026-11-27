import { resolvePlantSymbolForPlant, type PlantSymbolId, type ScenePersistedState } from './runtime/scene'
import type { PlantDisplay } from './runtime/plant-display'
import { resolvePlantDisplayColor } from './runtime/plant-presentation'
import { isPlantLayerShown } from './runtime/scene-visuals'
import { compareSpeciesByShownName } from '../utils/species-sort'

export interface PinnedPlantNameLegendEntry {
  readonly label: string
  readonly canonicalName?: string
  readonly color: string
  readonly symbol: PlantSymbolId
  readonly count: number
}

export interface PinnedPlantNameLegendSource {
  getSceneSnapshot(): ScenePersistedState
  getLocalizedCommonNames(): ReadonlyMap<string, string | null>
}

export function buildPinnedPlantNameLegendEntries(
  source: PinnedPlantNameLegendSource,
  display: PlantDisplay,
  locale: string,
): PinnedPlantNameLegendEntry[] {
  const scene = source.getSceneSnapshot()
  // The canvas draws no plant, so no pinned name, on a hidden or fully transparent Plants layer (canopi-knon).
  if (!isPlantLayerShown(scene)) return []

  const localizedNames = source.getLocalizedCommonNames()
  const groups = new Map<string, PinnedPlantNameLegendEntry>()

  for (const plant of scene.plants) {
    if (plant.pinnedName !== true) continue

    const label = localizedNames.get(plant.canonicalName) || plant.commonName || plant.canonicalName
    // The canvas's colour under the current plant display.
    const color = resolvePlantDisplayColor(plant, display)
    const symbol = resolvePlantSymbolForPlant(plant, scene.plantSpeciesSymbols)
    const key = `${label}\u0000${symbol}\u0000${color}`
    const existing = groups.get(key)

    if (existing) {
      groups.set(key, { ...existing, count: existing.count + 1 })
      continue
    }

    groups.set(key, { label, canonicalName: plant.canonicalName, color, symbol, count: 1 })
  }

  return [...groups.values()].sort((left, right) => comparePinnedPlantNameLegendEntries(left, right, locale))
}

function comparePinnedPlantNameLegendEntries(
  left: PinnedPlantNameLegendEntry,
  right: PinnedPlantNameLegendEntry,
  locale: string,
): number {
  return (
    compareSpeciesByShownName(
      { shownName: left.label, canonicalName: left.canonicalName ?? left.label },
      { shownName: right.label, canonicalName: right.canonicalName ?? right.label },
      locale,
    )
    || left.symbol.localeCompare(right.symbol)
    || left.color.localeCompare(right.color)
  )
}
