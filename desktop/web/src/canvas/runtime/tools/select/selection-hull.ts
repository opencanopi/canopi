// canvas/runtime/tools/select/selection-hull.ts
//
// Owns the selection's projected hull (spec §4.9): the screen box of the shapes the selection draws, as the world quad
// of that box. Each target is measured along the screen's axes as it is drawn: a rectangle by its turned corners, an
// ellipse by its turned radii, a polygon or a line by its points, a plant as the circle of its drawn radius, a note as
// its turned text box, a guide by its ends, a group by its members. The selection's world bounds are never used: on a
// turned map their box spreads into a diamond far wider than a shape drawn level on screen. The rotation handle sits
// above this hull (rotate-handle.test.ts, "the handle sits 28 px above the projected hull" and its shape cases), and the
// keyboard menu opens beside it (tool-host.test.ts, "the keyboard menu opens beside a shape drawn level at 45").

import { getAnnotationVisualWorldCorners, getRevealedAnnotationId } from '../../annotation-layout'
import { getCanvasDetailLayout } from '../../automatic-detail'
import type { CanvasDesignObjectSelectionModel } from '../../runtime'
import { resolveSceneObjectGroupMembers } from '../../scene/group-members'
import type { SceneDesignObjectTarget } from '../../scene/design-object-targets'
import type { SceneZoneEntity } from '../../scene/types'
import type { WorldPoint, WorldQuad } from '../../../../geo/view/types'
import { getRectangularZoneCorners } from '../../zone-geometry'
import { screenBasisOf, screenCoordsToWorldDelta, worldDeltaToScreenCoords } from '../screen-basis'
import type { ToolScene, ToolView } from '../tool'

/** The view queries the hull needs: ToolView, and the session's ViewTransform for the menu. */
type HullView = Pick<ToolView, 'metresPerPixelAt' | 'screenAxesInWorld' | 'worldDeltaToScreen' | 'screenDeltaToWorld'>

/**
 * The selection's screen box as a world quad, its corners top-left, top-right, bottom-right and bottom-left on screen;
 * null when no selected target is drawn.
 */
export function selectionScreenHull(scene: ToolScene, selection: CanvasDesignObjectSelectionModel, view: HullView): WorldQuad | null {
  const basis = screenBasisOf(view)
  const coordAcross = (v: { readonly x: number; readonly y: number }): number => worldDeltaToScreenCoords(basis, v).x
  const coordDown = (v: { readonly x: number; readonly y: number }): number => worldDeltaToScreenCoords(basis, v).y
  const pixelsPerMetreAt = (point: WorldPoint): number => 1 / Math.max(view.metresPerPixelAt(point), 1e-9)
  const persisted = scene.persisted
  const revealedId = getRevealedAnnotationId(scene.selection())
  const extent = { minAcross: Infinity, maxAcross: -Infinity, minDown: Infinity, maxDown: -Infinity }

  const span = (centre: WorldPoint, halfAcross: number, halfDown: number): void => {
    const projected = worldDeltaToScreenCoords(basis, centre)
    extent.minAcross = Math.min(extent.minAcross, projected.x - halfAcross)
    extent.maxAcross = Math.max(extent.maxAcross, projected.x + halfAcross)
    extent.minDown = Math.min(extent.minDown, projected.y - halfDown)
    extent.maxDown = Math.max(extent.maxDown, projected.y + halfDown)
  }
  const points = (outline: readonly WorldPoint[]): void => {
    for (const point of outline) span(point, 0, 0)
  }

  const add = (target: SceneDesignObjectTarget, revealable: boolean): void => {
    switch (target.kind) {
      case 'group': {
        const group = persisted.groups.find((entry) => entry.id === target.id)
        if (group) for (const member of resolveSceneObjectGroupMembers(persisted, group)) add(member, false)
        return
      }
      case 'plant': {
        const plant = persisted.plants.find((entry) => entry.id === target.id)
        if (!plant) return
        const radiusPx = scene.plantPresentation(plant).radiusPx
        span(plant.position, radiusPx, radiusPx)
        return
      }
      case 'zone': {
        const zone = persisted.zones.find((entry) => entry.id === target.id)
        if (zone) addZone(zone, coordAcross, coordDown, span, points)
        return
      }
      case 'annotation': {
        const annotation = persisted.annotations.find((entry) => entry.id === target.id)
        if (!annotation) return
        const pixelsPerMetre = pixelsPerMetreAt(annotation.position)
        const textAllowed = getCanvasDetailLayout(persisted, pixelsPerMetre).annotationIds.has(annotation.id)
        points(getAnnotationVisualWorldCorners(
          annotation, pixelsPerMetre, revealable && annotation.id === revealedId, textAllowed,
        ))
        return
      }
      case 'measurement-guide': {
        const guide = persisted.measurementGuides.find((entry) => entry.id === target.id)
        if (guide) points([guide.start, guide.end])
        return
      }
    }
  }

  for (const target of [...selection.editableTargets, ...selection.lockedTargets]) add(target, true)
  if (!Number.isFinite(extent.minAcross)) return null
  const at = (across: number, downward: number): WorldPoint => screenCoordsToWorldDelta(basis, { x: across, y: downward })
  return [
    at(extent.minAcross, extent.minDown),
    at(extent.maxAcross, extent.minDown),
    at(extent.maxAcross, extent.maxDown),
    at(extent.minAcross, extent.maxDown),
  ]
}

function addZone(
  zone: SceneZoneEntity,
  coordAcross: (v: { readonly x: number; readonly y: number }) => number,
  coordDown: (v: { readonly x: number; readonly y: number }) => number,
  span: (centre: WorldPoint, halfAcross: number, halfDown: number) => void,
  points: (outline: readonly WorldPoint[]) => void,
): void {
  if (zone.zoneType === 'rect' && zone.points.length >= 4) {
    const corners = getRectangularZoneCorners(zone)
    if (corners) points(corners)
    return
  }
  if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
    // The turned ellipse's half-extent in the (right, down) dual basis: hypot of the two semi-axes' coordinates.
    const centre = zone.points[0]!
    const radii = zone.points[1]!
    const radians = (zone.rotationDeg * Math.PI) / 180
    const major = { x: Math.cos(radians) * Math.abs(radii.x), y: Math.sin(radians) * Math.abs(radii.x) }
    const minor = { x: -Math.sin(radians) * Math.abs(radii.y), y: Math.cos(radians) * Math.abs(radii.y) }
    span(
      centre,
      Math.hypot(coordAcross(major), coordAcross(minor)),
      Math.hypot(coordDown(major), coordDown(minor)),
    )
    return
  }
  points(zone.points)
}
