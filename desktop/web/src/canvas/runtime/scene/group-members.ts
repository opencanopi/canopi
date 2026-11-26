import type {
  SceneObjectGroupEntity,
  SceneObjectGroupMember,
  ScenePersistedState,
} from './types'
import {
  sceneTargetKey,
  type SceneDesignObjectTarget,
} from './design-object-targets'

function cloneSceneObjectGroupMember(
  member: SceneObjectGroupMember,
): SceneObjectGroupMember {
  return member.unknownFields
    ? { ...member, unknownFields: structuredClone(member.unknownFields) }
    : { ...member }
}

export function cloneSceneObjectGroupMembers(
  members: readonly SceneObjectGroupMember[],
): SceneObjectGroupMember[] {
  return members.map(cloneSceneObjectGroupMember)
}

export function sceneObjectGroupMemberKey(member: SceneObjectGroupMember): string {
  return sceneTargetKey(member)
}

/** Returns a group member for UI `group-selected` (excludes groups and measurement guides). */
export function sceneObjectGroupMemberFromTarget(
  target: SceneDesignObjectTarget,
): SceneObjectGroupMember | null {
  if (target.kind === 'group' || target.kind === 'measurement-guide') return null
  return { kind: target.kind, id: target.id }
}

/** Returns the member key for any concrete object that can belong to an Object Group (including measurement guides). */
export function sceneObjectGroupMemberKeyForTarget(
  target: SceneDesignObjectTarget,
): string | null {
  return target.kind === 'group' ? null : sceneTargetKey(target)
}

export function sceneObjectGroupMemberLayerName(member: SceneObjectGroupMember): string {
  if (member.kind === 'zone') return 'zones'
  if (member.kind === 'annotation') return 'annotations'
  if (member.kind === 'measurement-guide') return 'measurement-guides'
  return 'plants'
}

export function dedupeSceneObjectGroupMembers(
  members: readonly SceneObjectGroupMember[],
): SceneObjectGroupMember[] {
  const seen = new Set<string>()
  const deduped: SceneObjectGroupMember[] = []
  for (const member of members) {
    const key = sceneObjectGroupMemberKey(member)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(cloneSceneObjectGroupMember(member))
  }
  return deduped
}

function resolveSceneObjectGroupMember(
  scene: ScenePersistedState,
  member: SceneObjectGroupMember,
): SceneObjectGroupMember | null {
  if (member.kind === 'plant') {
    return scene.plants.some((plant) => plant.id === member.id) ? member : null
  }
  if (member.kind === 'zone') {
    return scene.zones.some((zone) => zone.id === member.id) ? member : null
  }
  if (member.kind === 'annotation') {
    return scene.annotations.some((annotation) => annotation.id === member.id) ? member : null
  }
  return scene.measurementGuides.some((guide) => guide.id === member.id) ? member : null
}

export function resolveSceneObjectGroupMembers(
  scene: ScenePersistedState,
  group: SceneObjectGroupEntity,
): SceneObjectGroupMember[] {
  return group.members
    .map((member) => resolveSceneObjectGroupMember(scene, member))
    .filter((target): target is SceneObjectGroupMember => target !== null)
}

/** Whether the Scene holds `target`, by kind and id. */
export function sceneContainsTarget(scene: ScenePersistedState, target: SceneDesignObjectTarget): boolean {
  if (target.kind === 'group') return scene.groups.some((group) => group.id === target.id)
  if (target.kind === 'plant') return scene.plants.some((plant) => plant.id === target.id)
  if (target.kind === 'zone') return scene.zones.some((zone) => zone.id === target.id)
  if (target.kind === 'annotation') return scene.annotations.some((annotation) => annotation.id === target.id)
  return scene.measurementGuides.some((guide) => guide.id === target.id)
}

/** The layers `target` sits on: its own, or a group's distinct member layers in member order (missing members skipped). */
export function sceneTargetLayerNames(scene: ScenePersistedState, target: SceneDesignObjectTarget): string[] {
  if (target.kind !== 'group') return [sceneObjectGroupMemberLayerName(target)]
  const group = scene.groups.find((entry) => entry.id === target.id)
  if (!group) return []
  return [...new Set(resolveSceneObjectGroupMembers(scene, group).map(sceneObjectGroupMemberLayerName))]
}

/** Whether any layer `target` sits on is locked. */
export function isSceneTargetLayerLocked(scene: ScenePersistedState, target: SceneDesignObjectTarget): boolean {
  return sceneTargetLayerNames(scene, target)
    .some((layerName) => scene.layers.find((layer) => layer.name === layerName)?.locked === true)
}

export function getSceneGroupedMemberKeys(scene: ScenePersistedState): Map<string, string> {
  const grouped = new Map<string, string>()
  for (const group of scene.groups) {
    for (const member of group.members) {
      grouped.set(sceneObjectGroupMemberKey(member), group.id)
    }
  }
  return grouped
}

export function isSceneObjectGroupMemberTarget(
  member: SceneObjectGroupMember,
  target: SceneDesignObjectTarget,
): boolean {
  return member.kind === target.kind && member.id === target.id
}

interface DeletedSceneMemberIds {
  readonly plantIds?: ReadonlySet<string>
  readonly zoneIds?: ReadonlySet<string>
  readonly annotationIds?: ReadonlySet<string>
  readonly measurementGuideIds?: ReadonlySet<string>
}

function isDeletedMember(
  member: SceneObjectGroupMember,
  deleted: DeletedSceneMemberIds,
): boolean {
  if (member.kind === 'plant') return deleted.plantIds?.has(member.id) === true
  if (member.kind === 'zone') return deleted.zoneIds?.has(member.id) === true
  if (member.kind === 'annotation') return deleted.annotationIds?.has(member.id) === true
  return deleted.measurementGuideIds?.has(member.id) === true
}

/**
 * Removes deleted members (including `measurement-guide` members) and drops the group when fewer
 * than 2 members remain.
 */
export function pruneGroupDeletedMembers(
  group: SceneObjectGroupEntity,
  deleted: DeletedSceneMemberIds,
): SceneObjectGroupEntity | null {
  const members = group.members.filter((member) => !isDeletedMember(member, deleted))
  return members.length >= 2 ? { ...group, members } : null
}
