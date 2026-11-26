import type {
  SceneObjectGroupEntity,
  SceneObjectGroupMember,
  ScenePersistedState,
} from './types'
import {
  sceneTargetKey,
  type SceneConcreteDesignObjectTarget,
  type SceneDesignObjectTarget,
} from './design-object-targets'

function cloneSceneObjectGroupMember(
  member: SceneObjectGroupMember,
): SceneObjectGroupMember {
  return { ...member }
}

export function cloneSceneObjectGroupMembers(
  members: readonly SceneObjectGroupMember[],
): SceneObjectGroupMember[] {
  return members.map(cloneSceneObjectGroupMember)
}

export function sceneObjectGroupMemberKey(member: SceneObjectGroupMember): string {
  return sceneTargetKey(member)
}

export function sceneObjectGroupMemberFromTarget(
  target: SceneDesignObjectTarget,
): SceneObjectGroupMember | null {
  if (target.kind === 'group' || target.kind === 'measurement-guide') return null
  return { kind: target.kind, id: target.id }
}

export function sceneObjectGroupMemberLayerName(member: SceneObjectGroupMember): string {
  if (member.kind === 'zone') return 'zones'
  if (member.kind === 'annotation') return 'annotations'
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
): SceneConcreteDesignObjectTarget | null {
  if (member.kind === 'plant') {
    return scene.plants.some((plant) => plant.id === member.id) ? { kind: 'plant', id: member.id } : null
  }
  if (member.kind === 'zone') {
    return scene.zones.some((zone) => zone.id === member.id) ? { kind: 'zone', id: member.id } : null
  }
  return scene.annotations.some((annotation) => annotation.id === member.id)
    ? { kind: 'annotation', id: member.id }
    : null
}

export function resolveSceneObjectGroupMembers(
  scene: ScenePersistedState,
  group: SceneObjectGroupEntity,
): SceneConcreteDesignObjectTarget[] {
  return group.members
    .map((member) => resolveSceneObjectGroupMember(scene, member))
    .filter((target): target is SceneConcreteDesignObjectTarget => target !== null)
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
  if (target.kind === 'measurement-guide') return ['measurement-guides']
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
  target: SceneConcreteDesignObjectTarget,
): boolean {
  return member.kind === target.kind && member.id === target.id
}

export interface DeletedSceneMemberIds {
  readonly plantIds?: ReadonlySet<string>
  readonly zoneIds?: ReadonlySet<string>
  readonly annotationIds?: ReadonlySet<string>
  readonly measurementGuideIds?: ReadonlySet<string>
}

function isDeletedWireMember(
  member: { readonly kind: string; readonly id: string },
  deleted: DeletedSceneMemberIds,
): boolean {
  if (member.kind === 'plant') return deleted.plantIds?.has(member.id) === true
  if (member.kind === 'zone') return deleted.zoneIds?.has(member.id) === true
  if (member.kind === 'annotation') return deleted.annotationIds?.has(member.id) === true
  if (member.kind === 'measurement_guide') return deleted.measurementGuideIds?.has(member.id) === true
  return false
}

/**
 * Removes deleted members from both concrete `members` and preserved `wireMembers` (including
 * `measurement_guide` members) and drops the group only when fewer than 2 total members remain.
 */
export function pruneGroupDeletedMembers(
  group: SceneObjectGroupEntity,
  deleted: DeletedSceneMemberIds,
): SceneObjectGroupEntity | null {
  const members = group.members.filter((member) => !isDeletedWireMember(member, deleted))
  if (!group.wireMembers) {
    return members.length >= 2 ? { ...group, members } : null
  }
  const wireMembers = group.wireMembers.filter((member) => !isDeletedWireMember(member, deleted))
  const wireKeys = new Set(wireMembers.map((member) => `${member.kind}:${member.id}`))
  let totalCount = wireMembers.length
  for (const member of members) {
    if (!wireKeys.has(`${member.kind}:${member.id}`)) totalCount += 1
  }
  if (totalCount < 2) return null
  return {
    ...group,
    members,
    wireMembers,
  }
}
