import { buildCanvasPrintSnapshot } from './print-snapshot'
import { getCanvasPlantNameLabels } from './automatic-detail'
import { isPlantLayerShown } from './scene-visuals'
import { isWorkspaceOverviewScale } from '../workspace-camera-policy'
import type { PlacedPlant } from '../../types/design'
import type { SelectedPlantColorContext } from '../plant-color-context'
import type { SelectedPlantSymbolContext } from '../plant-symbol-context'
import type {
  CanvasDesignObjects,
  CanvasDesignObjectSelectionModel,
  CanvasPlantLabelCoverage,
  CanvasQueryRevision,
  CanvasQuerySurface,
  CanvasViewSceneRequest,
} from './runtime'
import type {
  SceneDocumentReader,
  SceneDesignObjectTarget,
  ScenePersistedState,
  SceneStateReader,
} from './scene'
import type { PointerWorld } from './interaction-ports'
import type { SceneRuntimeMutationController } from './scene-runtime/mutations'
import type { SceneRuntimePresentationController } from './scene-runtime/presentation'
import { EMPTY_SELECTION_MODEL, getDesignObjectSelectionModel } from './scene-runtime/selection'
import type { SettledSceneReader } from './scene-runtime/transactions'
import { createViewReadSurface } from './view/frame-source'
import type { ViewReadSurface } from './view/read-surface'
import type { ViewFrameSource } from './view/types'
import type { SpeciesCacheEntry } from './species-cache'

type PointerWorldListener = (point: PointerWorld | null) => void

interface SceneCanvasQuerySurfaceOptions {
  readonly revision: CanvasQueryRevision
  readonly sceneStore: SceneStateReader & SceneDocumentReader
  /** The runtime camera's frames: `view`, the label coverage and the frame's scale (which sizes screen-sized notes in
   *  the selection model) read them. */
  readonly frames: ViewFrameSource
  readonly settledReader: SettledSceneReader
  readonly mutations: Pick<
    SceneRuntimeMutationController,
    'getSelectedPlantColorContext' | 'getSelectedPlantSymbolContext'
  >
  readonly presentation: Pick<
    SceneRuntimePresentationController,
    | 'createPlantPresentationContext'
    | 'getLocalizedCommonNames'
    | 'getSpeciesCache'
    | 'getEnglishFallbackNames'
    | 'buildViewCaptureSnapshot'
    | 'buildRendererSnapshot'
  >
}

/**
 * The runtime's query surface. It outlives interaction sessions (the map can unmount and mount again): subscribePointerWorld
 * listeners stay with the surface, and scene-runtime.ts binds the live session's ToolHost.subscribePointerWorld to it with
 * bindPointerWorld (null when the session ends).
 */
export interface SceneCanvasQuerySurface extends CanvasQuerySurface {
  bindPointerWorld(source: ((listener: PointerWorldListener) => () => void) | null): void
}

export function createSceneCanvasQuerySurface(options: SceneCanvasQuerySurfaceOptions): SceneCanvasQuerySurface {
  return new SceneCanvasQueryRole(options)
}

class SceneCanvasQueryRole implements SceneCanvasQuerySurface {
  readonly view: ViewReadSurface
  private readonly pointerWorldListeners = new Set<PointerWorldListener>()
  private stopPointerWorld: (() => void) | null = null
  /** The point last published; a session that ends with one live publishes null, so nothing reads a point no cursor is at. */
  private lastPointerWorld: PointerWorld | null = null

  constructor(private readonly options: SceneCanvasQuerySurfaceOptions) {
    // The frames place the Scene's metres; their ground is read on the Scene's plane.
    this.view = createViewReadSurface(options.frames)
  }

  subscribePointerWorld(listener: PointerWorldListener): () => void {
    this.pointerWorldListeners.add(listener)
    return () => {
      this.pointerWorldListeners.delete(listener)
    }
  }

  bindPointerWorld(source: ((listener: PointerWorldListener) => () => void) | null): void {
    this.stopPointerWorld?.()
    this.stopPointerWorld = null
    if (this.lastPointerWorld) this.publishPointerWorld(null)
    this.stopPointerWorld = source?.((point) => this.publishPointerWorld(point)) ?? null
  }

  private publishPointerWorld(point: PointerWorld | null): void {
    this.lastPointerWorld = point
    for (const listener of [...this.pointerWorldListeners]) listener(point)
  }

  get revision(): CanvasQueryRevision { return this.options.revision }
  get sessionPlane() { return this.options.sceneStore.sessionPlaneSignal }
  capturePrintSnapshot() {
    void this.options.settledReader.revision.value
    return this.options.settledReader.readWhenSettled(() => {
      const scene = this.options.sceneStore.persisted
      return buildCanvasPrintSnapshot(
        scene,
        this.options.presentation.createPlantPresentationContext(1, scene.plants),
      )
    }, null)
  }
  captureViewScene(request: CanvasViewSceneRequest) {
    void this.options.settledReader.revision.value
    const { view, ...layers } = request
    const overview = isWorkspaceOverviewScale(view.pixelsPerMetre)
    return this.options.settledReader.readWhenSettled(
      () => this.options.presentation.buildViewCaptureSnapshot({ ...layers, overview }),
      null,
    )
  }
  sceneHasObjects(): boolean { return this.options.sceneStore.hasObjects }
  getSceneSnapshot(): ScenePersistedState {
    // A reader in a component, computed or effect follows each Scene Edit (a Species Key recolour reaches the tool card).
    void this.options.revision.scene.value
    return this.options.sceneStore.persisted
  }
  getSpeciesFocus() { return this.options.sceneStore.session.speciesFocus }
  getPlantLabelCoverage(): CanvasPlantLabelCoverage {
    const { view, mode } = this.options.frames.viewFrame.peek()
    const { width, height } = view.screen
    if (mode === 'overview' || width <= 0 || height <= 0) return { labelled: 0, inView: 0 }
    const snapshot = this.options.presentation.buildRendererSnapshot()
    if (!isPlantLayerShown(snapshot.scene)) return { labelled: 0, inView: 0 }
    const inView = new Set<string>()
    for (const plant of snapshot.scene.plants) {
      const point = view.worldToScreen(plant.position)
      if (point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height) inView.add(plant.id)
    }
    const labelled = new Set(getCanvasPlantNameLabels(snapshot, view.pixelsPerMetre)
      .filter((label) => inView.has(label.plantId))
      .map((label) => label.plantId))
    return { labelled: labelled.size, inView: inView.size }
  }
  getSelection(): SceneDesignObjectTarget[] {
    return this.options.sceneStore.session.selectedTargets.map((target) => ({ ...target }))
  }
  getDesignObjectSelection(): CanvasDesignObjectSelectionModel {
    const selectedTargets = this.options.sceneStore.session.selectedTargets
    if (selectedTargets.length === 0) return EMPTY_SELECTION_MODEL
    const viewportScale = this.options.frames.viewFrame.peek().view.pixelsPerMetre
    const scene = this.options.sceneStore.persisted
    return getDesignObjectSelectionModel(
      scene,
      selectedTargets,
      {
        annotationViewportScale: viewportScale,
        plantContext: this.options.presentation.createPlantPresentationContext(viewportScale, scene.plants),
      },
    )
  }
  getSelectedPlantColorContext(): SelectedPlantColorContext {
    return this.options.mutations.getSelectedPlantColorContext()
  }
  getSelectedPlantSymbolContext(): SelectedPlantSymbolContext {
    return this.options.mutations.getSelectedPlantSymbolContext()
  }
  getPlacedPlants(): PlacedPlant[] { return this.options.sceneStore.toCanopiFile().plants }
  getSettledPlacedPlants(): PlacedPlant[] | null {
    void this.options.settledReader.revision.value
    return this.options.settledReader.readWhenSettled(
      () => this.options.sceneStore.toCanopiFile().plants,
      null,
    )
  }
  getSettledDesignObjects(): CanvasDesignObjects | null {
    return this.options.settledReader.readWhenSettled(() => {
      const file = this.options.sceneStore.toCanopiFile()
      return {
        plants: file.plants,
        zones: file.zones,
        annotations: file.annotations,
        measurementGuides: file.measurement_guides ?? [],
        groups: file.groups,
      }
    }, null)
  }
  getLocalizedCommonNames(): ReadonlyMap<string, string | null> {
    return this.options.presentation.getLocalizedCommonNames()
  }
  getSpeciesCache(): ReadonlyMap<string, SpeciesCacheEntry> {
    return this.options.presentation.getSpeciesCache()
  }
  getEnglishFallbackNames(): ReadonlyMap<string, string> {
    return this.options.presentation.getEnglishFallbackNames()
  }
}
