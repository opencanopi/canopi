import { buildCanvasPrintSnapshot } from '../../canvas/runtime/print-snapshot'
import { createTestSceneRendererSnapshot } from './scene-renderer-snapshot'
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals'
import {
  createDefaultScenePersistedState,
  type SceneDesignObjectSelection,
  type ScenePersistedState,
} from '../../canvas/runtime/scene'
import type {
  CanvasPlantLabelCoverage,
  CanvasQuerySurface,
} from '../../canvas/runtime/runtime'
import type { PointerWorld, ToolHostState } from '../../canvas/runtime/interaction-ports'
import type { ToolId, ToolSource } from '../../canvas/runtime/interaction-types'
import type { PlacedPlant } from '../../types/design'
import type { SpeciesCacheEntry } from '../../canvas/runtime/presentation-data'
import { createViewReadSurface } from '../../geo/view/frame-source'
import type { ViewReadSurface } from '../../geo/view/read-surface'
import type { ViewFrame, ViewFrameSource, ViewScreen, WorldPoint } from '../../geo/view/types'
import { planarToViewCamera } from '../../geo/view/camera-math'
import { buildViewTransform } from '../../geo/view/view-transform'
import { createSessionPlane, type SessionPlane } from '../../geo/session-plane'
import { TEST_GEO_ORIGIN } from './geo-design'

/** A bearing-0 placement in today's terms: screen = world × scale + { x, y }. */
export interface TestPlacement { readonly x: number; readonly y: number; readonly scale: number }

interface TestCanvasQuerySurfaceOptions {
  readonly scene?: ScenePersistedState
  /** The view's placement. Default { x: 0, y: 0, scale: 1 }; below 0.1 px/m the view is in overview. */
  readonly placement?: TestPlacement
  /** The view's screen in CSS px. Default 400 x 300. */
  readonly screen?: { readonly width: number; readonly height: number }
  readonly plants?: readonly PlacedPlant[]
  readonly localizedNames?: ReadonlyMap<string, string | null>
  /** English catalog names shown for species with no name in the active locale. */
  readonly englishFallbackNames?: ReadonlyMap<string, string>
  readonly selection?: SceneDesignObjectSelection
  /** Defaults to a plane at the shared test origin; pass `null` for no Design frame. */
  readonly sessionPlane?: SessionPlane | null
  readonly plantLabelCoverage?: CanvasPlantLabelCoverage
  /** The catalog entries the runtime has loaded for the Design's species. */
  readonly speciesCache?: ReadonlyMap<string, SpeciesCacheEntry>
  /** Initial active canvas tool; defaults to 'select'. */
  readonly activeTool?: ToolId
}

export type TestCanvasQuerySurface = CanvasQuerySurface & {
  /** Writable: the fake's `view` reads its ground on this plane, so a test sets it instead of spreading another signal in. */
  readonly sessionPlane: Signal<SessionPlane | null>
  /** Writable: the fake's tool state, mirroring ToolHost's single state signal. */
  readonly toolState: Signal<ToolHostState>
  /** Writable: the fake's active tool, mirroring ToolHost's single activeTool signal. */
  readonly activeTool: Signal<ToolId>
  setActiveTool(tool: ToolId, source?: ToolSource | null): void
  emitEmptyGroundTap(world: WorldPoint): void
  /** Moves the fake's view to this placement, as a camera move would. */
  setPlacement(placement: TestPlacement): void
  bumpSceneRevision(): void
  bumpPlantNamesRevision(): void
  /** Moves the transient history, as the runtime does after each tool call. */
  bumpTransientHistory(): void
  setSettled(settled: boolean): void
  setPlants(plants: readonly PlacedPlant[]): void
  setLocalizedNames(names: ReadonlyMap<string, string | null>): void
  setEnglishFallbackNames(names: ReadonlyMap<string, string>): void
  setSelection(selection: SceneDesignObjectSelection): void
  /** Publishes the pointer to subscribePointerWorld, as the interaction session's ToolHost does. */
  emitPointerWorld(point: PointerWorld | null): void
}

export function createTestCanvasQuerySurface({
  scene = createDefaultScenePersistedState(),
  placement = { x: 0, y: 0, scale: 1 },
  screen = DEFAULT_SCREEN,
  plants = [],
  localizedNames = new Map(),
  englishFallbackNames = new Map(),
  selection = [],
  sessionPlane = createSessionPlane(TEST_GEO_ORIGIN),
  plantLabelCoverage = { labelled: 0, inView: 0 },
  speciesCache = new Map(),
  activeTool = 'select',
}: TestCanvasQuerySurfaceOptions = {}): TestCanvasQuerySurface {
  const sessionPlaneSignal = signal<SessionPlane | null>(sessionPlane)
  const toolStateSignal = signal<ToolHostState>({ id: activeTool, source: null })
  const activeToolSignal = signal<ToolId>(activeTool)
  const sceneRevision = signal(0)
  const plantNamesRevision = signal(0)
  const transientHistoryRevision = signal(0)
  const placementSignal = signal<TestPlacement>(placement)
  const admissionRevision = signal(0)
  const revision = {
    scene: sceneRevision,
    plantNames: plantNamesRevision,
    transientHistory: transientHistoryRevision,
  }
  let currentPlants = [...plants]
  let currentLocalizedNames = localizedNames
  let currentEnglishFallbackNames = englishFallbackNames
  let currentSelection = selection.map((target) => ({ ...target }))
  let settled = true
  const pointerWorldListeners = new Set<(point: PointerWorld | null) => void>()
  const emptyGroundTapListeners = new Set<(world: WorldPoint) => void>()

  return {
    revision,
    toolState: toolStateSignal,
    activeTool: activeToolSignal,
    setActiveTool: (tool, source) => {
      const prev = toolStateSignal.peek()
      const nextSource = source !== undefined ? source : (prev.id === tool ? prev.source : null)
      toolStateSignal.value = { id: tool, source: nextSource }
      activeToolSignal.value = tool
    },
    view: createFollowingTestView(placementSignal, { ...screen, devicePixelRatio: 1 }, sessionPlaneSignal),
    sessionPlane: sessionPlaneSignal,
    getSpeciesFocus: () => ({ canonicalName: null }),
    getPlantLabelCoverage: () => plantLabelCoverage,
    capturePrintSnapshot: () => {
      void admissionRevision.value
      return settled ? buildCanvasPrintSnapshot(scene, { pixelsPerMetre: placement.scale, speciesCache: new Map() }) : null
    },
    captureViewScene: (request) => {
      void admissionRevision.value
      if (!settled) return null
      const visible = new Set(request.visibleLayerNames)
      return createTestSceneRendererSnapshot({
        scene: { ...scene, layers: scene.layers.map((layer) => ({ ...layer, visible: visible.has(layer.name) })) },
        speciesFocus: { canonicalName: request.focusedSpecies },
      })
    },
    sceneHasObjects: () => scene.plants.length > 0 || scene.annotations.length > 0 || scene.measurementGuides.length > 0
      || scene.zones.some((zone) => zone.points.length > 0),
    getSceneSnapshot: () => scene,
    getSelection: () => currentSelection.map((target) => ({ ...target })),
    getDesignObjectSelection: () => ({
      // The selection as the runtime models it; this surface has no locks.
      editableTargets: currentSelection.map((target) => ({ ...target })),
      lockedTargets: [],
      blockedTargets: [],
      bounds: null,
      sameSpeciesReferenceCanonicalName: null,
      plantNamePinning: {
        plantIds: [],
        allPinned: false,
      },
    }),
    getSelectedPlantColorContext: () => ({
      plantIds: currentSelection
        .filter((target) => target.kind === 'plant')
        .map((target) => target.id),
      singleSpeciesCanonicalName: null,
      singleSpeciesCommonName: null,
      sharedCurrentColor: null,
      suggestedColor: null,
      singleSpeciesDefaultColor: null,
    }),
    getSelectedPlantSymbolContext: () => ({
      plantIds: [],
      singleSpeciesCanonicalName: null,
      singleSpeciesCommonName: null,
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'round',
      inheritedSymbol: null,
      singleSpeciesDefaultSymbol: null,
      canClearSelectedSymbol: false,
    }),
    getPlacedPlants: () => [...currentPlants],
    getSettledPlacedPlants: () => {
      void admissionRevision.value
      return settled ? [...currentPlants] : null
    },
    getSettledDesignObjects: () => {
      void admissionRevision.value
      return settled
        ? { plants: [...currentPlants], zones: [], annotations: [], measurementGuides: [], groups: [] }
        : null
    },
    getLocalizedCommonNames: () => currentLocalizedNames,
    getSpeciesCache: () => speciesCache,
    getEnglishFallbackNames: () => currentEnglishFallbackNames,
    setPlacement: (next) => {
      placementSignal.value = next
    },
    bumpSceneRevision: () => {
      sceneRevision.value += 1
    },
    bumpPlantNamesRevision: () => {
      plantNamesRevision.value += 1
    },
    bumpTransientHistory: () => {
      transientHistoryRevision.value += 1
    },
    setSettled: (nextSettled) => {
      if (settled === nextSettled) return
      settled = nextSettled
      admissionRevision.value += 1
    },
    setPlants: (nextPlants) => {
      currentPlants = [...nextPlants]
    },
    setLocalizedNames: (names) => {
      currentLocalizedNames = names
    },
    setEnglishFallbackNames: (names) => {
      currentEnglishFallbackNames = names
    },
    setSelection: (nextSelection) => {
      currentSelection = nextSelection.map((target) => ({ ...target }))
    },
    subscribePointerWorld: (listener) => {
      pointerWorldListeners.add(listener)
      return () => {
        pointerWorldListeners.delete(listener)
      }
    },
    emitPointerWorld: (point) => {
      for (const listener of [...pointerWorldListeners]) listener(point)
    },
    subscribeEmptyGroundTap: (listener) => {
      emptyGroundTapListeners.add(listener)
      return () => {
        emptyGroundTapListeners.delete(listener)
      }
    },
    emitEmptyGroundTap: (world) => {
      for (const listener of [...emptyGroundTapListeners]) listener(world)
    },
  }
}

/** A view read surface over the default fake's camera (400 x 300 at the identity placement), for literal fakes. */
export function createTestViewReadSurface(): ViewReadSurface {
  return createTestCanvasQuerySurface().view
}

const DEFAULT_SCREEN = Object.freeze({ width: 400, height: 300 })
const SCALE_BOUNDS = Object.freeze({ min: 0.00001, max: 2000 })
const OVERVIEW_BELOW_SCALE = 0.1
const NO_INSETS = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })
const FALLBACK_PLANE = createSessionPlane(TEST_GEO_ORIGIN)

/** The fake's `view` follows its placement and `sessionPlane` live, as the runtime's view follows its camera: a bearing-0 frame, settled at once. */
function createFollowingTestView(
  placement: ReadonlySignal<TestPlacement>,
  screen: ViewScreen,
  plane: ReadonlySignal<SessionPlane | null>,
): ViewReadSurface {
  let revision = 0
  const viewFrame = computed(() => testViewFrame(placement.value, screen, plane.value ?? FALLBACK_PLANE, ++revision))
  const frames: ViewFrameSource = { viewFrame, settledViewFrame: viewFrame, onViewFrame: () => () => {} }
  return createViewReadSurface(frames)
}

function testViewFrame(placement: TestPlacement, screen: ViewScreen, plane: SessionPlane, revision: number): ViewFrame {
  const view = buildViewTransform({
    camera: planarToViewCamera({ ...placement, bearingDeg: 0 }, screen, plane),
    screen,
    plane,
    planeRevision: 0,
  })
  return {
    view,
    mode: placement.scale < OVERVIEW_BELOW_SCALE ? 'overview' : 'site',
    scaleBounds: SCALE_BOUNDS,
    insets: NO_INSETS,
    attached: false,
    revision,
  }
}
