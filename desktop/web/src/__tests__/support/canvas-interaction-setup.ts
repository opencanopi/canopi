// Shared setup of the canvas interaction end-to-end suites (__tests__/canvas-interaction-e2e.*.test.ts):
// the fakes and helpers above the suites, and installSceneInteractionFixture, the
// describe-scope fixture each suite installs. Split from scene-interaction.test.ts in the
// canvas v2 seams commit; renamed with the suites at the end of 0B.
import { signal } from '@preact/signals'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { clearPlantStampSource } from '../../canvas/plant-stamp-source'
import { clearSavedObjectStampSource } from '../../canvas/saved-object-stamp-source'
import {
  IDLE_CANVAS_TOOL_GUIDANCE,
  currentCanvasSelection,
  setCanvasTool,
  setCanvasToolGuidance,
} from '../../canvas/session-state'
import { h, render as renderPreact } from 'preact'
import { setupRerender, teardown as teardownPreactTestUtils } from 'preact/test-utils'
import { ToolCard } from '../../components/canvas/ToolCard'
import { CanvasContextMenu } from '../../components/canvas/CanvasContextMenu'
import { closeCanvasContextMenu, openCanvasContextMenu } from '../../app/canvas-context-menu/state'
import { focusOwner } from '../../app/keyboard/focus-owner'
import { setCurrentCanvasSession } from '../../canvas/session'
import {
  createTestCanvasCommandSurface,
  createTestCanvasDocumentSurface,
  createTestCanvasKeyboardPort,
} from './canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './canvas-query-surface'
import { snapToGridEnabled } from '../../app/canvas-settings/signals'
import { plantSpacingIntervalM, singleKeyShortcuts } from '../../app/settings/state'
import { installKeyRouter, type KeyRouterHandle } from '../../app/keyboard/key-router'
import { CANVAS_KEYMAP_ROWS } from '../../app/keyboard/keymap'
import { TEST_KEY_PLATFORM } from './key-router'
import { t } from '../../i18n'
import { planarToViewCamera, screenToGeo } from '../../canvas/runtime/view/camera-math'
import { createSessionPlane } from '../../canvas/session-plane'
import type { MapLibreCameraDriverMap } from '../../maplibre/camera-driver'
import { createTestView, type TestView } from './test-view'
import {
  SceneStore,
  roundGeoPosition,
  type SceneAnnotationEntity,
  type SceneDesignObjectTarget,
  type SceneMeasurementGuideEntity,
  type ScenePlantEntity,
  type ScenePoint,
  type SceneZoneEntity,
} from '../../canvas/runtime/scene'
import {
  createSceneInteractionSession,
  type SceneInteractionSession,
  type SceneInteractionSessionDeps,
} from '../../canvas/runtime/interaction-session'
import type { CanvasDesignObjectSelectionModel } from '../../canvas/runtime/runtime'
import type {
  CanvasContextMenuRequest,
  CanvasRuntimeContextMenuAdapter,
} from '../../canvas/runtime/app-adapter'
import {
  buildCanvasContextMenuEntries,
  type CanvasContextMenuCommand,
  type CanvasContextMenuItemId,
} from '../../app/canvas-context-menu/entries'
import { getDesignObjectSelectionModel } from '../../canvas/runtime/scene-runtime/selection'
import { SceneHistory } from '../../canvas/runtime/scene-history'
import {
  SceneRuntimeEditCoordinator,
  type SceneCommandAdmission,
  type SceneEditCoordinator,
  type SceneEditTransaction,
  type SettledSceneReader,
} from '../../canvas/runtime/scene-runtime/transactions'
import {
  createSceneInteractionEventHarness,
  type SceneInteractionEventHarness,
} from './canvas-interaction-events'
import { createRecordingRenderer, type RecordingRenderer } from './recording-renderer'
import type { DraftShape } from '../../canvas/runtime/tools/draft'

/**
 * The session a default `render` refreshes: the runtime's render invalidates the scene and refreshes its own session's
 * measurements (scene-runtime.ts `_invalidate`), which the ToolHost's handles and the legacy bridge's chips follow.
 */
let renderedSession: SceneInteractionSession | null = null

/** The deps of a suite session: today's, plus the recording renderer the session's drafts reach. */
export type SceneInteractionTestDeps = SceneInteractionSessionDeps & { readonly renderer: RecordingRenderer }

/** The canonical lon/lat a changed plane position serializes to. */
export function storedGeo(store: SceneStore, point: { x: number; y: number }) {
  return roundGeoPosition(store.sessionPlane.toGeo(point))
}

export function createPlantPresentationContext(viewportScale: number) {
  return {
    pixelsPerMetre: viewportScale,
    speciesCache: new Map(),
  }
}

/**
 * A consistent MapLibre fake with a fixed camera: the geographic camera that shows today's attached viewport { x: 100, y: 50, scale: 2 }
 * on the plane of the attached test's origin (Paris). jumpTo is recorded and fires 'move', flyTo fires 'move' and 'moveend' (a
 * flight MapLibre ends at once), the guard is recorded, and the read-backs stay put.
 */
export class AttachedInteractionMap implements MapLibreCameraDriverMap {
  readonly canvas = document.createElement('canvas')
  readonly listeners = new Map<string, Set<() => void>>()
  readonly jumpTo = vi.fn(() => this.fire('move'))
  readonly flyTo = vi.fn(() => {
    this.fire('move')
    this.fire('moveend')
  })
  readonly setTransformConstrain = vi.fn()
  readonly resize = vi.fn()
  readonly stop = vi.fn()
  readonly on = vi.fn((type: string, listener: () => void) => {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener))
  })
  readonly off = vi.fn((type: string, listener: () => void) => {
    this.listeners.get(type)?.delete(listener)
  })
  readonly getPitch = vi.fn(() => 0)
  readonly getBearing = vi.fn(() => this.camera.bearingDeg)
  readonly getZoom = vi.fn(() => this.camera.zoom)
  readonly getCenter = vi.fn(() => ({ lng: this.camera.center.lon, lat: this.camera.center.lat }))
  readonly unproject = vi.fn(([x, y]: [number, number]) => {
    const ground = screenToGeo(this.camera, this.screen, { x, y })
    return { lng: ground.lon, lat: ground.lat }
  })
  readonly getCanvas = vi.fn(() => this.canvas)

  private readonly screen = { width: 400, height: 300, devicePixelRatio: 2 }
  private readonly camera = planarToViewCamera(
    { x: 100, y: 50, scale: 2, bearingDeg: 0 },
    this.screen,
    createSessionPlane({ lon: 2.3522, lat: 48.8566 }),
  )

  constructor() {
    Object.defineProperties(this.canvas, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
      width: { configurable: true, value: 800 },
      height: { configurable: true, value: 600 },
    })
  }

  private fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
}

/** Stands in for the app's right-click menu: records what the runtime asks it to show. */
export const contextMenuHost = {
  current: null as CanvasContextMenuRequest | null,
  opened: [] as CanvasContextMenuRequest[],
  adapter: {
    open: (request) => {
      contextMenuHost.current = request
      contextMenuHost.opened.push(request)
    },
    close: (request) => {
      if (contextMenuHost.current === request) contextMenuHost.current = null
    },
  } satisfies CanvasRuntimeContextMenuAdapter,
  reset(): void {
    this.current = null
    this.opened = []
  },
}

function contextMenuEntryOptions() {
  return {
    translate: t,
    characterKeyShortcuts: true,
    openPlantAppearance: vi.fn(),
    summary: null,
    openSpeciesDetail: vi.fn(),
    addToCalendar: vi.fn(),
    setUnitCost: vi.fn(),
  }
}

/** The open menu's command, as the app renders it. */
export function contextMenuCommand(id: CanvasContextMenuItemId): CanvasContextMenuCommand {
  const request = contextMenuHost.current
  if (!request) throw new Error('No context menu is open')
  // Arrange ▸ holds stacking and grouping one level down.
  const entry = buildCanvasContextMenuEntries(request, contextMenuEntryOptions())
    .flatMap((candidate) => 'submenu' in candidate ? candidate.submenu : [candidate])
    .find((candidate): candidate is CanvasContextMenuCommand => 'run' in candidate && candidate.id === id)
  if (!entry) throw new Error(`The context menu has no '${id}' item`)
  return entry
}

/** The native contextmenu at a client point on the map; returns the dispatched event. */
function dispatchContextMenu(container: HTMLElement, client: ScenePoint): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: client.x,
    clientY: client.y,
  })
  container.dispatchEvent(event)
  return event
}

export function contextMenuItemIds(): readonly string[] {
  const request = contextMenuHost.current
  if (!request) return []
  return buildCanvasContextMenuEntries(request, contextMenuEntryOptions())
    .flatMap((entry) => 'id' in entry ? [entry.id] : [])
}

export function createInteractionDeps(
  container: HTMLDivElement,
  store: SceneStore,
  view: TestView,
  overrides: Partial<Pick<SceneInteractionSessionDeps,
    | 'render'
    | 'sceneEdits'
    | 'commandAdmission'
    | 'settledReader'
    | 'getDesignObjectSelection'
    | 'selectionCommands'
    | 'setTool'
    | 'setHoveredTarget'
    | 'getPlantPresentationContext'
    | 'readPlantSpacingIntervalMeters'
    | 'commitPlantSpacingIntervalMeters'
    | 'translate'
    | 'contextMenu'
    | 'publishToolGuidance'
    | 'publishDesignPinHover'
    | 'nudge'
  >>
    & { onSceneEditCommit?: (type: string) => void } = {},
): SceneInteractionTestDeps {
  let selection: SceneDesignObjectTarget[] = []
  const setSelection = vi.fn((targets: Iterable<SceneDesignObjectTarget>) => {
    selection = [...targets].map((target) => ({ ...target }))
    store.setSelection(selection)
    currentCanvasSelection.value = new Set(selection.map((target) => target.id))
  })
  const clearSelection = vi.fn(() => {
    selection = []
    store.setSelection(selection)
    currentCanvasSelection.value = new Set()
  })
  // As the runtime does: only a scene render refreshes the session; a camera frame reaches the tools on their own listener.
  const render = overrides.render ?? (() => { renderedSession?.refreshMeasurements() })
  const history = new SceneHistory()
  if (overrides.onSceneEditCommit) {
    const record = history.record.bind(history)
    vi.spyOn(history, 'record').mockImplementation((command, transaction) => {
      overrides.onSceneEditCommit?.(command.type)
      return record(command, transaction)
    })
  }
  const sceneEdits = overrides.sceneEdits ?? new SceneRuntimeEditCoordinator({
    sceneStore: store,
    history,
    setSelection,
    incrementSceneRevision: () => {},
    syncCanvasSignalsFromScene: () => {},
    invalidate: () => render(),
  })
  const commandAdmission = overrides.commandAdmission
    ?? ('runWhenSettled' in sceneEdits
      ? sceneEdits as unknown as SceneCommandAdmission
      : {
          revision: signal(0),
          runWhenSettled: <T,>(operation: () => T): T => operation(),
        })
  const settledReader = overrides.settledReader
    ?? ('readWhenSettled' in sceneEdits
      ? sceneEdits as unknown as SettledSceneReader
      : {
          revision: signal(0),
          readWhenSettled: <T,>(operation: () => T): T => operation(),
        })

  return {
    container,
    getSceneStore: () => store,
    frames: view.frames,
    viewNavigation: view.navigation,
    getSpeciesCache: () => new Map(),
    getPlantPresentationContext: overrides.getPlantPresentationContext ?? createPlantPresentationContext,
    getSelection: () => selection.map((target) => ({ ...target })),
    setSelection,
    clearSelection,
    sceneEdits,
    commandAdmission,
    settledReader,
    getDesignObjectSelection: overrides.getDesignObjectSelection ?? (() =>
      getDesignObjectSelectionFromStore(store, view)
    ),
    selectionCommands: overrides.selectionCommands ?? {
      copy: vi.fn(),
      pasteAt: vi.fn(),
      canPaste: vi.fn(() => false),
      duplicateSelected: vi.fn(),
      toggleSelectedPlantNamePins: vi.fn(),
      deleteSelected: vi.fn(),
      selectAll: vi.fn(),
      bringToFront: vi.fn(),
      sendToBack: vi.fn(),
      selectSameSpecies: vi.fn(),
      lockSelected: vi.fn(),
      unlockSelected: vi.fn(),
      groupSelected: vi.fn(),
      ungroupSelected: vi.fn(),
      renameZone: vi.fn(() => true),
      rotateSelected: vi.fn(),
    },
    contextMenu: overrides.contextMenu ?? contextMenuHost.adapter,
    setTool: (overrides.setTool ?? ((name: string) => {
      void name
    })) as SceneInteractionSessionDeps['setTool'],
    render,
    readSnapToGridEnabled: () => snapToGridEnabled.value,
    readPlantSpacingIntervalMeters: overrides.readPlantSpacingIntervalMeters ?? (() => plantSpacingIntervalM.value),
    commitPlantSpacingIntervalMeters: overrides.commitPlantSpacingIntervalMeters ?? ((meters) => {
      plantSpacingIntervalM.value = meters
    }),
    translate: overrides.translate ?? t,
    setHoveredTarget: overrides.setHoveredTarget ?? (() => {}),
    getLocalizedCommonNames: () => new Map(),
    publishToolGuidance: overrides.publishToolGuidance ?? setCanvasToolGuidance,
    publishDesignPinHover: overrides.publishDesignPinHover ?? (() => {}),
    nudge: overrides.nudge ?? { nudgeSelected: vi.fn(() => true), endNudge: vi.fn() },
    renderer: createRecordingRenderer(),
    readScrollWheel: () => 'zoom',
    notifyTransientHistoryChange: () => {},
  }
}

/**
 * Zooms the test view to 0.05 px/m, below the overview line (0.1 px/m), keeping the plane origin's screen point, as a zoom-out
 * would reach overview; returns the step back to the site placement.
 */
export function enterOverview(view: Pick<TestView, 'viewport' | 'setViewport'>): () => void {
  const site = view.viewport()
  view.setViewport({ ...site, scale: 0.05 })
  return () => view.setViewport(site)
}

export function createSelectionCommands(
  overrides: Partial<SceneInteractionSessionDeps['selectionCommands']> = {},
): SceneInteractionSessionDeps['selectionCommands'] {
  return {
    copy: vi.fn(),
    pasteAt: vi.fn(),
    canPaste: vi.fn(() => false),
    duplicateSelected: vi.fn(),
    toggleSelectedPlantNamePins: vi.fn(),
    deleteSelected: vi.fn(),
    selectAll: vi.fn(),
    bringToFront: vi.fn(),
    sendToBack: vi.fn(),
    selectSameSpecies: vi.fn(),
    lockSelected: vi.fn(),
    unlockSelected: vi.fn(),
    groupSelected: vi.fn(),
    ungroupSelected: vi.fn(),
    renameZone: vi.fn(() => true),
    rotateSelected: vi.fn(),
    ...overrides,
  }
}

export function plantTarget(id: string): SceneDesignObjectTarget {
  return { kind: 'plant', id }
}

export function zoneTarget(id: string): SceneDesignObjectTarget {
  return { kind: 'zone', id }
}

export function annotationTarget(id: string): SceneDesignObjectTarget {
  return { kind: 'annotation', id }
}

export function measurementGuideTarget(id: string): SceneDesignObjectTarget {
  return { kind: 'measurement-guide', id }
}

export function groupTarget(id: string): SceneDesignObjectTarget {
  return { kind: 'group', id }
}

export function createAbortFailingSceneEdits(
  base: SceneEditCoordinator,
  targetType: string,
  failureMessage: string,
  failureMode: 'first' | 'always' = 'first',
): {
  readonly sceneEdits: SceneEditCoordinator
  readonly abortCalls: () => number
  readonly beginCalls: () => number
  readonly beginTypes: () => readonly string[]
} {
  let abortCallCount = 0
  let beginCallCount = 0
  const beginTypes: string[] = []
  return {
    sceneEdits: {
      run: (type, edit, options) => base.run(type, edit, options),
      begin(type, options) {
        beginTypes.push(type)
        const transaction = base.begin(type, options)
        if (type !== targetType) return transaction
        beginCallCount += 1
        return {
          mutate: (edit) => transaction.mutate(edit),
          setSelection: (ids) => transaction.setSelection(ids),
          commit: () => transaction.commit(),
          get changed() {
            return transaction.changed
          },
          abort() {
            abortCallCount += 1
            if (failureMode === 'always' || abortCallCount === 1) throw new Error(failureMessage)
            transaction.abort()
          },
        } satisfies SceneEditTransaction
      },
    },
    abortCalls: () => abortCallCount,
    beginCalls: () => beginCallCount,
    beginTypes: () => [...beginTypes],
  }
}

export function withoutNativeRandomUUID(action: () => void): void {
  const originalCrypto = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    // The browser's own method, so the stub keeps whatever signature the DOM lib gives it.
    value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
  })

  try {
    action()
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    })
  }
}

/**
 * The plant tooltip the ToolHost's passive hover shows (chrome/hover-tooltip.ts); it joins the window's hover card
 * layer at its first show.
 */
export function plantHoverTooltip(): HTMLElement {
  const tooltip = document.querySelector<HTMLElement>('[data-hover-card-layer] > [data-canvas-chrome="hover-tooltip"]')
  if (!tooltip) throw new Error('Expected Plant Hover Tooltip')
  return tooltip
}

export function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

export function captureWindowErrors(action: () => void): unknown[] {
  const errors: unknown[] = []
  const capture = (event: ErrorEvent): void => {
    errors.push(event.error)
    event.preventDefault()
  }
  window.addEventListener('error', capture)
  try {
    action()
  } finally {
    window.removeEventListener('error', capture)
  }
  return errors
}

export function makePlant(
  id: string,
  canonicalName: string,
  position: { x: number; y: number },
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

export function makeRectZone(
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

export function makeTextAnnotation(
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

export function makeMeasurementGuide(
  id: string,
  start: ScenePoint,
  end: ScenePoint,
  overrides: Partial<SceneMeasurementGuideEntity> = {},
): SceneMeasurementGuideEntity {
  return {
    kind: 'measurement-guide',
    id,
    locked: false,
    start,
    end,
    ...overrides,
  }
}

export function getDesignObjectSelectionFromStore(
  store: SceneStore,
  view: TestView,
): CanvasDesignObjectSelectionModel {
  const scale = view.view().pixelsPerMetre
  return getDesignObjectSelectionModel(
    store.persisted,
    store.session.selectedTargets,
    {
      annotationViewportScale: scale,
      plantContext: createPlantPresentationContext(scale),
    },
  )
}

/** The rotation handle the ToolHost shows through the handle layer, or null while Select hides it. */
export function rotationHandle(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-canvas-handle="rotate"]')
}

/** The centre of the rotation handle's hit box: 28 px after a mouse, 44 px after a finger. */
export function rotationHandleCenter(container: HTMLElement): ScenePoint {
  const handle = rotationHandle(container)
  if (!handle) throw new Error('Expected rotation handle to be visible')
  const left = Number.parseFloat(handle.style.left)
  const top = Number.parseFloat(handle.style.top)
  const width = Number.parseFloat(handle.style.width)
  const height = Number.parseFloat(handle.style.height)
  if (![left, top, width, height].every(Number.isFinite)) {
    throw new Error('Expected rotation handle to be positioned and sized')
  }
  return {
    x: left + width / 2,
    y: top + height / 2,
  }
}

/** The reshape handle id's prefix and last part for today's control-point `kind` and `index` (tools/select/reshape.ts). */
function zoneControlPointId(kind: string, index: number): { readonly prefix: string; readonly suffix: string } {
  switch (kind) {
    case 'line-endpoint':
    case 'polygon-vertex': return { prefix: 'vertex', suffix: String(index) }
    case 'rect-corner': return { prefix: 'rect-corner', suffix: ['nw', 'ne', 'se', 'sw'][index] ?? '' }
    case 'ellipse-east':
    case 'ellipse-west':
    case 'ellipse-north':
    case 'ellipse-south': return { prefix: 'ellipse-axis', suffix: kind.slice('ellipse-'.length) }
    default: throw new Error(`Unknown Zone Control Point kind ${kind}`)
  }
}

/** The selected zone's reshape handle of today's `kind` and `index`. */
export function zoneControlPoint(container: HTMLElement, kind: string, index: number): HTMLElement | null {
  const { prefix, suffix } = zoneControlPointId(kind, index)
  return container.querySelector<HTMLElement>(`[data-canvas-handle^="${prefix}:"][data-canvas-handle$=":${suffix}"]`)
}

export function zoneControlPointCenter(container: HTMLElement, kind: string, index: number): ScenePoint {
  const handle = zoneControlPoint(container, kind, index)
  if (!handle) throw new Error(`Expected ${kind} Zone Control Point ${index}`)
  return handleAnchor(handle)
}

/** The selected guide's end handle: 0 its start, 1 its end. */
export function measurementGuideControlPoint(container: HTMLElement, index: number): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-canvas-handle^="guide-end:"][data-canvas-handle$=":${index === 0 ? 'a' : 'b'}"]`)
}

export function measurementGuideControlPointCenter(container: HTMLElement, index: number): ScenePoint {
  const handle = measurementGuideControlPoint(container, index)
  if (!handle) throw new Error(`Expected Measurement Guide Control Point ${index}`)
  return handleAnchor(handle)
}

function handleAnchor(handle: HTMLElement): ScenePoint {
  const screenX = Number.parseFloat(handle.dataset.canvasHandleScreenX ?? '')
  const screenY = Number.parseFloat(handle.dataset.canvasHandleScreenY ?? '')
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) throw new Error('Expected the handle to be positioned')
  return { x: screenX, y: screenY }
}

/** The shapes of the last draft the session handed the renderer (drafts draw in Pixi, plan section 1, exception 2). */
export function draftShapes(deps: SceneInteractionTestDeps): readonly DraftShape[] {
  return deps.renderer.lastDraft()?.shapes ?? []
}

/** The chips of the last draft, in draw order. */
export function draftLabelTexts(deps: SceneInteractionTestDeps): string[] {
  return draftShapes(deps).flatMap((shape) => (shape.kind === 'label' ? [shape.text] : []))
}

export function selectionBoundsCenter(selection: CanvasDesignObjectSelectionModel): ScenePoint {
  if (!selection.bounds) throw new Error('Expected selection bounds')
  return {
    x: selection.bounds.minX + (selection.bounds.maxX - selection.bounds.minX) / 2,
    y: selection.bounds.minY + (selection.bounds.maxY - selection.bounds.minY) / 2,
  }
}

export function quarterTurnClockwise(pivot: ScenePoint, point: ScenePoint): ScenePoint {
  const dx = point.x - pivot.x
  const dy = point.y - pivot.y
  return {
    x: pivot.x - dy,
    y: pivot.y + dx,
  }
}

export function expectPointCloseTo(actual: ScenePoint | undefined, expected: ScenePoint): void {
  expect(actual?.x).toBeCloseTo(expected.x)
  expect(actual?.y).toBeCloseTo(expected.y)
}

export function pointsCenter(points: readonly ScenePoint[]): ScenePoint {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  return {
    x: minX + (maxX - minX) / 2,
    y: minY + (maxY - minY) / 2,
  }
}

/** The describe-scope state of the Scene Interaction suites, rebuilt before each test. */
export interface SceneInteractionFixtureState {
  readonly container: HTMLDivElement
  readonly testView: TestView
  readonly store: SceneStore
  readonly events: SceneInteractionEventHarness
  readonly sessions: SceneInteractionSession[]
  readonly toolCardHost: HTMLDivElement
  readonly flushToolCard: () => void
}

/**
 * Installs the shared fixture of a `SceneInteractionSession` suite: registers its
 * `beforeEach` and `afterEach` hooks and returns its helpers. `assign` receives the
 * fresh state before each test; `live` returns the suite's current `events`, which
 * test bodies may replace, so the hooks and helpers read `events` only through it.
 */
export function installSceneInteractionFixture(
  assign: (fixture: SceneInteractionFixtureState) => void,
  live: () => { readonly events: SceneInteractionEventHarness },
) {
  let container: HTMLDivElement
  let testView: TestView
  let store: SceneStore
  let events: SceneInteractionEventHarness
  let sessions: SceneInteractionSession[]

  let toolCardHost: HTMLDivElement
  let flushToolCard: () => void
  /** The app's own menu, once a test asks for it (appContextMenu). */
  let appMenuHost: HTMLDivElement | null = null
  let keyRouter: KeyRouterHandle
  let releaseMapRegion: () => void
  /** The edition's command sink under the canvas rows: records what a key runs there and consumes nothing. */
  const keyCommands = vi.fn((_command: string): boolean => false)

  function createTestSession(deps: SceneInteractionSessionDeps): SceneInteractionSession {
    const session = createSceneInteractionSession(deps)
    renderedSession = session
    // The runtime mirrors the session's tool for the tool card, as the command surface does.
    const setTool = session.setTool.bind(session)
    session.setTool = (name) => {
      setTool(name)
      setCanvasTool(name)
    }
    sessions.push(session)
    return session
  }

  /** The shared tool card, rendered beside the map as the workspace does. */
  function toolCard(): HTMLElement | null {
    flushToolCard()
    return document.querySelector<HTMLElement>('[data-tool-card]')
  }

  /** Plant a row's spacing field in the tool card. */
  function spacingInput(): HTMLInputElement | null {
    return toolCard()?.querySelector<HTMLInputElement>('[data-plant-spacing-interval-input]') ?? null
  }

  /** Types into the spacing field as a user does. */
  function typeSpacing(value: string): void {
    const input = spacingInput()!
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushToolCard()
  }

  /**
   * The app's own right-click menu (components/canvas/CanvasContextMenu over app/canvas-context-menu/state), rendered as
   * the workspace renders it, for a test that presses keys in the real menu: pass `adapter` as the deps' contextMenu.
   * `item` and `isOpen` read the rendered menu after the pending renders.
   */
  function appContextMenu() {
    if (!appMenuHost) {
      appMenuHost = document.body.appendChild(document.createElement('div'))
      renderPreact(h(CanvasContextMenu, { profileLine: undefined }), appMenuHost)
    }
    return {
      adapter: { open: openCanvasContextMenu, close: closeCanvasContextMenu } satisfies CanvasRuntimeContextMenuAdapter,
      item(id: string): HTMLElement | null {
        flushToolCard()
        return document.querySelector<HTMLElement>(`[role="menu"] [data-command="${id}"]`)
      },
      isOpen(): boolean {
        flushToolCard()
        return document.querySelector('[role="menu"]') !== null
      },
    }
  }

  /** A still right-click at a container point, as Windows sends it: the press, the release (which opens the canvas menu)
   *  and the trailing native contextmenu, which the source prevents; returns the contextmenu. */
  function openContextMenu(screen: ScenePoint): MouseEvent {
    const harness = live().events
    harness.pointerDown(screen, { button: 2 })
    harness.pointerUp(screen, { button: 2 })
    return dispatchContextMenu(container, harness.clientPoint(screen))
  }

  /** The Menu key while the map has focus: the menu for the current selection. */
  function openContextMenuFromKeyboard(): KeyboardEvent {
    container.tabIndex = -1
    container.focus()
    return live().events.keyDown({ key: 'ContextMenu', cancelable: true, target: container })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    events = createSceneInteractionEventHarness(container)
    flushToolCard = setupRerender()
    const latest = () => sessions[sessions.length - 1]?.plantRowSpacing
    const latestPath = () => sessions[sessions.length - 1]?.plantRowPath
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface({
        tools: {
          plantRowSpacing: {
            input: (text) => latest()?.input(text),
            commit: (text) => latest()?.commit(text),
            blur: (text) => latest()?.blur(text),
            cancel: () => latest()?.cancel(),
          },
          plantRowPath: {
            finish: () => latestPath()?.finish(),
            setMode: (mode) => latestPath()?.setMode(mode),
          },
        },
      }),
      queries: createTestCanvasQuerySurface(),
      documents: createTestCanvasDocumentSurface(),
      keyboard: createTestCanvasKeyboardPort(),
    })
    toolCardHost = document.createElement('div')
    document.body.appendChild(toolCardHost)
    // The map host is the focus owner's map region, as CanvasChrome registers it.
    releaseMapRegion = focusOwner.registerRegion('map', container)
    renderPreact(h(ToolCard, { stampChooser: undefined }), toolCardHost)
    contextMenuHost.reset()

    testView = createTestView({ screen: { width: 400, height: 300 }, viewport: { x: 0, y: 0, scale: 1 } })
    store = new SceneStore()
    sessions = []
    currentCanvasSelection.value = new Set()
    clearPlantStampSource()
    clearSavedObjectStampSource()
    snapToGridEnabled.value = false
    plantSpacingIntervalM.value = 0.5
    singleKeyShortcuts.value = true
    // The app's key router, with the canvas rows only: keys reach the latest session's port as they do in the workspace.
    keyCommands.mockClear()
    keyRouter = installKeyRouter({
      target: window,
      keymap: CANVAS_KEYMAP_ROWS,
      commands: { run: keyCommands },
      canvas: () => sessions.at(-1)?.keyboard ?? null,
      singleKeys: singleKeyShortcuts,
      focus: { cycleRegion: () => false },
      isModalOpen: () => false,
      platform: TEST_KEY_PLATFORM,
      document,
    })
    assign({ container, testView, store, events, sessions, toolCardHost, flushToolCard })
  })

  afterEach(() => {
    renderedSession = null
    keyRouter.dispose()
    singleKeyShortcuts.value = true
    const disposalErrors: unknown[] = []
    for (const session of sessions.reverse()) {
      try {
        session.dispose()
      } catch (error) {
        disposalErrors.push(error)
      }
    }
    live().events.dispose()
    renderPreact(null, toolCardHost)
    toolCardHost.remove()
    if (appMenuHost) {
      closeCanvasContextMenu()
      renderPreact(null, appMenuHost)
      appMenuHost.remove()
      appMenuHost = null
    }
    releaseMapRegion()
    teardownPreactTestUtils()
    setCurrentCanvasSession(null)
    setCanvasTool('select')
    setCanvasToolGuidance(IDLE_CANVAS_TOOL_GUIDANCE)
    container.remove()
    currentCanvasSelection.value = new Set()
    clearPlantStampSource()
    clearSavedObjectStampSource()
    snapToGridEnabled.value = false
    plantSpacingIntervalM.value = 0.5
    if (disposalErrors.length > 0) throw disposalErrors[0]
  })

  return {
    createTestSession,
    toolCard,
    spacingInput,
    typeSpacing,
    openContextMenu,
    openContextMenuFromKeyboard,
    appContextMenu,
    keyCommands,
  }
}
