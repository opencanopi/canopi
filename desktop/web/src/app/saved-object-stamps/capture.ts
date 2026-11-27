import type {
  CanvasDesignObjectSelectionModel,
  CanvasDesignObjectSelectionTarget,
} from '../../canvas/runtime/runtime'
import {
  resolvePlantSymbolForPlant,
  type SceneAnnotationEntity,
  type SceneObjectGroupEntity,
  type SceneObjectGroupMember,
  type ScenePersistedState,
  type ScenePlantEntity,
  type SceneZoneEntity,
} from '../../canvas/runtime/scene'
import type { CanvasRuntimeSavedObjectStampCapture } from '../../canvas/runtime/app-adapter'
import { canSaveSelectionAsObjectStamp } from '../../canvas/runtime/interaction/contextual-selection-actions'
import {
  SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION,
  type SavedObjectStampAnnotation,
  type SavedObjectStampPayload,
  type SavedObjectStampPlant,
  type SavedObjectStampZone,
} from '../../canvas/saved-object-stamp-payload'
import { defaultSavedObjectStampName } from './file'

export interface SavedObjectStampSelectionView {
  readonly canSave: boolean
  readonly reason: 'no-canvas' | 'empty-selection' | 'structural-blocker' | null
  readonly selectedCount: number
}

export interface NormalizedSelection {
  readonly name: string
  readonly payload: SavedObjectStampPayload
}

export function readSelectionModelView(
  selection: CanvasDesignObjectSelectionModel,
): SavedObjectStampSelectionView {
  const selectedCount = selection.editableTargets.length + selection.lockedTargets.length
  if (canSaveSelectionAsObjectStamp(selection)) return { canSave: true, reason: null, selectedCount }
  return {
    canSave: false,
    reason: selectedCount === 0 && selection.blockedTargets.length === 0
      ? 'empty-selection'
      : 'structural-blocker',
    selectedCount,
  }
}

export function normalizeSelection(capture: CanvasRuntimeSavedObjectStampCapture): NormalizedSelection | null {
  const selectionView = readSelectionModelView(capture.selection)
  if (!selectionView.canSave) return null

  const { scene, selection } = capture
  const selectedTargets = [...selection.editableTargets, ...selection.lockedTargets]
  const selected = collectSelectedConcreteTargets(scene, selectedTargets)
  const selectedGroups = collectSelectedGroups(scene, selectedTargets)
  const idMap = new Map<string, string>()

  const plants = scene.plants
    .filter((plant) => selected.plants.has(plant.id))
    .map((plant, index) => {
      const id = `plant-${index + 1}`
      idMap.set(concreteKey({ kind: 'plant', id: plant.id }), id)
      return savedPlantFromScene(plant, id, scene.plantSpeciesSymbols)
    })
  const zones = scene.zones
    .filter((zone) => selected.zones.has(zone.id))
    .map((zone, index) => {
      const id = `zone-${index + 1}`
      idMap.set(concreteKey({ kind: 'zone', id: zone.id }), id)
      return savedZoneFromScene(zone, id)
    })
  const annotations = scene.annotations
    .filter((annotation) => selected.annotations.has(annotation.id))
    .map((annotation, index) => {
      const id = `annotation-${index + 1}`
      idMap.set(concreteKey({ kind: 'annotation', id: annotation.id }), id)
      return savedAnnotationFromScene(annotation, id)
    })
  const measurementGuides = scene.measurementGuides
    .filter((guide) => selected.guides.has(guide.id))
    .map((guide, index) => {
      const id = `guide-${index + 1}`
      idMap.set(concreteKey({ kind: 'measurement-guide', id: guide.id }), id)
      return { id, start: { ...guide.start }, end: { ...guide.end }, ...(guide.locked ? { locked: true } : {}) }
    })
  const groups = selectedGroups.map((group, index) => ({
    id: `group-${index + 1}`,
    name: group.name,
    members: group.members
      .map((member) => remapGroupMember(member, idMap))
      .filter((member): member is SceneObjectGroupMember => member !== null),
  }))

  const includedSpecies = new Set(plants.map((plant) => plant.canonicalName))
  const plantSpeciesColors: Record<string, string> = {}
  const plantSpeciesSymbols: Record<string, string> = {}
  const plantSpeciesCodes: Record<string, string> = {}
  for (const species of includedSpecies) {
    if (scene.plantSpeciesColors[species]) plantSpeciesColors[species] = scene.plantSpeciesColors[species]!
    if (scene.plantSpeciesSymbols[species]) plantSpeciesSymbols[species] = scene.plantSpeciesSymbols[species]!
    if (scene.plantSpeciesCodes[species]) plantSpeciesCodes[species] = scene.plantSpeciesCodes[species]!
  }

  // 2.1-Q155 / 2.1-Q354: Save as stamp always captures matching care actions and species data.
  const design = capture.design ?? null
  const consortiums = design
    ? design.consortiums.flatMap((entry) => {
        const name = entry.target.kind === 'species' ? entry.target.canonical_name : ''
        return includedSpecies.has(name)
          ? [{ canonicalName: name, stratum: entry.stratum, startPhase: entry.start_phase, endPhase: entry.end_phase }]
          : []
      })
    : []
  const budget = design
    ? design.budget.flatMap((line) =>
        line.target.kind === 'species' && typeof line.target.canonical_name === 'string' && includedSpecies.has(line.target.canonical_name)
          ? [{ canonicalName: line.target.canonical_name, unitCost: line.unit_cost }]
          : [])
    : []
  const timeline = design
    ? design.timeline
        .filter((action) => action.targets.some((target) =>
          (target.kind === 'species' && includedSpecies.has(target.canonical_name))
          || (target.kind === 'placed_plant' && selected.plants.has(target.plant_id))
          || (target.kind === 'zone' && selected.zones.has(target.zone_id))))
        .map((action) => ({
          title: action.description,
          category: action.action_type,
          offsetDays: action.offset_days ?? null,
          notes: null,
          ...(action.recurrence ? { recurrence: action.recurrence } : {}),
          targets: action.targets.map((target) => {
            if (target.kind === 'placed_plant') {
              const remapped = idMap.get(concreteKey({ kind: 'plant', id: target.plant_id }))
              return remapped ? { kind: 'placed_plant', plant_id: remapped } : target
            }
            if (target.kind === 'zone') {
              const remapped = idMap.get(concreteKey({ kind: 'zone', id: target.zone_id }))
              return remapped ? { kind: 'zone', zone_id: remapped } : target
            }
            return target
          }),
        }))
    : []

  const payload: SavedObjectStampPayload = {
    version: SAVED_OBJECT_STAMP_PAYLOAD_V3_VERSION,
    anchor: selection.bounds
      ? {
          x: (selection.bounds.minX + selection.bounds.maxX) / 2,
          y: (selection.bounds.minY + selection.bounds.maxY) / 2,
        }
      : { x: 0, y: 0 },
    plants,
    zones,
    annotations,
    groups,
    ...(measurementGuides.length > 0 ? { measurementGuides } : {}),
    ...(Object.keys(plantSpeciesColors).length > 0 ? { plantSpeciesColors } : {}),
    ...(Object.keys(plantSpeciesSymbols).length > 0 ? { plantSpeciesSymbols } : {}),
    ...(Object.keys(plantSpeciesCodes).length > 0 ? { plantSpeciesCodes } : {}),
    ...(consortiums.length > 0 ? { consortiums } : {}),
    ...(budget.length > 0 ? { budget } : {}),
    ...(timeline.length > 0 ? { timeline } : {}),
  }
  return {
    name: defaultSavedObjectStampName(payload, capture.localizedCommonNames),
    payload,
  }
}

function collectSelectedConcreteTargets(
  scene: ScenePersistedState,
  targets: readonly CanvasDesignObjectSelectionTarget[],
): { plants: Set<string>; zones: Set<string>; annotations: Set<string>; guides: Set<string> } {
  const plants = new Set<string>()
  const zones = new Set<string>()
  const annotations = new Set<string>()
  const guides = new Set<string>()
  const groupById = new Map(scene.groups.map((group) => [group.id, group]))

  for (const target of targets) {
    if (target.kind === 'plant') plants.add(target.id)
    if (target.kind === 'zone') zones.add(target.id)
    if (target.kind === 'annotation') annotations.add(target.id)
    if (target.kind === 'measurement-guide') guides.add(target.id)
    if (target.kind === 'group') {
      for (const member of groupById.get(target.id)?.members ?? []) {
        if (member.kind === 'plant') plants.add(member.id)
        if (member.kind === 'zone') zones.add(member.id)
        if (member.kind === 'annotation') annotations.add(member.id)
        if (member.kind === 'measurement-guide') guides.add(member.id)
      }
    }
  }

  return { plants, zones, annotations, guides }
}

function collectSelectedGroups(
  scene: ScenePersistedState,
  targets: readonly CanvasDesignObjectSelectionTarget[],
): SceneObjectGroupEntity[] {
  const selectedGroupIds = new Set(targets.filter((target) => target.kind === 'group').map((target) => target.id))
  return scene.groups.filter((group) => selectedGroupIds.has(group.id))
}

function savedPlantFromScene(
  plant: ScenePlantEntity,
  id: string,
  plantSpeciesSymbols: Readonly<Record<string, string>>,
): SavedObjectStampPlant {
  return {
    id,
    canonicalName: plant.canonicalName,
    commonName: plant.commonName,
    color: plant.color,
    symbol: resolvePlantSymbolForPlant(plant, plantSpeciesSymbols),
    position: { ...plant.position },
    rotationDeg: plant.rotationDeg,
    scale: plant.canopySpreadM,
    ...(plant.locked ? { locked: true } : {}),
    ...(plant.pinnedName ? { pinnedName: true } : {}),
    ...(plant.notes != null ? { notes: plant.notes } : {}),
    ...(plant.plantedDate != null ? { plantedDate: plant.plantedDate } : {}),
    ...(plant.quantity != null && plant.quantity !== 1 ? { quantity: plant.quantity } : {}),
  }
}

function savedZoneFromScene(zone: SceneZoneEntity, id: string): SavedObjectStampZone {
  return {
    id,
    name: zone.name,
    zoneType: zone.zoneType,
    points: zone.points.map((point) => ({ ...point })),
    rotationDeg: zone.rotationDeg,
    fillColor: zone.fillColor,
    ...(zone.strokeColor != null ? { strokeColor: zone.strokeColor } : {}),
    ...(zone.opacity != null ? { opacity: zone.opacity } : {}),
    ...(zone.locked ? { locked: true } : {}),
    ...(zone.notes != null ? { notes: zone.notes } : {}),
  }
}

function savedAnnotationFromScene(annotation: SceneAnnotationEntity, id: string): SavedObjectStampAnnotation {
  return {
    id,
    annotationType: annotation.annotationType,
    position: { ...annotation.position },
    text: annotation.text,
    fontSize: annotation.fontSize,
    rotationDeg: annotation.rotationDeg,
    ...(annotation.locked ? { locked: true } : {}),
  }
}

function remapGroupMember(
  member: SceneObjectGroupMember,
  idMap: ReadonlyMap<string, string>,
): SceneObjectGroupMember | null {
  const id = idMap.get(concreteKey(member))
  if (!id) return null
  return { kind: member.kind, id }
}

function concreteKey(member: SceneObjectGroupMember): string {
  return `${member.kind}:${member.id}`
}
