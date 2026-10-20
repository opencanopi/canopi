import {
  resolveSceneObjectGroupMembers,
} from './group-members'
import {
  sceneTargetKey,
  type SceneConcreteDesignObjectTarget,
  type SceneDesignObjectTarget,
} from './design-object-targets'
import type { ScenePersistedState } from './types'

export function isSceneDesignObjectLocked(
  state: ScenePersistedState,
  target: SceneDesignObjectTarget,
): boolean {
  return isDirectSceneDesignObjectLocked(state, target)
    || (target.kind === 'group' && lockedSceneGroupMembers(state, target.id).length > 0)
}

export function isDirectSceneDesignObjectLocked(
  state: ScenePersistedState,
  target: SceneDesignObjectTarget,
): boolean {
  if (target.kind === 'plant') {
    return state.plants.some((plant) => plant.id === target.id && plant.locked)
  }
  if (target.kind === 'zone') {
    return state.zones.some((zone) => zone.id === target.id && zone.locked)
  }
  if (target.kind === 'annotation') {
    return state.annotations.some((annotation) => annotation.id === target.id && annotation.locked)
  }
  if (target.kind === 'measurement-guide') {
    return state.measurementGuides.some((guide) => guide.id === target.id && guide.locked)
  }
  return state.groups.some((group) => group.id === target.id && group.locked)
}

/** The group's members that are locked themselves, which lock the group too (none for an unknown group). */
export function lockedSceneGroupMembers(state: ScenePersistedState, groupId: string): SceneConcreteDesignObjectTarget[] {
  const group = state.groups.find((entry) => entry.id === groupId)
  if (!group) return []
  return resolveSceneObjectGroupMembers(state, group)
    .filter((member) => isDirectSceneDesignObjectLocked(state, member))
}

/** Whether a layer takes edits and new objects: neither hidden nor locked. A layer the Design does not list is editable. */
export function isSceneLayerEditable(state: ScenePersistedState, layerName: string): boolean {
  const layer = state.layers.find((entry) => entry.name === layerName)
  return layer?.visible !== false && layer?.locked !== true
}

export function setSceneDesignObjectLocks(
  state: ScenePersistedState,
  targets: Iterable<SceneDesignObjectTarget>,
  locked: boolean,
): void {
  const targetKeys = new Set([...targets].map(sceneTargetKey))
  for (const plant of state.plants) {
    if (targetKeys.has(sceneTargetKey({ kind: 'plant', id: plant.id }))) plant.locked = locked
  }
  for (const zone of state.zones) {
    if (targetKeys.has(sceneTargetKey({ kind: 'zone', id: zone.id }))) zone.locked = locked
  }
  for (const annotation of state.annotations) {
    if (targetKeys.has(sceneTargetKey({ kind: 'annotation', id: annotation.id }))) annotation.locked = locked
  }
  for (const guide of state.measurementGuides) {
    if (targetKeys.has(sceneTargetKey({ kind: 'measurement-guide', id: guide.id }))) guide.locked = locked
  }
  for (const group of state.groups) {
    if (targetKeys.has(sceneTargetKey({ kind: 'group', id: group.id }))) group.locked = locked
  }
}

/** Every directly locked Design Object, as typed targets (Unlock all). */
export function lockedSceneDesignObjectTargets(state: ScenePersistedState): SceneDesignObjectTarget[] {
  return [
    ...state.plants.filter((plant) => plant.locked).map((plant) => ({ kind: 'plant' as const, id: plant.id })),
    ...state.zones.filter((zone) => zone.locked).map((zone) => ({ kind: 'zone' as const, id: zone.id })),
    ...state.annotations.filter((note) => note.locked).map((note) => ({ kind: 'annotation' as const, id: note.id })),
    ...state.measurementGuides.filter((guide) => guide.locked).map((guide) => ({ kind: 'measurement-guide' as const, id: guide.id })),
    ...state.groups.filter((group) => group.locked).map((group) => ({ kind: 'group' as const, id: group.id })),
  ]
}

/** Whether any Design Object is locked (layer locks are separate and not counted). */
export function sceneHasLockedDesignObjects(state: ScenePersistedState): boolean {
  return state.plants.some((plant) => plant.locked)
    || state.zones.some((zone) => zone.locked)
    || state.annotations.some((note) => note.locked)
    || state.measurementGuides.some((guide) => guide.locked)
    || state.groups.some((group) => group.locked)
}
