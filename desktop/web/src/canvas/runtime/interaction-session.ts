// canvas/runtime/interaction-session.ts
//
// Owns the canvas's interaction session (spec §1.2–1.4, ADRs 0017 and 0018): it composes DomInputSource → normalise →
// recognise → InputRouter → ToolHost, with the keyboard port the key router reaches (spec §1.6), and prepares the map
// host as a keyboard stop. Every tool and every drop runs on the host (spec §1.4, "Drops"). The session hears the view's mode on
// its own 'tools' frame listener, which a throwing host listener cannot skip, nor it the host's (frame-source.ts): entering or
// leaving overview reconfigures the recogniser (entering it releases Space there), and entering it closes the menu.
// refreshMeasurements reaches ToolHost.sceneChanged(). It builds the host's chrome (chrome/: the handle layer,
// the text entry and the plant tooltip), bridges the plant and saved-stamp
// read models to the armed tool, reads the snapping settings per point, calls ToolHost.rawPress for every raw press on
// the map host, ToolHost.released() after a release that ended no press of the tool's and ToolHost.interrupted() after a
// window blur, follows a placed drop (the saved stamp's drag source, the map's focus on the next frame), owns the
// navigation cursor, and passes on no draft or handles while a story is presented.

import { effect, signal } from '@preact/signals'
import { readPlantStampSource, clearPlantStampSource, selectPlantStampSource } from '../plant-stamp-source'
import {
  clearSavedObjectStampDragSource,
  clearSavedObjectStampSource,
  readSavedObjectStampDragName,
  readSavedObjectStampSource,
  selectSavedObjectStampSource,
} from '../saved-object-stamp-source'
import {
  currentCanvasTool,
  IDLE_CANVAS_TOOL_GUIDANCE,
  noteCanvasLockedMoveRefused,
  type CanvasToolGuidance,
} from '../session-state'
import type {
  CanvasContextMenuCommands,
  CanvasFocusPort,
  CanvasRuntimeContextMenuAdapter,
  CanvasRuntimeTranslator,
  CanvasScrollWheelSetting,
} from './app-adapter'
import { createHandleLayer, type HandleLayer } from './chrome/handle-layer'
import { createHoverTooltip, type HoverTooltipController } from './chrome/hover-tooltip'
import { createTextEntryHost, type TextEntryHost } from './chrome/text-entry-host'
import { runCanvasRuntimeCleanups, throwCanvasRuntimeCleanupErrors } from './cleanup'
import { createDomInputSource, outcomeEffects } from './input/dom-input-source'
import type { Gesture } from './input/gestures'
import { createInputRouter } from './input/input-router'
import { detectPlatform, modKeyIsCmd, type InputPlatform } from './input/platform'
import type { AdapterEffect, RawInput, RecogniserConfig, RecogniserState, TargetClass } from './input/raw-input'
import { initialRecogniserState, recognise } from './input/recognise'
import { DEFAULT_THRESHOLDS } from './input/thresholds'
import type { GestureOutcome, PointerWorld, ToolHost, ToolHostDeps } from './interaction-ports'
import type { Modifiers, OverviewDropPayload, ToolId } from './interaction-types'
import { createCanvasKeyboardPort } from './keyboard-port'
import type { PlantPresentationContext } from './plant-presentation'
import type { SceneRenderTarget } from './renderers/scene-types'
import type {
  CanvasDesignObjectSelectionModel,
  CanvasKeyboardPort,
  CanvasPlantRowPathCommands,
  CanvasPlantRowSpacingField,
  CanvasSceneEditCommandSurface,
} from './runtime'
import { isSceneLayerEditable, type SceneDesignObjectSelection, type SceneDesignObjectTarget, type ScenePoint, type SceneStateReader } from './scene'
import type { SceneCommandAdmission, SceneEditCoordinator, SettledSceneReader } from './scene-runtime/transactions'
import type { SpeciesCacheEntry } from './species-cache'
import { createContextMenuPort, createToolHost, createToolScene } from './tools/tool-host'
import type { ViewNavigation } from './view/navigation'
import type { ViewFrame, ViewFrameSource } from './view/types'

/** Attributes the session sets on the map host and restores when it ends. */
const HOST_ATTRIBUTES = ['tabindex', 'role', 'aria-label', 'aria-describedby'] as const
const STORY_PRESENTING_ATTRIBUTE = 'data-story-presenting'
const NO_DROP: readonly AdapterEffect[] = Object.freeze([{ kind: 'drop-effect', dropEffect: 'none' }])
/** An actual drop (not a dragover or dragleave) prevents the browser's own drop (recognise.ts), unconditionally; a
 *  throwing route must not skip it, or the browser's default drop runs (today's pre-0B _onDrop prevented it before
 *  routing). A dragover's prevent-default stays tied to its outcome (REFUSED_DRAGOVER leaves it unprevented). */
const PREVENT_DEFAULT: readonly AdapterEffect[] = Object.freeze([{ kind: 'prevent-default' }])
/** The host's types, read through it (P5b: this module imports nothing else from tools/). */
type DraftPresentation = Parameters<ToolHostDeps['renderer']['setDraft']>[0]
type ToolSource = Parameters<ToolHost['setTool']>[1]
type HandleList = Parameters<ToolHostDeps['chrome']['setHandles']>[0]
type HandleId = Parameters<ToolHostDeps['chrome']['setHandles']>[1]
type PassiveHoverAt = NonNullable<Parameters<ToolHostDeps['chrome']['setTooltip']>[0]>

const NO_HANDLES: HandleList = Object.freeze([])

let descriptionSequence = 0

/** The session's dependencies: today's, which the host and the chrome run on, then the pipeline's own. */
export interface SceneInteractionSessionDeps {
  container: HTMLElement
  getSceneStore: () => SceneStateReader
  getSpeciesCache: () => ReadonlyMap<string, SpeciesCacheEntry>
  getPlantPresentationContext: (viewportScale: number) => PlantPresentationContext
  getSelection: () => SceneDesignObjectSelection
  setSelection: (targets: Iterable<SceneDesignObjectTarget>) => void
  clearSelection: () => void
  sceneEdits: SceneEditCoordinator
  commandAdmission: SceneCommandAdmission
  settledReader: SettledSceneReader
  /** The Site data pin (CanvasRuntimeAppAdapter.pinAt): ToolHostDeps.pin, called after a tap no tool uses. */
  pinAt?: (world: ScenePoint) => void
  /** The Site data profile (CanvasRuntimeAppAdapter.finishProfile): ToolHostDeps.finishProfile, Profile's finished line. */
  finishProfile?: (points: readonly ScenePoint[]) => void
  getDesignObjectSelection: () => CanvasDesignObjectSelectionModel
  selectionCommands: CanvasContextMenuCommands
  contextualCommands?: {
    readonly saveSelectionAsObjectStamp?: () => void
  }
  /** Renders the right-click menu; absent in a detached runtime. */
  contextMenu?: CanvasRuntimeContextMenuAdapter
  setTool: (id: ToolId) => void
  /** A scene render; a camera frame repaints on its own (the runtime's onCameraFrame). */
  render: () => void
  readSnapToGridEnabled: () => boolean
  /** Settings › Canvas › Pointing device (stored scrollWheel: 'zoom' is Mouse, 'pan' is Trackpad). Pinch and Ctrl wheel zoom either way. */
  readScrollWheel: () => CanvasScrollWheelSetting
  readPlantSpacingIntervalMeters: () => number
  commitPlantSpacingIntervalMeters: (meters: number) => void
  translate: CanvasRuntimeTranslator
  setHoveredTarget: (target: SceneDesignObjectTarget | null) => void
  getLocalizedCommonNames: () => ReadonlyMap<string, string | null>
  notifyTransientHistoryChange: () => void
  /** Mirrors the active tool's gesture and stamp state for the tool card. */
  publishToolGuidance: (guidance: CanvasToolGuidance) => void
  /** Mirrors whether a mouse or pen rests on the overview's Design pin, which then shows its tooltip (canopi-n2cg). */
  publishDesignPinHover: (hovered: boolean) => void
  /** The arrow keys' nudges, through the runtime's scene-edit commands. */
  nudge: Pick<CanvasSceneEditCommandSurface, 'nudgeSelected' | 'endNudge'>
  /** The view's frames (scene-runtime/construction.ts). */
  readonly frames: ViewFrameSource
  /** The view's navigation: pans, zooms, turns and north. */
  readonly viewNavigation: ViewNavigation
  /** The mounted renderer's draft sink (scene-runtime.ts, over the render scheduler). */
  readonly renderer: Pick<SceneRenderTarget, 'setDraft'>
  /** The app's focus port (CanvasRuntimeAppAdapter.focus); absent, the session focuses the map host itself, as today. */
  readonly focus?: CanvasFocusPort
  /** Injected for tests; otherwise the session detects it from the browser, as the editions' key routers detect theirs. */
  readonly platform?: InputPlatform
}

export interface SceneInteractionSession {
  /** The tool the session has armed now (after a failed switch: the one it kept or fell back to). */
  readonly tool: ToolId

  setTool(id: ToolId): void
  /** Plant a row's spacing field in the tool card; does nothing under another tool. */
  readonly plantRowSpacing: CanvasPlantRowSpacingField
  /** Plant a row's check button and mode switch in the tool card; nothing under another tool. */
  readonly plantRowPath: CanvasPlantRowPathCommands
  prepareForDocumentReplacement(): void
  refreshMeasurements(): void
  refreshTranslations(): void
  canUndoTransientHistory(): boolean
  canRedoTransientHistory(): boolean
  undoTransientHistory(): boolean
  redoTransientHistory(): boolean
  /** The canvas's key handling (spec §1.2a, §1.6), which the key router reaches through the runtime surfaces. */
  readonly keyboard: CanvasKeyboardPort
  /** ToolHost.subscribePointerWorld: the pointer's world and screen points over the map, null when it leaves (the inspection
   *  lens). The session drops the point of a move made with any button held (its raw buttonMask), as today's lens skipped it. */
  subscribePointerWorld(listener: (point: PointerWorld | null) => void): () => void
  /** ToolHost.holdsReorigin: re-origin waits while a press, a tool transient or the text entry is open (spec §4.19). */
  holdsReorigin(): boolean
  dispose(): void
}

export function createSceneInteractionSession(deps: SceneInteractionSessionDeps): SceneInteractionSession {
  return new DefaultSceneInteractionSession(deps)
}

class DefaultSceneInteractionSession implements SceneInteractionSession {
  readonly keyboard: CanvasKeyboardPort
  readonly plantRowSpacing: CanvasPlantRowSpacingField = {
    input: (text) => this._spacing(() => {
      this._toolHost.command({ kind: 'spacing-input', text })
    }),
    commit: (text) => this._spacing(() => {
      this._toolHost.command({ kind: 'spacing-input', text })
      this._toolHost.command({ kind: 'spacing-commit', via: 'enter' })
    }),
    blur: (text) => this._spacing(() => {
      this._toolHost.command({ kind: 'spacing-input', text })
      this._toolHost.command({ kind: 'spacing-commit', via: 'blur' })
    }),
    cancel: () => this._spacing(() => {
      this._toolHost.command({ kind: 'spacing-cancel' })
    }),
  }
  readonly plantRowPath: CanvasPlantRowPathCommands = {
    finish: () => this._spacing(() => {
      this._toolHost.command({ kind: 'confirm' })
    }),
    setMode: (mode) => this._spacing(() => {
      this._toolHost.command({ kind: 'spacing-mode', mode })
    }),
  }

  private readonly _config: RecogniserConfig
  private readonly _tool = signal<ToolId>(currentCanvasTool.peek())
  private readonly _frames: ViewFrameSource
  /** The view's mode as the session last heard it on a 'tools' frame: what the recogniser is configured with. */
  private _mode: ViewFrame['mode']
  private readonly _stopHearingMode: () => void
  private readonly _hostKeys: InteractionHostController
  private readonly _focus: CanvasFocusPort
  private readonly _handleLayer: HandleLayer
  private readonly _textEntry: TextEntryHost
  private readonly _tooltip: HoverTooltipController
  private readonly _toolHost: ToolHost
  private readonly _menu: ReturnType<typeof createContextMenuPort>
  private readonly _port: ReturnType<typeof createCanvasKeyboardPort>
  private readonly _router: ReturnType<typeof createInputRouter>
  private readonly _source: ReturnType<typeof createDomInputSource>
  private readonly _renderer: Pick<SceneRenderTarget, 'setDraft'>
  private readonly _detachSource: () => void
  private readonly _stopWatchingSources: () => void
  private readonly _storyObserver: MutationObserver | null
  private _recogniser: RecogniserState = initialRecogniserState()
  private _pointingDevice: 'mouse' | 'trackpad'
  private _panning = false
  private _navigationCursor: 'grab' | 'grabbing' | null = null
  private _toolCursor: string | null = null
  private _draft: DraftPresentation | null = null
  private _handles: HandleList = NO_HANDLES
  private _activeHandle: HandleId = null
  private _storyPresented = false
  /** Routing a move made with a button held: its hover reaches the host and the tool, not the lens (today's). */
  private _buttonHeld = false
  /** Routing a finger's input: a text entry it opens takes focus at once (A15). */
  private _fingerInput = false
  /** Inside refreshMeasurements' ToolHost.sceneChanged(): the runtime is already redrawing. */
  private _refreshing = false
  /** The pointer of the press being routed whose capture waits for the host's admission (ToolHostDeps.capturePress). */
  private _pressCapture: number | null = null
  /** The pointer of a press being routed on its own release (a touch tap, held until the lift, A3): its session has
   *  ended, and the press still runs. */
  private _pressAtRelease: number | null = null
  /** The map's focus again on the frame after a drop, once the browser's drag end has run (today's). */
  private _dropFocusFrame: number | null = null
  private _disposed = false

  constructor(private readonly _deps: SceneInteractionSessionDeps) {
    const platform = _deps.platform ?? detectPlatform(navigator, window as unknown as { readonly GestureEvent?: unknown })
    this._config = { platform, thresholds: DEFAULT_THRESHOLDS }
    this._pointingDevice = this._readPointingDevice()
    const navigation = _deps.viewNavigation
    this._frames = _deps.frames
    this._mode = _deps.frames.viewFrame.peek().mode
    this._renderer = _deps.renderer
    this._storyPresented = isStoryPresented()
    const container = _deps.container
    const clock = () => Date.now()
    const timers = {
      set: (atMs: number, callback: () => void): number => window.setTimeout(callback, Math.max(0, atMs - clock())),
      clear: (id: number): void => window.clearTimeout(id),
    }
    const focus: CanvasFocusPort = _deps.focus ?? {
      focusMap: () => container.focus({ preventScroll: true }),
    }
    this._focus = focus

    const rollback: Array<() => void> = []
    const own = <T>(resource: T, dispose: (resource: T) => void): T => {
      rollback.push(() => dispose(resource))
      return resource
    }
    try {
      this._hostKeys = own(prepareInteractionHost(container, _deps.translate, platform), (host) => host.dispose())
      this._handleLayer = own(createHandleLayer({ container, frames: this._frames }), (layer) => layer.dispose())
      this._textEntry = own(createTextEntryHost({
        container,
        frames: this._frames,
        translate: _deps.translate,
        focus,
        openedByTouch: () => this._fingerInput,
      }), (entry) => entry.dispose())
      this._tooltip = own(createHoverTooltip(container), (tooltip) => tooltip.dispose())
      const scene = createToolScene({
        store: liveStoreReader(_deps),
        selection: _deps.getSelection,
        isLayerOpenForCreation: (layer) => isSceneLayerEditable(_deps.getSceneStore().persisted, layer),
        pixelsPerMetre: () => this._frames.viewFrame.peek().view.pixelsPerMetre,
        speciesCache: _deps.getSpeciesCache,
        plantContext: _deps.getPlantPresentationContext,
        selectionModel: _deps.getDesignObjectSelection,
      })
      this._menu = own(createContextMenuPort({
        container,
        view: () => _deps.frames.viewFrame.peek().view,
        adapter: _deps.contextMenu,
        commands: _deps.selectionCommands,
        saveSelectionAsObjectStamp: _deps.contextualCommands?.saveSelectionAsObjectStamp,
        placePlantsAt: (world) => { this._toolHost.command({ kind: 'place-at', world }) },
        returnFocus: () => focus.focusMap(),
        scene,
        selectionModel: _deps.getDesignObjectSelection,
      }), (menu) => menu.close())
      const hostDeps: ToolHostDeps = {
        frames: this._frames,
        scene,
        edits: _deps.sceneEdits,
        admission: _deps.commandAdmission,
        settled: _deps.settledReader,
        setSelection: (targets) => _deps.setSelection(targets),
        renderer: {
          setDraft: (draft) => this._setDraft(draft),
        },
        // The runtime's scene render asks the session to refresh (refreshMeasurements → sceneChanged): a redraw the host
        // requests from inside that refresh is the one already under way.
        invalidate: () => {
          if (!this._refreshing) _deps.render()
        },
        chrome: {
          setHandles: (handles, active) => this._setHandles(handles, active),
          setCursor: (cursor) => {
            this._toolCursor = cursor
            this._applyCursor()
          },
          requestTextEntry: (request, submit, onCancel) => this._textEntry.open(request, submit, onCancel),
          closeTextEntry: () => this._textEntry.close(),
          cancelTextEntry: () => this._textEntry.cancel(),
          submitUnfocusedTextEntry: () => this._textEntry.submitUnfocused(),
          isTextEntryOpen: () => this._textEntry.isOpen(),
          setTooltip: (tooltip) => this._showTooltip(tooltip),
          focusedHandle: () => this._handleLayer.focusedHandle(),
        },
        menu: this._menu,
        focus,
        guidance: (guidance) => _deps.publishToolGuidance(guidance ? { ...IDLE_CANVAS_TOOL_GUIDANCE, ...guidance } : IDLE_CANVAS_TOOL_GUIDANCE),
        toolState: { active: this._tool, set: (id) => this._switchTool(id) },
        settings: {
          plantSpacingIntervalM: _deps.readPlantSpacingIntervalMeters,
          commitPlantSpacingIntervalM: _deps.commitPlantSpacingIntervalMeters,
        },
        snapping: () => ({ grid: _deps.readSnapToGridEnabled() }),
        translate: _deps.translate as ToolHostDeps['translate'],
        navigation: { turnToEdge: (a, b) => navigation.turnToEdge(a, b) },
        nudge: _deps.nudge,
        timers: { ...timers, clock },
        initialPointer: platform.os === 'ios' || platform.os === 'android' ? 'touch' : 'mouse',
        hover: (target) => _deps.setHoveredTarget(target),
        pin: _deps.pinAt,
        finishProfile: _deps.finishProfile,
        lockedMoveRefused: noteCanvasLockedMoveRefused,
        capturePress: (pointerId) => this._capturePress(pointerId),
        transientHistoryChanged: () => _deps.notifyTransientHistoryChange(),
        dropped: (kind) => this._dropped(kind),
        overviewDrop: (payload) => this._overviewDropped(payload),
        designPin: {
          contains: (at) => navigation.onDesignPin(at),
          hovered: (hovered) => _deps.publishDesignPinHover(hovered),
          // As the pin's own button and Return to Design: the Design fits and the map takes focus.
          tapped: () => {
            navigation.returnToDesign()
            focus.focusMap()
          },
        },
      }
      this._stopHearingMode = own(this._frames.onViewFrame('tools', (frame) => this._modeHeard(frame.mode)), (stop) => stop())
      this._toolHost = own(createToolHost(hostDeps), (host) => host.dispose())
      this._router = createInputRouter({ navigation, toolHost: this._toolHost })
      this._port = createCanvasKeyboardPort({
        host: container,
        toolHost: this._toolHost,
        hasSelection: () => _deps.getSelection().length > 0,
        navigation,
        session: {
          pointerSessionLive: () => this._pointerSessionLive(),
          overview: () => this._mode === 'overview',
          handleFocused: () => this._handleLayer.focusedHandle() !== null,
          spaceHeld: () => this._recogniser.held.space,
          keyState: (state) => this._setKeyState(state.space, state.mods),
          escapeGesture: () => this._escapeGesture(),
          requestTool: (id) => this._switchTool(id),
          clearSelection: () => {
            _deps.clearSelection()
            _deps.render()
            this._toolHost.sceneChanged()
          },
        },
      })
      this.keyboard = this._port
      this._source = createDomInputSource({
        host: container,
        platform,
        timers: {
          set: (delayMs, callback) => window.setTimeout(callback, delayMs),
          clear: (id) => window.clearTimeout(id),
        },
      })
      this._stopWatchingSources = own(this._watchToolSources(), (stop) => stop())
      this._storyObserver = own(this._observeStoryPresentation(), (observer) => observer?.disconnect())
      this.setTool(this._tool.peek())
      this._handInitialSource()
      this._detachSource = this._source.attach((input) => this._receive(input))
      rollback.length = 0
    } catch (error) {
      for (const cleanup of rollback.reverse()) {
        try {
          cleanup()
        } catch {
          // Preserve the construction failure after best-effort resource cleanup.
        }
      }
      throw error
    }
  }

  /**
   * Arms a tool on the host. Any failure leaves a fresh Select on the host (spec §1.4 "Faults"), drops the tool left's
   * source and still ends the live presses, as today's setTool had cleared the pointer gesture before the step that failed.
   */
  get tool(): ToolId {
    return this._tool.peek()
  }

  setTool(id: ToolId): void {
    if (this._disposed) return
    const previous = this._tool.peek()
    this._tool.value = id
    this._navigationCursor = null
    try {
      this._toolHost.setTool(id, toolSourceFor(id))
    } catch (error) {
      this._tool.value = 'select'
      this._endPressesAfterFailedSwitch()
      clearToolSource(previous)
      throw error
    }
    // The tool left drops its pick once it is deactivated, as today's tools did (the next tool never hears it).
    if (previous !== id) clearToolSource(previous)
    // The live presses belong to the tool left: they end on the host's path, which releases their capture.
    this._configure()
  }

  prepareForDocumentReplacement(): void {
    if (this._disposed) return
    const tool = this._tool.peek()
    runCanvasRuntimeCleanups([
      () => this._cancelDropFocus(),
      () => this._toolHost.prepareForDocumentReplacement(),
      () => this._escapeGesture(),
      () => clearToolSource(tool),
    ], 'Scene Interaction document replacement preparation failed')
  }

  refreshMeasurements(): void {
    if (this._disposed || this._refreshing) return
    this._refreshing = true
    try {
      this._toolHost.sceneChanged()
    } finally {
      this._refreshing = false
    }
  }

  refreshTranslations(): void {
    if (this._disposed) return
    this._hostKeys.refreshTranslations()
    this._toolHost.refreshTranslations()
  }

  canUndoTransientHistory(): boolean {
    return !this._disposed && this._toolHost.transientHistory.canUndo()
  }

  canRedoTransientHistory(): boolean {
    return !this._disposed && this._toolHost.transientHistory.canRedo()
  }

  undoTransientHistory(): boolean {
    return !this._disposed && this._toolHost.transientHistory.undo()
  }

  redoTransientHistory(): boolean {
    return !this._disposed && this._toolHost.transientHistory.redo()
  }

  holdsReorigin(): boolean {
    return !this._disposed && this._toolHost.holdsReorigin()
  }

  subscribePointerWorld(listener: (point: PointerWorld | null) => void): () => void {
    // The held-button rule is the session's, not the host's: today's lens skipped every move made with a button held (a
    // press off the map, or a right press, dragged across it; a pen's barrel or eraser too).
    return this._toolHost.subscribePointerWorld((point) => {
      if (point && this._buttonHeld) return
      listener(point)
    })
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    const errors: unknown[] = []
    const attempt = (cleanup: () => void): void => {
      try {
        cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    const tool = this._tool.peek()
    attempt(() => this._detachSource())
    attempt(() => this._storyObserver?.disconnect())
    attempt(() => this._stopHearingMode())
    attempt(() => this._stopWatchingSources())
    attempt(() => clearToolSource(tool))
    attempt(() => this._cancelDropFocus())
    attempt(() => this._toolHost.dispose())
    attempt(() => this._tooltip.dispose())
    attempt(() => this._textEntry.dispose())
    attempt(() => this._handleLayer.dispose())
    attempt(() => this._hostKeys.dispose())
    throwCanvasRuntimeCleanupErrors(errors, 'Scene Interaction Session disposal failed')
  }

  // ── Routing ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private _receive(input: RawInput): void {
    if (this._disposed) return
    // Every bit the pointer reports, a pen's eraser that no press takes included, as today's lens read it.
    this._buttonHeld = input.kind === 'move' && input.buttonMask !== 0
    this._fingerInput = (input.kind === 'down' || input.kind === 'move' || input.kind === 'up') && input.pointer === 'touch'
    try {
      this._dispatch(input)
    } finally {
      this._buttonHeld = false
      this._fingerInput = false
    }
  }

  private _dispatch(input: RawInput): void {
    switch (input.kind) {
      case 'drop':
        this._routeDrop(input)
        return
      case 'focus-out':
        this._toolHost.endNudgeSeries(true)
        return
      case 'down':
        this._toolHost.rawPress(input.role === 'auxiliary' ? 'middle' : input.role, input.target, input.id)
        break
      case 'wheel':
        this._syncPointingDevice()
        break
      default:
        break
    }
    if (input.kind !== 'cancel' || input.id !== 'all') {
      this._route(input)
      return
    }
    // The rest of today's blur (Space, the keys, the host's interruption) runs even when the tool's blur fails.
    runCanvasRuntimeCleanups([
      () => this._route(input),
      () => this._interrupted(),
    ], 'Scene Interaction window blur failed')
  }

  /** The input: recognised, routed, and the recogniser's and the host's effects applied to the event. */
  private _route(input: RawInput): void {
    const result = recognise(this._recogniser, input, this._config)
    this._takeRecogniser(result.state)
    const wheel = input.kind === 'wheel'
    if (wheel) {
      // Today's _onWheel prevented a wheel the map takes, and closed the canvas menu, before it moved the camera: a zoom
      // or pan that fails still keeps the page from zooming or scrolling.
      this._source.apply(result.effects)
      if (result.effects.length > 0) this._menu.close()
    }
    // A press the host hears takes its capture once admitted, before the tool (ToolHostDeps.capturePress), as today's
    // order; a pan's press, which the host never hears, takes it with the rest. The effects before the held capture (the
    // release of the same pointer's session whose up was lost) apply first, so they cannot undo the new press's capture.
    const press = result.gestures.find((gesture) => gesture.kind === 'press')
    const pressed = input.kind === 'down' && press?.kind === 'press' && press.id === input.id ? input.id : null
    const heldAt = pressed === null
      ? -1
      : result.effects.findIndex((effect) => effect.kind === 'capture' && effect.pointerId === pressed)
    const heldCapture = heldAt >= 0
    const effects = heldCapture ? result.effects.slice(heldAt + 1) : result.effects
    if (heldCapture) this._source.apply(result.effects.slice(0, heldAt))
    let outcome: GestureOutcome = {}
    this._pressCapture = heldCapture ? pressed : null
    this._pressAtRelease = input.kind === 'up' && press?.kind === 'press' ? press.id : null
    try {
      for (const gesture of result.gestures) {
        this._followNavigation(gesture)
        outcome = mergeOutcomes(outcome, this._router.route(gesture))
      }
    } finally {
      this._pressCapture = null
      this._pressAtRelease = null
    }
    this._source.apply(outcomeEffects(wheel ? [] : effects, outcome))
    // A refused press ends its session, whichever input resolved it (a held touch press resolves on a move or an up).
    if (outcome.rejectSession && press?.kind === 'press') {
      const rejected = recognise(this._recogniser, { kind: 'reject', t: input.t, id: press.id }, this._config)
      this._takeRecogniser(rejected.state)
      this._source.apply(rejected.effects)
    }
    if (outcome.consumeClickSeries) this._takeRecogniser(recognise(this._recogniser, { kind: 'consume-click-series', t: input.t }, this._config).state)
    if (this._releasesOutsideTool(input, result.gestures)) this._toolHost.released()
  }

  /**
   * Whether this input ended no press of the tool's, so today's window pointerup (or a pan's pointercancel or lost
   * capture) would have run the cancellation (ToolHost.released): the up, cancel, Esc or lost release that ends a pointer
   * pan or turn, or an up with no press of the map's at all, a still right-click's that opens the menu included. Today's
   * exceptions hold for the latter: nothing while another pointer's press is live, in overview (a still right-click there
   * opens nothing and cleans nothing), or over the note editor or a handle. The host handles the tap or drag-end of a
   * press the tool never heard itself.
   */
  private _releasesOutsideTool(input: RawInput, gestures: readonly Gesture[]): boolean {
    // A move ends a pointer pan or turn whose release was lost (spec §2.2 "Drag end").
    if (gestures.some(endsPointerNavigation)) {
      return input.kind === 'up' || input.kind === 'move' || (input.kind === 'cancel' && input.id !== 'all')
    }
    // A still right-click's up opens the menu and is still no press of the tool's: a held stamp's ghost hides (A34).
    if (input.kind !== 'up' || gestures.some((gesture) => gesture.kind !== 'menu-request')) return false
    if (this._recogniser.sessions.size > 0 || this._mode === 'overview') return false
    return !isOwnedOverlay(input.target)
  }

  /** Raw input that does not come from an event (configure, key state, Esc), routed as an event's would be. */
  private _feed(input: RawInput): readonly Gesture[] {
    const result = recognise(this._recogniser, input, this._config)
    this._takeRecogniser(result.state)
    for (const gesture of result.gestures) {
      this._followNavigation(gesture)
      this._router.route(gesture)
    }
    this._source.apply(result.effects.filter((effect) => effect.kind === 'release-capture'))
    return result.gestures
  }

  /**
   * A panel drag over the map, routed to the host's drop route. A dragover whose route throws answers 'none' as well as
   * the source's quarantine, as today's rejected dragover did (and, unlike a drop, stays un-prevented: a failed dragover
   * refuses the drop target, as a never-prevented one does). A drop's own prevent-default (recognise.ts, unconditional
   * for an actual drop) must reach the event even when the route throws, or the browser's own drop runs, pasting the
   * payload into whatever has focus (spec §1.4 "Drops"); the single fault rule still rethrows.
   */
  private _routeDrop(input: Extract<RawInput, { kind: 'drop' }>): void {
    try {
      this._route(input)
    } catch (error) {
      if (input.phase === 'over') this._source.apply(NO_DROP)
      else if (input.phase === 'drop') this._source.apply(PREVENT_DEFAULT)
      throw error
    }
  }

  /**
   * After the host placed a drop (ToolHostDeps.dropped): a saved stamp's drag source is spent (the panel's dragend clears
   * it too), and the map takes focus again on the next frame, after the browser's drag end, as today's drop did. A window
   * blur, a document replacement and the session's end drop that focus.
   */
  private _dropped(kind: 'species' | 'saved-stamp'): void {
    if (this._disposed) return
    if (kind === 'saved-stamp') clearSavedObjectStampDragSource()
    this._cancelDropFocus()
    this._dropFocusFrame = window.requestAnimationFrame(() => {
      this._dropFocusFrame = null
      this._focus.focusMap()
    })
  }

  /**
   * A plant or saved stamp dropped on the overview (ToolHostDeps.overviewDrop) places nothing: the Design fits as a tool
   * picked in overview does (about the view centre when it is empty), the plant or stamp stays picked (a stamp with the
   * name its Favorites drag holds, as Place gives it) and its stamp tool arms, and the map takes focus on the next frame as after a placed drop (canopi-n2cg).
   */
  private _overviewDropped(payload: OverviewDropPayload): void {
    if (this._disposed) return
    this._deps.viewNavigation.returnToDesign({ around: 'view-centre' })
    if (payload.kind === 'species') {
      selectPlantStampSource(payload.species)
      this._switchTool('plant-stamp')
    } else {
      selectSavedObjectStampSource(payload.stamp, readSavedObjectStampDragName())
      this._switchTool('saved-object-stamp')
    }
    this._dropped(payload.kind)
  }

  private _cancelDropFocus(): void {
    if (this._dropFocusFrame === null) return
    window.cancelAnimationFrame(this._dropFocusFrame)
    this._dropFocusFrame = null
  }

  /** After a window blur has reached the recogniser (Space released, live sessions ended) and the armed tool's path, even
   *  when that path failed. */
  private _interrupted(): void {
    this._cancelDropFocus()
    this._setNavigationCursor(null)
    this._toolHost.interrupted()
  }

  private _pointerSessionLive(): boolean {
    return sessionsLive(this._recogniser) || this._toolHost.hasLiveGesture()
  }

  /**
   * Takes the recogniser's next state. A navigation session that only gestures drive (a macOS trackpad twist) can begin
   * and end with no tool call, so when the recogniser's live sessions start or stop holding Cut and Delete, the hold's
   * readers hear it through the transient history, as they hear a tool call (the menu bar would otherwise keep them grey).
   */
  private _takeRecogniser(next: RecogniserState): void {
    const wasLive = sessionsLive(this._recogniser)
    this._recogniser = next
    if (sessionsLive(next) !== wasLive) this._deps.notifyTransientHistoryChange()
  }

  /** Esc with a pointer session live: the recogniser cancels it; a pointer pan or turn it ends runs today's cancellation
   *  (released). */
  private _escapeGesture(): void {
    const gestures = this._feed({ kind: 'escape', t: Date.now() })
    this._setNavigationCursor(this._panning ? 'grabbing' : null)
    if (gestures.some(endsPointerNavigation)) this._toolHost.released()
  }

  private _configure(): void {
    this._feed(this._configureInput())
  }

  private _modeHeard(mode: ViewFrame['mode']): void {
    if (this._disposed || mode === this._mode) return
    this._mode = mode
    // A tool whose cancel throws (the configure ends its live press) still leaves Space released and the menu closed.
    runCanvasRuntimeCleanups([
      () => this._configure(),
      ...(mode === 'overview' ? [() => this._menu.close()] : []),
    ], 'Interaction session mode change failed')
  }

  private _configureInput(): RawInput {
    return {
      kind: 'configure',
      t: Date.now(),
      context: {
        tool: this._tool.peek(),
        mode: this._mode,
        pointingDevice: this._pointingDevice,
      },
    }
  }

  /** Settings › Canvas › Pointing device, read before each wheel as today: 'pan' is Trackpad. */
  private _syncPointingDevice(): void {
    const next = this._readPointingDevice()
    if (next === this._pointingDevice) return
    this._pointingDevice = next
    this._configure()
  }

  private _readPointingDevice(): 'mouse' | 'trackpad' {
    return this._deps.readScrollWheel() === 'pan' ? 'trackpad' : 'mouse'
  }

  /** Arms a tool as a tool's own request does: the runtime's setTool first, then the session if it did not follow. */
  private _switchTool(id: ToolId): void {
    this._deps.setTool(id)
    if (this._tool.peek() !== id) this.setTool(id)
  }

  /**
   * After a failed switch the recogniser still ends its live sessions, with their captures and pans (today's cancellation
   * had cleared the pointer gesture before the step that failed). The tool's own cancel was the host's setTool, whose fault
   * rule has already aborted its edits. A live rotate's cancel still reaches the router, which closes its RotationSession
   * and restores the press bearing, so the view keys work again.
   */
  private _endPressesAfterFailedSwitch(): void {
    const result = recognise(this._recogniser, this._configureInput(), this._config)
    this._takeRecogniser(result.state)
    for (const gesture of result.gestures) {
      this._followNavigation(gesture)
      if (gesture.kind === 'rotate') this._router.route(gesture)
    }
    this._source.apply(result.effects.filter((effect) => effect.kind === 'release-capture'))
    this._applyCursor()
  }

  /** ToolHostDeps.capturePress: applies the press's held-back capture; false when the press ended while it was taken. */
  private _capturePress(pointerId: number): boolean {
    if (this._pressCapture === pointerId) {
      this._pressCapture = null
      this._source.apply([{ kind: 'capture', pointerId }])
    }
    return this._recogniser.sessions.has(pointerId) || this._pressAtRelease === pointerId
  }

  // ── Keys, the navigation cursor and camera moves ───────────────────────────────────────────────────────────────

  private _setKeyState(space: boolean, mods: Modifiers): void {
    this._feed({ kind: 'key-state', t: Date.now(), space, mods })
    if (space) {
      // Today's grab: always in overview; otherwise not during a press, nor with the Pan tool's own grab.
      if (this._mode === 'overview' || (!this._toolHost.hasLiveGesture() && this._tool.peek() !== 'hand')) {
        this._setNavigationCursor(this._panning ? 'grabbing' : 'grab')
      }
    } else if (!this._panning) {
      this._setNavigationCursor(null)
    }
  }

  /** A pointer pan shows 'grabbing' until it ends; then the tool's cursor comes back (today's cancel). */
  private _followNavigation(gesture: Gesture): void {
    if (gesture.kind !== 'pan' || gesture.source === 'wheel') return
    if (gesture.phase === 'start') {
      this._panning = true
      this._setNavigationCursor('grabbing')
    } else if (gesture.phase === 'end') {
      this._panning = false
      this._setNavigationCursor(null)
    }
  }

  private _setNavigationCursor(cursor: 'grab' | 'grabbing' | null): void {
    this._navigationCursor = cursor
    this._applyCursor()
  }

  private _applyCursor(): void {
    // The host sets its first tool's cursor while it is being built; the session's setTool applies it right after.
    if (!this._toolHost) return
    this._deps.container.style.cursor = this._navigationCursor ?? this._toolCursor ?? 'default'
  }

  // ── The host's chrome, and drafts and handles while a story is presented ─────────────────────────────────────────

  private _setDraft(draft: DraftPresentation | null): void {
    this._draft = draft
    this._renderer.setDraft(this._storyPresented ? null : draft)
  }

  private _setHandles(handles: HandleList, active: HandleId): void {
    this._handles = handles
    this._activeHandle = active
    if (!this._storyPresented) this._handleLayer.setHandles(handles, active)
  }

  /** The plant tooltip names the hovered plant as today: its localised common name, else the stored one, and its species. */
  private _showTooltip(tooltip: PassiveHoverAt | null): void {
    const plant = tooltip?.target.kind === 'plant'
      ? this._deps.getSceneStore().persisted.plants.find((entry) => entry.id === tooltip.target.id)
      : undefined
    if (!tooltip || !plant) {
      this._tooltip.hide()
      return
    }
    const commonName = this._deps.getLocalizedCommonNames().get(plant.canonicalName) ?? plant.commonName
    this._tooltip.show(tooltip.at.x, tooltip.at.y, commonName, plant.canonicalName)
  }

  /**
   * Today's CSS hid the DOM previews, the rotation handle and the control points while a story is presented
   * (html[data-story-presenting]); the draft and the handles follow it.
   */
  private _observeStoryPresentation(): MutationObserver | null {
    if (typeof MutationObserver === 'undefined') return null
    const observer = new MutationObserver(() => {
      const presented = isStoryPresented()
      if (presented === this._storyPresented || this._disposed) return
      this._storyPresented = presented
      this._renderer.setDraft(presented ? null : this._draft)
      if (presented) this._handleLayer.setHandles(NO_HANDLES, null)
      else this._handleLayer.setHandles(this._handles, this._activeHandle)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [STORY_PRESENTING_ATTRIBUTE] })
    return observer
  }

  // ── The plant and saved-stamp read models ──────────────────────────────────────────────────────────────────────

  /**
   * Place plants or the saved-stamp tool hears a new source while armed: the plant source after a microtask,
   * inside the settled admission (a pick from the chooser leaves its own update first), the saved stamp at once.
   */
  private _watchToolSources(): () => void {
    let plant = readPlantStampSource()
    let saved = readSavedObjectStampSource()
    const stopPlant = effect(() => {
      const next = readPlantStampSource()
      if (next === plant) return
      plant = next
      if (this._tool.peek() !== 'plant-stamp') return
      queueMicrotask(() => {
        if (this._disposed || this._tool.peek() !== 'plant-stamp') return
        this._deps.commandAdmission.runWhenSettled(
          () => this._toolHost.sourceChanged(toolSourceFor('plant-stamp')),
          undefined,
        )
      })
    })
    const stopSaved = effect(() => {
      const next = readSavedObjectStampSource()
      if (next === saved) return
      saved = next
      if (this._tool.peek() !== 'saved-object-stamp') return
      this._toolHost.sourceChanged(toolSourceFor('saved-object-stamp'))
    })
    return () => {
      stopPlant()
      stopSaved()
    }
  }

  /**
   * The host activated the first tool with no source, and the watchers start from the picks already made: a stamp tool
   * armed with a pick when the map mounts (or mounts again) hears it now, as today's tools read it live.
   */
  private _handInitialSource(): void {
    const tool = this._tool.peek()
    const source = toolSourceFor(tool)
    if (source) this._toolHost.sourceChanged(source)
  }

  private _spacing(run: () => void): void {
    if (!this._disposed) run()
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface InteractionHostController {
  refreshTranslations(): void
  dispose(): void
}

/**
 * Makes the map host a keyboard stop: in the Tab order, named, and described
 * by its keys, so a keyboard user can reach the tool keys, Shift F10 and the
 * Esc chain. `role="application"` hands every key to the map while it has
 * focus, which is what single-key tools need.
 */
function prepareInteractionHost(
  container: HTMLElement,
  translate: CanvasRuntimeTranslator,
  platform: Pick<InputPlatform, 'os'>,
): InteractionHostController {
  const previous = HOST_ATTRIBUTES.map((name) => [name, container.getAttribute(name)] as const)
  const description = document.createElement('div')
  description.id = `canopi-map-keys-${++descriptionSequence}`
  description.hidden = true
  description.dataset.mapKeysDescription = 'true'

  function refreshTranslations(): void {
    container.setAttribute('aria-label', translate('canvas.map.label'))
    // The mod key named as the shell's shortcut labels name it (app/shell-commands/shortcut-text.ts): Cmd on a Mac.
    const mod = translate(modKeyIsCmd(platform) ? 'shortcutKeys.cmd' : 'shortcutKeys.ctrl')
    description.textContent = translate('canvas.map.description', { mod })
  }

  const host: InteractionHostController = {
    refreshTranslations,
    dispose() {
      description.remove()
      for (const [name, value] of previous) {
        if (value === null) container.removeAttribute(name)
        else container.setAttribute(name, value)
      }
    },
  }
  try {
    container.appendChild(description)
    container.tabIndex = 0
    container.setAttribute('role', 'application')
    container.setAttribute('aria-describedby', description.id)
    refreshTranslations()
  } catch (error) {
    // The session never owns a host whose name failed to translate: it is restored here.
    host.dispose()
    throw error
  }
  return host
}

/** The scene store the deps name, read live (a hydration replaces nothing here, but the fixture may swap stores). */
function liveStoreReader(deps: SceneInteractionSessionDeps): SceneStateReader {
  return {
    get persisted() { return deps.getSceneStore().persisted },
    get session() { return deps.getSceneStore().session },
    get hasObjects() { return deps.getSceneStore().hasObjects },
    get sessionPlane() { return deps.getSceneStore().sessionPlane },
    get sessionPlaneSignal() { return deps.getSceneStore().sessionPlaneSignal },
  }
}

function toolSourceFor(tool: ToolId): ToolSource | null {
  if (tool === 'plant-stamp') {
    const species = readPlantStampSource()
    return species ? { kind: 'species', species } : null
  }
  if (tool === 'saved-object-stamp') {
    const stamp = readSavedObjectStampSource()
    return stamp ? { kind: 'saved-stamp', stamp } : null
  }
  return null
}

/** Leaving a stamp tool (or ending the session) drops its pick, as today's tools did on deactivation. */
function clearToolSource(tool: ToolId): void {
  if (tool === 'plant-stamp') clearPlantStampSource()
  else if (tool === 'saved-object-stamp') clearSavedObjectStampSource()
}

/** The end of a pan or turn that a pointer drove (middle, Space, overview, the Pan tool, Shift+middle or Shift+right), not
 *  a wheel's pan nor a macOS trackpad twist, which no pointer press holds. A rotate ends on release or cancel. */
function endsPointerNavigation(gesture: Gesture): boolean {
  if (gesture.kind === 'pan') return gesture.phase === 'end' && gesture.source !== 'wheel'
  if (gesture.kind === 'rotate') return (gesture.phase === 'end' || gesture.phase === 'cancel') && gesture.source !== 'trackpad-twist'
  return false
}

/** Whether a recogniser session is live. WebKit holds a twist session from every pinch's gesturestart: it is live only
 *  once it turns the view (past 10°), so a plain pinch-zoom keeps Esc, the arrows and the Menu key. */
function sessionsLive(recogniser: RecogniserState): boolean {
  for (const session of recogniser.sessions.values()) {
    if (session.navigation !== 'trackpad-twist' || session.slopPassed) return true
  }
  return false
}

/** The note editor or a handle: today's owned overlays, over which a release ran no cleanup. */
function isOwnedOverlay(target: TargetClass): boolean {
  return target.kind === 'owned-text' || target.kind === 'handle'
}

function mergeOutcomes(a: GestureOutcome, b: GestureOutcome): GestureOutcome {
  if (!b.quarantine && !b.rejectSession && !b.dropEffect && !b.consumeClickSeries) return a
  return {
    quarantine: a.quarantine || b.quarantine || undefined,
    rejectSession: a.rejectSession || b.rejectSession || undefined,
    consumeClickSeries: a.consumeClickSeries || b.consumeClickSeries || undefined,
    dropEffect: b.dropEffect ?? a.dropEffect,
  }
}

function isStoryPresented(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute(STORY_PRESENTING_ATTRIBUTE)
}
