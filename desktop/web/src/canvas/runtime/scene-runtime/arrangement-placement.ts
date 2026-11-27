import { createUuid } from '../../../utils/ids'
import type { SavedObjectStampPayload } from '../../saved-object-stamp-payload'
import { isEllipseZoneWithRadii } from './selection-rotation'
import type {
  SceneAnnotationEntity,
  SceneDesignObjectTarget,
  SceneMeasurementGuideEntity,
  SceneObjectGroupEntity,
  SceneObjectGroupMember,
  ScenePersistedState,
  ScenePlantEntity,
  ScenePoint,
  SceneZoneEntity,
} from '../scene'
import {
  dedupeSceneObjectGroupMembers,
  sceneObjectGroupMemberKey,
} from '../scene'
import type { SceneEditCoordinator } from './transactions'

interface SceneArrangementPrototype<T> {
  readonly sourceId: string
  readonly entity: T
}

export interface SceneArrangementTemplate {
  readonly plants: readonly SceneArrangementPrototype<ScenePlantEntity>[]
  readonly zones: readonly SceneArrangementPrototype<SceneZoneEntity>[]
  readonly annotations: readonly SceneArrangementPrototype<SceneAnnotationEntity>[]
  readonly measurementGuides: readonly SceneArrangementPrototype<SceneMeasurementGuideEntity>[]
  readonly groups: readonly SceneArrangementPrototype<SceneObjectGroupEntity>[]
}

interface SceneArrangementPlacementInput {
  readonly template: SceneArrangementTemplate
  readonly translateBy: ScenePoint
  readonly historyType: string
  readonly onCommitted?: () => void
  /** Preserve per-object `locked` flags from the template (used by saved stamps, 2.1-M88). */
  readonly preserveLocks?: boolean
  /** Optional fill-only species metadata merger (colors, symbols, Q168 codes) applied in the same Scene transaction. */
  readonly mergeSpecies?: (draft: ScenePersistedState) => void
  /** When placing a saved object stamp, pass its payload so Session Core records one compound Scene+Document entry. */
  readonly savedStamp?: SavedObjectStampPayload
}

interface SceneArrangementPlacementReceipt {
  readonly committed: boolean
  readonly createdCount: number
  readonly selectedTopLevelTargets: readonly SceneDesignObjectTarget[]
}

export interface SceneArrangementPlacement {
  place(input: SceneArrangementPlacementInput): SceneArrangementPlacementReceipt
}

export interface SceneArrangementPlacementDeps {
  readonly sceneEdits: SceneEditCoordinator
  readonly createId?: () => string
}

export function createSceneArrangementPlacement({
  sceneEdits,
  createId = createUuid,
}: SceneArrangementPlacementDeps): SceneArrangementPlacement {
  return {
    place({ template, translateBy, historyType, onCommitted, preserveLocks = false, mergeSpecies, savedStamp }): SceneArrangementPlacementReceipt {
      let createdCount = 0
      let selectedTopLevelTargets: SceneDesignObjectTarget[] = []
      let idRemap: ReadonlyMap<string, string> = new Map()
      const committed = sceneEdits.run(historyType, (tx) => {
        tx.mutate((draft) => {
          const placement = materializeSceneArrangement(draft, template, translateBy, createId, preserveLocks)
          appendPlacement(draft, placement)
          mergeSpecies?.(draft)
          createdCount = placement.createdCount
          selectedTopLevelTargets = placement.selectedTopLevelTargets
          idRemap = placement.idRemap
        })
        if (selectedTopLevelTargets.length > 0) tx.setSelection(selectedTopLevelTargets)
      }, {
        onCommitted,
        ...(savedStamp ? { savedStamp: { payload: savedStamp, getIdRemap: () => idRemap } } : {}),
      })

      return { committed, createdCount, selectedTopLevelTargets }
    },
  }
}

interface MaterializedSceneArrangement {
  readonly plants: ScenePlantEntity[]
  readonly zones: SceneZoneEntity[]
  readonly annotations: SceneAnnotationEntity[]
  readonly measurementGuides: SceneMeasurementGuideEntity[]
  readonly groups: SceneObjectGroupEntity[]
  readonly selectedTopLevelTargets: SceneDesignObjectTarget[]
  readonly createdCount: number
  readonly idRemap: ReadonlyMap<string, string>
}

function materializeSceneArrangement(
  draft: ScenePersistedState,
  template: SceneArrangementTemplate,
  translateBy: ScenePoint,
  createId: () => string,
  preserveLocks: boolean,
): MaterializedSceneArrangement {
  const reservedIds = existingSceneIds(draft)
  const sourceToCloneId = new Map<string, string>()

  const plants = template.plants.map(({ sourceId, entity }): ScenePlantEntity => {
    const id = allocateUniqueId(reservedIds, createId)
    sourceToCloneId.set(sceneObjectGroupMemberKey({ kind: 'plant', id: sourceId }), id)
    return {
      ...entity,
      id,
      locked: preserveLocks ? Boolean(entity.locked) : false,
      position: translatePoint(entity.position, translateBy),
    }
  })

  const zones = template.zones.map(({ sourceId, entity }): SceneZoneEntity => {
    // A copy is a new zone: a new identity, the same display name.
    const id = allocateUniqueId(reservedIds, () => `zone-${createId()}`)
    sourceToCloneId.set(sceneObjectGroupMemberKey({ kind: 'zone', id: sourceId }), id)
    return {
      ...entity,
      id,
      locked: preserveLocks ? Boolean(entity.locked) : false,
      points: translateZonePoints(entity, translateBy),
    }
  })

  const annotations = template.annotations.map(({ sourceId, entity }): SceneAnnotationEntity => {
    const id = allocateUniqueId(reservedIds, createId)
    sourceToCloneId.set(sceneObjectGroupMemberKey({ kind: 'annotation', id: sourceId }), id)
    return {
      ...entity,
      id,
      locked: preserveLocks ? Boolean(entity.locked) : false,
      position: translatePoint(entity.position, translateBy),
    }
  })

  const measurementGuides = template.measurementGuides.map(({ sourceId, entity }): SceneMeasurementGuideEntity => {
    const id = allocateUniqueId(reservedIds, () => `measurement-guide-${createId()}`)
    sourceToCloneId.set(sceneObjectGroupMemberKey({ kind: 'measurement-guide', id: sourceId }), id)
    return {
      ...entity,
      id,
      locked: preserveLocks ? Boolean(entity.locked) : false,
      start: translatePoint(entity.start, translateBy),
      end: translatePoint(entity.end, translateBy),
    }
  })

  const groupedMemberKeys = new Set<string>()
  const groups = template.groups
    .map(({ entity }): SceneObjectGroupEntity | null => {
      const members = dedupeSceneObjectGroupMembers(
        entity.members
          .map((member): SceneObjectGroupMember | null => {
            const cloneId = sourceToCloneId.get(sceneObjectGroupMemberKey(member))
            if (!cloneId) return null
            return member.unknownFields
              ? { kind: member.kind, id: cloneId, unknownFields: structuredClone(member.unknownFields) }
              : { kind: member.kind, id: cloneId }
          })
          .filter((member): member is SceneObjectGroupMember => member !== null),
      )
      if (members.length < 2) return null
      for (const member of members) groupedMemberKeys.add(sceneObjectGroupMemberKey(member))
      return {
        ...entity,
        id: allocateUniqueId(reservedIds, createId),
        locked: preserveLocks ? Boolean(entity.locked) : false,
        members,
      }
    })
    .filter((group): group is SceneObjectGroupEntity => group !== null)

  const selectedTopLevelTargets: SceneDesignObjectTarget[] = groups.map((group) => ({
    kind: 'group',
    id: group.id,
  }))
  addUngroupedSelection(selectedTopLevelTargets, groupedMemberKeys, plants, zones, annotations)
  for (const guide of measurementGuides) {
    if (!groupedMemberKeys.has(sceneObjectGroupMemberKey({ kind: 'measurement-guide', id: guide.id }))) {
      selectedTopLevelTargets.push({ kind: 'measurement-guide', id: guide.id })
    }
  }

  return {
    plants,
    zones,
    annotations,
    measurementGuides,
    groups,
    selectedTopLevelTargets,
    createdCount: plants.length + zones.length + annotations.length + measurementGuides.length + groups.length,
    idRemap: sourceToCloneId,
  }
}

function appendPlacement(draft: ScenePersistedState, placement: MaterializedSceneArrangement): void {
  draft.plants = [...draft.plants, ...placement.plants]
  draft.zones = [...draft.zones, ...placement.zones]
  draft.annotations = [...draft.annotations, ...placement.annotations]
  draft.measurementGuides = [...draft.measurementGuides, ...placement.measurementGuides]
  draft.groups = [...draft.groups, ...placement.groups]
}

function addUngroupedSelection(
  selection: SceneDesignObjectTarget[],
  groupedMemberKeys: ReadonlySet<string>,
  plants: readonly ScenePlantEntity[],
  zones: readonly SceneZoneEntity[],
  annotations: readonly SceneAnnotationEntity[],
): void {
  for (const plant of plants) {
    if (!groupedMemberKeys.has(sceneObjectGroupMemberKey({ kind: 'plant', id: plant.id }))) {
      selection.push({ kind: 'plant', id: plant.id })
    }
  }
  for (const zone of zones) {
    if (!groupedMemberKeys.has(sceneObjectGroupMemberKey({ kind: 'zone', id: zone.id }))) {
      selection.push({ kind: 'zone', id: zone.id })
    }
  }
  for (const annotation of annotations) {
    if (!groupedMemberKeys.has(sceneObjectGroupMemberKey({ kind: 'annotation', id: annotation.id }))) {
      selection.push({ kind: 'annotation', id: annotation.id })
    }
  }
}

function existingSceneIds(scene: ScenePersistedState): Set<string> {
  return new Set([
    ...scene.plants.map((plant) => plant.id),
    ...scene.zones.map((zone) => zone.id),
    ...scene.annotations.map((annotation) => annotation.id),
    ...scene.measurementGuides.map((guide) => guide.id),
    ...scene.groups.map((group) => group.id),
  ])
}

function allocateUniqueId(reservedIds: Set<string>, createId: () => string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = createId()
    if (reservedIds.has(id)) continue
    reservedIds.add(id)
    return id
  }
  throw new Error('Unable to allocate a unique Scene arrangement identity')
}

export function translatePoint(point: ScenePoint, delta: ScenePoint): ScenePoint {
  return { x: point.x + delta.x, y: point.y + delta.y }
}

/** Moves a zone's points; an ellipse keeps its radii (the second point) as they are. */
export function translateZonePoints(
  zone: Pick<SceneZoneEntity, 'zoneType' | 'points'>,
  delta: ScenePoint,
): ScenePoint[] {
  if (isEllipseZoneWithRadii(zone)) {
    return zone.points.map((point, index) => index === 1 ? { ...point } : translatePoint(point, delta))
  }
  return zone.points.map((point) => translatePoint(point, delta))
}

