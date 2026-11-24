import type {
  SceneAnnotationEntity,
  SceneMeasurementGuideEntity,
  SceneObjectGroupEntity,
  ScenePersistedState,
  ScenePlantEntity,
  ScenePoint,
  SceneZoneEntity,
} from '../scene'
import type { SessionPlane } from '../../../geo/session-plane'
import type { SceneSelectionTarget } from './selection'
import type { SceneArrangementTemplate } from './arrangement-placement'
import { resolveSceneObjectGroupMembers } from '../scene'

export interface SceneClipboardPayload {
  /** The session plane the metre positions below are expressed in. */
  plane: SessionPlane
  plants: ScenePlantEntity[]
  zones: SceneZoneEntity[]
  annotations: SceneAnnotationEntity[]
  measurementGuides: SceneMeasurementGuideEntity[]
  groups: SceneObjectGroupEntity[]
  sourceTargets: SceneSelectionTarget[]
}

export function createClipboardPayload(
  persisted: ScenePersistedState,
  selected: readonly SceneSelectionTarget[],
  plane: SessionPlane,
): SceneClipboardPayload | null {
  if (selected.length === 0) return null
  const { plantIds, zoneIds, annotationIds, measurementGuideIds, groupIds } = resolveSelectedEntitySets(persisted, selected)
  // `persisted` is the store's own fresh copy, so the payload takes its objects as they are.
  return {
    plane,
    plants: persisted.plants.filter((plant) => plantIds.has(plant.id)),
    zones: persisted.zones.filter((zone) => zoneIds.has(zone.id)),
    annotations: persisted.annotations.filter((annotation) => annotationIds.has(annotation.id)),
    measurementGuides: persisted.measurementGuides.filter((guide) => measurementGuideIds.has(guide.id)),
    groups: persisted.groups.filter((group) => groupIds.has(group.id)),
    sourceTargets: [...selected],
  }
}

/**
 * Copied objects keep their geographic position: a paste after a re-origin or
 * in another Design first moves the payload into the current plane through
 * lon/lat.
 */
export function reprojectClipboardPayload(
  payload: SceneClipboardPayload,
  plane: SessionPlane,
): SceneClipboardPayload {
  if (payload.plane === plane) return payload
  const point = (p: ScenePoint): ScenePoint => plane.toPlane(payload.plane.toGeo(p))
  const ellipse = (center: ScenePoint, radii: ScenePoint): [ScenePoint, ScenePoint] => {
    const min = point({ x: center.x - radii.x, y: center.y - radii.y })
    const max = point({ x: center.x + radii.x, y: center.y + radii.y })
    return [
      { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 },
      { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2 },
    ]
  }
  return {
    ...payload,
    plane,
    plants: payload.plants.map((plant) => ({ ...plant, position: point(plant.position) })),
    zones: payload.zones.map((zone) => {
      if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
        const [center, radii] = ellipse(zone.points[0]!, zone.points[1]!)
        return { ...zone, points: [center, radii, ...zone.points.slice(2).map(point)] }
      }
      return { ...zone, points: zone.points.map(point) }
    }),
    annotations: payload.annotations.map((annotation) => ({ ...annotation, position: point(annotation.position) })),
    measurementGuides: payload.measurementGuides.map((guide) => ({
      ...guide,
      start: point(guide.start),
      end: point(guide.end),
    })),
  }
}

/** The payload as a placement template; placing rebuilds every nested field, so the payload stays for the next paste. */
export function createClipboardArrangementTemplate(
  payload: SceneClipboardPayload,
  options: { preservePinnedNames?: boolean } = {},
): SceneArrangementTemplate {
  const entry = <T extends { readonly id: string }>(entity: T) => ({ sourceId: entity.id, entity })
  return {
    plants: payload.plants.map((plant) => entry({
      ...plant,
      pinnedName: options.preservePinnedNames === true ? plant.pinnedName === true : false,
    })),
    zones: payload.zones.map(entry),
    annotations: payload.annotations.map(entry),
    measurementGuides: payload.measurementGuides.map(entry),
    groups: payload.groups.map(entry),
  }
}

/** The ids a selection covers, a group's members included. */
export function resolveSelectedEntitySets(
  persisted: ScenePersistedState,
  selected: readonly SceneSelectionTarget[],
): {
  plantIds: Set<string>
  zoneIds: Set<string>
  annotationIds: Set<string>
  measurementGuideIds: Set<string>
  groupIds: Set<string>
} {
  const plantIds = new Set<string>()
  const zoneIds = new Set<string>()
  const annotationIds = new Set<string>()
  const measurementGuideIds = new Set<string>()
  const groupIds = new Set<string>()

  for (const target of selected) {
    if (target.kind === 'plant') {
      plantIds.add(target.id)
      continue
    }
    if (target.kind === 'zone') {
      zoneIds.add(target.id)
      continue
    }
    if (target.kind === 'annotation') {
      annotationIds.add(target.id)
      continue
    }
    if (target.kind === 'measurement-guide') {
      measurementGuideIds.add(target.id)
      continue
    }

    groupIds.add(target.id)
    const group = persisted.groups.find((entry) => entry.id === target.id)
    if (!group) continue
    for (const member of resolveSceneObjectGroupMembers(persisted, group)) {
      if (member.kind === 'plant') plantIds.add(member.id)
      else if (member.kind === 'zone') zoneIds.add(member.id)
      else annotationIds.add(member.id)
    }
  }

  return { plantIds, zoneIds, annotationIds, measurementGuideIds, groupIds }
}
