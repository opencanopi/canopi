// canvas/runtime/interaction-ports.ts  (types; implementations in input/ and tools/)

import type { ReadonlySignal } from '@preact/signals'
import type { CanvasToolGuidance } from '../session-state'
import type { CanvasContextMenuPointAction, CanvasFocusPort } from './app-adapter'
import type { Gesture, MenuSource } from './input/gestures'
import type { InputPlatform } from './input/platform'
import type { AdapterEffect, RawInput, TargetClass } from './input/raw-input'
import type { OverviewDropPayload, PointerKind, ToolHandleId, ToolId } from './interaction-types'
import type { PlantPresentationContext } from './plant-presentation'
import type { SpeciesCacheEntry } from './presentation-data'
import type { SceneRenderTarget } from './renderers/scene-types'
import type { CanvasDesignObjectSelectionModel, CanvasSceneEditCommandSurface } from './runtime'
import type { SceneDesignObjectSelection, SceneDesignObjectTarget } from './scene/design-object-targets'
import type { SceneStateReader } from './scene/store'
import type { SceneCommandAdmission, SceneEditCoordinator, SettledSceneReader } from './scene-runtime/transactions'
import type { ToolHandle } from './tools/draft'
import type {
  SceneLayerKind,
  TextEntryRequest,
  ToolCommand,
  ToolContext,
  ToolReply,
  ToolScene,
  ToolSettingsPort,
  ToolSource,
} from './tools/tool'
import type { ViewNavigation } from './view/navigation'
import type { ScreenPoint, ViewFrameSource, WorldPoint } from './view/types'

/** What a route answers for the event being handled; the source applies it. Every field optional; {} changes nothing. */
export interface GestureOutcome {
  /** preventDefault and stopImmediatePropagation (an unsettled scene, a refused drop). */
  readonly quarantine?: boolean
  /** dragover and drop: dataTransfer.dropEffect. */
  readonly dropEffect?: 'copy' | 'move' | 'none'
  /** A refused press: its capture is not taken and its recogniser session ends without a gesture (later moves are hovers). */
  readonly rejectSession?: boolean
  /** A tap that left overview (the Design pin's fit): the rest of its click series reaches no tool (canopi-n2cg). */
  readonly consumeClickSeries?: boolean
}

export interface DomInputSourceDeps {
  readonly host: HTMLElement                                    // the map host; listeners attach here and on window (0B: from attach; from F only during an owned session)
  readonly platform: InputPlatform
  /** `set` waits `delayMs`: the source measures a deadline from the last input's time, base-free (A1). */
  readonly timers: { set(delayMs: number, cb: () => void): number; clear(id: number): void }
}
export interface DomInputSource {
  /** Installs the listeners; returns the disposer that removes every listener it added (tested: exactly once each) and
   *  releases every pointer capture the source still holds (a press live at disposal), after the sink is gone. A sink
   *  that throws on a press on the map host quarantines that event, then rethrows; on any other event it rethrows and the
   *  event goes on, so a failing hover never stops every pointermove in the app. */
  attach(sink: (input: RawInput) => void): () => void
  /** Applies effects to the event being handled: the recogniser's, and a GestureOutcome's as 'prevent-default',
   *  'stop-propagation' and 'drop-effect'. */
  apply(effects: readonly AdapterEffect[]): void
}

/**
 * An adapter over the menu controller (`createCanvasContextMenu`, interaction/canvas-context-menu.ts), which builds the
 * app's CanvasContextMenuRequest (canvas/runtime/app-adapter.ts: anchor, world, retargeted selection, commands,
 * placePlantsAt, saveSelectionAsObjectStamp, returnFocus) and hands it to CanvasRuntimeAppAdapter.contextMenu.
 * The host fills the optional entries from its hit and tool state, and the controller carries them onto the request
 * (CanvasContextMenuRequest.finishShape, .turnViewToEdge, .holdsSelectionDeletes, .pointActions); there is no
 * highlightEdge (U4).
 */
/** What a pointer menu acts on: the click's pick at its point (tool-host.ts contextMenuTargetAt). `target`: the object
 *  whose menu opens, a locked object included; with none, a `visible` object on a locked layer gets the disabled menu,
 *  and none the empty map's. */
export interface ContextMenuPick {
  readonly visible: SceneDesignObjectTarget | null
  readonly target: SceneDesignObjectTarget | null
}
export interface ContextMenuPort {
  open(request: {
    readonly at: WorldPoint | 'selection'
    readonly screen: ScreenPoint | null
    readonly pick?: ContextMenuPick                             // a pointer menu's pick, made once by the host; absent: nothing picked
    readonly finishShape?: () => void                           // the armed tool can finish its draft (CanvasTool.canFinish)
    readonly turnViewToEdge?: () => void                        // a zone-edge hit within the source's tolerance (§4.16)
    readonly holdsSelectionDeletes?: true                       // the host's re-origin hold at the open: Cut and Delete disabled (U39)
    readonly pointActions?: readonly CanvasContextMenuPointAction[]   // the point menu (A16): these entries only, after Finish shape
  }): void
  /** `restoreFocus`: focus held outside the map (in the menu) goes back to the menu's opener or the map, as the menu's
   *  Esc gives it back; the host closes a stale point menu so. */
  close(options?: { readonly restoreFocus?: boolean }): void
  readonly isOpen: () => boolean
}
export interface InputRouterDeps {
  readonly navigation: Pick<ViewNavigation, 'panByPx' | 'zoomAroundPx' | 'beginRotation'>
  readonly toolHost: ToolHost
}
export interface InputRouter {
  /** Routes one gesture: navigation → ViewNavigation, menu-request → ToolHost.menuAt (the host is the only menu opener), editing and drops → ToolHost.
   *  A pan from a pointer source (middle, Space, the Pan tool's and overview drags; not a wheel) also hands its `at` to
   *  ToolHost.notePointer, so the host's resting pointer moves with the pointer. Computes no geometry. */
  route(g: Gesture): GestureOutcome
}

/** Built by interaction-session.ts; everything the host needs, so tools stay narrow. */
export interface ToolHostDeps {
  readonly frames: ViewFrameSource                              // ToolView, re-emit on onViewFrame('tools'), plane changes
  readonly scene: ToolScene                                     // from createToolScene below
  readonly edits: SceneEditCoordinator
  readonly admission: SceneCommandAdmission                     // presses, menus, drops and commands run when settled (an unsettled one is quarantined)
  readonly settled: SettledSceneReader                          // dragover reads
  /** History-free, dirty-free selection (the runtime's setSelection and clearSelection); backs ToolEffects.setSelection and the menu retarget. */
  readonly setSelection: (targets: readonly SceneDesignObjectTarget[]) => void
  readonly renderer: Pick<SceneRenderTarget, 'setDraft'>
  /** Redraw request after a tool call that mutated an open transaction or changed its draft or handles. */
  readonly invalidate: () => void
  readonly chrome: {
    setHandles(h: readonly ToolHandle[], active: ToolHandleId | null): void; setCursor(c: string): void
    requestTextEntry(r: TextEntryRequest, submit: (text: string) => 'close' | 'keep', onCancel?: () => void): void; closeTextEntry(): void
    /** Discards the open entry and tells its opener (onCancel), as the entry's own Esc does: entering overview with a
     *  commit refused, so the tool resets. */
    cancelTextEntry(): void
    /** Submits an open entry that no longer holds focus (its blur commit was refused), which the map taking focus cannot
     *  blur again; an entry that holds focus is left to that blur. A press or a menu calls it before focusing the map. */
    submitUnfocusedTextEntry(): void
    /** Whether the note's text entry is open, read live wherever the host needs the entry's state (handles hidden while it is open, the
     *  submit before the next press focuses the map); the host keeps no flag of its own. Esc in the entry stays the entry's
     *  own element handler. */
    isTextEntryOpen(): boolean
    setTooltip(t: { readonly target: SceneDesignObjectTarget; readonly at: ScreenPoint } | null): void   // chrome/hover-tooltip.ts
    /** The handle that holds keyboard focus (HandleLayer.focusedHandle), read when Delete reaches the tool. */
    focusedHandle(): ToolHandleId | null
  }
  readonly menu: ContextMenuPort                                // opened only by the host (menuAt)
  readonly focus: CanvasFocusPort                               // ToolEffects.requestFocus
  readonly guidance: (g: Partial<CanvasToolGuidance> | null) => void
  readonly toolState: { readonly active: ReadonlySignal<ToolId>; set(id: ToolId): void }   // the session's tool signal
  readonly settings: ToolSettingsPort
  /** Snap to grid, read at each point (interaction-session.ts wires the runtime settings adapter's readSnapToGridEnabled);
   *  the shape tools/snapping.ts takes. */
  readonly snapping: () => { readonly grid: boolean }
  readonly translate: ToolContext['translate']
  /** "Turn view to this edge" (§4.16): the menu entry's action on a zone-edge hit. */
  readonly navigation: Pick<ViewNavigation, 'turnToEdge'>
  /** The runtime's scene-edit nudge commands; the host owns the series (nudge below). */
  readonly nudge: Pick<CanvasSceneEditCommandSurface, 'nudgeSelected' | 'endNudge'>
  readonly timers: { set(atMs: number, cb: () => void): number; clear(id: number): void; readonly clock: () => number }
  /** The pointer kind before any hover, press or tap (ToolContext.pointer): 'touch' on iOS and Android, so a selection
   *  made off the map before the first touch gets a finger's handles (interaction-session.ts, from InputPlatform.os). */
  readonly initialPointer: PointerKind
  /** Hover restyle (a directly locked object shows the locked hover stroke): the runtime's hovered target. */
  readonly hover: (target: SceneDesignObjectTarget | null) => void
  /** Pins a Site data point (canopi-f47t.42, U49 Q17; spec §1.10, §3.8, fixture J10): called after a resolved Select tap
   *  that hit nothing and moved nothing, or any Pan-tool tap; never in overview, never by another tool. It claims nothing:
   *  the tap still reaches the tool (Select clears the selection). Absent on Web and while the Site data panel is closed
   *  (CanvasRuntimeAppAdapter.pinAt, passed by scene-runtime.ts). */
  readonly pin?: (world: WorldPoint) => void
  /** The Site data profile (canopi-f47t.42, spec §1.10): ToolEffects.finishProfile's line, 2 or more points. Absent on Web
   *  (CanvasRuntimeAppAdapter.finishProfile, passed by scene-runtime.ts). */
  readonly finishProfile?: (points: readonly WorldPoint[]) => void
  /** ToolEffects.refuseLockedMove: a drag refused by a lock, which the session reports for the lock toast (2.1-Q177). */
  readonly lockedMoveRefused: () => void
  /**
   * Takes an admitted press's pointer capture (the recogniser's, which the session holds back until the host admits the
   * press), before handles and the tool; a refused press takes none.
   * False when the capture was lost while it was taken (a synchronous lostpointercapture ended the press): the host stops
   * the press before the tool hears it.
   */
  readonly capturePress: (pointerId: number) => boolean
  /** Bumps the runtime's transientHistory revision (Edit › Undo during a draft). */
  readonly transientHistoryChanged: () => void
  /**
   * A drop the host placed, once its Scene Edit committed, Select is armed and the map has focus: the session clears the
   * saved stamp's drag source after a saved-stamp drop (clearSavedObjectStampDragSource; the panel's dragend clears it
   * too) and focuses the map again on the next animation frame, after the browser's drag end.
   */
  readonly dropped: (kind: 'species' | 'saved-stamp') => void
  /**
   * A plant or saved stamp dropped in overview, which places nothing: the session fits the Design, keeps the plant or
   * stamp picked and arms its stamp tool (canopi-n2cg).
   */
  readonly overviewDrop: (payload: OverviewDropPayload) => void
  /**
   * The overview's Design pin (canopi-n2cg), which is transparent to the pointer: the map's own tap and hover find it.
   * `contains`: a screen point on its box (ViewNavigation.onDesignPin). `hovered`: a mouse or pen rests on it, so it shows
   * its tooltip (the host sets the pointer cursor). `tapped`: a tap on it, which fits the Design as Return to Design does
   * and gives the map focus.
   */
  readonly designPin: {
    contains(at: ScreenPoint): boolean
    hovered(hovered: boolean): void
    tapped(): void
  }
}

/** What createToolScene reads (tools/tool-host.ts re-exports the factory). Hit tests need the scale and the plant presentation
 *  for screen-sized plants and notes; the hovered note comes from store.session.hoveredTarget. The selection model is memoised
 *  by reference (scene-runtime/selection.ts). */
export interface ToolSceneSource {
  readonly store: SceneStateReader                              // the runtime's scene store
  readonly selection: () => SceneDesignObjectSelection
  readonly isLayerOpenForCreation: (layer: SceneLayerKind) => boolean
  readonly pixelsPerMetre: () => number                         // frame.view.pixelsPerMetre: exact at bearing 0 (metresPerPixelAt is not)
  readonly speciesCache: () => ReadonlyMap<string, SpeciesCacheEntry>
  readonly plantContext: (pixelsPerMetre: number) => PlantPresentationContext   // incl. localised common names
  readonly selectionModel: () => CanvasDesignObjectSelectionModel               // querySurface.getDesignObjectSelection
}

export interface ToolHost {
  /** Editing gestures, hovers and drops (drops go to the host's shared drop handler, whatever tool is armed); converts to world at event time. */
  gesture(g: Gesture): GestureOutcome
  command(c: ToolCommand): ToolReply
  /** Hits, retargets and opens the canvas menu through ToolHostDeps.menu; quarantines a menu the scene does not admit.
   *  `handle`: the handle the menu's press landed on (the keyboard menu reads the focused one); when the armed tool answers
   *  CanvasTool.pointMenu for it, the point menu opens there instead, retargeting nothing (A16). */
  menuAt(at: ScreenPoint | 'selection', source: MenuSource, handle?: ToolHandleId): GestureOutcome
  setTool(id: ToolId, source: ToolSource | null): void
  /** A new source for the armed tool (the session's read-model bridge): forwards to CanvasTool.sourceChanged. */
  sourceChanged(source: ToolSource | null): void
  /**
   * Presses the host never sees as gestures: the session calls it for every raw pointerdown on the map host before routing it
   * (from the source's raw input, not a gesture; the down's role, 'auxiliary' as 'middle'). Commits the nudge series for any
   * button. For an admitted primary or middle press outside the text entry ('owned-text'), with no live press from
   * another pointer id, it also closes the canvas menu and focuses the map (so an open text
   * entry commits on its blur).
   */
  rawPress(button: 'primary' | 'secondary' | 'middle', target: TargetClass, pointerId?: number): void
  /**
   * Where the pointer is during a pointer-source pan (the router, from the pan's `at`): updates the host's stored resting
   * pointer and re-emits there at once, as each camera frame does, so a draft or a ghost stays under the pointer whatever
   * the order of the pan's frame and this call. Wheel and key pans leave the resting pointer where it is.
   */
  notePointer(screen: ScreenPoint): void
  /** Scene or selection changed outside a tool call (select all, undo, menu commands, nudges): refresh handles and decorations. */
  sceneChanged(): void
  /** True while a note's text entry is open. The keyboard port's Space reads it: an open entry, focused or not, arms no
   *  pan: the field keeps its shared keys while it is open. */
  textEntryOpen(): boolean
  /** The re-origin hold (§4.19): a live press, the active tool's transient or an open text entry. */
  holdsReorigin(): boolean
  // Esc chain queries (CanvasKeyboardPort reads these)
  hasLiveGesture(): boolean
  /** The active tool holds a transient its Esc drops first (none whose tool `escapeLeaves`: Place plants' waiting point). */
  activeToolHasEscapeTransient(): boolean
  activeToolIsSelect(): boolean
  /**
   * Arrow nudge, the one owner of the series: with a selection, the Select tool and site mode, turns the screen direction
   * into a world delta along screenAxesInWorld() (0.1 m, or 1 m when large), calls deps.nudge.nudgeSelected and (re)starts
   * the 800 ms idle timer that commits the series ('handled'). 'refused': the runtime refused the nudge, and the key is
   * swallowed. 'pass': Select is not armed, the map is in overview or nothing is selected; the key goes on to the
   * keyboard port's arrow rule (§3.6: with nothing selected it pans; otherwise the key is not consumed).
   */
  nudge(direction: ScreenPoint, large: boolean): 'handled' | 'refused' | 'pass'
  hasNudgeSeries(): boolean                                     // the Esc layer 65
  endNudgeSeries(commit: boolean): void                         // Esc aborts; idle, focusout, a press or another key commit
  /**
   * A pointer release that ended no press of the tool's, which the session reports after routing it: the end or cancel
   * (pointercancel, lost capture, Esc) of a pointer pan (middle, Space, overview or the Pan tool's), or an up with no
   * press of the map's (a right-click release, a release off the map, after a press the scene refused or whose capture was lost); not
   * one while another pointer's press is live, in overview, or over the note editor or a handle. The host's own tap and
   * drag-end of a press the tool never heard do the same. Each one ends the transient interaction: the series commits, the
   * drop preview and the passive hover clear, the active tool's cancelTransient('navigate') runs (a tool that keeps its draft through a
   * pan keeps it here too) and the cursor returns to the tool's. A press of the tool's still live is left to its own
   * release.
   */
  released(): void
  /**
   * Ends an interrupted interaction; the session calls it on window blur after feeding the recogniser (which releases
   * Space and ends the live sessions): commits the nudge series, clears the passive hover and the tooltip, calls the active
   * tool's cancelTransient('navigate') (a tool that keeps its draft through a pan keeps it
   * here too) and resets the cursor to the tool's. A failure aborts whatever Scene Edit was still open.
   */
  interrupted(): void
  /** Transient history (Edit › Undo and Redo during a draft): sends the active tool the 'undo-transient' and 'redo-transient' commands and
   *  reads its canUndoTransient?/canRedoTransient?. deps.transientHistoryChanged runs after every call into the tool and after a
   *  deferred onCommitted. */
  readonly transientHistory: {
    canUndo(): boolean; canRedo(): boolean; undo(): boolean; redo(): boolean
  }
  prepareForDocumentReplacement(): void                         // deactivate('document-replaced') and drop live sessions
  refreshTranslations(): void                                   // re-publishes guidance and handle labels
  /** Every hover whose target is the map (`surface`), before the overview and hover-suppression filters; null on hover-end:
   *  the pointer left the map, or moved over owned chrome, the text entry or a handle (U6), so the lens drops its point
   *  there. A hover off the map publishes nothing (spec §1.4 "Hover", §2.2 "Hover"). After a camera change the settled
   *  frame republishes a mouse or pen resting on the map, so readouts follow the ground. A hover made with a button held is
   *  published too: the interaction session's subscribePointerWorld drops it (its raw buttonMask), so the lens skips a
   *  move with any button held. For the inspection lens, the status line and, later, hover readouts over analysis results: the screen point lets a readout query the map there without projecting (R1, P2). */
  subscribePointerWorld(listener: (point: PointerWorld | null) => void): () => void
  dispose(): void
}

/** The pointer over the map: its Scene point, its map-host screen point and its kind. Site data values ignore a touch
 *  publish for hover and read a finger through the pin (canopi-f47t.42). */
export interface PointerWorld { readonly world: WorldPoint; readonly screen: ScreenPoint; readonly pointerKind: PointerKind }
