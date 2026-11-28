// canvas/runtime/tools/stamp-rotation.ts  (pure)
//
// Owns how a held stamp's angle steps (each stamp tool keeps its own pick's start: the saved stamp's in
// saved-object-stamp.ts), where a stamp's objects land (stampTemplateAt: turned about the stamp's anchor, then moved with
// it to the pointer; the ghost and the placement both use it), and the ghosts that show what a press would place: drafts
// of 'objects' ghosts, zones and plants in one at 0.62 and notes in a second at 0.68 (today's opacities), for both stamp
// tools and the saved stamp's dragover preview for the drop route. `[` and `]` reach the stamp tools as rotate-held
// commands of ±15° from the keyboard port, which keeps today's key gating (spec §1.2a).

import { type SceneArrangementTemplate, translatePoint, translateZonePoints } from '../scene-runtime/arrangement-placement'
import {
  rotateAnnotationAbout,
  rotatePlantAbout,
  rotateZoneAbout,
} from '../scene-runtime/selection-rotation'
import type { ScenePoint } from '../scene/types'
import { createScreenAlignedBounds } from './hit-testing'
import type { DraftShape } from './draft'

const STAMP_GHOST_OPACITY = 0.62
/** Notes draw a little less faint than zones and plants (the draft layer multiplies each note's own opacities). */
const STAMP_GHOST_NOTE_OPACITY = 0.68

/** The stamp's angle after a step, normalised to [0, 360): a saved stamp starts at any live bearing (37.5° → 52.5°). */
export function turnStampRotation(current: number, step: number): number {
  return (((current + step) % 360) + 360) % 360
}

/**
 * The stamp's objects where a press with its anchor at `at` places them: turned by `degrees` about the anchor, as the
 * selection rotation turns them, then moved by at − anchor. The ghost draws this template and the placement adds it.
 */
export function stampTemplateAt(
  template: SceneArrangementTemplate,
  anchor: ScenePoint,
  at: ScenePoint,
  degrees: number,
): SceneArrangementTemplate {
  const turned = rotateArrangementTemplate(template, anchor, degrees)
  const delta = { x: at.x - anchor.x, y: at.y - anchor.y }
  return {
    plants: turned.plants.map((entry) => ({ ...entry, entity: { ...entry.entity, position: translatePoint(entry.entity.position, delta) } })),
    zones: turned.zones.map((entry) => ({ ...entry, entity: { ...entry.entity, points: translateZonePoints(entry.entity, delta) } })),
    annotations: turned.annotations.map((entry) => ({
      ...entry,
      entity: { ...entry.entity, position: translatePoint(entry.entity.position, delta) },
    })),
    measurementGuides: turned.measurementGuides.map((entry) => ({
      ...entry,
      entity: { ...entry.entity, start: translatePoint(entry.entity.start, delta), end: translatePoint(entry.entity.end, delta) },
    })),
    groups: turned.groups,
  }
}

function rotateArrangementTemplate(
  template: SceneArrangementTemplate,
  pivot: ScenePoint,
  degrees: number,
): SceneArrangementTemplate {
  if (degrees === 0) return template
  return {
    ...template,
    plants: template.plants.map((entry) => ({ ...entry, entity: rotatePlantAbout(entry.entity, pivot, degrees) })),
    zones: template.zones.map((entry) => ({ ...entry, entity: rotateZoneAbout(entry.entity, pivot, degrees) })),
    annotations: template.annotations.map((entry) => ({ ...entry, entity: rotateAnnotationAbout(entry.entity, pivot, degrees) })),
  }
}

/**
 * A stamp's ghosts as drafts of a template already where a press would put it (stampTemplateAt): zones and plants in one
 * 'objects' ghost at 0.62, notes in a second at 0.68 (today's opacities).
 */
export function stampGhostShapes(template: SceneArrangementTemplate): DraftShape[] {
  const shapes: DraftShape[] = []
  if (template.plants.length + template.zones.length > 0) {
    shapes.push(ghostOf({ ...NO_OBJECTS, plants: template.plants, zones: template.zones }, STAMP_GHOST_OPACITY))
  }
  if (template.annotations.length > 0) {
    shapes.push(ghostOf({ ...NO_OBJECTS, annotations: template.annotations }, STAMP_GHOST_NOTE_OPACITY))
  }
  return shapes
}

const NO_OBJECTS: SceneArrangementTemplate = Object.freeze({ plants: [], zones: [], annotations: [], measurementGuides: [], groups: [] })

function ghostOf(template: SceneArrangementTemplate, opacity: number): DraftShape {
  return { kind: 'ghost', opacity, entity: { kind: 'objects', template } }
}

/**
 * The centre of a stamp template's screen-aligned bounding box at `bearingDeg` (2.1-Q89):
 * at bearing 0 this equals the world AABB centre; on a turned map it projects onto the
 * screen's right/down axes (`right = (cos θ, sin θ)`, `down = (-sin θ, cos θ)`).
 */
export function screenAlignedTemplateCenter(
  template: SceneArrangementTemplate,
  bearingDeg: number,
): ScenePoint | null {
  const box = createScreenAlignedBounds(bearingDeg)
  for (const { entity } of template.plants) box.addPoint(entity.position)
  for (const { entity } of template.zones) box.addZone(entity)
  for (const { entity } of template.annotations) box.addPoint(entity.position)
  for (const { entity } of template.measurementGuides) box.addPoints([entity.start, entity.end])
  return box.center()
}
