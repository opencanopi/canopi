import type { PanelTarget, SpeciesPanelTarget } from '../generated/contracts'

type Target = PanelTarget
type SpeciesTarget = SpeciesPanelTarget

export interface TargetScenePoint {
  readonly x: number
  readonly y: number
}

interface TargetPlantRef {
  readonly id: string
  readonly canonicalName: string
  readonly position?: TargetScenePoint
}

export interface TargetZoneRef {
  readonly id: string
  readonly zoneType?: string
  readonly points?: readonly TargetScenePoint[]
  readonly rotationDeg?: number
}

export interface TargetSceneInput {
  readonly plants: readonly TargetPlantRef[]
  readonly zones: readonly TargetZoneRef[]
}

export interface TargetSceneIndex {
  readonly plantsById: ReadonlyMap<string, TargetPlantRef>
  readonly plantIdsBySpecies: ReadonlyMap<string, readonly string[]>
  readonly zonesById: ReadonlyMap<string, TargetZoneRef>
}

type ResolvedTargetRef =
  | { readonly kind: 'plant'; readonly id: string; readonly plant: TargetPlantRef }
  | { readonly kind: 'zone'; readonly id: string; readonly zone: TargetZoneRef }

export interface TargetResolution {
  readonly plantIds: readonly string[]
  readonly zoneIds: readonly string[]
  readonly resolvedRefs: readonly ResolvedTargetRef[]
}

export const MANUAL_TARGET: Target = { kind: 'manual' }

export function speciesTarget(canonicalName: string): SpeciesTarget {
  return { kind: 'species', canonical_name: canonicalName }
}

export function isSpeciesTarget(target: Target): target is SpeciesTarget {
  return target.kind === 'species'
}

function targetKey(target: Target): string {
  switch (target.kind) {
    case 'placed_plant':
      return `placed_plant:${target.plant_id}`
    case 'species':
      return `species:${target.canonical_name}`
    case 'zone':
      return `zone:${target.zone_id}`
    case 'manual':
      return 'manual'
    case 'none':
      return 'none'
  }
}

function targetListsEqual(left: readonly Target[], right: readonly Target[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (targetKey(left[i]!) !== targetKey(right[i]!)) return false
  }
  return true
}

function targetsEqual(left: Target, right: Target): boolean {
  return targetKey(left) === targetKey(right)
}

export function indexTargetScene(scene: TargetSceneInput): TargetSceneIndex {
  const plantsById = new Map<string, TargetPlantRef>()
  const plantIdsBySpecies = new Map<string, string[]>()
  const zonesById = new Map<string, TargetZoneRef>()

  for (const plant of scene.plants) {
    plantsById.set(plant.id, plant)
    const speciesPlantIds = plantIdsBySpecies.get(plant.canonicalName) ?? []
    speciesPlantIds.push(plant.id)
    plantIdsBySpecies.set(plant.canonicalName, speciesPlantIds)
  }

  for (const zone of scene.zones) {
    zonesById.set(zone.id, zone)
  }

  return { plantsById, plantIdsBySpecies, zonesById }
}

export function resolveTargetsInScene(
  values: readonly Target[],
  index: TargetSceneIndex,
): TargetResolution {
  const seenFeatureKeys = new Set<string>()
  const plantIds: string[] = []
  const zoneIds: string[] = []
  const resolvedRefs: ResolvedTargetRef[] = []

  const addPlant = (id: string, plant: TargetPlantRef): void => {
    if (!plantIds.includes(id)) plantIds.push(id)
    const featureKey = `plant:${id}`
    if (seenFeatureKeys.has(featureKey)) return
    seenFeatureKeys.add(featureKey)
    resolvedRefs.push({ kind: 'plant', id, plant })
  }

  const addZone = (id: string, zone: TargetZoneRef): void => {
    if (!zoneIds.includes(id)) zoneIds.push(id)
    const featureKey = `zone:${id}`
    if (seenFeatureKeys.has(featureKey)) return
    seenFeatureKeys.add(featureKey)
    resolvedRefs.push({ kind: 'zone', id, zone })
  }

  for (const target of values) {
    switch (target.kind) {
      case 'species': {
        for (const plantId of index.plantIdsBySpecies.get(target.canonical_name) ?? []) {
          const plant = index.plantsById.get(plantId)
          if (plant) addPlant(plantId, plant)
        }
        break
      }
      case 'placed_plant': {
        const plant = index.plantsById.get(target.plant_id)
        if (plant) addPlant(target.plant_id, plant)
        break
      }
      case 'zone': {
        const zone = index.zonesById.get(target.zone_id)
        if (zone) addZone(target.zone_id, zone)
        break
      }
      case 'manual':
      case 'none':
        break
    }
  }

  return { plantIds, zoneIds, resolvedRefs }
}

export const targetIdentity = {
  species: speciesTarget,
  key: targetKey,
  equals: targetsEqual,
  listEquals: targetListsEqual,
  indexScene: indexTargetScene,
  resolve: resolveTargetsInScene,
} as const
