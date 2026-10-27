import { getCanvasDetailLayout } from '../automatic-detail'
import { getAnnotationFontEpoch, getAnnotationVisualWorldBounds, getRevealedAnnotationId } from '../annotation-layout'
import type { SceneBounds } from '../view/types'
import {
  getPlantWorldBounds,
  type PlantPresentationContext,
} from '../plant-presentation'
import type {
  CanvasDesignObjectSelectionBlockedTarget,
  CanvasDesignObjectSelectionModel,
  CanvasDesignObjectSelectionTarget,
} from '../runtime'
import type { ScenePersistedState, SceneDesignObjectSelection } from '../scene'
import {
  getSceneGroupedMemberKeys,
  resolveSceneObjectGroupMembers,
  sceneContainsTarget,
  sceneObjectGroupMemberFromTarget,
  sceneObjectGroupMemberKey,
  sceneTargetKey,
  sceneTargetLayerNames,
  freezeInDev,
  isSceneDesignObjectLocked,
} from '../scene'
import { getCanvasPlantDisplay } from '../plant-display'
import { getZoneWorldBounds } from '../zone-geometry'
import { getSameSpeciesReferenceCanonicalName } from './species-selection'

declare global {
  interface Window {
    /** Dev builds count each selection model build here when a test or a live check sets it to a number. */
    __CANOPI_SELECTION_MODEL_BUILDS__?: number
  }
}

export type SceneSelectionTarget = CanvasDesignObjectSelectionTarget

export interface SceneSelectionReadModelOptions {
  readonly revealedAnnotationId?: string | null
  readonly annotationViewportScale: number
  readonly plantContext: PlantPresentationContext
}

export interface SceneSelectionEntityIds {
  readonly selectedPlantIds: Set<string>
  readonly selectedZoneIds: Set<string>
  readonly selectedAnnotationIds: Set<string>
  readonly selectedMeasurementGuideIds: Set<string>
}

export function projectSceneSelectionEntityIds(
  persisted: ScenePersistedState,
  selectedTargets: SceneDesignObjectSelection,
): SceneSelectionEntityIds {
  const selectedKeys = new Set(selectedTargets.map(sceneTargetKey))
  const selectedGroupMemberKeys = new Set<string>()

  for (const group of persisted.groups) {
    if (!selectedKeys.has(sceneTargetKey({ kind: 'group', id: group.id }))) continue
    for (const member of group.members) {
      selectedGroupMemberKeys.add(sceneObjectGroupMemberKey(member))
    }
  }

  const isSelected = (target: SceneSelectionTarget): boolean => {
    const key = sceneTargetKey(target)
    return selectedKeys.has(key) || selectedGroupMemberKeys.has(key)
  }
  const selectedPlantIds = new Set<string>()
  const selectedZoneIds = new Set<string>()
  const selectedAnnotationIds = new Set<string>()
  const selectedMeasurementGuideIds = new Set<string>()

  for (const plant of persisted.plants) {
    if (isSelected({ kind: 'plant', id: plant.id })) selectedPlantIds.add(plant.id)
  }
  for (const zone of persisted.zones) {
    if (isSelected({ kind: 'zone', id: zone.id })) selectedZoneIds.add(zone.id)
  }
  for (const annotation of persisted.annotations) {
    if (isSelected({ kind: 'annotation', id: annotation.id })) {
      selectedAnnotationIds.add(annotation.id)
    }
  }
  for (const guide of persisted.measurementGuides) {
    if (selectedKeys.has(sceneTargetKey({ kind: 'measurement-guide', id: guide.id }))) {
      selectedMeasurementGuideIds.add(guide.id)
    }
  }

  return {
    selectedPlantIds,
    selectedZoneIds,
    selectedAnnotationIds,
    selectedMeasurementGuideIds,
  }
}

export function getSelectedTopLevelTargets(
  persisted: ScenePersistedState,
  selectedTargets: SceneDesignObjectSelection,
): SceneSelectionTarget[] {
  const groupedMemberKeys = getSceneGroupedMemberKeys(persisted)
  const selectedKeys = new Set(selectedTargets.map(sceneTargetKey))
  const targets: SceneSelectionTarget[] = []

  for (const group of persisted.groups) {
    if (!selectedKeys.has(sceneTargetKey({ kind: 'group', id: group.id }))) continue
    targets.push({ kind: 'group', id: group.id })
  }

  for (const plant of persisted.plants) {
    if (
      !selectedKeys.has(sceneTargetKey({ kind: 'plant', id: plant.id }))
      || groupedMemberKeys.has(sceneTargetKey({ kind: 'plant', id: plant.id }))
    ) continue
    targets.push({ kind: 'plant', id: plant.id })
  }

  for (const zone of persisted.zones) {
    if (
      !selectedKeys.has(sceneTargetKey({ kind: 'zone', id: zone.id }))
      || groupedMemberKeys.has(sceneTargetKey({ kind: 'zone', id: zone.id }))
    ) continue
    targets.push({ kind: 'zone', id: zone.id })
  }

  for (const annotation of persisted.annotations) {
    if (
      !selectedKeys.has(sceneTargetKey({ kind: 'annotation', id: annotation.id }))
      || groupedMemberKeys.has(sceneTargetKey({ kind: 'annotation', id: annotation.id }))
    ) continue
    targets.push({ kind: 'annotation', id: annotation.id })
  }

  for (const guide of persisted.measurementGuides) {
    if (!selectedKeys.has(sceneTargetKey({ kind: 'measurement-guide', id: guide.id }))) continue
    targets.push({ kind: 'measurement-guide', id: guide.id })
  }

  return targets
}

/** The read model of an empty selection, shared and frozen. */
export const EMPTY_SELECTION_MODEL: CanvasDesignObjectSelectionModel = Object.freeze({
  editableTargets: Object.freeze([]),
  lockedTargets: Object.freeze([]),
  blockedTargets: Object.freeze([]),
  bounds: null,
  sameSpeciesReferenceCanonicalName: null,
  plantNamePinning: Object.freeze({ plantIds: Object.freeze([]), allPinned: false }),
})

/** The one editable target of `kind` when it is the whole selection, with nothing locked or blocked; else null. */
export function singleEditableTarget<K extends CanvasDesignObjectSelectionTarget['kind']>(
  selection: CanvasDesignObjectSelectionModel,
  kind: K,
): Extract<CanvasDesignObjectSelectionTarget, { kind: K }> | null {
  if (selection.editableTargets.length !== 1 || selection.lockedTargets.length > 0 || selection.blockedTargets.length > 0) {
    return null
  }
  const [target] = selection.editableTargets
  return target?.kind === kind ? target as Extract<CanvasDesignObjectSelectionTarget, { kind: K }> : null
}

interface SelectionModelMemo {
  readonly selectedTargets: SceneDesignObjectSelection
  readonly annotationViewportScale: number
  readonly symbolScale: number
  readonly fontEpoch: number
  readonly model: CanvasDesignObjectSelectionModel
}

/** Each Scene's last model, so runtimes reading their own Scenes in turn (the workspace, the snapshot or print map) keep
 *  theirs, and a closed Design's Scene is not kept alive. */
const selectionModelMemos = new WeakMap<ScenePersistedState, SelectionModelMemo>()

/**
 * The selection's read model, memoised by reference: the store hands out the same Scene and selection until they change,
 * so the same Scene, selection, scale, symbol size and note font epoch return the model built last for that Scene
 * (frozen in dev builds). A pan builds nothing; a zoom, an edit, a selection change, a symbol-size change or a note
 * font's load builds it again. Every caller sizes plants at the annotation scale, so the plant context is not part of
 * the key.
 */
export function getDesignObjectSelectionModel(
  persisted: ScenePersistedState,
  selectedTargets: SceneDesignObjectSelection,
  options: SceneSelectionReadModelOptions,
): CanvasDesignObjectSelectionModel {
  const symbolScale = getCanvasPlantDisplay().symbolScale
  const fontEpoch = getAnnotationFontEpoch()
  const memo = selectionModelMemos.get(persisted)
  if (
    memo?.selectedTargets === selectedTargets
    && memo.annotationViewportScale === options.annotationViewportScale
    && memo.symbolScale === symbolScale
    && memo.fontEpoch === fontEpoch
  ) return memo.model
  const model = freezeInDev(buildDesignObjectSelectionModel(persisted, selectedTargets, options))
  selectionModelMemos.set(persisted, {
    selectedTargets,
    annotationViewportScale: options.annotationViewportScale,
    symbolScale,
    fontEpoch,
    model,
  })
  return model
}

function buildDesignObjectSelectionModel(
  persisted: ScenePersistedState,
  selectedTargets: SceneDesignObjectSelection,
  options: SceneSelectionReadModelOptions,
): CanvasDesignObjectSelectionModel {
  const builds = import.meta.env.DEV ? globalThis.window?.__CANOPI_SELECTION_MODEL_BUILDS__ : undefined
  if (typeof builds === 'number') window.__CANOPI_SELECTION_MODEL_BUILDS__ = builds + 1
  const topLevelTargets = getSelectedTopLevelTargets(persisted, selectedTargets)
  const blockedTargets = getBlockedSelectionTargets(persisted, selectedTargets)
  const blockedKeys = new Set(blockedTargets.map((blocked) => sceneTargetKey(blocked.target)))
  const lockedTargets = blockedTargets
    .filter((blocked): blocked is CanvasDesignObjectSelectionBlockedTarget & {
      target: CanvasDesignObjectSelectionTarget
    } => blocked.reason === 'locked-design-object')
    .map((blocked) => blocked.target)
  const editableTargets = topLevelTargets.filter(
    (target) => !blockedKeys.has(sceneTargetKey(target)),
  )
  const plantNamePinning = getPlantNamePinning(persisted, editableTargets)
  return {
    editableTargets,
    lockedTargets,
    blockedTargets,
    bounds: getCombinedTargetBounds(persisted, [...editableTargets, ...lockedTargets], {
      ...options, revealedAnnotationId: getRevealedAnnotationId(selectedTargets),
    }),
    sameSpeciesReferenceCanonicalName: getSameSpeciesReferenceCanonicalName(persisted, editableTargets),
    plantNamePinning,
  }
}

function getPlantNamePinning(
  persisted: ScenePersistedState,
  editableTargets: readonly SceneSelectionTarget[],
): CanvasDesignObjectSelectionModel['plantNamePinning'] {
  const plantIds = editableTargets
    .filter((target): target is Extract<SceneSelectionTarget, { kind: 'plant' }> => target.kind === 'plant')
    .map((target) => target.id)
  if (plantIds.length === 0) {
    return {
      plantIds: [],
      allPinned: false,
    }
  }
  const pinnedById = new Map(persisted.plants.map((plant) => [plant.id, plant.pinnedName]))
  return {
    plantIds,
    allPinned: plantIds.every((id) => pinnedById.get(id) === true),
  }
}

export function getCombinedTargetBounds(
  persisted: ScenePersistedState,
  targets: readonly SceneSelectionTarget[],
  options: SceneSelectionReadModelOptions,
): SceneBounds | null {
  let combined: SceneBounds | null = null
  for (const target of targets) {
    const bounds = getTargetBounds(persisted, target, options)
    if (!bounds) continue
    combined = combined
      ? {
          minX: Math.min(combined.minX, bounds.minX),
          minY: Math.min(combined.minY, bounds.minY),
          maxX: Math.max(combined.maxX, bounds.maxX),
          maxY: Math.max(combined.maxY, bounds.maxY),
        }
      : bounds
  }
  return combined
}

function getTargetBounds(
  persisted: ScenePersistedState,
  target: SceneSelectionTarget,
  options: SceneSelectionReadModelOptions,
): SceneBounds | null {
  if (target.kind === 'group') {
    const group = persisted.groups.find((entry) => entry.id === target.id)
    if (!group) return null
    return getCombinedTargetBounds(
      persisted,
      resolveSceneObjectGroupMembers(persisted, group),
      { ...options, revealedAnnotationId: null },
    )
  }

  const plant = target.kind === 'plant'
    ? persisted.plants.find((entry) => entry.id === target.id)
    : null
  if (plant) {
    const bounds = getPlantWorldBounds(plant, { ...options.plantContext, plants: persisted.plants })
    return {
      minX: bounds.x,
      minY: bounds.y,
      maxX: bounds.x + bounds.width,
      maxY: bounds.y + bounds.height,
    }
  }

  const zone = target.kind === 'zone'
    ? persisted.zones.find((entry) => entry.id === target.id)
    : null
  if (zone && zone.points.length > 0) {
    const bounds = getZoneWorldBounds(zone)
    if (!bounds) return null
    return {
      minX: bounds.x,
      minY: bounds.y,
      maxX: bounds.x + bounds.width,
      maxY: bounds.y + bounds.height,
    }
  }

  const annotation = target.kind === 'annotation'
    ? persisted.annotations.find((entry) => entry.id === target.id)
    : null
  if (annotation) {
    const bounds = getAnnotationVisualWorldBounds(
      annotation, options.annotationViewportScale, annotation.id === options.revealedAnnotationId,
      getCanvasDetailLayout(persisted, options.annotationViewportScale).annotationIds.has(annotation.id),
    )
    return {
      minX: bounds.x,
      minY: bounds.y,
      maxX: bounds.x + bounds.width,
      maxY: bounds.y + bounds.height,
    }
  }

  const guide = target.kind === 'measurement-guide'
    ? persisted.measurementGuides.find((entry) => entry.id === target.id)
    : null
  if (!guide) return null
  return {
    minX: Math.min(guide.start.x, guide.end.x),
    minY: Math.min(guide.start.y, guide.end.y),
    maxX: Math.max(guide.start.x, guide.end.x),
    maxY: Math.max(guide.start.y, guide.end.y),
  }
}

function getBlockedSelectionTargets(
  persisted: ScenePersistedState,
  selectedTargets: SceneDesignObjectSelection,
): CanvasDesignObjectSelectionBlockedTarget[] {
  const blockedTargets: CanvasDesignObjectSelectionBlockedTarget[] = []
  const seen = new Set<string>()
  const groupedMemberKeys = getSceneGroupedMemberKeys(persisted)

  for (const target of selectedTargets) {
    const member = sceneObjectGroupMemberFromTarget(target)
    // A structural block wins over the Design Object's own lock: a locked Object on a locked Layer is not selected locked.
    if (
      !sceneContainsTarget(persisted, target)
      || (member && groupedMemberKeys.has(sceneObjectGroupMemberKey(member)))
      || isOnHiddenOrLockedLayer(persisted, target)
    ) {
      pushBlocked(blockedTargets, seen, { target, reason: 'structural' })
    } else if (isSceneDesignObjectLocked(persisted, target)) {
      pushBlocked(blockedTargets, seen, { target, reason: 'locked-design-object' })
    }
  }

  return blockedTargets
}

function pushBlocked(
  blockedTargets: CanvasDesignObjectSelectionBlockedTarget[],
  seen: Set<string>,
  blocked: CanvasDesignObjectSelectionBlockedTarget,
): void {
  const key = sceneTargetKey(blocked.target)
  if (seen.has(key)) return
  seen.add(key)
  blockedTargets.push(blocked)
}

function isOnHiddenOrLockedLayer(persisted: ScenePersistedState, target: SceneSelectionTarget): boolean {
  return sceneTargetLayerNames(persisted, target)
    .map((layerName) => persisted.layers.find((layer) => layer.name === layerName))
    .some((layer) => layer?.visible === false || layer?.locked === true)
}
