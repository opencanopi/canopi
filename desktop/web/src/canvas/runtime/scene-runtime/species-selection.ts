import {
  getSceneGroupedMemberKeys,
  isSceneLayerEditable,
  normalizeSceneDesignObjectTargets,
  resolveSceneObjectGroupMembers,
  sceneTargetKey,
  type SceneDesignObjectSelection,
  type SceneDesignObjectTarget,
  type ScenePersistedState,
} from '../scene'
import type { SceneSelectionTarget } from './selection'

export function getSelectablePlantIdsForSpecies(
  scene: ScenePersistedState,
  canonicalName: string,
): string[] {
  if (!isSceneLayerEditable(scene, 'plants')) return []
  const groupedMemberKeys = getSceneGroupedMemberKeys(scene)

  return scene.plants
    .filter((plant) =>
      plant.canonicalName === canonicalName
      && !plant.locked
      && !groupedMemberKeys.has(sceneTargetKey({ kind: 'plant', id: plant.id })),
    )
    .map((plant) => plant.id)
}

export function applySpeciesSelection(
  currentSelection: SceneDesignObjectSelection,
  speciesPlantIds: readonly string[],
  additive: boolean,
): SceneDesignObjectTarget[] {
  const speciesTargets = speciesPlantIds.map((id): SceneDesignObjectTarget => ({ kind: 'plant', id }))
  if (!additive) return speciesTargets

  const next = new Map(currentSelection.map((target) => [sceneTargetKey(target), target]))
  const allSelected = speciesPlantIds.length > 0
    && speciesTargets.every((target) => next.has(sceneTargetKey(target)))
  for (const target of speciesTargets) {
    const key = sceneTargetKey(target)
    if (allSelected) next.delete(key)
    else next.set(key, target)
  }
  return normalizeSceneDesignObjectTargets(next.values())
}

export function getSameSpeciesReferenceCanonicalName(
  scene: ScenePersistedState,
  targets: readonly SceneSelectionTarget[],
): string | null {
  if (targets.length === 0) return null
  const canonicalNames = new Set<string>()
  const collectPlant = (plantId: string): boolean => {
    const plant = scene.plants.find((entry) => entry.id === plantId)
    if (!plant) return false
    canonicalNames.add(plant.canonicalName)
    return canonicalNames.size <= 1
  }
  for (const target of targets) {
    if (target.kind === 'plant') {
      if (!collectPlant(target.id)) return null
      continue
    }
    if (target.kind === 'group') {
      const group = scene.groups.find((entry) => entry.id === target.id)
      if (!group) return null
      const members = resolveSceneObjectGroupMembers(scene, group)
      if (members.length === 0) return null
      for (const member of members) {
        if (member.kind !== 'plant' || !collectPlant(member.id)) return null
      }
      continue
    }
    return null
  }
  return [...canonicalNames][0] ?? null
}
