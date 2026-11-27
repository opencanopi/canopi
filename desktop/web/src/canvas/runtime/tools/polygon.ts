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

import { CLOSE_DISTANCE_PX, isSamePoint, pointMenuItems, pointPressIntent } from '../../point-editor/rules'
import type { ToolHandleId, ToolId } from '../interaction-types'
import type { GroundMeasure } from '../../../geo/session-plane'
import type { UnitSystem } from '../../../utils/format'
import type { WorldPoint } from '../../../geo/view/types'
import { createPolygonalZoneDraftMeasurements } from '../zone-measurements'
import type { DraftShape, DraftStroke, ToolHandle } from './draft'
import { measureLabelShapes } from './measure-labels'
import { handleSizeFor } from './select/handle-size'
import type { CanvasTool, ToolCommand, ToolContext, ToolGesture, ToolPoint, ToolReply, ToolScene, ToolView } from './tool'
import { appendPolygonZoneToDraft } from './tool-actions'
import { DRAFT_STROKE, ZONE_DRAFT_FILL } from './zone-drag'

/** The owner of the draft's point and dot handles (`point:draft:<i>`, `dot:draft:<i>`). */
const DRAFT_OWNER = 'draft'

function draftHandleId(role: 'point' | 'dot', index: number): ToolHandleId {
  return `${role}:${DRAFT_OWNER}:${index}` as ToolHandleId
}

function parseDraftHandle(id: string): { readonly role: 'point' | 'dot'; readonly index: number } | null {
  const role = id.startsWith(`point:${DRAFT_OWNER}:`) ? 'point' : id.startsWith(`dot:${DRAFT_OWNER}:`) ? 'dot' : null
  if (!role) return null
  const raw = id.slice(role.length + DRAFT_OWNER.length + 2)
  const index = Number(raw)
  if (!raw || !Number.isInteger(index) || index < 0) return null
  return { role, index }
}

/** A live press on a drafted point or midpoint dot, and where the pointer has taken it. */
type DraftPointDrag =
  | { readonly kind: 'move'; readonly index: number; at: WorldPoint | null; readonly closeOnTap: boolean }
  | { readonly kind: 'insert'; readonly after: number; at: WorldPoint | null }

/** The corners' fill carries no stroke: the rubber band draws the edges. */
const FILL_ONLY: DraftStroke = Object.freeze({ token: 'draft', widthPx: 0 })
const VERTEX_MARKER_STYLE: DraftStroke = Object.freeze({ token: 'draft', widthPx: 3.5 })
/** A light disc of radius 3.5 px on a 1 px casing ring (plan §1, exception 2), at each point of a vertex path. */
export const VERTEX_MARKER = Object.freeze({ radiusPx: 1.75, style: VERTEX_MARKER_STYLE })

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
  draft(
    points: readonly WorldPoint[],
    active: WorldPoint | null,
    view: ToolView,
    groundMeasure?: GroundMeasure,
    unitSystem?: UnitSystem,
    locale?: string,
  ): DraftShape[]
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
  let redoStack: WorldPoint[][] = []
  /** Where the rubber band ends: the pointer, or the last point placed. */
  let active: WorldPoint | null = null
  let pointDrag: DraftPointDrag | null = null
  /** The drafted point Delete takes when no point handle has focus: the one last pressed, moved or inserted. */
  let touched: number | null = null
  let drawn = false
  let handlesPublished = false

  function context(): ToolContext {
    if (!ctx) throw new Error(`The ${spec.id} tool is not active`)
    return ctx
  }

  function hasTransient(): boolean {
    return points.length > 0 || redoStack.length > 0
  }

  function canDraw(): boolean {
    return spec.canDraw?.(context().scene) ?? true
  }

  function shownPoints(): readonly WorldPoint[] {
    const drag = pointDrag
    if (!drag?.at) return points
    if (drag.kind === 'move') {
      return points.map((point, index) => (index === drag.index ? drag.at! : point))
    }
    const next = [...points]
    next.splice(drag.after + 1, 0, drag.at)
    return next
  }

  function draftHandles(tool: ToolContext, pts: readonly WorldPoint[]): ToolHandle[] {
    if (pts.length === 0) return []
    const size = handleSizeFor(tool.pointer())
    const handles: ToolHandle[] = pts.map((anchor, index) => ({
      id: draftHandleId('point', index),
      anchor,
      hitRadiusPx: size.pointRadiusPx,
      glyph: 'corner',
      label: tool.translate('canvas.zoneControlPoint.label', { index: index + 1 }),
    }))
    // While a point or midpoint dot is dragging, hide dots so they do not chase the pointer.
    if (pointDrag || pts.length < 2) return handles
    for (let index = 0; index < pts.length - 1; index += 1) {
      const from = pts[index]!
      const to = pts[index + 1]!
      if (tool.view.screenDistance(from, to) < size.minMidpointEdgePx) continue
      handles.push({
        id: draftHandleId('dot', index),
        anchor: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
        hitRadiusPx: size.midpointRadiusPx,
        glyph: 'midpoint',
        label: tool.translate('canvas.zoneEdgeMidpoint.label', { index: index + 1 }),
      })
    }
    return handles
  }

  function redraw(): void {
<<<<<<< HEAD
    const tool = context()
    const { effects, scene, view } = tool
=======
    const { effects, scene, view, settings } = context()
>>>>>>> d8499abdd (fix(2c-3): route unitSystem to all display sites, fix es/it parser, land F35 & #921 should-fix)
    effects.setGuidance({ gesture: points.length > 0 })
    if (points.length === 0) {
      if (handlesPublished) {
        handlesPublished = false
        effects.setHandles([])
      }
      if (!drawn) return
      drawn = false
      effects.setDraft(null)
      return
    }
    drawn = true
    const shown = shownPoints()
    effects.setDraft({
      shapes: spec.draft(
        shown,
        pointDrag ? null : active,
        view,
        scene.groundMeasure,
        settings.unitSystem?.() ?? 'metric',
        settings.locale?.() ?? 'en',
      ),
    })
    const handles = draftHandles(tool, shown)
    const touchedId = touched !== null ? draftHandleId('point', touched) : null
    const activeHandle = touchedId !== null && handles.some((handle) => handle.id === touchedId)
      ? touchedId
      : null
    handlesPublished = true
    effects.setHandles(handles, activeHandle)
  }

  /** Updates the draft points and forgets any redo states (anchors.ts model, 2.1-Q88). */
  function commitPoints(next: WorldPoint[]): void {
    points = next
    redoStack = []
    if (points.length === 0) active = null
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
    commitPoints([...points, next])
    touched = null
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

  /** Deletes point `index`, refusing to drop the only remaining point (2.1-Q88, Plant a row parity). */
  function deletePoint(index: number): void {
    if (points.length <= 1 || index < 0 || index >= points.length) return
    commitPoints(points.filter((_, at) => at !== index))
    touched = null
    pointDrag = null
    redraw()
  }

  function pointIndexOf(handle: ToolHandleId): number | null {
    const parsed = parseDraftHandle(handle)
    return parsed?.role === 'point' ? parsed.index : null
  }

  function focusedPointIndex(): number | null {
    const focused = context().focusedHandle()
    return focused !== null ? pointIndexOf(focused) : null
  }

  function deletePointIfAllowed(index: number | null): ToolReply {
    if (index === null || points.length <= 1 || !points[index]) return 'pass'
    deletePoint(index)
    return 'handled'
  }

  function reply(handled: boolean): ToolReply {
    return handled ? 'handled' : 'pass'
  }

  function confirmCommand(): ToolReply {
    if (points.length === 0) return 'pass'
    finish()
    return 'handled'
  }

  function removeLastCommand(): ToolReply {
    const index = focusedPointIndex()
    if (index !== null && points.length > 1) {
      deletePoint(index)
      return 'handled'
    }
    return reply(undo())
  }

  function deleteFocusedOrTouched(): ToolReply {
    return deletePointIfAllowed(focusedPointIndex() ?? touched)
  }

  function pointActionCommand(c: Extract<ToolCommand, { kind: 'point-action' }>): ToolReply {
    return c.action === 'delete-point' ? deletePointIfAllowed(pointIndexOf(c.handle)) : 'pass'
  }

  /** A press on one of the draft's point or midpoint-dot handles (2.1-Q88, Plant a row's grammar). */
  function handlePress(handle: ToolHandleId, point: ToolPoint, clickCount: number): boolean {
    const parsed = parseDraftHandle(handle)
    if (!parsed || points.length === 0) return false
    const { role, index } = parsed
    const intent = pointPressIntent({
      role,
      clickCount,
      alt: point.modifiers.subtractive,
      isLastDraftPoint: role === 'point' && index === points.length - 1,
    })
    switch (intent) {
      case 'finish':
        finish()
        return true
      case 'delete':
        deletePoint(index)
        return true
      case 'move': {
        if (!points[index]) return false
        const closeOnTap = index === 0 && Boolean(spec.closesAt) && points.length >= spec.minPoints && clickCount === 1
        touched = index
        pointDrag = { kind: 'move', index, at: null, closeOnTap }
        redraw()
        return true
      }
      case 'insert': {
        const from = points[index]
        const to = points[index + 1]
        if (!from || !to) return false
        const mid: WorldPoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
        const next = [...points]
        next.splice(index + 1, 0, mid)
        commitPoints(next)
        touched = index + 1
        redraw()
        return true
      }
      case 'insert-drag':
        if (index < 0 || index >= points.length - 1) return false
        pointDrag = { kind: 'insert', after: index, at: null }
        redraw()
        return true
    }
  }

  function handleMove(at: WorldPoint): void {
    if (!pointDrag) return
    pointDrag.at = at
    redraw()
  }

  function handleRelease(): void {
    const drag = pointDrag
    pointDrag = null
    if (!drag) return
    if (!drag.at) {
      if (drag.kind === 'move' && drag.closeOnTap) {
        finish()
        return
      }
      redraw()
      return
    }
    if (drag.kind === 'move') {
      const next = points.map((point, index) => (index === drag.index ? drag.at! : point))
      commitPoints(next)
      touched = drag.index
    } else {
      const next = [...points]
      next.splice(drag.after + 1, 0, drag.at)
      commitPoints(next)
      touched = drag.after + 1
    }
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

  /** Steps back by removing the last point onto the redo stack (2.1-Q88, anchors.ts parity). */
  function undo(): boolean {
    if (points.length === 0) return false
    redoStack = [...redoStack, points]
    points = points.slice(0, -1)
    pointDrag = null
    touched = null
    if (points.length === 0) active = null
    redraw()
    return true
  }

  function redoPoint(): boolean {
    const restored = redoStack[redoStack.length - 1]
    if (!restored) return false
    redoStack = redoStack.slice(0, -1)
    points = [...restored]
    pointDrag = null
    touched = null
    if (active === null && points.length > 0) active = points[points.length - 1]!
    redraw()
    return true
  }

  /** Esc (A17, 2.1-Q88): removes the last point onto the redo stack; the last point left takes the redo with it, so the
   *  next Esc leaves the tool; a redo-only history goes, and the tool asks for Select in the same press. */
  function stepBack(): boolean {
    if (points.length > 1) return undo()
    if (points.length === 1) {
      drop()
      return true
    }
    if (redoStack.length === 0) return false
    drop()
    context().effects.requestTool('select')
    return true
  }

  function drop(): void {
    points = []
    redoStack = []
    active = null
    pointDrag = null
    touched = null
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
      if (pointDrag) return null
      const last = points[points.length - 1]
      return last ? { kind: 'direction', origin: last, stepDeg: 45 } : null
    },
    activate(next) {
      ctx = next
      points = []
      redoStack = []
      active = null
      pointDrag = null
      touched = null
      drawn = false
      handlesPublished = false
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
        case 'handle-drag':
          if (g.phase === 'start') return handlePress(g.handle, g.point, g.clickCount) ? 'handled' : 'pass'
          if (g.phase === 'move') {
            if (!pointDrag) return 'pass'
            handleMove(g.point.snapped)
            return 'handled'
          }
          if (!pointDrag) return 'pass'
          handleRelease()
          return 'handled'
        case 'cancel':
          if (pointDrag) {
            pointDrag = null
            redraw()
          }
          return 'pass'
        // The press added the point: a tap or a drag's end adds nothing, and a cancel keeps the draft.
        case 'drag-end':
        case 'hover-end':
        case 'tap':
          return 'pass'
      }
    },
    command(c: ToolCommand): ToolReply {
      switch (c.kind) {
        case 'confirm':
          return confirmCommand()
        case 'remove-last':
          return removeLastCommand()
        case 'undo-transient':
          return reply(undo())
        case 'redo-transient':
          return reply(redoPoint())
        case 'delete-handle':
          return deleteFocusedOrTouched()
        case 'point-action':
          return pointActionCommand(c)
        case 'escape':
          return reply(stepBack())
        case 'edit-text':
        case 'place-at':
        case 'rotate-held':
        case 'spacing-cancel':
        case 'spacing-commit':
        case 'spacing-input':
        case 'spacing-mode':
          return 'pass'
      }
    },
    viewChanged() {
      if (points.length > 0) redraw()
    },
    canFinish: () => points.length >= spec.minPoints,
    pointMenu(handle) {
      const index = pointIndexOf(handle)
      if (index === null || !points[index]) return []
      return pointMenuItems({ sharpable: false, sharp: false, canDelete: points.length > 1 })
    },
    hasTransient,
    cancelTransient(reason) {
      // An interruption keeps the draft only while it has points (today's hasPolygonDraft): a redo-only history goes.
      if (reason === 'navigate' && points.length > 0) return
      if (hasTransient()) drop()
    },
    canUndoTransient: () => points.length > 0,
    canRedoTransient: () => redoStack.length > 0,
    deactivate() {
      if (hasTransient()) drop()
      else if (handlesPublished) {
        handlesPublished = false
        ctx?.effects.setHandles([])
      }
    },
  }
}

function polygonDraftShapes(
  corners: readonly WorldPoint[],
  active: WorldPoint | null,
  view: ToolView,
  groundMeasure?: GroundMeasure,
  unitSystem?: UnitSystem,
  locale?: string,
): DraftShape[] {
  const shapes: DraftShape[] = []
  if (corners.length >= 3) shapes.push({ kind: 'polygon', points: corners, style: FILL_ONLY, fill: ZONE_DRAFT_FILL })
  const band = active ? [...corners, active] : corners
  if (band.length >= 2) shapes.push({ kind: 'polyline', points: band, style: DRAFT_STROKE })
  for (const center of corners) shapes.push({ kind: 'circle-px', center, ...VERTEX_MARKER })
  const chips = createPolygonalZoneDraftMeasurements(corners, active, groundMeasure, unitSystem, locale)
  shapes.push(...measureLabelShapes(chips, (a, b) => view.screenDistance(a, b)))
  return shapes
}
