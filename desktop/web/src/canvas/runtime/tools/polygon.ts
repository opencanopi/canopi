// canvas/runtime/tools/polygon.ts
//
// Owns the vertex-path grammar Polygon and Profile share (createVertexPathTool, architecture review finding 14), and
// Polygon as its spec. Each press adds a point at the snapped point (with Shift the new segment turns to a 45° step from
// the last point through the host's constraint, its length then snapped, spec §2.3). The spec's `closesAt` may finish on
// a press (Polygon: within 8 px of the first corner, a finger's within 22 px, Q5, tested on ToolPoint.free); the second
// press of a double-click, Enter and the canvas menu's "Finish shape" (canFinish) finish a path of `minPoints` or more
// through the spec's `finish`. Alt+press on a placed point (within the closing radius) deletes it and the redo, the
// first included (answer 2: the zone corners' rule while drawing). Hovers, and the drag after a press, move the rubber
// band and add nothing. Backspace, Edit › Undo and Esc take the last point back onto a redo stack (transient history, no Scene Edit), and
// Ctrl+Shift+Z restores it; the Esc that takes the last point empties the draft and its redo, so the next Esc leaves the
// tool, and an Esc on a redo-only history drops it and arms Select at once (A17); an interruption ('navigate') keeps
// them while the draft has points and drops a redo-only history, as today; overview, a tool change or a document
// replacement drops them. The draft holds re-origin (hasTransient), so its points stay in one plane.
// Polygon: the first corner clears the selection without an undo step, and the finish is one Scene Edit that adds the
// zone and selects it. Its draft is a fill-only polygon of the corners, the rubber band, a disc per corner and the edge
// and area chips (tools/measure-labels.ts), whose edge chips re-cull on every camera frame.

import { CLOSE_DISTANCE_PX, isSamePoint } from '../../point-editor/rules'
import type { ToolId } from '../interaction-types'
import type { GroundMeasure } from '../../../geo/session-plane'
import type { WorldPoint } from '../../../geo/view/types'
import { createPolygonalZoneDraftMeasurements } from '../zone-measurements'
import type { DraftShape, DraftStroke } from './draft'
import { measureLabelShapes } from './measure-labels'
import type { CanvasTool, ToolCommand, ToolContext, ToolGesture, ToolPoint, ToolReply, ToolScene, ToolView } from './tool'
import { appendPolygonZoneToDraft } from './tool-actions'
import { DRAFT_STROKE, ZONE_DRAFT_FILL } from './zone-drag'

/** The corners' fill carries no stroke: the rubber band draws the edges. */
const FILL_ONLY: DraftStroke = Object.freeze({ token: 'draft', widthPx: 0 })
/** A light disc of radius 3.5 px on a 1 px casing ring (plan §1, exception 2), at each point of a vertex path. */
export const VERTEX_MARKER = Object.freeze({ radiusPx: 1.75, style: Object.freeze({ token: 'draft', widthPx: 3.5 }) as DraftStroke })

/** What one vertex-path tool needs beyond the shared grammar. */
export interface VertexPathSpec {
  readonly id: ToolId
  /** The points a finish needs (Polygon 3, Profile 2). */
  readonly minPoints: number
  /** A press that finishes instead of adding a point, given `minPoints` already (Polygon: on the first corner). */
  closesAt?(points: readonly WorldPoint[], press: ToolPoint, view: ToolView): boolean
  /** Whether the path may be drawn now; a press or a finish while it may not drops the draft (Polygon: zones open). */
  canDraw?(scene: ToolScene): boolean
  /** The first point is about to be placed (Polygon clears the selection). */
  onFirstPoint?(ctx: ToolContext): void
  /** The draft of the placed points and the rubber band's end (the pointer, or the last point placed). */
  draft(points: readonly WorldPoint[], active: WorldPoint | null, view: ToolView, groundMeasure?: GroundMeasure): DraftShape[]
  /** Finishes a path of `minPoints` or more; `done` drops the draft (now, or when an edit commits). */
  finish(points: readonly WorldPoint[], ctx: ToolContext, done: () => void): void
}

export function createPolygonTool(): CanvasTool {
  return createVertexPathTool(POLYGON)
}

const POLYGON: VertexPathSpec = {
  id: 'polygon',
  minPoints: 3,
  closesAt: (corners, press, view) => view.screenDistance(corners[0]!, press.free) <= CLOSE_DISTANCE_PX[press.pointer],
  canDraw: (scene) => scene.isLayerOpenForCreation('zones'),
  onFirstPoint({ scene, effects }) {
    if (scene.selection().length > 0) effects.setSelection([])
  },
  draft: polygonDraftShapes,
  /** One Scene Edit adds the zone and selects it; the draft goes once it commits. */
  finish(shape, { effects }, done) {
    effects.edits.run('interaction-polygon', (tx) => {
      let zoneId: string | null = null
      tx.mutate((draft) => {
        zoneId = appendPolygonZoneToDraft(draft, shape)
      })
      if (zoneId) tx.setSelection([{ kind: 'zone', id: zoneId }])
    }, {
      onCommitted: () => done(),
    })
  },
}

/** A tool that draws a path point by point: Polygon's grammar, with what differs in `spec`. */
export function createVertexPathTool(spec: VertexPathSpec): CanvasTool {
  let ctx: ToolContext | null = null
  let points: WorldPoint[] = []
  let redo: WorldPoint[] = []
  /** Where the rubber band ends: the pointer, or the last point placed. */
  let active: WorldPoint | null = null
  let drawn = false

  function context(): ToolContext {
    if (!ctx) throw new Error(`The ${spec.id} tool is not active`)
    return ctx
  }

  function hasTransient(): boolean {
    return points.length > 0 || redo.length > 0
  }

  function canDraw(): boolean {
    return spec.canDraw?.(context().scene) ?? true
  }

  function redraw(): void {
    const { effects, scene, view } = context()
    effects.setGuidance({ gesture: points.length > 0 })
    if (points.length === 0) {
      if (!drawn) return
      drawn = false
      effects.setDraft(null)
      return
    }
    drawn = true
    effects.setDraft({ shapes: spec.draft(points, active, view, scene.groundMeasure) })
  }

  function press(point: ToolPoint, clickCount: number): void {
    if (!canDraw()) {
      drop()
      return
    }
    // Alt+press on a placed point deletes it, the first included: it never closes or finishes (answer 2).
    const under = point.modifiers.subtractive ? pointUnder(point) : null
    if (under !== null) {
      deletePoint(under)
      return
    }
    // A press the spec closes on, or the second press of a double-click, finishes a path of minPoints or more; the
    // second press of a double-click whose first finished the path starts nothing.
    if (closesAt(point) || (clickCount >= 2 && points.length >= spec.minPoints)) {
      finish()
      return
    }
    if (clickCount >= 2 && points.length === 0) return
    const next = point.snapped
    const last = points[points.length - 1]
    if (last && isSamePoint(last, next)) {
      active = next
      redraw()
      return
    }
    if (points.length === 0) spec.onFirstPoint?.(context())
    points = [...points, next]
    redo = []
    active = next
    redraw()
  }

  /** The placed point nearest an Alt+press within the closing radius on screen (a finger's on touch), else null. */
  function pointUnder(press: ToolPoint): number | null {
    const { view } = context()
    let nearest: number | null = null
    let best = CLOSE_DISTANCE_PX[press.pointer]
    points.forEach((placed, index) => {
      const distance = view.screenDistance(placed, press.free)
      if (distance <= best) {
        best = distance
        nearest = index
      }
    })
    return nearest
  }

  /** Alt+press: the point goes, and the redo with it (a new edit, as a new point). */
  function deletePoint(index: number): void {
    points = points.filter((_, at) => at !== index)
    redo = []
    if (points.length === 0) active = null
    redraw()
  }

  function closesAt(point: ToolPoint): boolean {
    if (points.length < spec.minPoints || !spec.closesAt) return false
    return spec.closesAt(points, point, context().view)
  }

  /** Fewer than minPoints wait; a path that may no longer be drawn drops. */
  function finish(): void {
    if (points.length < spec.minPoints) return
    if (!canDraw()) {
      drop()
      return
    }
    spec.finish(points, context(), drop)
  }

  function undo(): boolean {
    const removed = points[points.length - 1]
    if (!removed) return false
    redo = [...redo, removed]
    points = points.slice(0, -1)
    if (points.length === 0) active = null
    redraw()
    return true
  }

  function redoPoint(): boolean {
    const restored = redo[redo.length - 1]
    if (!restored) return false
    redo = redo.slice(0, -1)
    points = [...points, restored]
    if (active === null) active = restored
    redraw()
    return true
  }

  /** Esc (A17): the last point goes onto the redo stack; the last one left takes the redo with it, so the next Esc
   *  leaves the tool; a redo-only history goes, and the tool asks for Select in the same press. */
  function stepBack(): boolean {
    if (points.length > 1) return undo()
    if (points.length === 1) {
      drop()
      return true
    }
    if (redo.length === 0) return false
    drop()
    context().effects.requestTool('select')
    return true
  }

  function drop(): void {
    points = []
    redo = []
    active = null
    redraw()
  }

  /** The rubber band follows the pointer while a draft is open; the passive hover waits. */
  function follow(point: ToolPoint): ToolReply {
    if (points.length === 0) return 'pass'
    active = point.snapped
    redraw()
    return 'handled'
  }

  return {
    id: spec.id,
    constraint() {
      const last = points[points.length - 1]
      return last ? { kind: 'direction', origin: last, stepDeg: 45 } : null
    },
    activate(next) {
      ctx = next
      points = []
      redo = []
      active = null
      drawn = false
    },
    gesture(g: ToolGesture): ToolReply {
      switch (g.kind) {
        case 'press':
          press(g.point, g.clickCount)
          return 'handled'
        case 'hover':
        case 'drag-start':
        case 'drag-move':
          return follow(g.point)
        // The press added the point: a tap or a drag's end adds nothing, and a cancel keeps the draft.
        default:
          return 'pass'
      }
    },
    command(c: ToolCommand): ToolReply {
      switch (c.kind) {
        case 'confirm':
          if (points.length === 0) return 'pass'
          finish()
          return 'handled'
        case 'remove-last':
        case 'undo-transient':
          return undo() ? 'handled' : 'pass'
        case 'redo-transient':
          return redoPoint() ? 'handled' : 'pass'
        case 'escape':
          return stepBack() ? 'handled' : 'pass'
        default:
          return 'pass'
      }
    },
    viewChanged() {
      if (points.length > 0) redraw()
    },
    canFinish: () => points.length >= spec.minPoints,
    hasTransient,
    cancelTransient(reason) {
      // An interruption keeps the draft only while it has points (today's hasPolygonDraft): a redo-only history goes.
      if (reason === 'navigate' && points.length > 0) return
      if (hasTransient()) drop()
    },
    canUndoTransient: () => points.length > 0,
    canRedoTransient: () => redo.length > 0,
    deactivate() {
      if (hasTransient()) drop()
    },
  }
}

function polygonDraftShapes(
  corners: readonly WorldPoint[],
  active: WorldPoint | null,
  view: ToolView,
  groundMeasure?: GroundMeasure,
): DraftShape[] {
  const shapes: DraftShape[] = []
  if (corners.length >= 3) shapes.push({ kind: 'polygon', points: corners, style: FILL_ONLY, fill: ZONE_DRAFT_FILL })
  const band = active ? [...corners, active] : corners
  if (band.length >= 2) shapes.push({ kind: 'polyline', points: band, style: DRAFT_STROKE })
  for (const center of corners) shapes.push({ kind: 'circle-px', center, ...VERTEX_MARKER })
  const chips = createPolygonalZoneDraftMeasurements(corners, active, groundMeasure)
  shapes.push(...measureLabelShapes(chips, (a, b) => view.screenDistance(a, b)))
  return shapes
}
