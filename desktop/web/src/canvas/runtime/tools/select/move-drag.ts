// canvas/runtime/tools/select/move-drag.ts
//
// Owns Select's move-drag: a press on a selectable object opens one
// 'interaction-drag' Scene Edit over the selection's editable objects; each move shifts them by the pointer's travel since
// the press, snapped so that the pressed object (or the first captured one) lands on the grid and guides, not the pointer
// (ToolContext.snap); the release commits once when anything moved more than a millimetre, one undo step through the
// scene's patch command, and otherwise rolls back. While a plant is dragged, the draft shows its distances to the two
// nearest plants left behind (tools/distance-guides.ts).

import {
  applySceneDragDeltaToDraft,
  captureSceneDragState,
  createSceneDragState,
  type SceneDragState,
} from '../../scene-runtime/drag-state'
import type { SceneEditTransaction } from '../../scene-runtime/transactions'
import type { SceneDesignObjectTarget } from '../../scene/design-object-targets'
import type { ScenePersistedState } from '../../scene/types'
import type { WorldPoint } from '../../../../geo/view/types'
import type { DraftPresentation } from '../draft'
import { plantDragDistanceGuideShapes } from '../distance-guides'
import type { ToolContext, ToolPoint } from '../tool'

/** A shift below this (metres, per axis) is the same shift. */
const DELTA_EPSILON_M = 0.0001
/** A drag that moved no axis further than this (metres) moved nothing. */
const MOVED_THRESHOLD_M = 0.001

export interface MoveDrag {
  readonly tx: SceneEditTransaction
  readonly state: SceneDragState
  readonly start: WorldPoint
  /** The point that snaps: the pressed object's reference point, else the first captured one. */
  readonly snapRef: WorldPoint | null
  /** The dragged plant the distance guides start from. */
  readonly activePlantId: string | null
  lastDelta: WorldPoint
  /** True until the Scene Edit is committed or rolled back. */
  open: boolean
}

/** Opens the drag of the selection's editable objects from the press on `hit`. */
export function beginMoveDrag(
  ctx: ToolContext,
  scene: Readonly<ScenePersistedState>,
  hit: SceneDesignObjectTarget,
  start: ToolPoint,
): MoveDrag {
  const tx = ctx.effects.edits.begin('interaction-drag')
  const state = createSceneDragState()
  captureSceneDragState(state, scene, ctx.scene.selectionModel().editableTargets)
  return {
    tx,
    state,
    start: start.world,
    snapRef: dragStartForTarget(state, hit) ?? firstCapturedDragStart(state),
    activePlantId: hit.kind === 'plant' && state.plantStarts.has(hit.id) ? hit.id : null,
    lastDelta: { x: 0, y: 0 },
    open: true,
  }
}

/** Moves the selection to the pointer; returns the draft to show, or undefined when nothing changed. */
export function moveSelection(ctx: ToolContext, drag: MoveDrag, point: ToolPoint): DraftPresentation | null | undefined {
  const delta = snappedDelta(ctx, drag, point.world)
  if (Math.abs(delta.x - drag.lastDelta.x) < DELTA_EPSILON_M && Math.abs(delta.y - drag.lastDelta.y) < DELTA_EPSILON_M) {
    return undefined
  }
  drag.lastDelta = delta
  drag.tx.mutate((draft) => applySceneDragDeltaToDraft(draft, drag.state, delta))
  return distanceGuides(ctx, drag)
}

/** True when the drag moved anything. */
export function hasMoved(drag: MoveDrag): boolean {
  return Math.abs(drag.lastDelta.x) > MOVED_THRESHOLD_M || Math.abs(drag.lastDelta.y) > MOVED_THRESHOLD_M
}

/** Commits a drag that moved. */
export function commitMoveDrag(drag: MoveDrag): void {
  if (!drag.open) return
  drag.open = false
  drag.tx.commit()
}

/** Rolls the selection back. */
export function abortMoveDrag(drag: MoveDrag): void {
  if (!drag.open) return
  drag.tx.abort()
  drag.open = false
}

function snappedDelta(ctx: ToolContext, drag: MoveDrag, world: WorldPoint): WorldPoint {
  const raw = { x: world.x - drag.start.x, y: world.y - drag.start.y }
  const ref = drag.snapRef
  if (!ref) return raw
  const snapped = ctx.snap({ x: ref.x + raw.x, y: ref.y + raw.y })
  return { x: snapped.x - ref.x, y: snapped.y - ref.y }
}

function distanceGuides(ctx: ToolContext, drag: MoveDrag): DraftPresentation | null {
  const plantId = drag.activePlantId
  const active = plantId ? ctx.scene.persisted.plants.find((plant) => plant.id === plantId) : undefined
  if (!active) return null
  const shapes = plantDragDistanceGuideShapes(ctx.scene, active, new Set(drag.state.plantStarts.keys()))
  return shapes.length > 0 ? { shapes } : null
}

function dragStartForTarget(state: SceneDragState, target: SceneDesignObjectTarget): WorldPoint | null {
  if (target.kind === 'plant') return state.plantStarts.get(target.id) ?? null
  if (target.kind === 'annotation') return state.annotationStarts.get(target.id) ?? null
  if (target.kind === 'measurement-guide') return state.measurementGuideStarts.get(target.id)?.start ?? null
  if (target.kind === 'zone') return state.zoneStarts.get(target.id)?.[0] ?? null
  return null
}

function firstCapturedDragStart(state: SceneDragState): WorldPoint | null {
  return state.plantStarts.values().next().value
    ?? state.annotationStarts.values().next().value
    ?? state.measurementGuideStarts.values().next().value?.start
    ?? state.zoneStarts.values().next().value?.[0]
    ?? null
}
