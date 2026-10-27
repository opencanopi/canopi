// canvas/runtime/tools/tool.ts  (the tool contract; with interaction-types.ts, where tool implementations get their shared types)
// Every import below is `import type`, each from the module that defines the type, never from a barrel (scene/index.ts):
//   ../interaction-types.ts: ToolId, PointerKind, CancelReason, ToolHandleId (§1.2a)
//   ./draft.ts: DraftPresentation, ToolHandle
//   ../view/types.ts: WorldPoint, WorldVector, WorldQuad
//   ../scene/types.ts: ScenePersistedState, ScenePlantEntity, SceneLayerEntity
//   ../scene/design-object-targets.ts: SceneDesignObjectTarget, SceneDesignObjectSelection
//   ../scene-runtime/transactions.ts: SceneEditCoordinator
//   ../scene-runtime/arrangement-placement.ts: SceneArrangementTemplate
//   ../runtime.ts: CanvasDesignObjectSelectionModel
//   ../../session-state.ts: CanvasToolGuidance
//   ../../plant-stamp-source.ts: PlantStampSourceInput; ../../saved-object-stamp-payload.ts: SavedObjectStampPayload
//   ../../point-editor/rules.ts: PointAction, PointMenuItem (it imports only interaction-types.ts, type-only)
// tools-import-no-maplibre-dom-or-pixi allows all of them (it forbids view/** values, not type-only view/types.ts, and
// names none of the others). tools-reach-no-maplibre-or-pixi holds because no listed module reaches maplibre-gl, pixi.js
// or src/maplibre/**, even through type-only edges, which that reachable rule follows;
// view/types.ts, draft.ts and interaction-types.ts are seams files: draft.ts imports only view/types.ts, interaction-types.ts
// and GhostEntity from this file (type-only both ways, no runtime cycle), and interaction-types.ts only the two clean
// drag-payload modules above. Tool implementations
// import these types from tool.ts, draft.ts or the same defining modules. Any later type import must keep
// tools-reach-no-maplibre-or-pixi true.

import type { CancelReason, PointerKind, ToolHandleId, ToolId } from '../interaction-types'
import type { DraftPresentation, ToolHandle } from './draft'
import type { WorldPoint, WorldQuad, WorldVector } from '../view/types'
import type { ScenePersistedState, ScenePlantEntity, SceneLayerEntity } from '../scene/types'
import type { SceneDesignObjectSelection, SceneDesignObjectTarget } from '../scene/design-object-targets'
import type { SceneEditCoordinator } from '../scene-runtime/transactions'
import type { SceneArrangementTemplate } from '../scene-runtime/arrangement-placement'
import type { CanvasDesignObjectSelectionModel } from '../runtime'
import type { CanvasToolGuidance } from '../../session-state'
import type { PlantStampSourceInput } from '../../plant-stamp-source'
import type { SavedObjectStampPayload } from '../../saved-object-stamp-payload'
import type { PointAction, PointMenuItem } from '../../point-editor/rules'

/** Modifiers by meaning, resolved per platform and per phase by the ToolHost. */
export interface ToolModifiers {
  /** Toggle into the selection: Shift, Ctrl or Cmd (a Mac Ctrl press is a right-click and never reaches a tool). */
  readonly additive: boolean
  /** Remove from the selection: Alt. */
  readonly subtractive: boolean
  /** Shift: 45° screen steps for Polygon, Plant a row, Line and Measure; a square or a circle for Rectangle and Ellipse;
   *  the rotate handle's 15° steps from the press angle. Point handles (corners, vertices, guide ends) ignore Shift and snap
   *  as usual (U36). */
  readonly constrain: boolean
  /** Plant a row only: Ctrl or Cmd held (on every OS). */
  readonly noSnap: boolean
}

export interface ToolPoint {
  readonly world: WorldPoint       // raw plane metres (for a tool with clampsToView, from the screen point clamped to the view)
  /** world snapped to the grid without the constraint: Polygon's close test. Equals world when snap is off. */
  readonly free: WorldPoint
  /** world after the tool's constraint (CanvasTool.constraint, Shift): 'direction' turns origin → point to the step and keeps the length; 'rotation-delta' turns the point about the pivot so the angle since the press is a step multiple. Equals world when none applies. */
  readonly constrained: WorldPoint
  /** The grid on world axes (user); under a 'direction' constraint the constraint wins and the length along its ray is
   *  rounded to the grid interval (spec §2.3, one order for every tool). Equals constrained when snap is off, noSnap is
   *  held or the constraint is 'rotation-delta'. */
  readonly snapped: WorldPoint
  readonly modifiers: ToolModifiers
  readonly pointer: PointerKind
}

/** What a hit query returns: a design object, or a part of one. */
export type HitTarget =
  | { readonly kind: 'object'; readonly target: SceneDesignObjectTarget }                          // scene/design-object-targets.ts
  | { readonly kind: 'zone-edge'; readonly zoneId: string; readonly edgeIndex: number; readonly distancePx: number }
/** What a hit asks for. The pick is hit-testing.ts's (canopi-qd2k): the topmost drawn object on interactive layers, a group
 *  as the top-level target, closed zones by their outline only within PICK_TOLERANCE_PX[pointer], the revealed (selected or
 *  hovered) note, and object-locked objects, which the caller selects without moving (Select's press, click.ts). */
export interface HitFilter {
  /** The pointer the hit is for: it sets the outline tolerance (a finger's is wider). Required, so no hit forgets it. */
  readonly pointer: PointerKind
  /** hitAt: also locked layers that are visible (hitTestVisibleTopLevel, the host's hover). */
  readonly includeLocked?: boolean
  /** hitAt: answers only the edge, nearest the point, of the zone the pick names (hit-testing.ts hitZoneEdge): with
   *  `includeLocked` the visible pick's ("Turn view to this edge", spec §4.16), else the editable pick's (Select's
   *  double-click that adds a corner). hitAt only: a band has no tolerance. */
  readonly zoneEdge?: true
}
/** The selection read model: today's CanvasDesignObjectSelectionModel (canvas/runtime/runtime.ts:48), unchanged. */
export type SelectionReadModel = CanvasDesignObjectSelectionModel
/** Layer names as stored (SceneLayerEntity.name): 'plants', 'zones', 'annotations', 'measurements', …
 *  Stays `string` in the seams (SceneLayerEntity.name is `string`, scene/types.ts:15; the seams do not edit scene/types.ts). Narrowing it to the known names is a later, optional change. */
export type SceneLayerKind = SceneLayerEntity['name']
/**
 * A preview of what a placement would create, drawn with the draft by the scene's own drawing code (plan 0D1 "Ghosts").
 * The entities are already where a click would put them: the tool builds the plant as a click would (plantEntityFromStampSource),
 * and a stamp tool draws the template a press would add (stamp-rotation.ts stampTemplateAt: the held turn about the
 * stamp's anchor, then the move to the pointer). The tool card reads the held turn from guidance, not from the ghost.
 * A plant ghost is the plant's mark only: the Place plants mature-width ring, its label and the nearest-plant guide are ellipse, label and polyline shapes.
 * mark 'symbol' draws the plant's symbol; 'dot' draws Plant a row's look: a filled disc in the plant's display colour with a 2 px
 * border of the same colour, radius half the plant's world AABB (today's (a4c86d39) plant-spacing-overlay.ts:158-181; Plant a row emits
 * its row ghosts with 'dot' at opacity 0.35). Colours come from the scene's plant presentation, never a raw colour in the draft. `sizeFrom`
 * is the point whose plant presentation gives a 'dot' its radius: Plant a row passes its source plant's position, so every disc in the row
 * has the source's size, as today's (a4c86d39) plant-spacing-tool.ts:423-427 did; without it the ghost's own position is used.
 * Object and saved-stamp ghosts draw zones and plants at 0.62 and notes at 0.68 today: the tool emits the notes as a second 'objects'
 * ghost at 0.68 (the draft layer multiplies by each note's own marker and text opacity).
 */
export type GhostEntity =
  | { readonly kind: 'plant'; readonly plant: ScenePlantEntity; readonly mark: 'symbol' | 'dot'; readonly sizeFrom?: WorldPoint }
  | { readonly kind: 'objects'; readonly template: SceneArrangementTemplate }  // stamp pick, saved stamp
/** A note's text entry; the host owns the textarea. The tool card's spacing field is not one (it sends spacing commands). */
export interface TextEntryRequest {
  readonly anchor: WorldPoint
  readonly rotationDeg: number                     // stored note rotation; the host draws the textarea at rotationDeg − bearing
  readonly initialText: string
  readonly placeholderKey: string
  /** One mode: the field is drawn at the note's font size and line height, where the note will draw. */
  readonly fontSizePx?: number                     // the note's stored font size; a new note's default 16 px
}

export type ToolGesture =
  | { readonly kind: 'hover'; readonly point: ToolPoint; readonly hit: HitTarget | null }
  | { readonly kind: 'hover-end' }
  | { readonly kind: 'press'; readonly point: ToolPoint; readonly hit: HitTarget | null; readonly clickCount: number }
  | { readonly kind: 'tap'; readonly point: ToolPoint; readonly hit: HitTarget | null; readonly clickCount: number }
  | { readonly kind: 'drag-start' | 'drag-move' | 'drag-end'; readonly point: ToolPoint; readonly start: ToolPoint; readonly startHit: HitTarget | null }
  /** clickCount: the press's (a double-click on a polygon's edge midpoint adds a corner), carried by the start only. */
  | { readonly kind: 'handle-drag'; readonly phase: 'start'; readonly handle: ToolHandleId; readonly point: ToolPoint; readonly start: ToolPoint; readonly clickCount: number }
  | { readonly kind: 'handle-drag'; readonly phase: 'move' | 'end'; readonly handle: ToolHandleId; readonly point: ToolPoint; readonly start: ToolPoint }
  | { readonly kind: 'cancel'; readonly reason: CancelReason }
// Drops are not tool gestures: the host's shared drop handler serves every tool (§1.4).

export type ToolCommand =
  | { readonly kind: 'escape' }                                    // only when the tool's Esc layer is top
  | { readonly kind: 'confirm' }                                   // Enter (polygon: finish)
  | { readonly kind: 'remove-last' }                               // Backspace
  | { readonly kind: 'rotate-held'; readonly stepDeg: 15 | -15 }   // [ ] while a stamp is held
  | { readonly kind: 'place-at'; readonly world: WorldPoint }      // context menu "Place plants here": snapped by the host; dropped in overview
  | { readonly kind: 'delete-handle' }                             // Delete on a focused or selected zone corner (phase 2)
  | { readonly kind: 'edit-text' }                                 // Enter / F2 on one selected note
  | { readonly kind: 'undo-transient' } | { readonly kind: 'redo-transient' }
  // The tool card's Plant a row spacing field (CanvasToolCommandSurface.plantRowSpacing, forwarded by the session):
  | { readonly kind: 'spacing-input'; readonly text: string }                 // typing: the preview follows a valid spacing
  | { readonly kind: 'spacing-commit'; readonly via: 'enter' | 'blur' }       // keeps a valid spacing; Enter returns focus to the map, blur moves none
  | { readonly kind: 'spacing-cancel' }                                       // Esc in the field: drops the source, focus to the map
  // Plant a row's path (CanvasToolCommandSurface.plantRowPath, U58): the card's [Interval | Plants] switch. A point
  // action comes from the point menu (A16), on the point it was opened on (decision 16: the card has no point buttons).
  | { readonly kind: 'spacing-mode'; readonly mode: 'interval' | 'count' }
  | { readonly kind: 'point-action'; readonly handle: ToolHandleId; readonly action: PointAction }

/**
 * A 'handled' hover clears and skips the host's passive hover (restyle, tooltip); 'pass' lets it run.
 * A drag-start or drag-move is a hover with the button down unless the tool answers 'handled': a tool that keeps its press
 * to the release answers 'handled' (Select, Text, Place plants), one whose press let go of it answers 'pass'.
 */
export type ToolReply = 'handled' | 'pass'

/** Read-only view queries: everything a tool may know about the camera. */
export interface ToolView {
  /** In [0, 360) as the ViewCamera keeps it, so a tool can store it as a rotation without importing view/ (policy P5). */
  readonly bearingDeg: number
  readonly mode: 'site' | 'overview'
  metresPerPixelAt(p: WorldPoint): number
  screenDistance(a: WorldPoint, b: WorldPoint): number
  screenAxesInWorld(): { readonly right: WorldVector; readonly down: WorldVector }
  /** Screen-aligned rectangle from two world corners: rotationDeg = the bearing (in [0, 360)). Shift's square and circle use `square`. */
  screenAlignedRect(a: WorldPoint, b: WorldPoint, options?: { readonly square?: boolean }):
    { readonly center: WorldPoint; readonly width: number; readonly height: number; readonly rotationDeg: number }
}
// Angle constraints are not a ToolView query: the host applies them (CanvasTool.constraint), so ToolPoint.snapped is always right.

/** Read-only scene queries: in 0B a façade over today's linear hit tests at the frame's pixelsPerMetre (the index comes later). */
export interface ToolScene {
  readonly persisted: Readonly<ScenePersistedState>
  hitAt(world: WorldPoint, filter: HitFilter): HitTarget | null
  hitInQuad(quad: WorldQuad): readonly HitTarget[]
  nearestPlant(world: WorldPoint): { readonly plant: ScenePlantEntity; readonly distanceM: number } | null
  /** How the scene presents a plant now: the name in today's order (localised, stored common,
   *  canonical), the display colour and the symbol radius in CSS px. For tool-card names, row glyphs and the source ring. */
  plantPresentation(plant: ScenePlantEntity): { readonly commonName: string; readonly color: string; readonly radiusPx: number }
  isLayerOpenForCreation(layer: SceneLayerKind): boolean
  selection(): SceneDesignObjectSelection
  selectionModel(): SelectionReadModel         // memoised by reference: the same Scene, selection and scale return the same model
}

/** The only way a tool changes anything. */
export interface ToolEffects {
  readonly edits: SceneEditCoordinator                      // unchanged transaction API (begin/run/mutate/setSelection/commit/abort)
  /** History-free, dirty-free selection: click, band, clearing (today's session setSelection; a transaction's setSelection records an undo step). */
  setSelection(targets: readonly SceneDesignObjectTarget[]): void
  setDraft(draft: DraftPresentation | null): void           // world-space; drawn by the renderer
  /** DOM handle layer; hit by the source. `active`: the handle the tool marks active (Select's selected corner); the
   *  host's live handle drag wins over it. */
  setHandles(handles: readonly ToolHandle[], active?: ToolHandleId | null): void
  setGuidance(guidance: Partial<CanvasToolGuidance> | null): void
  requestTool(id: ToolId): void
  /** Opens the host's text entry; submit runs on Enter and on blur and keeps the field open on 'keep' (a refused commit);
   *  onCancel runs when the entry closes without a submit (its own Esc), so the tool can follow the cancel. */
  requestTextEntry(request: TextEntryRequest, submit: (text: string) => 'close' | 'keep', onCancel?: () => void): void
  closeTextEntry(): void
  requestFocus(target: 'map'): void                         // ToolHostDeps.focus (CanvasFocusPort, §1.6), implemented by the FocusOwner
  /** Profile only (canopi-f47t.42): hands the finished line (2+ points) to the Site data profile (ToolHostDeps.finishProfile);
   *  the tool then requests Select. */
  finishProfile(points: readonly WorldPoint[]): void
  /** A drag refused by a lock, once per refused drag (Select's press on a locked object; 2.1-Q177): ToolHostDeps
   *  .lockedMoveRefused, which raises the lock toast. */
  refuseLockedMove(): void
}

export interface ToolSettingsPort {
  plantSpacingIntervalM(): number
  commitPlantSpacingIntervalM(metres: number): void
}

export interface ToolContext {
  readonly view: ToolView
  readonly scene: ToolScene
  readonly effects: ToolEffects
  readonly settings: ToolSettingsPort
  /** The host's grid and guide snapping of any world point (the move-drag snaps the dragged object's reference point, not the pointer). */
  snap(point: WorldPoint): WorldPoint
  /** The handle that holds keyboard focus now (a tabbed-to zone corner), or null. */
  focusedHandle(): ToolHandleId | null
  /** The pointer kind that last hovered or pressed the map, whichever tool heard it (Select's handle size, Q1). */
  pointer(): PointerKind
  readonly translate: (key: string, options?: Readonly<Record<string, unknown>>) => string
}

export interface CanvasTool {
  readonly id: ToolId
  /** True while the tool's next release must be admitted by the scene (Select's band: today's requiresSettledPointerUp). */
  settledRelease?(): boolean
  readonly clampsToView?: boolean                 // the host clamps the screen point to the view before converting (Plant a row)
  /**
   * The constraint for the next point while Shift (modifiers.constrain) is held, or null. 'direction': the last polygon
   * corner, the row source, the line or guide start; the host turns origin → point to stepDeg against the screen axes
   * (identical to world axes at bearing 0) and keeps the length. 'rotation-delta': the rotate handle; the angle turned
   * about the pivot since startDeg rounds to stepDeg (relative steps, as today, bearing-independent). Order with
   * snapping: §2.3.
   */
  constraint?(): ToolConstraint | null
  activate(ctx: ToolContext, source: ToolSource | null): void
  /** A new source arrives while armed (species picked again, saved stamp changed). */
  sourceChanged?(source: ToolSource | null): void
  gesture(g: ToolGesture): ToolReply
  command(c: ToolCommand): ToolReply
  /** Scene or selection changed outside the tool (undo, remote edit). */
  sceneChanged?(): void
  /** A camera frame on which the host re-emitted nothing (the pointer off the map): rebuild a draft whose look depends on the
   *  scale, such as the polygon's edge chips hidden below 36 px (today's refreshViewportDependent). */
  viewChanged?(): void
  /** True when the draft can finish now (a polygon with 3 or more corners): the canvas menu then leads with "Finish
   *  shape", which sends the tool 'confirm'. */
  canFinish?(): boolean
  /** The point menu for a pressed or focused handle (point-editor/rules.ts pointMenuItems); empty when the handle is not a
   *  point, and the host then opens the ordinary canvas menu (A16). Each entry comes back as a 'point-action' command. */
  pointMenu?(handle: ToolHandleId): readonly PointMenuItem[]
  /** True while the tool holds a draft, pick, row source or Place plants' waiting point: Esc drops it first unless
   *  `escapeLeaves`, and it holds re-origin (§4.19). */
  hasTransient(): boolean
  /** Esc leaves the tool even while it holds a transient, which is then no Esc layer (Place plants' waiting point, U35). */
  readonly escapeLeaves?: true
  cancelTransient(reason: 'tool-change' | 'document-replaced' | 'navigate' | 'overview'): void   // 'overview': the map entered overview; drop what today's overview reset dropped (a stamp keeps its pick and hides only its ghost)
  /** Transient history (polygon corners), read by ToolHost.transientHistory; the tool acts on the undo-transient and redo-transient commands. */
  canUndoTransient?(): boolean
  canRedoTransient?(): boolean
  deactivate(reason: 'switch' | 'document-replaced' | 'dispose'): void
}

export type ToolConstraint =
  | { readonly kind: 'direction'; readonly origin: WorldPoint; readonly stepDeg: 45 }
  | { readonly kind: 'rotation-delta'; readonly pivot: WorldPoint; readonly startDeg: number; readonly stepDeg: 15 }

/** Arming payloads that today arrive through module-level signals. */
export type ToolSource =
  | { readonly kind: 'species'; readonly species: PlantStampSourceInput }
  /** name: armCanvasTool writes it for the tool card (readSavedObjectStampName); the tool ignores it; sources the session
   *  rebuilds from the read models omit it. */
  | { readonly kind: 'saved-stamp'; readonly stamp: SavedObjectStampPayload; readonly name?: string | null }
