// canvas/runtime/tools/select/select-tool.ts
//
// Owns the Select tool (spec §1.4, §3.2): a plain CanvasTool the ToolHost runs, composed of the Select gestures. A
// press selects at once (click.ts) and goes on as a band from empty ground (band.ts), a move-drag of the selection
// (move-drag.ts), a drag refused on a locked object, reported once for the lock toast (2.1-Q177), or nothing more; a double-click opens a note for editing in the host's text entry (note-edit.ts), as do
// Enter and F2 on one selected note ('edit-text'). Its handles are the rotation handle (rotate-handle.ts), the selected
// zone's reshape points (reshape.ts) and the selected guide's ends (guide-ends.ts), sized for the pointer kind that last
// hovered or pressed the map (ToolContext.pointer; handle-size.ts: 44 px targets after a touch, Q1); the host shows them while Select is
// armed, the text entry is closed and no Scene Edit is open. Hovers pass, so the host's passive hover runs, and the tool
// card's gesture flag stays off.

import { dotHandle } from '../../../point-editor/layout'
import { pointMenuItems, pointPressIntent, type PointMenuItem } from '../../../point-editor/rules'
import type { PointerKind, ToolHandleId } from '../../interaction-types'
import type { SceneDesignObjectTarget } from '../../scene/design-object-targets'
import type { SceneMeasurementGuideEntity, SceneZoneEntity } from '../../scene/types'
import type { ToolHandle } from '../draft'
import type { CanvasTool, HitTarget, ToolContext, ToolGesture, ToolPoint, ToolReply, ToolView } from '../tool'
import { bandDraft, bandSelection, type Band } from './band'
import { clickSelection, pressSelection, type SelectPress } from './click'
import { draggableGuide, guideEndHandles, guideEnds, guideEndSubject, guideLengthShapes, type GuideEnd } from './guide-ends'
import { handleSizeFor } from './handle-size'
import { abortMoveDrag, beginMoveDrag, commitMoveDrag, hasMoved, moveSelection, type MoveDrag } from './move-drag'
import { noteExists, openNoteEntry, selectedEditableNoteId } from './note-edit'
import { beginPointHandleDrag, type PointHandleDrag } from './point-handle'
import {
  addPolygonCorner,
  canRemovePolygonCorner,
  isPolygonCorner,
  removePolygonCorner,
  reshapableZone,
  zoneControlPointHandles,
  zoneControlPoints,
  zoneCornerInsertSubject,
  zoneEdgeMidpoints,
  zoneReshapeSubject,
  type ZoneControlPoint,
  type ZoneEdgeMidpoint,
} from './reshape'
import {
  abortRotation,
  applyRotation,
  beginRotation,
  finishRotation,
  ROTATE_HANDLE_ID,
  rotateHandle,
  rotationConstraint,
  type RotationDrag,
} from './rotate-handle'

type ZoneEdgeHit = Extract<HitTarget, { kind: 'zone-edge' }>

/** What the press started, from the press to its release or cancel. */
type SelectGesture =
  | { readonly kind: 'band'; readonly band: Band }
  | { readonly kind: 'move'; readonly drag: MoveDrag; readonly press: SelectPress }
  | { readonly kind: 'rotate'; readonly drag: RotationDrag }
  | { readonly kind: 'reshape'; readonly drag: PointHandleDrag<SceneZoneEntity> }
  | { readonly kind: 'guide-end'; readonly drag: PointHandleDrag<SceneMeasurementGuideEntity> }
  /** A move-drag press on a locked object: its drag is refused once (`refused` from then on), with the lock toast
   *  (2.1-Q177); without a drag it is a click. */
  | { readonly kind: 'locked'; readonly press: SelectPress; refused: boolean }
  /** A press that selected and ends with its release (an additive toggle, a species, a note opened). */
  | { readonly kind: 'done' }

export function createSelectTool(): CanvasTool {
  let context: ToolContext | null = null
  let gesture: SelectGesture | null = null
  let editingNoteId: string | null = null
  /** The turn so far while the rotation handle is dragged: its readout, shown while the host shows the handles. */
  let rotationDeltaDeg: number | null = null
  /** The bearing the handles were placed at: the rotation handle sits above the projected hull, so a turn moves it. */
  let handlesBearingDeg = 0
  /** The scale the handles were placed at (screen px per world metre): the midpoint dots' room and the hull of screen-sized
   *  plants and notes depend on it. */
  let handlesPixelsPerMetre = 0
  /** The pointer kind the handles were sized for (ToolContext.pointer, Q1). */
  let handlesPointer: PointerKind = 'mouse'
  let reshapePoints = new Map<ToolHandleId, ZoneControlPoint>()
  let edgeMidpoints = new Map<ToolHandleId, ZoneEdgeMidpoint>()
  let guideEndPoints = new Map<ToolHandleId, GuideEnd>()
  /** The selected corner: the polygon corner last pressed without moving, or the one after a removed corner, shown as the
   *  active handle; Delete removes it. */
  let selectedCorner: ToolHandleId | null = null
  /** The object the last press hit, or null (empty ground, a handle): a double-click selects a plant's species or edits a
   *  note only when it hits the same object (U42). */
  let lastPressHit: SceneDesignObjectTarget | null = null
  /** The zone edge the last press was on (`zoneId:edgeIndex`), or null: a double-click adds a corner only on the same edge. */
  let lastPressEdge: string | null = null

  function ctx(): ToolContext {
    if (!context) throw new Error('The Select tool is not active.')
    return context
  }

  /** The rotation handle, the selected zone's reshape points and the selected guide's ends, for the current selection. */
  function refreshHandles(): void {
    const c = ctx()
    const scene = c.scene.persisted
    const selection = c.scene.selectionModel()
    const handles: ToolHandle[] = []
    // A point handle's drag hides the rotation handle from its press to its release.
    const pointDrag = gesture?.kind === 'reshape' || gesture?.kind === 'guide-end'
    const pointer = c.pointer()
    const size = handleSizeFor(pointer)
    const zone = reshapableZone(scene, selection)
    const points = zone ? zoneControlPoints(zone) : []
    const midpoints = zone ? zoneEdgeMidpoints(zone, c.view, size) : []
    // The rotation handle rises over the chips that the dots put beside their edges.
    const rotate = pointDrag
      ? null
      : rotateHandle(c.scene, selection, c.view, c.translate, rotationDeltaDeg, size, midpoints.length > 0)
    handlesBearingDeg = c.view.bearingDeg
    handlesPixelsPerMetre = pixelsPerMetre(c.view)
    handlesPointer = pointer
    if (rotate) handles.push(rotate)
    reshapePoints = new Map(points.map((entry) => [entry.id, entry]))
    handles.push(...zoneControlPointHandles(points, size, c.translate))
    edgeMidpoints = new Map(midpoints.map((entry) => [entry.id, entry]))
    handles.push(...midpoints.map((dot) =>
      dotHandle(dot, size, c.translate('canvas.zoneEdgeMidpoint.label', { index: dot.edgeIndex + 1 }))))
    const guide = draggableGuide(scene, selection)
    const ends = guide ? guideEnds(guide) : []
    guideEndPoints = new Map(ends.map((entry) => [entry.id, entry]))
    handles.push(...guideEndHandles(ends, size, c.translate))
    if (selectedCorner && !reshapePoints.has(selectedCorner)) selectedCorner = null
    c.effects.setHandles(handles, selectedCorner)
  }

  /** A camera frame that turned or zoomed the view redraws the handles (U40), as does a hover by another pointer kind (Q1);
   *  a pan leaves them as they are. The host re-emits a hover or a live drag on each camera frame, so both follow it. */
  function followView(): void {
    if (!context) return
    const { view } = context
    // A pan changes none of them, so it recomputes nothing.
    if (view.bearingDeg === handlesBearingDeg && pixelsPerMetre(view) === handlesPixelsPerMetre && context.pointer() === handlesPointer) {
      return
    }
    refreshHandles()
  }

  function press(point: ToolPoint, hit: HitTarget | null, clickCount: number): void {
    const c = ctx()
    selectedCorner = null
    const previousEdge = lastPressEdge
    const edge = zoneEdgeAt(point)
    lastPressEdge = edge && `${edge.zoneId}:${edge.edgeIndex}`
    if (clickCount >= 2 && edge && lastPressEdge === previousEdge && addCornerOnEdge(point, edge)) {
      lastPressHit = null
      lastPressEdge = null
      gesture = { kind: 'done' }
      refreshHandles()
      return
    }
    const previous = lastPressHit
    lastPressHit = hit?.kind === 'object' ? hit.target : null
    const result = pressSelection(c, point, hit, clickCount, previous)
    switch (result.kind) {
      case 'band':
        // The band draws from its drag: a tap (a finger's held press resolves at its lift) draws none.
        gesture = { kind: 'band', band: { start: point.world, additive: result.additive } }
        break
      case 'move':
        gesture = result.locked ? { kind: 'locked', press: result, refused: false } : {
          kind: 'move',
          drag: beginMoveDrag(c, c.scene.persisted, result.target, point),
          press: result,
        }
        break
      case 'edit-note':
        gesture = { kind: 'done' }
        editNote(result.annotationId)
        break
      case 'done':
        gesture = { kind: 'done' }
        break
    }
    refreshHandles()
  }

  /** The picked zone's edge nearest the point (hit-testing.ts hitZoneEdge), or null. */
  function zoneEdgeAt(point: ToolPoint): ZoneEdgeHit | null {
    const edge = ctx().scene.hitAt(point.world, { pointer: point.pointer, zoneEdge: true })
    return edge?.kind === 'zone-edge' ? edge : null
  }

  /** A double-click on an edge of the selected polygon, whose first press was on the same edge (U42), adds a corner there
   *  (reusing hitZoneEdge's edge). */
  function addCornerOnEdge(point: ToolPoint, edge: ZoneEdgeHit): boolean {
    const c = ctx()
    if (point.modifiers.additive || point.modifiers.subtractive) return false
    const zone = reshapableZone(c.scene.persisted, c.scene.selectionModel())
    if (zone?.zoneType !== 'polygon' || edge.zoneId !== zone.id) return false
    addPolygonCorner(c, zone.id, edge.edgeIndex, point.world)
    return true
  }

  function dragTo(point: ToolPoint): void {
    const c = ctx()
    const current = gesture
    if (current?.kind === 'band') {
      c.effects.setDraft(bandDraft(c.view, current.band, point.world))
    } else if (current?.kind === 'move') {
      const draft = moveSelection(c, current.drag, point)
      if (draft !== undefined) c.effects.setDraft(draft)
    } else if (current?.kind === 'locked' && !current.refused) {
      current.refused = true
      c.effects.refuseLockedMove()
    }
  }

  /** The press's release, after a drag (`dragged`) or without one. */
  function release(point: ToolPoint, dragged: boolean): void {
    const c = ctx()
    const current = gesture
    if (!current) return
    try {
      if (current.kind === 'band') {
        if (dragged) c.effects.setSelection(bandSelection(c, current.band, point.world))
      } else if (current.kind === 'move') {
        // The release reads the last move: the pointer's travel since then moves nothing.
        if (hasMoved(current.drag)) {
          commitMoveDrag(current.drag)
        } else {
          abortMoveDrag(current.drag)
          clickSelection(c, current.press)
        }
      } else if (current.kind === 'locked' && !dragged) {
        clickSelection(c, current.press)
      }
    } finally {
      gesture = null
      c.effects.setDraft(null)
      refreshHandles()
    }
  }

  function handleDrag(g: Extract<ToolGesture, { kind: 'handle-drag' }>): void {
    const c = ctx()
    if (g.phase === 'start') {
      lastPressHit = null
      lastPressEdge = null
      startHandleDrag(g)
      refreshHandles()
      return
    }
    const current = gesture
    if (!current) return
    if (g.phase === 'move') {
      if (current.kind === 'rotate') rotationDeltaDeg = applyRotation(current.drag, g.point)
      else if (current.kind === 'reshape') current.drag.move(g.point)
      else if (current.kind === 'guide-end') {
        current.drag.move(g.point)
        const guide = current.drag.current
        const shapes = guide ? guideLengthShapes(guide, (a, b) => c.view.screenDistance(a, b)) : []
        c.effects.setDraft(shapes.length > 0 ? { shapes } : null)
      }
      // The host re-emits a live handle drag on a camera frame: a zoom under a still pointer turns nothing, so no scene
      // change rebuilds the handles, and this follows the new scale.
      followView()
      return
    }
    try {
      if (current.kind === 'rotate') finishRotation(current.drag, g.point)
      else if (current.kind === 'reshape' || current.kind === 'guide-end') current.drag.finish(g.point)
      // A polygon corner pressed and released without moving becomes the selected corner (U40).
      const corner = current.kind === 'reshape' && !current.drag.moved ? reshapePoints.get(g.handle) : undefined
      selectedCorner = corner && isPolygonCorner(corner) ? g.handle : null
    } finally {
      gesture = null
      rotationDeltaDeg = null
      c.effects.setDraft(null)
      refreshHandles()
    }
  }

  function startHandleDrag(g: Extract<ToolGesture, { kind: 'handle-drag'; phase: 'start' }>): void {
    const { handle, start } = g
    const c = ctx()
    const scene = c.scene.persisted
    const selection = c.scene.selectionModel()
    // Polygon corners and their midpoint dots follow the one point contract (point-editor/rules.ts, A2): a dot's
    // double-click inserts a corner in place and its drag inserts one that follows the pointer (a still press inserts
    // nothing); Alt+click on a corner removes it, keeping at least 3, and any other press on it moves it.
    const edgeMidpoint = edgeMidpoints.get(handle)
    if (edgeMidpoint) {
      const intent = pointPressIntent({ role: 'dot', clickCount: g.clickCount, alt: start.modifiers.subtractive, isLastDraftPoint: false })
      const zone = reshapableZone(scene, selection)
      if (intent === 'insert') addPolygonCorner(c, edgeMidpoint.zoneId, edgeMidpoint.edgeIndex, edgeMidpoint.anchor)
      else if (zone?.id === edgeMidpoint.zoneId) {
        gesture = { kind: 'reshape', drag: beginPointHandleDrag(c, zoneCornerInsertSubject(zone, edgeMidpoint.edgeIndex)) }
        return
      }
      gesture = { kind: 'done' }
      return
    }
    const pressedCorner = reshapePoints.get(handle)
    if (pressedCorner && isPolygonCorner(pressedCorner)
      && pointPressIntent({ role: 'point', clickCount: g.clickCount, alt: start.modifiers.subtractive, isLastDraftPoint: false }) === 'delete') {
      removePolygonCorner(c, pressedCorner.zoneId, pressedCorner.index)
      gesture = { kind: 'done' }
      return
    }
    if (handle === ROTATE_HANDLE_ID) {
      const drag = beginRotation(c, scene, start)
      if (!drag) return
      gesture = { kind: 'rotate', drag }
      rotationDeltaDeg = 0
      return
    }
    const reshapePoint = reshapePoints.get(handle)
    const zone = reshapePoint ? reshapableZone(scene, selection) : null
    if (reshapePoint && zone?.id === reshapePoint.zoneId) {
      gesture = { kind: 'reshape', drag: beginPointHandleDrag(c, zoneReshapeSubject(zone, reshapePoint)) }
      return
    }
    const end = guideEndPoints.get(handle)
    const guide = end ? draggableGuide(scene, selection) : null
    if (end && guide?.id === end.guideId) {
      gesture = { kind: 'guide-end', drag: beginPointHandleDrag(c, guideEndSubject(guide, end)) }
    }
  }

  /** The point menu of a selected polygon's corner: Delete point, refused at 3 corners (A16); nothing for any other handle. */
  function pointMenu(handle: ToolHandleId): readonly PointMenuItem[] {
    const corner = reshapePoints.get(handle)
    const zone = corner && isPolygonCorner(corner) ? reshapableZone(ctx().scene.persisted, ctx().scene.selectionModel()) : null
    if (!zone || zone.id !== corner!.zoneId) return []
    return pointMenuItems({ sharpable: false, sharp: false, canDelete: canRemovePolygonCorner(zone) })
  }

  /** Rolls back what the gesture changed. */
  function cancelGesture(): void {
    const current = gesture
    if (!current) return
    if (current.kind === 'move') abortMoveDrag(current.drag)
    else if (current.kind === 'rotate') abortRotation(current.drag)
    else if (current.kind === 'reshape' || current.kind === 'guide-end') current.drag.cancel()
    gesture = null
    rotationDeltaDeg = null
    ctx().effects.setDraft(null)
    refreshHandles()
  }

  /** Delete or Backspace on the focused corner, else the selected one, or the point menu's Delete point on `handle`:
   *  removed, keeping at least 3, and the corner now at its index (wrapped to the first) becomes the selected corner,
   *  which the handle layer focuses when the removed corner had focus, so Delete goes on down to 3 (U37); a refused
   *  removal keeps the selected corner and the zone; with neither, the key passes. */
  function deleteCorner(handle: ToolHandleId | null = null): ToolReply {
    const focused = ctx().focusedHandle()
    const id = handle ?? (focused && reshapePoints.has(focused) ? focused : selectedCorner)
    const corner = id ? reshapePoints.get(id) : undefined
    if (!corner || !isPolygonCorner(corner)) return 'pass'
    if (removePolygonCorner(ctx(), corner.zoneId, corner.index)) {
      refreshHandles()
      const left = [...reshapePoints.values()].filter((point) => point.zoneId === corner.zoneId && isPolygonCorner(point))
      selectedCorner = left.find((point) => point.index === corner.index % left.length)?.id ?? null
      refreshHandles()
    }
    return 'handled'
  }

  function editNote(annotationId: string): boolean {
    const opened = openNoteEntry(ctx(), annotationId, () => {
      if (editingNoteId === annotationId) editingNoteId = null
    })
    if (opened) editingNoteId = annotationId
    return opened
  }

  return {
    id: 'select',
    settledRelease: () => gesture?.kind === 'band',
    constraint: () => (gesture?.kind === 'rotate' ? rotationConstraint(gesture.drag) : null),
    activate(ctx) {
      context = ctx
      // Select publishes no gesture to the tool card, whatever it holds.
      ctx.effects.setGuidance({ gesture: false })
      refreshHandles()
    },
    gesture(g): ToolReply {
      switch (g.kind) {
        case 'press':
          press(g.point, g.hit, g.clickCount)
          break
        case 'drag-start':
        case 'drag-move':
          dragTo(g.point)
          // The host re-emits a live drag on a camera frame, not a hover: a key turn mid-band moves the handle too.
          followView()
          // The press stays Select's to its release: no passive hover over its moves.
          return 'handled'
        case 'drag-end':
          release(g.point, true)
          break
        case 'tap':
          release(g.point, false)
          break
        case 'handle-drag':
          handleDrag(g)
          break
        case 'cancel':
          cancelGesture()
          break
        case 'hover':
          // The host re-emits the resting pointer on a camera frame instead of calling viewChanged.
          followView()
          break
        default:
          break
      }
      return 'pass'
    },
    viewChanged() {
      followView()
    },
    pointMenu,
    command(c): ToolReply {
      // Backspace is the Mac's delete key, so it removes a corner as Delete does.
      if (c.kind === 'delete-handle' || c.kind === 'remove-last') return deleteCorner()
      // The point menu's Delete point (a corner offers no other entry).
      if (c.kind === 'point-action') return c.action === 'delete-point' ? deleteCorner(c.handle) : 'pass'
      if (c.kind !== 'edit-text') return 'pass'
      const noteId = selectedEditableNoteId(ctx())
      return noteId && editNote(noteId) ? 'handled' : 'pass'
    },
    sceneChanged() {
      const c = ctx()
      // The note editor closes once its note is gone (a replaced document, an undo).
      if (editingNoteId !== null && !noteExists(c.scene.persisted, editingNoteId)) {
        editingNoteId = null
        c.effects.closeTextEntry()
      }
      refreshHandles()
    },
    hasTransient: () => false,
    cancelTransient() {
      cancelGesture()
    },
    deactivate() {
      gesture = null
      editingNoteId = null
      rotationDeltaDeg = null
      reshapePoints = new Map()
      edgeMidpoints = new Map()
      guideEndPoints = new Map()
      selectedCorner = null
      lastPressHit = null
      lastPressEdge = null
    },
  }
}

/** Screen px per world metre on the session plane, where screen distance depends on the scale alone. */
function pixelsPerMetre(view: Pick<ToolView, 'screenDistance'>): number {
  return view.screenDistance(ORIGIN, UNIT_X)
}

const ORIGIN = Object.freeze({ x: 0, y: 0 })
const UNIT_X = Object.freeze({ x: 1, y: 0 })
