// canvas/runtime/tools/plant-row.ts
// Owner of the device spacing interval write (patch-settings-only-in-field-owners, ADR 0022; §18 F31). Invariant: only this
// tool and its wiring patch the row spacing setting.
//
// Owns Plant a row ('plant-spacing', key W; spec §1.4, §1.11, §3.2, §3.7; plan §4 "2.0 plant along a path", U58): a
// press on a placed plant picks it as the row's source and first point (the tool card's spacing field asks for focus on
// that press's release, unless it became a drag). After the pick a click on the ground adds a point (Alt held: a sharp
// one), and the row follows a smooth curve through them (canvas/plant-path/); a click on the first point with 3 points
// or more closes a loop (its handle, or the ground within CLOSE_DISTANCE_PX). Enter, a double-click on the ground or the last point, the tool card's check
// button and the menu's "Finish shape" plant it (from 2 points), one Scene Edit that adds ordinary plants and selects
// the source and the new plants, ungrouped (answers 27, 28: the path is edited only while drawn; nothing stores it). A
// press-drag-release from the picked plant with no other point still plants a straight row at its release.
// Before planting the points follow the shared point contract (point-editor/rules.ts): a point drags; a midpoint dot's
// drag inserts a point, its double-click inserts one in place; Alt+click, Delete and the point menu delete a point
// (never the picked plant, never below 2 points, 3 on a loop); the point menu turns a point sharp or smooth. A press, a
// drag or a point action makes a point the last touched, which Delete takes when no point has focus. Esc,
// Backspace and Ctrl+Z step back one point onto the draft's redo stack (a loop opens first), Ctrl+Shift+Z restores it.
// While a plant is picked Ctrl+Z, Ctrl+Shift+Z and Backspace never reach the Design: with nothing to step they do
// nothing, and only Esc drops the picked plant; with none picked Esc lets the chain's tool layer leave (A17). A picked
// plant that can no longer repeat (deleted, moved, locked, hidden or grouped, or its layer locked or hidden) ends the
// draft at once with "source missed".
// The row's plants repeat the source at the card's spacing: every N m (Settings keeps the interval) or N plants, the
// picked one counted. Shift turns the next point to 45° steps against the screen from the last one (the host's
// constraint; none while a point drags, U36), Ctrl or Cmd turns snapping off (noSnap), and the host clamps the pointer to
// the view (clampsToView). A pan, a blur and a tool re-arm keep the draft. The draft is the source ring at the plant's
// presented radius, the dashed curve, a disc for each plant the row would add (at most 250) and the curve's length in the
// zone chip format; the points and dots are DOM handles. On a 2-point row all of it is the straight row's, bit for bit.

import { plantAlongPath, type PathPlanting, type PathSpacing } from '../../plant-path/spacing'
import { flattenPath, pointAlong, tangentAlong, type PathPoints } from '../../plant-path/curve'
import {
  addPoint,
  closePath,
  editDraft,
  insertAfter,
  movePoint,
  removePoint,
  setSharp,
  startDraft,
  stepBack,
  stepForward,
  type PathDraft,
} from '../../point-editor/anchors'
import { dotHandles, parsePointHandle, pointHandleId, pointHandles } from '../../point-editor/layout'
import { CLOSE_DISTANCE_PX, isSamePoint, pointMenuItems, pointPressIntent, type PointAction } from '../../point-editor/rules'
import {
  formatPlantSpacingIntervalInput,
  parsePlantRowCountInput,
  parsePlantSpacingIntervalInput,
} from '../../plant-spacing-interval'
import { createPlantSpacingGeneratedPlants } from '../../plant-spacing-sequence'
import type { CanvasPlantRowGuidance } from '../../session-state'
import { createUuid } from '../../../utils/ids'
import type { ToolHandleId } from '../interaction-types'
import { isSceneObjectGroupMemberTarget } from '../scene/group-members'
import { isSceneDesignObjectLocked } from '../scene/locks'
import { resolvePlantSymbolForPlant } from '../scene/plant-symbols'
import type { ScenePlantEntity } from '../scene/types'
import type { ScreenPoint, WorldPoint } from '../view/types'
import { formatMetricDistance } from '../zone-measurements'
import type { DraftShape, DraftStroke, ToolHandle } from './draft'
import { handleSizeFor } from './select/handle-size'
import type { CanvasTool, ToolCommand, ToolContext, ToolGesture, ToolPoint } from './tool'

const PLANT_ROW_DENSE_WARNING_THRESHOLD = 100
const PLANT_ROW_PREVIEW_POSITION_LIMIT = 250
/** The most plants one row adds beside the picked one: above it the card reads "too many plants" and nothing plants. */
const PLANT_ROW_MAX_ADDED_PLANTS = 5_000
/** The most "N plants" takes, the picked one counted: the row that adds the most. */
const PLANT_ROW_MAX_COUNT = PLANT_ROW_MAX_ADDED_PLANTS + 1
const PLANT_ROW_GHOST_OPACITY = 0.35
const SOURCE_RING_STROKE: DraftStroke = Object.freeze({ token: 'selection', widthPx: 2 })
/** Today's 2 px CSS dashed border, drawn as dashes and gaps of 3 × its width (convention). */
const ROW_GUIDE_STROKE: DraftStroke = Object.freeze({ token: 'selection', widthPx: 2, dash: Object.freeze([6, 6]) })
/** The owner of the draft's point and dot handles (`point:draft:<i>`, `dot:draft:<i>`). */
const DRAFT_OWNER = 'draft'
/** A length chip beside a dot keeps this much screen between the curve and its nearest side (measure-labels.ts). */
const BESIDE_DOT_GAP_PX = 6

interface PlantRowSource {
  readonly sourceId: string
  /** The picked plant as it was picked; the row repeats the plant as the Scene holds it now (livePlant), so a Species
   *  Key recolour reaches the card glyph and the new plants, and this copy serves only once the plant is gone. */
  readonly plant: ScenePlantEntity
  readonly label: string
}

/** A live press on a point or a dot, and where the pointer has taken it (null until it moves past the press). */
type PointDrag =
  | { readonly kind: 'move'; readonly index: number; at: WorldPoint | null }
  | { readonly kind: 'insert'; readonly after: number; at: WorldPoint | null }

export function createPlantRowTool(): CanvasTool {
  let ctx: ToolContext | null = null
  let source: PlantRowSource | null = null
  /** The row's points, the picked plant first, and the states its step-backs took (A17). */
  let draft: PathDraft | null = null
  let mode: 'interval' | 'count' = 'interval'
  let intervalText = ''
  let intervalValid = true
  let countText = ''
  let countValid = true
  /** The rubber band's end: where a pointer over the map would add the next point, from its hover or ground drag until
   *  it leaves the map or lifts, or the points change (a finger never hovers, so after a tap the row is what plants). */
  let endpoint: WorldPoint | null = null
  /** The preview's row: what the draft draws and the card counts. */
  let preview: { readonly path: PathPoints; readonly planting: PathPlanting; readonly positions: readonly WorldPoint[] } | null = null
  let missed = false
  let shownCount: { readonly count: number; readonly density: CanvasPlantRowGuidance['density'] } | null = null
  let focusRequest = 0
  /** The held press picked the source: its field asks for focus on the release, unless the press became a drag (the map
   *  took focus then; a field focused on the next render would take Esc, Enter and letters from it). */
  let fieldFocusOnRelease = false
  /** The held press is on the picked plant with no other point: its drag draws a straight row, planted at the release. */
  let straightPress = false
  /** A press on the picked plant after the pick: its click adds this point at the release, its drag none. */
  let pendingPoint: ToolPoint | null = null
  let pointDrag: PointDrag | null = null
  /** The point Delete takes when no point has focus: the one last pressed, moved, inserted or turned sharp. */
  let touched: number | null = null

  function context(): ToolContext {
    if (!ctx) throw new Error('Plant a row is not active.')
    return ctx
  }

  function pointsOf(): PathPoints | null {
    return draft?.path ?? null
  }

  // ── What the tool card and the map show ─────────────────────────────────────────────────────────────────────────

  /** The source plant as the Scene holds it now, else as it was picked. */
  function livePlant(tool: ToolContext, picked: PlantRowSource): ScenePlantEntity {
    return tool.scene.persisted.plants.find((plant) => plant.id === picked.sourceId) ?? picked.plant
  }

  /** The picked plant's symbol and colour as the Scene shows them now. */
  function glyphOf(tool: ToolContext, picked: PlantRowSource): CanvasPlantRowGuidance['glyph'] {
    const plant = livePlant(tool, picked)
    return {
      symbol: resolvePlantSymbolForPlant(plant, tool.scene.persisted.plantSpeciesSymbols),
      color: tool.scene.plantPresentation(plant).color,
    }
  }

  function describe(tool: ToolContext): CanvasPlantRowGuidance {
    const path = pointsOf()
    return {
      phase: source ? 'row' : missed ? 'missed' : 'pick',
      plantName: source?.label ?? null,
      glyph: source ? glyphOf(tool, source) : null,
      interval: intervalText,
      intervalValid,
      count: source ? shownCount?.count ?? null : null,
      density: source ? shownCount?.density ?? 'normal' : 'normal',
      focusRequest,
      points: path?.points.length ?? 0,
      closed: path?.closed ?? false,
      mode,
      countText,
      countValid,
      length: preview && path && path.points.length >= 2 ? formatMetricDistance(preview.planting.lengthM) : null,
      loopSpacing: preview?.path.closed && mode === 'interval' && preview.planting.count > 0
        ? formatMetricDistance(preview.planting.effectiveSpacingM)
        : null,
      touch: tool.pointer() === 'touch',
    }
  }

  /** The card, then the map: every change of state ends here. */
  function publish(): void {
    const tool = ctx
    if (!tool) return
    refreshPreview()
    tool.effects.setGuidance({ gesture: source !== null, plantRow: describe(tool) })
    tool.effects.setDraft(source ? { shapes: draftShapes(tool, source) } : null)
    const handles = source ? draftHandles(tool) : []
    const touchedShown = touched !== null && handles.some((handle) => handle.id === pointHandleId(DRAFT_OWNER, touched!))
    tool.effects.setHandles(handles, touchedShown ? pointHandleId(DRAFT_OWNER, touched!) : null)
  }

  /** The path the preview follows: the draft with a live point drag applied, and the rubber band's end after its points. */
  function previewPath(): PathPoints | null {
    const path = pointsOf()
    if (!path) return null
    const dragged = draggedPath(path)
    if (dragged !== path || path.closed || !endpoint) return dragged
    // With only the picked plant the row runs to the pointer, even onto the plant (a 0 cm row, as before).
    const last = path.points[path.points.length - 1]!.position
    if (path.points.length > 1 && isSamePoint(last, endpoint)) return path
    return { points: [...path.points, { position: endpoint, sharp: false }], closed: false }
  }

  /** The draft with the live point drag applied. */
  function draggedPath(path: PathPoints): PathPoints {
    const drag = pointDrag
    if (!drag?.at) return path
    return drag.kind === 'move' ? movePoint(path, drag.index, drag.at) : insertAfter(path, drag.after, drag.at)
  }

  function refreshPreview(): void {
    const path = source ? previewPath() : null
    if (!path || path.points.length < 2) {
      // Nothing drawn yet: the card counts nothing (null), as before the first hover.
      preview = null
      shownCount = null
      return
    }
    const planting = plantAlongPath(path, spacing() ?? { kind: 'interval', metres: 0 })
    preview = { path, planting, positions: planting.positions(PLANT_ROW_PREVIEW_POSITION_LIMIT) }
    setGeneratedCount(planting.count, {
      dense: planting.count > PLANT_ROW_DENSE_WARNING_THRESHOLD,
      blocked: planting.count > PLANT_ROW_MAX_ADDED_PLANTS,
    })
  }

  function draftShapes(tool: ToolContext, picked: PlantRowSource): DraftShape[] {
    const start = picked.plant.position
    // The ring sits at the radius the scene presents the plant with now (the plant in the scene, for its crowding).
    const presented = livePlant(tool, picked)
    const radiusPx = tool.scene.plantPresentation(presented).radiusPx
    const shapes: DraftShape[] = [{ kind: 'circle-px', center: start, radiusPx, style: SOURCE_RING_STROKE }]
    const row = preview
    if (!row || row.path.points.length < 2) return shapes
    // The guide and the ring under the row's discs, the length on top.
    const straight = row.path.points.length === 2 && !row.path.closed
    const flat = straight ? null : flattenPath(row.path)
    const end = row.path.points[1]!.position
    shapes.push({ kind: 'polyline', points: flat ? flat.vertices : [start, end], style: ROW_GUIDE_STROKE })
    const ghosts = createPlantSpacingGeneratedPlants(presented, row.positions, (index) => `plant-row-ghost-${index}`)
    for (const plant of ghosts) {
      shapes.push({ kind: 'ghost', entity: { kind: 'plant', plant, mark: 'dot', sizeFrom: start }, opacity: PLANT_ROW_GHOST_OPACITY })
    }
    const anchor = flat ? pointAlong(flat, row.planting.lengthM / 2) : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    const beside = besideDot(tool, anchor, flat ? tangentAlong(flat, row.planting.lengthM / 2) : { x: end.x - start.x, y: end.y - start.y })
    shapes.push({
      kind: 'label',
      anchor,
      offsetPx: { x: 0, y: 0 },
      text: formatMetricDistance(row.planting.lengthM),
      tone: 'hint-primary',
      ...(beside ? { beside } : {}),
    })
    return shapes
  }

  /** The length chip moves off a midpoint dot that sits under it, along the curve's screen normal (A9). */
  function besideDot(tool: ToolContext, anchor: WorldPoint, tangent: WorldPoint): { readonly normalPx: ScreenPoint; readonly gapPx: number } | null {
    const path = pointsOf()
    if (!path) return null
    const size = handleSizeFor(tool.pointer())
    const dots = dotHandles(DRAFT_OWNER, draggedPath(path), (a, b) => tool.view.screenDistance(a, b), size, () => '')
    if (!dots.some((dot) => tool.view.screenDistance(dot.anchor, anchor) <= size.midpointRadiusPx)) return null
    const { right, down } = tool.view.screenAxesInWorld()
    const x = tangent.x * right.x + tangent.y * right.y
    const y = tangent.x * down.x + tangent.y * down.y
    const length = Math.hypot(x, y)
    if (!(length > 0)) return null
    // The normal on the screen's upper side, so the chip reads above a level curve.
    const normal = y / length > 0 || (y === 0 && x < 0) ? { x: y / length, y: -x / length } : { x: -y / length, y: x / length }
    return { normalPx: normal, gapPx: BESIDE_DOT_GAP_PX }
  }

  /** The draft's handles: the placed points, the picked plant once it can close a loop (3 points), and the dots of
   *  segments with room on screen. */
  function draftHandles(tool: ToolContext): ToolHandle[] {
    const path = pointsOf()
    if (!path || path.points.length < 2) return []
    const shown = draggedPath(path)
    const size = handleSizeFor(tool.pointer())
    const points = pointHandles(DRAFT_OWNER, shown, size, (index) => tool.translate('canvas.plantRow.point', { index: index + 1 }))
    // A dot drag inserts its point at the release: until then its segment keeps its dot under the pointer.
    const dots = pointDrag ? [] : dotHandles(DRAFT_OWNER, shown, (a, b) => tool.view.screenDistance(a, b), size,
      (index) => tool.translate('canvas.plantRow.dot', { index: index + 1 }))
    return [...points.slice(path.points.length >= 3 ? 0 : 1), ...dots]
  }

  function focusIntervalInput(): void {
    focusRequest += 1
  }

  /** The release of the press that picked the source: the field asks for focus now. */
  function focusFieldOnRelease(): boolean {
    if (!fieldFocusOnRelease) return false
    fieldFocusOnRelease = false
    if (source) focusIntervalInput()
    return true
  }

  // ── Source ──────────────────────────────────────────────────────────────────────────────────────────────────────

  function showSourcePicking(reason: 'select-source' | 'source-missed' = 'select-source'): void {
    missed = reason === 'source-missed'
    shownCount = null
  }

  function clear(): void {
    source = null
    draft = null
    endpoint = null
    preview = null
    pointDrag = null
    straightPress = false
    touched = null
    // "N plants" belongs to the row being drawn; the next row starts every N m (the device's interval).
    mode = 'interval'
    countText = ''
    countValid = true
    showSourcePicking()
  }

  /** A press with no source: the plant under it, if it can repeat (not locked, not grouped away). */
  function pickSource(point: ToolPoint): void {
    const tool = context()
    const persisted = tool.scene.persisted
    // Today's hitTestTopLevel: object locks come back and are refused here.
    const hit = tool.scene.hitAt(point.world, { pointer: point.pointer })
    const target = hit?.kind === 'object' ? hit.target : null
    const plant = target?.kind === 'plant' && !isSceneDesignObjectLocked(persisted, target)
      ? persisted.plants.find((entry) => entry.id === target.id)
      : undefined
    if (!plant) {
      showSourcePicking('source-missed')
      return
    }
    source = {
      sourceId: plant.id,
      plant: { ...plant, pinnedName: false, position: { ...plant.position } },
      label: tool.scene.plantPresentation(plant).commonName,
    }
    draft = startDraft({ position: source.plant.position, sharp: false })
    intervalText = formatPlantSpacingIntervalInput(tool.settings.plantSpacingIntervalM())
    intervalValid = true
    missed = false
    shownCount = null
    fieldFocusOnRelease = true
    straightPress = true
  }

  /** The picked plant can still repeat: there, where it was picked, not locked, hidden or grouped. */
  function canUseSource(candidate: PlantRowSource): boolean {
    const persisted = context().scene.persisted
    const target = { kind: 'plant', id: candidate.sourceId } as const
    if (isSceneDesignObjectLocked(persisted, target)) return false
    const layer = persisted.layers.find((entry) => entry.name === 'plants')
    if (layer?.visible === false || layer?.locked === true) return false
    const plant = persisted.plants.find((entry) => entry.id === candidate.sourceId)
    const picked = candidate.plant.position
    if (!plant || plant.position.x !== picked.x || plant.position.y !== picked.y) return false
    return !persisted.groups.some((group) => group.members.some((member) => isSceneObjectGroupMemberTarget(member, target)))
  }

  // ── Points ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Every change of the points: the rubber band waits for the pointer's next hover. */
  function setDraft(next: PathDraft): void {
    draft = next
    endpoint = null
  }

  /** A press on the ground after the pick (spec §3.2): finishes, closes the loop, starts a straight drag or adds a point. */
  function pressWithSource(g: Extract<ToolGesture, { kind: 'press' }>): void {
    const tool = context()
    const current = draft!
    const { points, closed } = current.path
    if (g.clickCount >= 2) {
      // The second press of a double-click on the ground: its first added the point it finishes at.
      if (points.length >= 2) finish()
      return
    }
    if (closed) return
    if (points.length === 1) {
      // On the picked plant with no other point: its drag draws the straight row; a click there adds its point at the
      // release instead (a short row on a zoomed-out map starts inside the plant's symbol).
      if (pressesSource(g)) {
        straightPress = true
        pendingPoint = g.point
        return
      }
    } else if (tool.view.screenDistance(points[0]!.position, g.point.free) <= CLOSE_DISTANCE_PX[g.point.pointer]) {
      // On the first point: 3 points or more close the loop; fewer would fold the row back onto its start.
      if (points.length >= 3) {
        setDraft(editDraft(current, closePath(current.path)!))
        touched = null
      }
      return
    }
    placePoint(g.point)
  }

  /** A click's new last point (Alt held: sharp); a click on the last point adds none and ends the rubber band there. */
  function placePoint(point: ToolPoint): void {
    const tool = context()
    const current = draft!
    const { points } = current.path
    const next = point.snapped
    if (isSamePoint(points[points.length - 1]!.position, next)) {
      endpoint = null
      return
    }
    // The first point after the pick clears the selection without an undo step, as Polygon's first corner does.
    if (points.length === 1 && tool.scene.selection().length > 0) tool.effects.setSelection([])
    setDraft(editDraft(current, addPoint(current.path, next, point.modifiers.subtractive)))
    // A new point is not touched: Delete waits for a press on a point.
    touched = null
  }

  function pressesSource(g: Extract<ToolGesture, { kind: 'press' }>): boolean {
    const target = g.hit?.kind === 'object' ? g.hit.target : null
    return target?.kind === 'plant' && target.id === source?.sourceId
  }

  /** A press on one of the draft's handles (point-editor/rules.ts, A2). */
  function handlePress(handle: ToolHandleId, point: ToolPoint, clickCount: number): void {
    const parsed = parsePointHandle(handle)
    const path = pointsOf()
    if (!parsed || parsed.ownerId !== DRAFT_OWNER || !path) return
    const { role, index } = parsed
    const lastIndex = path.points.length - 1
    const intent = pointPressIntent({
      role,
      clickCount,
      alt: point.modifiers.subtractive,
      isLastDraftPoint: role === 'point' && !path.closed && index === lastIndex,
    })
    switch (intent) {
      case 'finish':
        finish()
        return
      case 'delete':
        deletePoint(index)
        return
      case 'move':
        // The picked plant never moves while a new row is drawn: from 3 points a press on it closes the loop.
        if (index === 0) {
          if (clickCount === 1 && !path.closed && path.points.length >= 3) {
            setDraft(editDraft(draft!, closePath(path)!))
            touched = null
          }
          return
        }
        touched = index
        pointDrag = { kind: 'move', index, at: null }
        return
      case 'insert': {
        const dot = draftHandles(context()).find((entry) => entry.id === handle)
        if (!dot) return
        setDraft(editDraft(draft!, insertAfter(path, index, dot.anchor)))
        touched = index + 1
        return
      }
      case 'insert-drag':
        pointDrag = { kind: 'insert', after: index, at: null }
    }
  }

  /** The live point drag follows the pointer (snapped, never constrained: U36). */
  function handleMove(at: WorldPoint): void {
    if (pointDrag) pointDrag.at = at
  }

  /** A point drag's release: the moved or inserted point joins the draft; a still press inserts nothing. */
  function handleRelease(): void {
    const drag = pointDrag
    pointDrag = null
    if (!drag?.at || !draft) return
    if (drag.kind === 'move') {
      setDraft(editDraft(draft, movePoint(draft.path, drag.index, drag.at)))
      touched = drag.index
    } else {
      setDraft(editDraft(draft, insertAfter(draft.path, drag.after, drag.at)))
      touched = drag.after + 1
    }
  }

  /** Deletes a point the draft may lose: never the picked plant, never below the minimum (refused silently). */
  function deletePoint(index: number): boolean {
    if (!draft || index <= 0) return false
    const next = removePoint(draft.path, index)
    if (!next) return false
    setDraft(editDraft(draft, next))
    touched = null
    return true
  }

  function pointIndexOf(handle: ToolHandleId): number | null {
    const parsed = parsePointHandle(handle)
    return parsed?.ownerId === DRAFT_OWNER && parsed.role === 'point' ? parsed.index : null
  }

  function pointAction(handle: ToolHandleId, action: PointAction): boolean {
    const index = pointIndexOf(handle)
    if (index === null || index <= 0 || !draft || !draft.path.points[index]) return false
    if (action === 'delete-point') return deletePoint(index)
    setDraft(editDraft(draft, setSharp(draft.path, index, action === 'sharp-corner')))
    touched = index
    return true
  }

  /** Esc, Backspace or Ctrl+Z: one point back onto the redo stack; false with only the picked plant left. */
  function stepBackOnce(): boolean {
    const back = draft ? stepBack(draft, 1) : null
    if (!back) return false
    setDraft(back)
    touched = null
    pointDrag = null
    return true
  }

  /** Esc, on the map or in the card's field (U58): the last point, else the picked plant; false with none picked. */
  function escapeOnce(): boolean {
    if (!source) return false
    if (!stepBackOnce()) clear()
    return true
  }

  /** Ctrl+Shift+Z: the state the last step back took; false with none. */
  function stepForwardOnce(): boolean {
    const forward = draft ? stepForward(draft) : null
    if (!forward) return false
    setDraft(forward)
    touched = null
    return true
  }

  // ── Row ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  function setGeneratedCount(count: number, options: { dense?: boolean; blocked?: boolean }): void {
    shownCount = { count, density: options.blocked ? 'blocked' : options.dense ? 'dense' : 'normal' }
  }

  /** The card's spacing, or null while its field's text is not a valid one. */
  function spacing(): PathSpacing | null {
    if (mode === 'count') {
      const parsed = parsePlantRowCountInput(countText)
      countValid = parsed.valid && parsed.count <= PLANT_ROW_MAX_COUNT
      return parsed.valid && countValid ? { kind: 'count', count: parsed.count } : null
    }
    const parsed = parsePlantSpacingIntervalInput(intervalText)
    intervalValid = parsed.valid
    return parsed.valid ? { kind: 'interval', metres: parsed.meters } : null
  }

  /** The row follows the pointer: its snapped point, which the host constrained under Shift. */
  function previewAt(point: ToolPoint): void {
    endpoint = point.snapped
  }

  /** Plants the draft's row (the finish), or the straight row to `straightEnd` (a drag's release from the plant). */
  function plant(straightEnd: WorldPoint | null = null): void {
    if (!source || !draft) return
    if (!canUseSource(source)) {
      clear()
      showSourcePicking('source-missed')
      return
    }
    const path: PathPoints = straightEnd
      ? { points: [draft.path.points[0]!, { position: straightEnd, sharp: false }], closed: false }
      : draft.path
    if (straightEnd) endpoint = straightEnd
    const chosen = spacing()
    if (!chosen) {
      focusIntervalInput()
      return
    }
    const planting = plantAlongPath(path, chosen)
    // The preview already reads blocked above the limit.
    if (planting.count === 0 || planting.count > PLANT_ROW_MAX_ADDED_PLANTS) return
    commitPositions(source, planting.positions())
  }

  function finish(): void {
    if (draft && draft.path.points.length >= 2) plant()
  }

  /** Plants the new plants at `positions`: the picked plant stays as it is, and they repeat it as the Scene holds it at
   *  the commit (canUseSource checked it is there: its colour now, not at the pick). */
  function commitPositions(picked: PlantRowSource, positions: readonly WorldPoint[]): void {
    const tool = context()
    const repeated = livePlant(tool, picked)
    const generatedIds: string[] = []
    tool.effects.edits.run('interaction-plant-spacing', (tx) => {
      tx.mutate((scene) => {
        const generated = createPlantSpacingGeneratedPlants(repeated, positions, () => {
          const id = createUuid()
          generatedIds.push(id)
          return id
        })
        scene.plants = [...scene.plants, ...generated]
      })
      tx.setSelection([picked.sourceId, ...generatedIds].map((id) => ({ kind: 'plant', id })))
    }, {
      onCommitted: () => {
        clear()
        publish()
      },
    })
  }

  // ── The tool card's spacing field ───────────────────────────────────────────────────────────────────────────────

  /** The card's field: the interval in "every N m", the count in "N plants" (the same field commands, U58). */
  function spacingCommand(c: Extract<ToolCommand, { kind: 'spacing-input' | 'spacing-commit' | 'spacing-cancel' }>): void {
    const tool = context()
    if (c.kind === 'spacing-input') {
      if (mode === 'count') countText = c.text
      else intervalText = c.text
      spacing()
      return
    }
    if (c.kind === 'spacing-cancel') {
      // Esc in the field is Esc on the map, and gives the map its focus back; with nothing picked the tool leaves.
      const stepped = escapeOnce()
      tool.effects.requestFocus('map')
      if (!stepped) tool.effects.requestTool('select')
      return
    }
    const chosen = spacing()
    if (!chosen) {
      // Enter keeps the field until the spacing is valid; leaving it moves no focus.
      if (c.via === 'enter') focusIntervalInput()
      return
    }
    // Only the interval is the device's; a count belongs to this row.
    if (chosen.kind === 'interval') {
      tool.settings.commitPlantSpacingIntervalM(chosen.metres)
      intervalText = formatPlantSpacingIntervalInput(chosen.metres)
    }
    if (c.via === 'enter') tool.effects.requestFocus('map')
  }

  function setMode(next: 'interval' | 'count'): void {
    if (mode === next) return
    mode = next
    // "N plants" starts from the row's plants now, the picked one counted, at most the most a row plants.
    if (next === 'count' && !parsePlantRowCountInput(countText).valid) {
      const plants = (shownCount?.count ?? 0) + 1
      countText = String(Math.min(Math.max(plants, 2), PLANT_ROW_MAX_COUNT))
    }
    spacing()
  }

  return {
    id: 'plant-spacing',
    clampsToView: true,
    constraint() {
      const path = pointsOf()
      if (!path || pointDrag || path.closed) return null
      return { kind: 'direction', origin: path.points[path.points.length - 1]!.position, stepDeg: 45 }
    },
    activate(next) {
      ctx = next
      intervalText = formatPlantSpacingIntervalInput(next.settings.plantSpacingIntervalM())
      publish()
    },
    gesture(g) {
      switch (g.kind) {
        case 'press':
          fieldFocusOnRelease = false
          straightPress = false
          pendingPoint = null
          if (source) pressWithSource(g)
          else pickSource(g.point)
          break
        case 'drag-start':
          pendingPoint = null
          if (!source) return 'pass'
          // The drag gives the map its focus, so the field asks for none on the release.
          fieldFocusOnRelease = false
          context().effects.requestFocus('map')
          previewAt(g.point)
          break
        case 'drag-move':
          if (!source) return 'pass'
          previewAt(g.point)
          break
        case 'drag-end':
          if (!source) return 'pass'
          if (straightPress) {
            straightPress = false
            plant(g.point.snapped)
          } else {
            // The press added its point; the lift adds none, and the band waits for the next hover.
            endpoint = null
          }
          break
        case 'handle-drag':
          if (!source) return 'pass'
          if (g.phase === 'start') handlePress(g.handle, g.point, g.clickCount)
          else if (g.phase === 'move') handleMove(g.point.snapped)
          else handleRelease()
          break
        case 'tap': {
          straightPress = false
          const pending = pendingPoint
          pendingPoint = null
          if (pending && source && draft) {
            placePoint(pending)
            publish()
            return 'handled'
          }
          // The tap itself stays the host's, as before; only the field's focus request is published.
          if (focusFieldOnRelease()) publish()
          return 'pass'
        }
        case 'cancel':
          fieldFocusOnRelease = false
          straightPress = false
          pendingPoint = null
          pointDrag = null
          if (source) publish()
          return 'pass'
        case 'hover':
          if (!source) return 'pass'
          previewAt(g.point)
          publish()
          // While a source is picked the row replaces the hover restyle and the plant tooltip.
          return 'handled'
        case 'hover-end':
          // The pointer left the map (for the card, say): the row is the one the finish plants.
          if (source && endpoint) {
            endpoint = null
            publish()
          }
          return 'pass'
        default:
          // A cancelled drag keeps the source and its preview.
          return 'pass'
      }
      publish()
      return 'handled'
    },
    command(c) {
      switch (c.kind) {
        case 'escape':
          // The points step back first, then the picked plant goes; with none Esc passes, and the chain's tool layer leaves.
          if (!escapeOnce()) return 'pass'
          publish()
          return 'handled'
        case 'remove-last': {
          // Backspace: the focused point, else the last point; while a plant is picked it never reaches Delete selected.
          if (!source) return 'pass'
          const focused = context().focusedHandle()
          const index = focused === null ? null : pointIndexOf(focused)
          if (index !== null) deletePoint(index)
          else stepBackOnce()
          publish()
          return 'handled'
        }
        case 'undo-transient':
        case 'redo-transient':
          // While a plant is picked Ctrl+Z and Ctrl+Shift+Z are the draft's alone, even with nothing to step.
          if (!source) return 'pass'
          if (c.kind === 'undo-transient') stepBackOnce()
          else stepForwardOnce()
          publish()
          return 'handled'
        case 'delete-handle': {
          // Delete: the focused point, else the last-touched one.
          const focused = context().focusedHandle()
          const index = (focused === null ? null : pointIndexOf(focused)) ?? touched
          if (index === null || !deletePoint(index)) return 'pass'
          publish()
          return 'handled'
        }
        case 'confirm':
          if (!source || !draft || draft.path.points.length < 2) return 'pass'
          finish()
          publish()
          return 'handled'
        case 'spacing-input':
        case 'spacing-commit':
        case 'spacing-cancel':
          spacingCommand(c)
          publish()
          return 'handled'
        case 'spacing-mode':
          if (!source) return 'pass'
          setMode(c.mode)
          publish()
          return 'handled'
        case 'point-action':
          // From the point menu, opened on a point (the card has no point buttons since decision 16).
          if (!pointAction(c.handle, c.action)) return 'pass'
          publish()
          return 'handled'
        default:
          return 'pass'
      }
    },
    sceneChanged() {
      // The picked plant can no longer repeat (the Layers panel locked or hid its layer, say): the draft ends at once.
      if (source && ctx && !canUseSource(source)) {
        clear()
        showSourcePicking('source-missed')
      }
      publish()
    },
    viewChanged: publish,
    canFinish: () => source !== null && draft !== null && draft.path.points.length >= 2,
    pointMenu(handle) {
      const path = pointsOf()
      const parsed = parsePointHandle(handle)
      if (!source || !path || parsed?.ownerId !== DRAFT_OWNER || parsed.role !== 'point' || parsed.index <= 0) return []
      const point = path.points[parsed.index]
      if (!point) return []
      return pointMenuItems({ sharpable: true, sharp: point.sharp, canDelete: removePoint(path, parsed.index) !== null })
    },
    hasTransient: () => source !== null,
    // The picked source and its points outlive every cancellation (a pan, a blur, overview); Esc steps them back.
    cancelTransient() {},
    canUndoTransient: () => source !== null,
    canRedoTransient: () => source !== null,
    deactivate() {
      clear()
      ctx?.effects.setDraft(null)
      ctx?.effects.setHandles([])
      ctx = null
    },
  }
}
