// __tests__/support/tool-harness.ts  (test support)
//
// The ToolHarness (spec §1.8): how tool and ToolHost tests build a scene and the ToolScene over it, and drive a real
// ToolHost with gesture scripts (below). Scenes are real SceneStores in session-plane metres; the scene source reads the
// frame scale, the species cache and the localised names through injected functions, as interaction-session.ts passes
// the runtime's.

import { signal, type ReadonlySignal } from '@preact/signals'
import type { CanvasToolGuidance } from '../../canvas/session-state'
import { createSessionPlane, type GeoPosition } from '../../canvas/session-plane'
import type { Gesture, MenuSource, NavigationSource, PressTarget } from '../../canvas/runtime/input/gestures'
import { createInputRouter } from '../../canvas/runtime/input/input-router'
import type { TargetClass } from '../../canvas/runtime/input/raw-input'
import type {
  ContextMenuPort,
  GestureOutcome,
  ToolHost,
  ToolHostDeps,
  ToolSceneSource,
} from '../../canvas/runtime/interaction-ports'
import type {
  CancelReason,
  CanvasDropPayload,
  Modifiers,
  OverviewDropPayload,
  PointerKind,
  ToolHandleId,
  ToolId,
} from '../../canvas/runtime/interaction-types'
import type { PlantPresentationContext } from '../../canvas/runtime/plant-presentation'
import type { SpeciesCacheEntry } from '../../canvas/runtime/presentation-data'
import {
  SceneStore,
  type SceneAnnotationEntity,
  type SceneDesignObjectTarget,
  type SceneMeasurementGuideEntity,
  type ScenePersistedState,
  type ScenePlantEntity,
  type ScenePoint,
  type SceneZoneEntity,
} from '../../canvas/runtime/scene'
import { SceneHistory } from '../../canvas/runtime/scene-history'
import {
  applySceneDragDeltaToDraft,
  captureSceneDragState,
  createSceneDragState,
  type SceneDragState,
} from '../../canvas/runtime/scene-runtime/drag-state'
import { getDesignObjectSelectionModel } from '../../canvas/runtime/scene-runtime/selection'
import {
  SceneRuntimeEditCoordinator,
  type SceneCommandAdmission,
  type SceneEditCoordinator,
  type SceneEditTransaction,
} from '../../canvas/runtime/scene-runtime/transactions'
import type { ToolHandle } from '../../canvas/runtime/tools/draft'
import { TOOL_REGISTRY, type ToolFactory } from '../../canvas/runtime/tools/registry'
import type { SnapSettings } from '../../canvas/runtime/tools/snapping'
import type {
  CanvasTool,
  TextEntryRequest,
  ToolCommand,
  ToolContext,
  ToolGesture,
  ToolSettingsPort,
  ToolSource,
} from '../../canvas/runtime/tools/tool'
import { createToolHost, createToolScene } from '../../canvas/runtime/tools/tool-host'
import type { ScreenPoint, ViewCamera, ViewScreen, WorldPoint } from '../../canvas/runtime/view/types'
import { createRecordingRenderer, type RecordingRenderer } from './recording-renderer'
import { createTestView, type TestView } from './test-view'

export function plantEntity(
  id: string,
  canonicalName: string,
  position: ScenePoint,
  overrides: Partial<ScenePlantEntity> = {},
): ScenePlantEntity {
  return {
    kind: 'plant',
    id,
    locked: false,
    canonicalName,
    commonName: canonicalName,
    color: null,
    canopySpreadM: 2,
    position,
    rotationDeg: null,
    notes: null,
    plantedDate: null,
    quantity: 1,
    ...overrides,
  }
}

export function rectZone(
  id: string,
  points: SceneZoneEntity['points'],
  overrides: Partial<SceneZoneEntity> = {},
): SceneZoneEntity {
  return {
    kind: 'zone',
    id,
    name: null,
    locked: false,
    zoneType: 'rect',
    points,
    rotationDeg: 0,
    fillColor: null,
    notes: null,
    ...overrides,
  }
}

export function textNote(
  id: string,
  position: ScenePoint,
  text: string,
  overrides: Partial<SceneAnnotationEntity> = {},
): SceneAnnotationEntity {
  return {
    kind: 'annotation',
    id,
    locked: false,
    annotationType: 'text',
    position,
    text,
    fontSize: 16,
    rotationDeg: null,
    ...overrides,
  }
}

export function measurementGuide(
  id: string,
  start: ScenePoint,
  end: ScenePoint,
  overrides: Partial<SceneMeasurementGuideEntity> = {},
): SceneMeasurementGuideEntity {
  return { kind: 'measurement-guide', id, locked: false, start, end, ...overrides }
}

/** A scene store holding `scene` (on the default new-Design layers unless it names its own). */
export function sceneStoreWith(scene: Partial<ScenePersistedState>): SceneStore {
  const store = new SceneStore()
  store.updatePersisted((draft) => {
    Object.assign(draft, scene)
  })
  return store
}

export interface ToolSceneSourceOptions {
  /** The frame's pixelsPerMetre; default 1 (the split suites' camera). */
  readonly pixelsPerMetre?: () => number
  readonly speciesCache?: ReadonlyMap<string, SpeciesCacheEntry>
  readonly localizedCommonNames?: ReadonlyMap<string, string | null>
  readonly isLayerOpenForCreation?: ToolSceneSource['isLayerOpenForCreation']
}

/** The ToolScene source over a scene store, read live as the runtime's is. */
export function createToolSceneSource(store: SceneStore, options: ToolSceneSourceOptions = {}): ToolSceneSource {
  const speciesCache = options.speciesCache ?? new Map<string, SpeciesCacheEntry>()
  const plantContext = (pixelsPerMetre: number): PlantPresentationContext => ({
    pixelsPerMetre,
    speciesCache,
    ...(options.localizedCommonNames ? { localizedCommonNames: options.localizedCommonNames } : {}),
  })
  const pixelsPerMetre = options.pixelsPerMetre ?? (() => 1)
  return {
    store,
    selection: () => store.session.selectedTargets,
    isLayerOpenForCreation: options.isLayerOpenForCreation ?? ((layer) => {
      const entry = store.persisted.layers.find((candidate) => candidate.name === layer)
      return entry?.visible !== false && entry?.locked !== true
    }),
    pixelsPerMetre,
    speciesCache: () => speciesCache,
    plantContext,
    selectionModel: () => {
      const scale = pixelsPerMetre()
      return getDesignObjectSelectionModel(store.persisted, store.session.selectedTargets, {
        annotationViewportScale: scale,
        plantContext: { ...plantContext(scale), plants: store.persisted.plants },
      })
    },
  }
}

// ── The host harness ────────────────────────────────────────────────────────────────────────────────────────────────
//
// createToolHarness runs gesture scripts through a real createToolHost, with the input router in front of it and a
// recording ToolHostDeps behind it. The scripts send gestures as the recogniser emits them (a scripted drag has passed
// the slop) and do what interaction-session.ts does around it: they report each raw press (a primary press, and the
// right press before a mouse menu) through rawPress before routing, take a press's capture when the host asks
// (capturePress, recorded), end a session the host rejected, end the nudge series on focus-out and call interrupted
// after a blur. Tools come from
// tools/registry.ts, which a test replaces through vi.mock('…/tools/registry', () => ({ TOOL_REGISTRY: {} })) and fills
// with useStubTools: like the real registry, it lists every tool id.

export interface StubToolRecord {
  readonly gestures: ToolGesture[]
  readonly commands: ToolCommand[]
  /** 'activate', 'deactivate:<reason>', 'cancelTransient:<reason>', 'viewChanged', 'sceneChanged', 'sourceChanged'. */
  readonly calls: string[]
}

export interface StubTool extends CanvasTool, StubToolRecord {
  /** The context of the last activation. */
  ctx(): ToolContext
  /** The last gesture of `kind` the tool received. */
  last<K extends ToolGesture['kind']>(kind: K): (ToolGesture & { readonly kind: K }) | undefined
  /** How many gestures of `kind` the tool received. */
  count(kind: ToolGesture['kind']): number
}

/** What a stub does besides recording; every member defaults to a quiet tool that passes. */
export type StubToolBehaviour = Partial<Omit<CanvasTool, 'id'>>

/** A recording CanvasTool standing in for a real one (a stub 'polygon' checks the host's plumbing, not Polygon's rules). */
export function stubTool(id: ToolId, behaviour: StubToolBehaviour = {}): StubTool {
  const gestures: ToolGesture[] = []
  const commands: ToolCommand[] = []
  const calls: string[] = []
  let context: ToolContext | null = null
  const { activate, gesture, command, cancelTransient, deactivate, sceneChanged, viewChanged, sourceChanged, ...rest } = behaviour
  return {
    ...rest,
    id,
    gestures,
    commands,
    calls,
    ctx() {
      if (!context) throw new Error(`The stub ${id} was never activated.`)
      return context
    },
    last(kind) {
      for (let index = gestures.length - 1; index >= 0; index -= 1) {
        const entry = gestures[index]!
        if (entry.kind === kind) return entry as never
      }
      return undefined
    },
    count: (kind) => gestures.filter((entry) => entry.kind === kind).length,
    activate(ctx, source) {
      context = ctx
      calls.push('activate')
      activate?.(ctx, source)
    },
    sourceChanged(source) {
      calls.push('sourceChanged')
      sourceChanged?.(source)
    },
    gesture(g) {
      gestures.push(g)
      return gesture?.(g) ?? 'pass'
    },
    command(c) {
      commands.push(c)
      return command?.(c) ?? 'pass'
    },
    sceneChanged() {
      calls.push('sceneChanged')
      sceneChanged?.()
    },
    viewChanged() {
      calls.push('viewChanged')
      viewChanged?.()
    },
    hasTransient: rest.hasTransient ?? (() => false),
    cancelTransient(reason) {
      calls.push(`cancelTransient:${reason}`)
      cancelTransient?.(reason)
    },
    deactivate(reason) {
      calls.push(`deactivate:${reason}`)
      deactivate?.(reason)
    },
  }
}

/** Every tool id: the record fails to type-check when ToolId gains or loses one. */
const TOOL_IDS = Object.keys({
  select: true, hand: true, 'plant-stamp': true, text: true, line: true, 'measurement-guide': true, rectangle: true,
  ellipse: true, polygon: true, 'object-stamp': true, 'saved-object-stamp': true, 'plant-spacing': true, profile: true,
} satisfies Record<ToolId, true>) as ToolId[]

/** Lists every tool id in the vi.mock'ed tools/registry.ts: each of `tools` returns its stub, and every other id a fresh
 *  quiet stub, as the real registry lists them all. */
export function useStubTools(...tools: readonly CanvasTool[]): void {
  const registry = TOOL_REGISTRY as Record<ToolId, ToolFactory>
  if (Object.isFrozen(registry)) {
    throw new Error('useStubTools needs tools/registry.ts replaced: vi.mock(\'…/tools/registry\', () => ({ TOOL_REGISTRY: {} })).')
  }
  for (const id of TOOL_IDS) registry[id] = () => stubTool(id)
  for (const tool of tools) registry[tool.id] = () => tool
}

// A replaced registry lists every tool id from the start, so a file's first test, in any order, finds the tools its
// afterEach's useStubTools() restores for the next one (canopi-f47t.52.228.55).
if (!Object.isFrozen(TOOL_REGISTRY)) useStubTools()

const NO_MODIFIERS: Modifiers = Object.freeze({ shift: false, ctrl: false, alt: false, meta: false })

export interface ToolHarnessOptions {
  readonly scene?: Partial<ScenePersistedState>
  /** Armed when the host is built; default 'select'. */
  readonly tool?: ToolId
  /** Bearing-0 placement (screen = world × scale + { x, y }); default { x: 0, y: 0, scale: 1 }, on a 400 × 300 screen. */
  readonly viewport?: { readonly x: number; readonly y: number; readonly scale: number }
  /** Instead of viewport: a full camera, for a turned map (createTestView's camera; its centre defaults to the plane's origin). */
  readonly camera?: Partial<ViewCamera>
  /** The map's screen; default 400 × 300 (createTestView's). */
  readonly screen?: Partial<ViewScreen>
  readonly snapping?: SnapSettings
  /** Default: the scene's edit coordinator, as the runtime passes it. */
  readonly admission?: SceneCommandAdmission
  /** Default: the scene's edit coordinator over the harness's history. */
  readonly edits?: SceneEditCoordinator
  /** ToolHostDeps.pin: the Site data pin, absent by default (Web, or the panel closed). */
  readonly pin?: (world: WorldPoint) => void
  /** ToolHostDeps.finishProfile: the Site data profile, absent by default (Web). */
  readonly finishProfile?: (points: readonly WorldPoint[]) => void
  /** Default: a series over the edit coordinator, one Scene Edit until endNudge, as the runtime's. */
  readonly nudge?: ToolHostDeps['nudge']
  /**
   * ToolHostDeps.capturePress after the harness records it: false when the capture was lost while it was taken (a
   * synchronous lostpointercapture). Default: the capture holds.
   */
  readonly capturePress?: (pointerId: number) => boolean
  /** The tools' settings port; default a 1 m row interval whose commits go nowhere. */
  readonly settings?: ToolSettingsPort
  /** The tools' translator; default the key itself. */
  readonly translate?: ToolHostDeps['translate']
}

export interface ToolHarnessRecord {
  invalidations: number
  transientHistoryChanges: number
  readonly hovers: (SceneDesignObjectTarget | null)[]
  readonly pointerWorld: (WorldPoint | null)[]
  readonly selections: (readonly SceneDesignObjectTarget[])[]
  readonly guidance: (Partial<CanvasToolGuidance> | null)[]
  readonly focus: string[]
  readonly menus: Parameters<ContextMenuPort['open']>[0][]
  readonly nudges: string[]
  /** The pointer ids whose press capture the host took (ToolHostDeps.capturePress), in order. */
  readonly captures: number[]
  /** The drops the host placed (ToolHostDeps.dropped), in order. */
  readonly drops: ('species' | 'saved-stamp')[]
  /** The drops the host took in overview (ToolHostDeps.overviewDrop), in order. */
  readonly overviewDrops: OverviewDropPayload[]
  /** The Design pin's hover changes (ToolHostDeps.designPin.hovered), in order. */
  readonly pinHovers: boolean[]
  /** Taps on the Design pin (ToolHostDeps.designPin.tapped). */
  pinTaps: number
  /** Drags refused by a lock (ToolHostDeps.lockedMoveRefused). */
  lockedMoveRefusals: number
}

/** The open text entry: its request, the host's submit and onCancel, the text typed into it (its initial text until typeText),
 *  and whether it holds focus (from its opening; it loses focus when its blur commit is refused). */
export interface ToolHarnessTextEntry {
  readonly request: TextEntryRequest
  readonly submit: (text: string) => 'close' | 'keep'
  readonly onCancel: (() => void) | null
  text: string
  focused: boolean
}

export interface ToolHarnessChrome {
  readonly handles: readonly ToolHandle[]
  readonly activeHandle: ToolHandleId | null
  /** The handle that holds keyboard focus, as the handle layer reports it; a test sets it. */
  focusedHandle: ToolHandleId | null
  readonly cursor: string
  readonly tooltip: { readonly target: SceneDesignObjectTarget; readonly at: ScreenPoint } | null
  /** The open text entry, which ToolHostDeps.chrome.isTextEntryOpen reports; it commits on the map's focus (its blur) while it
   *  holds focus, and on submitUnfocusedTextEntry once it has lost it. */
  readonly textEntry: ToolHarnessTextEntry | null
}

export interface PressOptions {
  readonly mods?: Partial<Modifiers>
  readonly target?: PressTarget
  readonly pointer?: PointerKind
  readonly clickCount?: number
  /** Default: the next of the harness's own ids, from 1. */
  readonly pointerId?: number
}

export interface ToolHarness {
  readonly host: ToolHost
  /** The session's tool signal the host arms and reads (ToolHostDeps.toolState.active). */
  readonly toolState: ReadonlySignal<ToolId>
  readonly view: TestView
  readonly store: SceneStore
  readonly history: SceneHistory
  readonly edits: SceneEditCoordinator
  readonly renderer: RecordingRenderer
  readonly chrome: ToolHarnessChrome
  readonly record: ToolHarnessRecord
  /** True while the canvas menu the host opened through ToolHostDeps.menu is open. */
  readonly menuOpen: boolean
  /** Settings › Canvas snapping, read by the host at each point. */
  snapping: SnapSettings
  /** The world point under a screen point of the current frame. */
  world(at: ScreenPoint): WorldPoint
  /** Arms a tool as the session does: its tool signal, then ToolHost.setTool. */
  arm(id: ToolId, source?: ToolSource | null): void
  select(...targets: SceneDesignObjectTarget[]): void
  /** A hover over `target` (default the map's surface), as the recogniser classified it. */
  hover(at: ScreenPoint, mods?: Partial<Modifiers>, target?: TargetClass): GestureOutcome
  leave(): GestureOutcome
  press(at: ScreenPoint, options?: PressOptions): GestureOutcome
  /** A move: drag-start, then drag-move while a press is live; a hover otherwise. */
  move(at: ScreenPoint, mods?: Partial<Modifiers>): GestureOutcome
  /** Up: a tap without movement, a drag-end after one. */
  release(at?: ScreenPoint, mods?: Partial<Modifiers>): GestureOutcome
  click(at: ScreenPoint, options?: PressOptions): GestureOutcome
  drag(from: ScreenPoint, to: ScreenPoint, options?: PressOptions): GestureOutcome
  cancel(reason: CancelReason): GestureOutcome
  wheelZoom(at: ScreenPoint, factor: number): GestureOutcome
  /** A pointer pan from `from` to `to` (a right-drag by default), the ground following the pointer. */
  pan(from: ScreenPoint, to: ScreenPoint, source?: NavigationSource): void
  menu(at: ScreenPoint | 'selection', source?: MenuSource): GestureOutcome
  /** A panel drag over the map (dragover, dragleave, drop), as the session routes it to the host's drop route. */
  drop(phase: 'over' | 'leave' | 'drop', at?: ScreenPoint, payload?: CanvasDropPayload): GestureOutcome
  /** An arrow key as the keyboard port sends it to the host. */
  arrow(key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', large?: boolean): ReturnType<ToolHost['nudge']>
  focusOut(): void
  /** A window blur: the recogniser ends the live session, then the session calls interrupted. */
  blur(): void
  /** A re-origin: the camera moves into the plane at `origin`, keeping its ground (the host sees the plane change). */
  reorigin(origin: GeoPosition): void
  /** Runs the host's manual clock: its due timers (double-click windows, the nudge series). */
  advance(ms: number): void
  /** Edit › Undo on the scene's history (not the transient history). */
  undo(): boolean
  /** An open, focused 'edit' entry that no tool asked for, whose submit closes it: the chrome reports it open. */
  openTextEntry(): void
  /** Types into the open text entry, replacing its text. */
  typeText(text: string): void
  /** Enter in the text entry: its text goes to the submit, and the host closes the entry on 'close'. */
  enterText(): 'close' | 'keep'
  /** Esc in the text entry: its own element handler closes it without a submit, then runs the opener's onCancel. */
  escapeTextEntry(): void
  /** Focus leaves the text entry for somewhere off the map: it submits, and on 'keep' stays open without focus. */
  blurTextEntry(): 'close' | 'keep'
  dispose(): void
}

const ARROW_DIRECTIONS = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
} as const

export function createToolHarness(options: ToolHarnessOptions = {}): ToolHarness {
  const view = createTestView({
    plane: createSessionPlane({ lon: 0, lat: 0 }),
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.camera ? { camera: options.camera } : {}),
    ...(options.screen ? { screen: options.screen } : {}),
  })
  const store = sceneStoreWith(options.scene ?? {})
  const history = new SceneHistory()
  const coordinator = new SceneRuntimeEditCoordinator({
    sceneStore: store,
    history,
    setSelection: (targets) => store.setSelection(targets),
    incrementSceneRevision: () => {},
    syncCanvasSignalsFromScene: () => {},
    invalidate: () => {},
  })
  const edits = options.edits ?? coordinator
  const renderer = createRecordingRenderer()
  const record: ToolHarnessRecord = {
    invalidations: 0,
    transientHistoryChanges: 0,
    hovers: [],
    pointerWorld: [],
    selections: [],
    guidance: [],
    focus: [],
    menus: [],
    nudges: [],
    captures: [],
    drops: [],
    overviewDrops: [],
    pinHovers: [],
    pinTaps: 0,
    lockedMoveRefusals: 0,
  }
  const chrome = {
    handles: [] as readonly ToolHandle[],
    activeHandle: null as ToolHandleId | null,
    focusedHandle: null as ToolHandleId | null,
    cursor: 'default',
    tooltip: null as ToolHarnessChrome['tooltip'],
    textEntry: null as ToolHarnessTextEntry | null,
  }
  let menuOpen = false
  let now = 0
  const timers = createHarnessTimers(() => now)
  const toolState = signal<ToolId>(options.tool ?? 'select')
  const scene = createToolScene(createToolSceneSource(store, { pixelsPerMetre: () => view.view().pixelsPerMetre }))
  let snapping: SnapSettings = options.snapping ?? { grid: false }

  const host = createToolHost({
    frames: view.frames,
    scene,
    edits,
    admission: options.admission ?? coordinator,
    settled: coordinator,
    setSelection(targets) {
      store.setSelection(targets)
      record.selections.push([...targets])
    },
    renderer,
    invalidate: () => {
      record.invalidations += 1
    },
    chrome: {
      setHandles(handles, active) {
        chrome.handles = handles
        chrome.activeHandle = active
      },
      setCursor(cursor) {
        chrome.cursor = cursor
      },
      requestTextEntry(request, submit, onCancel) {
        chrome.textEntry = { request, submit, onCancel: onCancel ?? null, text: request.initialText, focused: true }
      },
      closeTextEntry() {
        chrome.textEntry = null
      },
      cancelTextEntry() {
        const entry = chrome.textEntry
        chrome.textEntry = null
        entry?.onCancel?.()
      },
      submitUnfocusedTextEntry() {
        const entry = chrome.textEntry
        if (entry && !entry.focused) submitTextEntry(entry)
      },
      isTextEntryOpen: () => chrome.textEntry !== null,
      focusedHandle: () => chrome.focusedHandle,
      setTooltip(tooltip) {
        chrome.tooltip = tooltip
      },
    },
    menu: {
      open(request) {
        record.menus.push(request)
        menuOpen = true
      },
      close() {
        menuOpen = false
      },
      isOpen: () => menuOpen,
    },
    focus: {
      focusMap() {
        record.focus.push('map')
        // A text entry that holds focus commits on its blur; one that has lost it hears nothing.
        const entry = chrome.textEntry
        if (entry?.focused) blurTextEntry(entry)
      },
    },
    guidance: (guidance) => {
      record.guidance.push(guidance)
    },
    toolState: {
      active: toolState,
      set(id) {
        toolState.value = id
      },
    },
    settings: options.settings ?? {
      plantSpacingIntervalM: () => 1,
      commitPlantSpacingIntervalM: () => {},
    },
    snapping: () => snapping,
    translate: options.translate ?? ((key) => key),
    navigation: view.navigation,
    nudge: options.nudge ?? createNudgeSeries(store, edits, record),
    timers: { ...timers, clock: () => now },
    initialPointer: 'mouse',
    hover(target) {
      store.setHoveredTarget(target)
      record.hovers.push(target)
    },
    ...(options.pin ? { pin: options.pin } : {}),
    ...(options.finishProfile ? { finishProfile: options.finishProfile } : {}),
    lockedMoveRefused: () => {
      record.lockedMoveRefusals += 1
    },
    capturePress(pointerId) {
      record.captures.push(pointerId)
      return options.capturePress?.(pointerId) ?? true
    },
    transientHistoryChanged: () => {
      record.transientHistoryChanges += 1
    },
    dropped(kind) {
      record.drops.push(kind)
    },
    overviewDrop(payload) {
      record.overviewDrops.push(payload)
    },
    designPin: {
      contains: (at) => view.navigation.onDesignPin(at),
      hovered: (hovered) => { record.pinHovers.push(hovered) },
      tapped: () => { record.pinTaps += 1 },
    },
  })
  host.subscribePointerWorld((point) => {
    record.pointerWorld.push(point && point.world)
  })
  const router = createInputRouter({ navigation: view.navigation, toolHost: host })

  let nextPointerId = 1
  let session: {
    readonly id: number
    readonly pointer: PointerKind
    readonly clickCount: number
    last: ScreenPoint
    dragged: boolean
  } | null = null

  const mods = (partial: Partial<Modifiers> = {}): Modifiers => ({ ...NO_MODIFIERS, ...partial })

  /** The entry's submit, as the chrome runs it: a 'close' closes the entry, a 'keep' leaves it open with its text. */
  function submitTextEntry(entry: ToolHarnessTextEntry): 'close' | 'keep' {
    const reply = entry.submit(entry.text)
    if (reply === 'close' && chrome.textEntry === entry) chrome.textEntry = null
    return reply
  }

  function blurTextEntry(entry: ToolHarnessTextEntry): 'close' | 'keep' {
    entry.focused = false
    return submitTextEntry(entry)
  }

  /** The session's routing: every gesture goes straight to the router. */
  function route(g: Gesture): GestureOutcome {
    return router.route(g)
  }

  const harness: ToolHarness = {
    host,
    toolState,
    view,
    store,
    history,
    edits,
    renderer,
    chrome,
    record,
    get menuOpen() {
      return menuOpen
    },
    get snapping() {
      return snapping
    },
    set snapping(next) {
      snapping = next
    },
    world(at) {
      return view.view().screenToWorld(at)
    },
    arm(id, source = null) {
      toolState.value = id
      host.setTool(id, source)
    },
    select(...targets) {
      store.setSelection(targets)
      host.sceneChanged()
    },
    hover: (at, partial, target = { kind: 'surface' }) => route({ kind: 'hover', at, pointer: 'mouse', mods: mods(partial), target }),
    leave: () => route({ kind: 'hover-end' }),
    press(at, pressOptions = {}) {
      const id = pressOptions.pointerId ?? nextPointerId++
      const target = pressOptions.target ?? { kind: 'surface' }
      const pointer = pressOptions.pointer ?? 'mouse'
      const clickCount = pressOptions.clickCount ?? 1
      // The session reports the raw pointerdown before it routes what the recogniser made of it.
      host.rawPress('primary', target, id)
      const outcome = route({ kind: 'press', id, at, pointer, mods: mods(pressOptions.mods), clickCount, target })
      session = outcome.rejectSession ? null : { id, pointer, clickCount, last: at, dragged: false }
      return outcome
    },
    move(at, partial) {
      const live = session
      if (!live) return harness.hover(at, partial)
      live.last = at
      if (!live.dragged) {
        live.dragged = true
        return route({ kind: 'drag-start', id: live.id, at, mods: mods(partial) })
      }
      return route({ kind: 'drag-move', id: live.id, at, mods: mods(partial) })
    },
    release(at, partial) {
      const live = session
      if (!live) return {}
      session = null
      const point = at ?? live.last
      if (live.dragged) return route({ kind: 'drag-end', id: live.id, at: point, mods: mods(partial) })
      return route({ kind: 'tap', id: live.id, at: point, pointer: live.pointer, mods: mods(partial), clickCount: live.clickCount })
    },
    click(at, pressOptions) {
      const outcome = harness.press(at, pressOptions)
      if (outcome.rejectSession) return outcome
      return harness.release(at, pressOptions?.mods)
    },
    drag(from, to, pressOptions) {
      const outcome = harness.press(from, pressOptions)
      if (outcome.rejectSession) return outcome
      harness.move({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, pressOptions?.mods)
      harness.move(to, pressOptions?.mods)
      return harness.release(to, pressOptions?.mods)
    },
    cancel(reason) {
      if (!session) return {}
      session = null
      return route({ kind: 'cancel', reason })
    },
    wheelZoom: (at, factor) => route({ kind: 'zoom', anchorPx: at, factor, source: 'wheel' }),
    pan(from, to, source = 'secondary-drag') {
      route({ kind: 'pan', phase: 'start', deltaPx: { x: 0, y: 0 }, source, at: from })
      route({ kind: 'pan', phase: 'move', deltaPx: { x: to.x - from.x, y: to.y - from.y }, source, at: to })
      route({ kind: 'pan', phase: 'end', deltaPx: { x: 0, y: 0 }, source, at: to })
    },
    menu(at, source = 'mouse') {
      // A mouse menu follows its right press, which the session reports as a raw press.
      if (source === 'mouse') host.rawPress('secondary', { kind: 'surface' })
      return route({ kind: 'menu-request', at, source })
    },
    drop: (phase, at = { x: 0, y: 0 }, payload = { kind: 'unknown' }) => route({ kind: 'drop', phase, at, payload }),
    arrow: (key, large = false) => host.nudge(ARROW_DIRECTIONS[key], large),
    focusOut() {
      host.endNudgeSeries(true)
    },
    blur() {
      harness.cancel('blur')
      host.interrupted()
    },
    reorigin(origin) {
      view.host.current().planeChanged(createSessionPlane(origin))
    },
    advance(ms) {
      now += ms
      timers.runDue()
    },
    undo: () => coordinator.undo(),
    openTextEntry() {
      chrome.textEntry = {
        request: { anchor: { x: 0, y: 0 }, rotationDeg: 0, initialText: '', placeholderKey: 'canvas.textNote.placeholder' },
        submit: () => 'close',
        onCancel: null,
        text: '',
        focused: true,
      }
    },
    typeText(text) {
      const entry = chrome.textEntry
      if (!entry) throw new Error('No text entry is open.')
      entry.text = text
    },
    enterText() {
      const entry = chrome.textEntry
      if (!entry) throw new Error('No text entry is open.')
      return submitTextEntry(entry)
    },
    escapeTextEntry() {
      const entry = chrome.textEntry
      chrome.textEntry = null
      entry?.onCancel?.()
    },
    blurTextEntry() {
      const entry = chrome.textEntry
      if (!entry?.focused) throw new Error('No focused text entry is open.')
      return blurTextEntry(entry)
    },
    dispose() {
      host.dispose()
      view.dispose()
    },
  }
  return harness
}

/** Timers on the harness's manual clock; the harness runs the due ones after each advance. */
function createHarnessTimers(now: () => number) {
  let nextId = 1
  const pending = new Map<number, { readonly atMs: number; readonly run: () => void }>()
  return {
    set(atMs: number, run: () => void): number {
      const id = nextId++
      pending.set(id, { atMs, run })
      return id
    },
    clear(id: number): void {
      pending.delete(id)
    },
    runDue(): void {
      for (;;) {
        let due: [number, { readonly atMs: number; readonly run: () => void }] | null = null
        for (const entry of pending) {
          if (entry[1].atMs <= now() && (!due || entry[1].atMs < due[1].atMs)) due = entry
        }
        if (!due) return
        pending.delete(due[0])
        due[1].run()
      }
    },
  }
}

/** The runtime's nudge series in miniature: one Scene Edit from the first step until endNudge commits or aborts it. */
function createNudgeSeries(
  store: SceneStore,
  edits: SceneEditCoordinator,
  record: ToolHarnessRecord,
): ToolHostDeps['nudge'] {
  let series: { readonly edit: SceneEditTransaction; readonly state: SceneDragState; total: ScenePoint } | null = null
  return {
    nudgeSelected(delta) {
      record.nudges.push(`nudge:${delta.x},${delta.y}`)
      if (!series) {
        if (store.session.selectedTargets.length === 0) return false
        const state = createSceneDragState()
        captureSceneDragState(state, store.persisted, store.session.selectedTargets)
        series = { edit: edits.begin('keyboard-nudge'), state, total: { x: 0, y: 0 } }
      }
      const open = series
      open.total = { x: open.total.x + delta.x, y: open.total.y + delta.y }
      open.edit.mutate((draft) => applySceneDragDeltaToDraft(draft, open.state, open.total))
      return true
    },
    endNudge(endOptions) {
      record.nudges.push(endOptions?.abort ? 'end:abort' : 'end')
      const open = series
      if (!open) return
      series = null
      if (endOptions?.abort) open.edit.abort()
      else open.edit.commit()
    },
  }
}
