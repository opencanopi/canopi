import { translateZonePoints } from './selection-rotation'
import {
  resolveSceneObjectGroupMembers,
  sceneTargetKey,
  type SceneDesignObjectSelection,
  type SceneMeasurementGuideEntity,
  type ScenePersistedState,
  type ScenePoint,
} from '../scene'

type MeasurementGuideDragStart = Pick<SceneMeasurementGuideEntity, 'start' | 'end'>

export interface SceneDragState {
  plantStarts: Map<string, ScenePoint>
  zoneStarts: Map<string, ScenePoint[]>
  annotationStarts: Map<string, ScenePoint>
  measurementGuideStarts: Map<string, MeasurementGuideDragStart>
}

export function createSceneDragState(): SceneDragState {
  return {
    plantStarts: new Map(),
    zoneStarts: new Map(),
    annotationStarts: new Map(),
    measurementGuideStarts: new Map(),
  }
}

function resetSceneDragState(state: SceneDragState): void {
  state.plantStarts.clear()
  state.zoneStarts.clear()
  state.annotationStarts.clear()
  state.measurementGuideStarts.clear()
}

export function captureSceneDragState(
  state: SceneDragState,
  scene: ScenePersistedState,
  selection: SceneDesignObjectSelection,
): void {
  resetSceneDragState(state)
  const selectionKeys = new Set(selection.map(sceneTargetKey))

  for (const plant of scene.plants) {
    if (selectionKeys.has(sceneTargetKey({ kind: 'plant', id: plant.id }))) {
      state.plantStarts.set(plant.id, { ...plant.position })
    }
  }

  for (const zone of scene.zones) {
    if (selectionKeys.has(sceneTargetKey({ kind: 'zone', id: zone.id }))) {
      state.zoneStarts.set(zone.id, zone.points.map((point) => ({ ...point })))
    }
  }

  for (const annotation of scene.annotations) {
    if (selectionKeys.has(sceneTargetKey({ kind: 'annotation', id: annotation.id }))) {
      state.annotationStarts.set(annotation.id, { ...annotation.position })
    }
  }

  for (const guide of scene.measurementGuides) {
    if (selectionKeys.has(sceneTargetKey({ kind: 'measurement-guide', id: guide.id }))) {
      state.measurementGuideStarts.set(guide.id, {
        start: { ...guide.start },
        end: { ...guide.end },
      })
    }
  }

  for (const group of scene.groups) {
    if (!selectionKeys.has(sceneTargetKey({ kind: 'group', id: group.id }))) continue
    for (const member of resolveSceneObjectGroupMembers(scene, group)) {
      const plant = member.kind === 'plant' ? scene.plants.find((entry) => entry.id === member.id) : null
      if (plant) state.plantStarts.set(plant.id, { ...plant.position })
      const zone = member.kind === 'zone' ? scene.zones.find((entry) => entry.id === member.id) : null
      if (zone) state.zoneStarts.set(zone.id, zone.points.map((point) => ({ ...point })))
      const annotation = member.kind === 'annotation'
        ? scene.annotations.find((entry) => entry.id === member.id)
        : null
      if (annotation) state.annotationStarts.set(annotation.id, { ...annotation.position })
      const guide = member.kind === 'measurement-guide'
        ? scene.measurementGuides.find((entry) => entry.id === member.id)
        : null
      if (guide) state.measurementGuideStarts.set(guide.id, { start: { ...guide.start }, end: { ...guide.end } })
    }
  }
}

export function applySceneDragDeltaToDraft(
  draft: ScenePersistedState,
  state: SceneDragState,
  delta: ScenePoint,
): void {
  draft.plants = draft.plants.map((plant) => {
    const start = state.plantStarts.get(plant.id)
    if (!start) return plant
    return {
      ...plant,
      position: {
        x: start.x + delta.x,
        y: start.y + delta.y,
      },
    }
  })
  draft.zones = draft.zones.map((zone) => {
    const start = state.zoneStarts.get(zone.id)
    if (!start) return zone
    return {
      ...zone,
      points: translateZonePoints(zone, delta, start),
    }
  })
  draft.annotations = draft.annotations.map((annotation) => {
    const start = state.annotationStarts.get(annotation.id)
    if (!start) return annotation
    return {
      ...annotation,
      position: {
        x: start.x + delta.x,
        y: start.y + delta.y,
      },
    }
  })
  draft.measurementGuides = draft.measurementGuides.map((guide) => {
    const start = state.measurementGuideStarts.get(guide.id)
    if (!start) return guide
    return {
      ...guide,
      start: {
        x: start.start.x + delta.x,
        y: start.start.y + delta.y,
      },
      end: {
        x: start.end.x + delta.x,
        y: start.end.y + delta.y,
      },
    }
  })
}
