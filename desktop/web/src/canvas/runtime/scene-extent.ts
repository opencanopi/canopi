// canvas/runtime/scene-extent.ts
//
// Owns a scene's extent for the view's fits (SceneExtent.extentPoints, spec §1.1): the corner points of every plant, zone and note
// footprint at a candidate scale, in plane metres, and the selected objects' outlines for zoom to selection. Notes and
// default-mode plants are screen-sized, so an extent depends on the scale. It sits outside view/ because it measures the scene
// (P4): the runtime's construction gives both to the navigation's readSceneExtent and readSelectionPoints.

import { getAnnotationVisualWorldCorners, getAnnotationWorldBounds } from './annotation-layout'
import { getCanvasDetailLayout } from './automatic-detail'
import { getPlantWorldBounds, type PlantPresentationContext } from './plant-presentation'
import type { SceneDesignObjectTarget, ScenePersistedState, SceneZoneEntity } from './scene'
import { resolveSceneObjectGroupMembers } from './scene/group-members'
import { getSceneLayerStyle } from './scene-visuals'
import type { WorldPoint } from '../../geo/view/types'
import { getZoneExtentPoints, getZoneWorldBounds } from './zone-geometry'

function isLayerShown(scene: ScenePersistedState, layerName: string): boolean {
  const style = getSceneLayerStyle(scene, layerName)
  return style.visible && style.opacity > 0
}

/** Sides of the polygon drawn around a disc or an ellipse: it holds the shape and overshoots it by under 0.5 %. */
const OUTLINE_SIDES = 32

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * `plantContext` sizes the plants as the renderer does (species symbols, canopy spreads). Its own scale is replaced by the
 * candidate scale.
 */
export function sceneExtentPoints(
  scene: ScenePersistedState,
  plantContext: PlantPresentationContext,
): (pixelsPerMetre: number) => readonly WorldPoint[] {
  return (pixelsPerMetre) => {
    const points: WorldPoint[] = []
    const corners = (box: Box): void => {
      points.push(
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height },
      )
    }
    const plantsAtScale: PlantPresentationContext = {
      ...plantContext,
      pixelsPerMetre,
      plants: scene.plants,
    }
    if (isLayerShown(scene, 'plants')) {
      for (const plant of scene.plants) corners(getPlantWorldBounds(plant, plantsAtScale))
    }
    if (isLayerShown(scene, 'zones')) {
      for (const zone of scene.zones) {
        const box = getZoneWorldBounds(zone)
        if (box) corners(box)
      }
    }
    if (isLayerShown(scene, 'annotations')) {
      for (const annotation of scene.annotations) corners(getAnnotationWorldBounds(annotation, pixelsPerMetre))
    }
    if (isLayerShown(scene, 'measurement-guides')) {
      for (const guide of scene.measurementGuides) points.push({ ...guide.start }, { ...guide.end })
    }
    return points
  }
}

/**
 * The selected objects' outlines at `pixelsPerMetre`, for zoom to selection: zones by their shape (rectangle corners, polygon and
 * line vertices, a polygon around an ellipse), plants by a polygon around their disc, notes by their four corners as the selection
 * shows them, and measurement guides by their ends; a group contributes its members. An oriented fit of these points frames the
 * shapes, never their world-axis boxes (spec §1.1).
 */
export function selectionExtentPoints(
  scene: ScenePersistedState,
  targets: readonly SceneDesignObjectTarget[],
  options: { readonly plantContext: PlantPresentationContext; readonly revealedAnnotationId?: string | null },
): (pixelsPerMetre: number) => readonly WorldPoint[] {
  return (pixelsPerMetre) => {
    const points: WorldPoint[] = []
    const plantsAtScale: PlantPresentationContext = {
      ...options.plantContext,
      pixelsPerMetre,
      plants: scene.plants,
    }
    let detailAnnotationIds: ReadonlySet<string> | null = null
    const add = (target: SceneDesignObjectTarget, revealedAnnotationId: string | null): void => {
      if (target.kind === 'group') {
        const group = scene.groups.find((entry) => entry.id === target.id)
        if (group) for (const member of resolveSceneObjectGroupMembers(scene, group)) add(member, null)
        return
      }
      if (target.kind === 'plant') {
        if (!isLayerShown(scene, 'plants')) return
        const plant = scene.plants.find((entry) => entry.id === target.id)
        if (plant) points.push(...outlineAround(plant.position, getPlantWorldBounds(plant, plantsAtScale).width / 2))
        return
      }
      if (target.kind === 'zone') {
        if (!isLayerShown(scene, 'zones')) return
        const zone = scene.zones.find((entry) => entry.id === target.id)
        if (zone) points.push(...zoneOutline(zone))
        return
      }
      if (target.kind === 'annotation') {
        if (!isLayerShown(scene, 'annotations')) return
        const annotation = scene.annotations.find((entry) => entry.id === target.id)
        if (!annotation) return
        detailAnnotationIds ??= getCanvasDetailLayout(scene, pixelsPerMetre, options.plantContext.plantDisplay?.symbolScale).annotationIds
        points.push(...getAnnotationVisualWorldCorners(
          annotation, pixelsPerMetre, annotation.id === revealedAnnotationId, detailAnnotationIds.has(annotation.id),
        ))
        return
      }
      if (!isLayerShown(scene, 'measurement-guides')) return
      const guide = scene.measurementGuides.find((entry) => entry.id === target.id)
      if (guide) points.push({ ...guide.start }, { ...guide.end })
    }
    for (const target of targets) add(target, options.revealedAnnotationId ?? null)
    return points
  }
}

function zoneOutline(zone: SceneZoneEntity): readonly WorldPoint[] {
  return getZoneExtentPoints(zone)
}

/** Outline points of every placed object in the Scene (plants, zone outlines, notes, measurement guides), in plane metres. */
export function designOutlinePoints(scene: ScenePersistedState): WorldPoint[] {
  const points: WorldPoint[] = []
  for (const plant of scene.plants) points.push(plant.position)
  for (const zone of scene.zones) points.push(...zoneOutline(zone))
  for (const annotation of scene.annotations) points.push(annotation.position)
  for (const guide of scene.measurementGuides) points.push(guide.start, guide.end)
  return points
}

/**
 * A regular polygon around the ellipse (a disc when `radiusY` is omitted) turned by `rotationDeg` about its centre, as zones turn:
 * its sides touch the shape, and at rotation 0 the ones facing the axes lie on its box.
 */
function outlineAround(centre: WorldPoint, radiusX: number, radiusY = radiusX, rotationDeg = 0): WorldPoint[] {
  const reach = 1 / Math.cos(Math.PI / OUTLINE_SIDES)
  const radians = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const points: WorldPoint[] = []
  for (let side = 0; side < OUTLINE_SIDES; side++) {
    const angle = ((2 * side + 1) * Math.PI) / OUTLINE_SIDES
    const across = Math.cos(angle) * radiusX * reach
    const down = Math.sin(angle) * radiusY * reach
    points.push({ x: centre.x + across * cos - down * sin, y: centre.y + across * sin + down * cos })
  }
  return points
}
