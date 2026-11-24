import type { SceneBounds } from '../../../geo/view/types'
import { degreesToRadians, pointsBounds, rotatePointAround } from '../zone-geometry'
import type { CanvasDesignObjectSelectionModel } from '../runtime'
import {
  resolveSceneObjectGroupMembers,
  type SceneAnnotationEntity,
  type ScenePersistedState,
  type ScenePlantEntity,
  type ScenePoint,
  type SceneZoneEntity,
} from '../scene'

/**
 * Rotating a selection about a pivot: the rotation handle's drag and the
 * Rotate… command share this, so both turn plants, notes, zones and guides alike.
 * Positive degrees turn clockwise on the map (the session plane's y grows
 * southward). Only editable targets move; a selection with a locked or
 * otherwise blocked object does not rotate at all.
 */
type RotatableTarget =
  | { readonly kind: 'plant'; readonly id: string }
  | { readonly kind: 'zone'; readonly id: string }
  | { readonly kind: 'annotation'; readonly id: string }
  | { readonly kind: 'measurement-guide'; readonly id: string }
  | { readonly kind: 'group'; readonly id: string }

export interface RotationTransformState {
  readonly plants: Map<string, ScenePoint>
  readonly zones: Map<string, ZoneRotationStart>
  readonly annotations: Map<string, AnnotationRotationStart>
  readonly measurementGuides: Map<string, MeasurementGuideRotationStart>
}

interface ZoneRotationStart {
  readonly zoneType: string
  readonly points: readonly ScenePoint[]
  readonly rotationDeg: number
}

interface AnnotationRotationStart {
  readonly position: ScenePoint
  readonly rotationDeg: number
}

interface MeasurementGuideRotationStart {
  readonly start: ScenePoint
  readonly end: ScenePoint
}

export function isRotatableSelection(selection: CanvasDesignObjectSelectionModel): selection is CanvasDesignObjectSelectionModel & {
  readonly bounds: SceneBounds
  readonly editableTargets: readonly RotatableTarget[]
} {
  if (!selection.bounds || selection.blockedTargets.length > 0 || selection.editableTargets.length === 0) return false
  // A lone plant has nothing to turn: its symbol stays upright (ADR 0019).
  return selection.editableTargets.length > 1 || selection.editableTargets[0]!.kind !== 'plant'
}

export function captureRotationTransformState(
  scene: ScenePersistedState,
  selection: CanvasDesignObjectSelectionModel,
): RotationTransformState | null {
  if (!isRotatableSelection(selection)) return null
  const state = createRotationTransformState()
  for (const target of selection.editableTargets) captureTopLevelTarget(scene, state, target)
  if (
    state.plants.size === 0
    && state.zones.size === 0
    && state.annotations.size === 0
    && state.measurementGuides.size === 0
  ) {
    return null
  }
  return state
}

function createRotationTransformState(): RotationTransformState {
  return {
    plants: new Map(),
    zones: new Map(),
    annotations: new Map(),
    measurementGuides: new Map(),
  }
}

function captureTopLevelTarget(
  scene: ScenePersistedState,
  state: RotationTransformState,
  target: RotatableTarget,
): void {
  if (target.kind === 'group') {
    const group = scene.groups.find((entry) => entry.id === target.id)
    if (!group) return
    for (const member of resolveSceneObjectGroupMembers(scene, group)) captureMemberTarget(scene, state, member)
    return
  }
  if (target.kind === 'measurement-guide') {
    const guide = scene.measurementGuides.find((entry) => entry.id === target.id)
    if (guide) state.measurementGuides.set(guide.id, { start: { ...guide.start }, end: { ...guide.end } })
    return
  }
  captureMemberTarget(scene, state, target)
}

function captureMemberTarget(
  scene: ScenePersistedState,
  state: RotationTransformState,
  target: { kind: 'plant' | 'zone' | 'annotation'; id: string },
): void {
  const plant = target.kind === 'plant' ? scene.plants.find((entry) => entry.id === target.id) : null
  if (plant) {
    state.plants.set(plant.id, { ...plant.position })
    return
  }

  const zone = target.kind === 'zone' ? scene.zones.find((entry) => entry.id === target.id) : null
  if (zone) {
    state.zones.set(zone.id, {
      zoneType: zone.zoneType,
      points: zone.points.map((point) => ({ ...point })),
      rotationDeg: zone.rotationDeg,
    })
    return
  }

  const annotation = target.kind === 'annotation'
    ? scene.annotations.find((entry) => entry.id === target.id)
    : null
  if (annotation) {
    state.annotations.set(annotation.id, {
      position: { ...annotation.position },
      rotationDeg: annotation.rotationDeg ?? 0,
    })
  }
}

export function centerOfBounds(bounds: SceneBounds): ScenePoint {
  return {
    x: bounds.minX + (bounds.maxX - bounds.minX) / 2,
    y: bounds.minY + (bounds.maxY - bounds.minY) / 2,
  }
}

function normalizeRotationDeg(degrees: number): number {
  const normalized = degrees % 360
  return cleanDegrees(normalized < 0 ? normalized + 360 : normalized)
}

export function applyRotationTransformToDraft(
  draft: ScenePersistedState,
  state: RotationTransformState,
  pivot: ScenePoint,
  deltaDeg: number,
): void {
  draft.plants = draft.plants.map((plant) => {
    const start = state.plants.get(plant.id)
    if (!start) return plant
    return {
      ...plant,
      position: rotateByDegrees(start, pivot, deltaDeg),
    }
  })

  draft.annotations = draft.annotations.map((annotation) => {
    const start = state.annotations.get(annotation.id)
    if (!start) return annotation
    return {
      ...annotation,
      position: rotateByDegrees(start.position, pivot, deltaDeg),
      rotationDeg: normalizeRotationDeg(start.rotationDeg + deltaDeg),
    }
  })

  draft.zones = draft.zones.map((zone) => {
    const start = state.zones.get(zone.id)
    if (!start) return zone
    return rotateZone(zone, start, pivot, deltaDeg)
  })

  draft.measurementGuides = draft.measurementGuides.map((guide) => {
    const start = state.measurementGuides.get(guide.id)
    if (!start) return guide
    return {
      ...guide,
      start: rotateByDegrees(start.start, pivot, deltaDeg),
      end: rotateByDegrees(start.end, pivot, deltaDeg),
    }
  })
}

/**
 * Copies of scene objects turned about `pivot` exactly as a selection turns:
 * plants move and stay upright, notes and oriented zones also turn their
 * `rotationDeg`, polygonal and linear zones turn their points. Stamps placed
 * at an angle use it, so a rotated stamp lands as if it had been rotated after.
 */
export function rotatePlantAbout<T extends ScenePlantEntity>(plant: T, pivot: ScenePoint, degrees: number): T {
  return { ...plant, position: rotateByDegrees(plant.position, pivot, degrees) }
}

export function rotateAnnotationAbout<T extends SceneAnnotationEntity>(annotation: T, pivot: ScenePoint, degrees: number): T {
  return {
    ...annotation,
    position: rotateByDegrees(annotation.position, pivot, degrees),
    rotationDeg: normalizeRotationDeg((annotation.rotationDeg ?? 0) + degrees),
  }
}

export function rotateZoneAbout<T extends SceneZoneEntity>(zone: T, pivot: ScenePoint, degrees: number): T {
  return rotateZone(zone, { zoneType: zone.zoneType, points: zone.points, rotationDeg: zone.rotationDeg }, pivot, degrees)
}

function rotateZone<T extends ScenePersistedState['zones'][number]>(
  zone: T,
  start: ZoneRotationStart,
  pivot: ScenePoint,
  deltaDeg: number,
): T {
  if (start.zoneType === 'ellipse' && start.points.length >= 2) {
    return {
      ...zone,
      points: [
        rotateByDegrees(start.points[0]!, pivot, deltaDeg),
        { ...start.points[1]! },
      ],
      rotationDeg: normalizeRotationDeg(start.rotationDeg + deltaDeg),
    }
  }

  if (start.zoneType === 'rect' && start.points.length >= 4) {
    const bounds = pointsBounds(start.points.slice(0, 4))
    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    }
    return {
      ...zone,
      points: rectPointsAroundCenter(rotateByDegrees(center, pivot, deltaDeg), bounds.width, bounds.height),
      rotationDeg: normalizeRotationDeg(start.rotationDeg + deltaDeg),
    }
  }

  return {
    ...zone,
    points: start.points.map((point) => rotateByDegrees(point, pivot, deltaDeg)),
    rotationDeg: start.rotationDeg,
  }
}

function rotateByDegrees(point: ScenePoint, pivot: ScenePoint, degrees: number): ScenePoint {
  return rotatePointAround(point, pivot, degreesToRadians(degrees))
}

function rectPointsAroundCenter(center: ScenePoint, width: number, height: number): ScenePoint[] {
  const halfWidth = width / 2
  const halfHeight = height / 2
  return [
    { x: center.x - halfWidth, y: center.y - halfHeight },
    { x: center.x + halfWidth, y: center.y - halfHeight },
    { x: center.x + halfWidth, y: center.y + halfHeight },
    { x: center.x - halfWidth, y: center.y + halfHeight },
  ]
}


function cleanDegrees(value: number): number {
  return Math.abs(value) < 0.0000001 ? 0 : value
}
