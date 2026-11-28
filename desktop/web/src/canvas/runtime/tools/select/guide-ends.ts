// canvas/runtime/tools/select/guide-ends.ts
//
// Owns the end handles of the one selected measurement guide under Select: its two ends as ToolHandle data the host shows
// through the handle layer, the geometry of dragging one (a 0.5 m minimum length) and the length chip the drag shows
// beside the selected zone's chips (tools/measure-labels.ts, `measure-quiet`). The drag itself is point-handle.ts's, edit type
// 'interaction-measurement-guide-control-point'. Each handle's label is translated ('canvas.guideEnd.label').

import type { ToolHandleId } from '../../interaction-types'
import { createMeasurementGuideDraftMeasurements } from '../../measurement-guides'
import type { CanvasDesignObjectSelectionModel } from '../../runtime'
import { singleEditableTarget } from '../../scene-runtime/selection'
import type { SceneMeasurementGuideEntity, ScenePersistedState } from '../../scene/types'
import type { GroundMeasure } from '../../../../geo/session-plane'
import type { UnitSystem } from '../../../../utils/format'
import type { WorldPoint } from '../../../../geo/view/types'
import type { DraftShape, ToolHandle } from '../draft'
import { measureLabelShapes } from '../measure-labels'
import type { ToolContext } from '../tool'
import type { HandleSize } from './handle-size'
import type { PointHandleSubject } from './point-handle'

/** One end handle: which end of which guide it moves ('a' the start, 'b' the end). */
export interface GuideEnd {
  readonly id: ToolHandleId
  readonly guideId: string
  readonly index: 0 | 1
  readonly world: WorldPoint
}

const MIN_MEASUREMENT_GUIDE_LENGTH_M = 0.5

/** The one selected guide the end handles belong to: a single editable guide, nothing locked or blocked. */
export function draggableGuide(
  scene: Readonly<ScenePersistedState>,
  selection: CanvasDesignObjectSelectionModel,
): SceneMeasurementGuideEntity | null {
  const target = singleEditableTarget(selection, 'measurement-guide')
  return target ? scene.measurementGuides.find((guide) => guide.id === target.id) ?? null : null
}

export function guideEnds(guide: SceneMeasurementGuideEntity): GuideEnd[] {
  return [
    { id: `guide-end:${guide.id}:a` as ToolHandleId, guideId: guide.id, index: 0, world: guide.start },
    { id: `guide-end:${guide.id}:b` as ToolHandleId, guideId: guide.id, index: 1, world: guide.end },
  ]
}

export function guideEndHandles(ends: readonly GuideEnd[], size: HandleSize, translate: ToolContext['translate']): ToolHandle[] {
  return ends.map((end) => ({
    id: end.id,
    anchor: end.world,
    hitRadiusPx: size.pointRadiusPx,
    glyph: 'vertex',
    label: translate('canvas.guideEnd.label', { index: end.index + 1 }),
  }))
}

/** What dragging `end` edits. */
export function guideEndSubject(
  guide: SceneMeasurementGuideEntity,
  end: GuideEnd,
): PointHandleSubject<SceneMeasurementGuideEntity> {
  return {
    editType: 'interaction-measurement-guide-control-point',
    entityId: guide.id,
    start: cloneMeasurementGuide(guide),
    reshape: (start, dragged) => reshapeMeasurementGuide(start, end.index, dragged),
    equal: measurementGuidesEqual,
    write(draft, guideId, next) {
      draft.measurementGuides = draft.measurementGuides.map((entry) => (entry.id === guideId ? next : entry))
    },
  }
}

/** The dragged guide's length chip; `screenDistance` is ToolView.screenDistance. */
export function guideLengthShapes(
  guide: Pick<SceneMeasurementGuideEntity, 'start' | 'end'>,
  screenDistance: (a: WorldPoint, b: WorldPoint) => number,
  groundMeasure?: Pick<GroundMeasure, 'groundLength'>,
  unitSystem: UnitSystem = 'metric',
  locale = 'en',
): DraftShape[] {
  return measureLabelShapes(
    createMeasurementGuideDraftMeasurements(guide.start, guide.end, groundMeasure, unitSystem, locale),
    screenDistance,
  )
}

/** The guide with its end `index` at `dragged`, or null where it would be shorter than the minimum. */
function reshapeMeasurementGuide(
  guide: SceneMeasurementGuideEntity,
  index: 0 | 1,
  dragged: WorldPoint,
): SceneMeasurementGuideEntity | null {
  const next = index === 0 ? { ...guide, start: { ...dragged } } : { ...guide, end: { ...dragged } }
  if (Math.hypot(next.end.x - next.start.x, next.end.y - next.start.y) < MIN_MEASUREMENT_GUIDE_LENGTH_M) return null
  return next
}

function measurementGuidesEqual(left: SceneMeasurementGuideEntity, right: SceneMeasurementGuideEntity): boolean {
  return left.start.x === right.start.x
    && left.start.y === right.start.y
    && left.end.x === right.end.x
    && left.end.y === right.end.y
}

function cloneMeasurementGuide(guide: SceneMeasurementGuideEntity): SceneMeasurementGuideEntity {
  return { ...guide, start: { ...guide.start }, end: { ...guide.end } }
}
