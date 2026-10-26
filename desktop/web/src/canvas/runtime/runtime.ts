import type { SpeciesFocus, SpeciesFocusCommands } from './species-key'
import type { CanvasPrintSnapshot } from '../print'
import type { CanvasInspectionHandle } from '../inspection'
import type { ReadonlySignal } from '@preact/signals'
import type {
  Annotation,
  CanopiFile,
  MeasurementGuide,
  ObjectGroup,
  PlacedPlant,
  Zone,
} from '../../types/design'
import type { SessionPlane } from '../session-plane'
import type { SelectedPlantColorContext } from '../plant-color-context'
import type { SelectedPlantSymbolContext } from '../plant-symbol-context'
import type { PlantSymbolId, SceneDesignObjectTarget, ScenePoint,ScenePersistedState } from './scene'
import type { SceneBounds } from './view/types'
import type { PlantLabelMode } from './plant-display'
import type { SceneRendererSnapshot } from './renderers/scene-types'
import type { PointerWorld } from './interaction-ports'
import type { Modifiers, ToolId } from './interaction-types'
import type { ViewCommandSurface, ViewReadSurface } from './view/read-surface'
import type { ViewTransform } from './view/types'
import type { SpeciesCacheEntry } from './species-cache'

export interface CanvasRuntimeDocumentMetadata {
  name: string
  description?: string | null
}

export type CanvasDesignObjectSelectionTarget = SceneDesignObjectTarget

/**
 * A structural block (a missing Design Object, a grouped member, a hidden or locked Layer) keeps the target out of every
 * edit; a locked Design Object stays selected as locked.
 */
type CanvasDesignObjectSelectionBlockReason = 'structural' | 'locked-design-object'

export interface CanvasDesignObjectSelectionBlockedTarget {
  readonly target: CanvasDesignObjectSelectionTarget
  readonly reason: CanvasDesignObjectSelectionBlockReason
}

export interface CanvasDesignObjectSelectionModel {
  readonly editableTargets: readonly CanvasDesignObjectSelectionTarget[]
  readonly lockedTargets: readonly CanvasDesignObjectSelectionTarget[]
  readonly blockedTargets: readonly CanvasDesignObjectSelectionBlockedTarget[]
  readonly bounds: SceneBounds | null
  readonly sameSpeciesReferenceCanonicalName: string | null
  readonly plantNamePinning: {
    readonly plantIds: readonly string[]
    readonly allPinned: boolean
  }
}

export interface CanvasQueryRevision {
  readonly scene: ReadonlySignal<number>
  readonly plantNames: ReadonlySignal<number>
  /**
   * Moves after each tool call, settling commit and interaction teardown, so after every change of the re-origin hold
   * (`CanvasKeyboardPort.holdsSelectionDeletes`): the menu bar re-reads the hold on it (S3b).
   */
  readonly transientHistory: ReadonlySignal<number>
}

/** Plant a row's spacing field, which the tool card shows while a plant is picked. */
export interface CanvasPlantRowSpacingField {
  /** The text changed: the preview follows a valid spacing. */
  input(text: string): void
  /** Enter: keeps a valid spacing and gives the map focus back; an invalid one keeps the field focused. */
  commit(text: string): void
  /** The field lost focus: keeps a valid spacing without moving focus. */
  blur(text: string): void
  /** Esc in the field: as Esc on the map (the last point, else the picked plant), and gives the map focus back. */
  cancel(): void
}

/** Plant a row's path (U58): the tool card's check button and [Interval | Plants] switch. */
export interface CanvasPlantRowPathCommands {
  /** The check button: plants the drawn row (Enter's finish). */
  finish(): void
  /** Every N m (`interval`) or N plants (`count`, the picked plant counted). */
  setMode(mode: 'interval' | 'count'): void
}

export interface CanvasToolCommandSurface {
  setTool(id: ToolId): void
  readonly plantRowSpacing: CanvasPlantRowSpacingField
  readonly plantRowPath?: CanvasPlantRowPathCommands
}

/**
 * The viewport commands app code may give: the view's command surface (spec §1.1a). The name stays for `canvas/session.ts`
 * (`currentCanvasViewportCommandSurface`).
 */
export type CanvasViewportCommandSurface = ViewCommandSurface

export interface CanvasHistoryCommandSurface {
  readonly canUndo: ReadonlySignal<boolean>
  readonly canRedo: ReadonlySignal<boolean>
  undo(): void
  redo(): void
}

/** Design objects in their persisted lon/lat form (no metres). */
export interface CanvasDesignObjects {
  readonly plants: readonly PlacedPlant[]
  readonly zones: readonly Zone[]
  readonly annotations: readonly Annotation[]
  readonly measurementGuides: readonly MeasurementGuide[]
  readonly groups: readonly ObjectGroup[]
}

export interface CanvasDesignObjectImportReceipt {
  readonly committed: boolean
  readonly createdCount: number
}

export interface CanvasSceneEditCommandSurface {
  /** Present only where the edition saves stamps (Desktop; 2.1-Q150): menus offer Save as stamp from this field. */
  readonly saveSelectionAsObjectStamp?: () => void
  /**
   * Adds lon/lat design objects as one undoable edit: positions enter the
   * session plane, identities are re-allocated, locks are cleared and the new
   * objects become the selection. Group members refer to the given ids.
   */
  importDesignObjects(objects: CanvasDesignObjects): CanvasDesignObjectImportReceipt
  copy(): void
  paste(): void
  pasteAt(point: ScenePoint): void
  canPaste(): boolean
  duplicateSelected(): void
  toggleSelectedPlantNamePins(): void
  deleteSelected(): void
  selectAll(): void
  selectSameSpecies(): void
  /** Replaces the selection with every selectable plant of these species. */
  selectSpecies(canonicalNames: readonly string[]): void
  /** Empties the selection (session state: no edit, history or dirty state). */
  clearSelection(): void
  bringToFront(): void
  sendToBack(): void
  lockSelected(): void
  unlockSelected(): void
  /** Unlocks every locked Design Object in the Design as one edit; layer locks stay. */
  unlockAll(): void
  groupSelected(): void
  ungroupSelected(): void
  /**
   * Gives a zone a display name as one undoable edit; a blank name clears it,
   * and lists then name the zone by its type and size. The zone's id, which
   * Calendar and Budget targets and groups refer to, never changes. False when
   * nothing changed (unknown or locked zone, locked layer, same name).
   */
  renameZone(zoneId: string, name: string | null): boolean
  /**
   * Turns the editable selection about its centre by `degrees`, clockwise on
   * the map for positive values, as one undoable edit. A selection holding a
   * locked object, a measurement or a single plant does not turn.
   */
  rotateSelected(degrees: number): void
  /**
   * Moves the editable selection by `delta` session-plane metres (the arrow
   * keys on the map). Nudges until `endNudge()` are one undoable edit; locked
   * objects never move. False when nothing editable moved.
   */
  nudgeSelected(delta: ScenePoint): boolean
  /** Ends the nudge series: commits it as one edit, or restores it with `abort`. */
  endNudge(options?: { readonly abort?: boolean }): void
}

export interface CanvasChromeCommandSurface {
  toggleGrid(): void
  toggleSnapToGrid(): void
}

export interface CanvasLayerCommandSurface {
  setSceneLayerVisibility(name: string, visible: boolean): boolean
  setSceneLayerOpacity(name: string, opacity: number): boolean
  setSceneLayerLocked(name: string, locked: boolean): boolean
  /**
   * Presenting a story: the map shows only these Design layers and no
   * selection or hover until `null`. Session state only: never a Scene edit,
   * history entry or dirty state.
   */
  presentLayers(visibleLayerNames: readonly string[] | null): void
}

export interface CanvasPlantPresentationCommandSurface {
  ensureSpeciesCacheEntries(canonicalNames: string[], activeLocale: string): Promise<boolean>
  setSelectedPlantColor(color: string | null): number
  setSelectedPlantSymbol(symbol: PlantSymbolId | null): number
  setPlantColorForSpecies(canonicalName: string, color: string | null): number
  setPlantSymbolForSpecies(canonicalName: string, symbol: PlantSymbolId): number
}

export interface CanvasCommandSurface {
  readonly speciesFocus: SpeciesFocusCommands
  readonly tools: CanvasToolCommandSurface
  readonly viewport: CanvasViewportCommandSurface
  readonly history: CanvasHistoryCommandSurface
  readonly sceneEdits: CanvasSceneEditCommandSurface
  readonly chrome: CanvasChromeCommandSurface
  readonly layers: CanvasLayerCommandSurface
  readonly plantPresentation: CanvasPlantPresentationCommandSurface
}

export interface CanvasViewSceneRequest {
  /** The view the scene is captured for: its scale decides overview. */
  readonly view: ViewTransform
  /** Design layers drawn; every other layer is hidden. */
  readonly visibleLayerNames: readonly string[]
  /** Species the view focuses; others are dimmed as Species Focus does. */
  readonly focusedSpecies: string | null
  /** Labels the view shows; absent, the workspace's choice. */
  readonly plantLabels?: PlantLabelMode
}

/** How many plants in view carry a label on the map now ("Codes shown for 70 of 282 plants in view"). */
export interface CanvasPlantLabelCoverage {
  readonly labelled: number
  readonly inView: number
}

export interface CanvasQuerySurface {
  getSpeciesFocus(): SpeciesFocus
  /** Labels drawn for the plants in view; zero in overview and while nothing is mounted. */
  getPlantLabelCoverage(): CanvasPlantLabelCoverage
  readonly revision: CanvasQueryRevision
  /** What app code observes of the view (spec §1.1a): coarse signals and the capture of what is on screen. */
  readonly view: ViewReadSurface
  // The open Design's metre frame; null only before the first hydration.
  readonly sessionPlane: ReadonlySignal<SessionPlane | null>
  capturePrintSnapshot(): CanvasPrintSnapshot | null
  /**
   * The settled scene as a saved view shows it in `view`, for an off-screen
   * snapshot: no selection, hover or panel highlight. Null while an edit owns
   * the Scene. Never changes session state.
   */
  captureViewScene(request: CanvasViewSceneRequest): SceneRendererSnapshot | null
  /** Whether the Scene holds any plant, note, measurement guide, or zone with a point ("Where is your site?"). */
  sceneHasObjects(): boolean
  /** The persisted Scene; a reader inside a component, computed or effect follows the Scene revision. */
  getSceneSnapshot(): ScenePersistedState
  getSelection(): SceneDesignObjectTarget[]
  getDesignObjectSelection(): CanvasDesignObjectSelectionModel
  getSelectedPlantColorContext(): SelectedPlantColorContext
  getSelectedPlantSymbolContext(): SelectedPlantSymbolContext
  getPlacedPlants(): PlacedPlant[]
  getSettledPlacedPlants(): PlacedPlant[] | null
  /** Canonical lon/lat design objects, as a save would write them; null while busy. */
  getSettledDesignObjects(): CanvasDesignObjects | null
  getLocalizedCommonNames(): ReadonlyMap<string, string | null>
  /**
   * The catalog entries loaded for the Design's species (stratum, width): a plant without its own colour takes its
   * stratum's from here, as the canvas draws it. A load advances `revision.plantNames`.
   */
  getSpeciesCache(): ReadonlyMap<string, SpeciesCacheEntry>
  /**
   * English catalog names for the Design's species with no name in the UI
   * language (empty in English). Lists show them marked as English.
   */
  getEnglishFallbackNames(): ReadonlyMap<string, string>
  /**
   * Forwards ToolHost.subscribePointerWorld (§1.1a): the pointer's world and screen points over the map, null when it leaves.
   * The inspection lens reads it instead of its own map-host pointermove. Before the interaction session exists it hears nothing.
   */
  subscribePointerWorld(listener: (point: PointerWorld | null) => void): () => void
}

export interface CanvasDocumentReplacementReceipt {
  readonly callerFinalizerInvoked: boolean
}

export class CanvasDocumentReplacementNotAdmittedError extends Error {
  constructor(readonly reason: unknown) {
    super(
      reason instanceof Error
        ? reason.message
        : 'Canvas rejected document replacement before hydration',
    )
    this.name = 'CanvasDocumentReplacementNotAdmittedError'
  }
}

export type CanvasPersistenceAcknowledgement = 'applied' | 'stale'

export interface CanvasPersistenceCapture {
  readonly content: CanopiFile
  isCurrent(): boolean
  acknowledgeSaved(): CanvasPersistenceAcknowledgement
}

export class CanvasAuthorityBusyError extends Error {
  constructor(
    readonly activeType: string,
    message = `Canvas authority ${activeType} is busy`,
  ) {
    super(message)
    this.name = 'CanvasAuthorityBusyError'
  }
}

const canvasDocumentReplacementTokenBrand = Symbol('canvas-document-replacement-token')

export interface CanvasDocumentReplacementToken {
  readonly [canvasDocumentReplacementTokenBrand]: true
}

export function createCanvasDocumentReplacementToken(): CanvasDocumentReplacementToken {
  return Object.freeze({
    [canvasDocumentReplacementTokenBrand]: true as const,
  })
}

export interface CanvasDocumentSurface {
  /**
   * False from a load or replace until that Design's first scene is drawn (or nothing will draw it): the Design's chrome and
   * the start screen wait for it, so the chrome never shows over an empty map. Camera moves and edits never turn it false.
   */
  readonly presented: ReadonlySignal<boolean>
  attachInspectionTo(element: HTMLElement): CanvasInspectionHandle
  showCanvasChrome(): void
  hideCanvasChrome(): void
  zoomToFit(): void
  loadDocument(file: CanopiFile): void
  replaceDocument(
    file: CanopiFile,
    token: CanvasDocumentReplacementToken,
    finalizeReplacement: () => void,
  ): CanvasDocumentReplacementReceipt
  hasLoadedDocument(): boolean
  captureForPersistence(
    metadata: CanvasRuntimeDocumentMetadata,
    doc: CanopiFile,
  ): CanvasPersistenceCapture
  resize(width: number, height: number): void
  destroy(): void
}

export type CanvasEscapeLayer = 'gesture' | 'nudge-series' | 'tool-transient' | 'tool' | 'selection'

export interface CanvasKeyboardPort {
  escapeLayers(): readonly CanvasEscapeLayer[]            // live canvas layers now, by Esc priority (spec §3.7)
  /** Runs a live layer; app/keyboard/escape-chain.ts decides which, from the focus. */
  escape(layer: CanvasEscapeLayer): void
  /** False when nothing consumed it. confirm, remove-last, delete-handle, rotate-held, edit-text and context-menu return false
   *  in overview; edit-text only under Select, and confirm under Select edits the one selected note (Enter). */
  command(c: CanvasKeyCommand): boolean
  /** The key router's first call for every keydown (capture) and keyup: the nudge commit on any key but an arrow, a
   *  modifier or Esc, and the Space hold (code Space, not text, and a live pointer
   *  session or not a control). The verdict tells the router what to do; the port never touches the event. */
  keyState(k: CanvasKeyState): CanvasKeyVerdict
  /** A key that deletes the selection (Delete, Backspace's fallback, Ctrl+X) runs nothing while this holds (U33,
   *  canopi-f47t.21): a live pointer session, or a tool transient (a draft, a Plant a row source, Place plants' waiting
   *  point, a held stamp pick; the re-origin hold's, an open note entry included). */
  holdsSelectionDeletes(): boolean
  readonly host: HTMLElement
}
export interface CanvasKeyState {
  readonly type: 'keydown' | 'keyup'
  readonly key: string             // arrows, modifiers and Escape keep a nudge series
  readonly code: string            // 'Space'
  readonly mods: Modifiers
  readonly text: boolean           // the target is a text field
  readonly onCanvas: boolean       // focus is the map host (not a control in it) or nothing (app/keyboard/target-class.ts)
}
/** held: the router prevents and Space is held for panning, nothing else runs; pass-live and pass: the router goes on, with a
 *  pointer session live or not. */
export type CanvasKeyVerdict = 'held' | 'pass-live' | 'pass'

/** The router reaches the live session's port here: keyboard-port.ts implements it, and workspace-runtime-composition.ts
 *  exposes a forwarding port that reaches the session's once it exists (spec §1.2a, §1.6). */
export interface CanvasRuntimeSurfaces {
  readonly commands: CanvasCommandSurface
  readonly queries: CanvasQuerySurface
  readonly documents: CanvasDocumentSurface
  readonly keyboard: CanvasKeyboardPort          // canvas/session.ts exports currentCanvasKeyboardPort
}

export type CanvasKeyCommand =
  | { kind: 'confirm' } | { kind: 'remove-last' } | { kind: 'edit-text' } | { kind: 'delete-handle' }
  | { kind: 'rotate-held'; stepDeg: 15 | -15 }
  | { kind: 'arrow'; dir: 'up' | 'down' | 'left' | 'right'; large: boolean }   // keyboard-port.ts: ToolHost.nudge; 'handled' and 'refused' take it, on 'pass' panByPx with nothing selected
  | { kind: 'rotate-view'; direction: 1 | -1 } | { kind: 'reset-north' }
  | { kind: 'zoom-step'; direction: 1 | -1 }                                    // plain + / − with map focus
  | { kind: 'context-menu' }                                                    // Menu key, Shift+F10
