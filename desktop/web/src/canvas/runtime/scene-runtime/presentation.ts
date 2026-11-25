import { getRevealedAnnotationId } from '../annotation-layout'
import type { PlantPresentationContext } from '../plant-presentation'
import {
  createDetachedCanvasPlantLabelSource,
  createDetachedCanvasSpeciesPresentationCache,
  type CanvasPlantLabelSource,
  type CanvasSpeciesPresentationCache,
  type SpeciesCacheEntry,
} from '../presentation-data'
import type { SceneEditingAids, SceneRendererHoverTarget, SceneRendererSnapshot } from '../renderers/scene-types'
import type { PlantLabelMode } from '../plant-display'
import type {
  SceneDesignObjectTarget,
  ScenePersistedState,
  ScenePlantEntity,
  SceneStateReader,
} from '../scene'
import { isSceneDesignObjectLocked, isSceneTargetLayerLocked, sceneContainsTarget } from '../scene'
import { projectSceneSelectionEntityIds } from './selection'

interface SceneRuntimePresentationControllerOptions {
  sceneStore: SceneStateReader
  /** The live frame's scale, for plant presentation contexts (`view.pixelsPerMetre`). */
  readPixelsPerMetre(): number
  getLocale(): string
  resolveHighlightedTargets(scene: ScenePersistedState): {
    plantIds: readonly string[]
    zoneIds: readonly string[]
  }
  onPlantNamesChanged(): void
  speciesCache?: CanvasSpeciesPresentationCache
  plantLabels?: CanvasPlantLabelSource
}

export interface ScenePresentationRefreshResult {
  changed: boolean
  /** Advances when plant names or species data loaded: lists and colours that read them refresh on it. */
  plantNamesRevision: number
  failure: { readonly error: unknown } | null
}

export class SceneRuntimePresentationController {
  private readonly _sceneStore: SceneStateReader
  private readonly _readPixelsPerMetre: () => number
  private readonly _getLocale: () => string
  private readonly _resolveHighlightedTargets: SceneRuntimePresentationControllerOptions['resolveHighlightedTargets']
  private readonly _onPlantNamesChanged: () => void
  private readonly _speciesCache: CanvasSpeciesPresentationCache
  private readonly _plantLabels: CanvasPlantLabelSource
  private _preparedPlantNamesRevision = 0
  private _publishedPlantNamesRevision = 0
  /** Layers a presented story shows; null when nothing is presented. */
  private _presentedLayerNames: ReadonlySet<string> | null = null
  /** The workspace's grid (SceneCanvasRuntime's, while the chrome shows and the grid is on); null draws none. */
  private _editingAids: SceneEditingAids | null = null

  constructor(options: SceneRuntimePresentationControllerOptions) {
    this._sceneStore = options.sceneStore
    this._readPixelsPerMetre = options.readPixelsPerMetre
    this._getLocale = options.getLocale
    this._resolveHighlightedTargets = options.resolveHighlightedTargets
    this._onPlantNamesChanged = options.onPlantNamesChanged
    this._speciesCache = options.speciesCache ?? createDetachedCanvasSpeciesPresentationCache()
    this._plantLabels = options.plantLabels ?? createDetachedCanvasPlantLabelSource()
  }

  getSpeciesCache(): ReadonlyMap<string, SpeciesCacheEntry> {
    return this._speciesCache.getCache()
  }

  getLocalizedCommonNames(): ReadonlyMap<string, string | null> {
    return this._plantLabels.getLocaleSnapshot(this._getLocale())
  }

  getEnglishFallbackNames(): ReadonlyMap<string, string> {
    return this._plantLabels.getEnglishFallbackSnapshot(this._getLocale())
  }

  getSuggestedPlantColor(canonicalName: string): string | null {
    return this._speciesCache.getSuggestedPlantColor(canonicalName)
  }

  createPlantPresentationContext(
    viewportScale = this._readPixelsPerMetre(),
    plants: readonly ScenePlantEntity[] = this._sceneStore.persisted.plants,
  ): PlantPresentationContext {
    return {
      plants,
      pixelsPerMetre: viewportScale,
      speciesCache: this._speciesCache.getCache(),
      localizedCommonNames: this.getLocalizedCommonNames(),
    }
  }

  /**
   * While a story is presented the map shows only the named Design layers and
   * no selection, hover or measurement guides; null shows the Design as it is again. Session
   * presentation only: the Scene, its history and dirty state never change.
   * Returns whether anything changed.
   */
  presentLayers(visibleLayerNames: readonly string[] | null): boolean {
    const next = visibleLayerNames ? new Set(visibleLayerNames) : null
    const current = this._presentedLayerNames
    if (next === null && current === null) return false
    if (next && current && next.size === current.size && [...next].every((name) => current.has(name))) return false
    this._presentedLayerNames = next
    return true
  }

  /**
   * The grid the workspace map draws, the pattern of `presentLayers`: only the workspace snapshot carries it, never
   * the overview, a capture or a presented story. Returns whether it changed, so the caller syncs the scene only then.
   */
  setEditingAids(aids: SceneEditingAids | null): boolean {
    if (editingAidsEqual(this._editingAids, aids)) return false
    this._editingAids = aids
    return true
  }

  buildRendererSnapshot(options: { overview?: boolean } = {}): SceneRendererSnapshot {
    const presented = this._presentedLayerNames
    if (presented) return this.buildPresentedSnapshot(presented, options.overview === true)
    const scene = this._sceneStore.persisted
    const session = this._sceneStore.session
    if (options.overview) return buildOverviewRendererSnapshot(scene, session.speciesFocus)
    const hoveredPlant = session.hoveredTarget?.kind === 'plant'
      ? scene.plants.find((plant) => plant.id === session.hoveredTarget?.id)
      : null
    const highlightedTargets = this._resolveHighlightedTargets(scene)
    const localizedCommonNames = this.getLocalizedCommonNames()

    const selectionLabelPlantIds = session.selectedTargets.length === 1
      && session.selectedTargets[0]?.kind === 'plant'
      ? new Set([session.selectedTargets[0].id])
      : new Set<string>()
    const selectionProjection = projectSceneSelectionEntityIds(scene, session.selectedTargets)

    return {
      scene,
      speciesFocus: session.speciesFocus,
      selectionLabelPlantIds,
      revealedAnnotationId: getRevealedAnnotationId(session.selectedTargets),
      ...selectionProjection,
      highlightedPlantIds: new Set(highlightedTargets.plantIds),
      highlightedZoneIds: new Set(highlightedTargets.zoneIds),
      speciesCache: this._speciesCache.getCache(),
      localizedCommonNames,
      hoveredCanonicalName: hoveredPlant?.canonicalName ?? null,
      hoverTarget: getRendererHoverTarget(scene, session.hoveredTarget),
      ...this._editingAids ? { editingAids: this._editingAids } : {},
      groundMeasure: this._sceneStore.sessionPlane,
    }
  }

  private buildPresentedSnapshot(visible: ReadonlySet<string>, overview: boolean): SceneRendererSnapshot {
    const snapshot = this.buildViewCaptureSnapshot({
      overview,
      visibleLayerNames: [...visible],
      focusedSpecies: this._sceneStore.session.speciesFocus.canonicalName,
    })
    // Measurement guides are an editing aid, like the grid, which a presented story never draws.
    const presented = { ...snapshot, scene: { ...snapshot.scene, measurementGuides: [] } }
    if (overview) return presented
    // The step's highlights ring on the canvas, which alone draws them; a capture draws none.
    const highlighted = this._resolveHighlightedTargets(presented.scene)
    return { ...presented, highlightedPlantIds: new Set(highlighted.plantIds), highlightedZoneIds: new Set(highlighted.zoneIds) }
  }

  /**
   * A snapshot for an off-screen view capture: the persisted scene with only
   * the requested layers visible, no selection, hover or panel highlight.
   */
  buildViewCaptureSnapshot(request: {
    readonly overview: boolean
    readonly visibleLayerNames: readonly string[]
    readonly focusedSpecies: string | null
    readonly plantLabels?: PlantLabelMode
  }): SceneRendererSnapshot {
    const persisted = this._sceneStore.persisted
    const visible = new Set(request.visibleLayerNames)
    const scene: ScenePersistedState = {
      ...persisted,
      layers: persisted.layers.map((layer) => ({ ...layer, visible: visible.has(layer.name) })),
    }
    const speciesFocus = { canonicalName: request.focusedSpecies }
    if (request.overview) return buildOverviewRendererSnapshot(scene, speciesFocus)
    const localizedCommonNames = this.getLocalizedCommonNames()
    const speciesCache = this._speciesCache.getCache()
    const selectionLabelPlantIds = new Set<string>()
    return {
      scene,
      speciesFocus,
      selectionLabelPlantIds,
      revealedAnnotationId: null,
      selectedPlantIds: new Set(),
      selectedZoneIds: new Set(),
      selectedAnnotationIds: new Set(),
      selectedMeasurementGuideIds: new Set(),
      highlightedPlantIds: new Set(),
      highlightedZoneIds: new Set(),
      speciesCache,
      localizedCommonNames,
      hoveredCanonicalName: null,
      hoverTarget: null,
      ...request.plantLabels ? { plantLabels: request.plantLabels } : {},
      groundMeasure: this._sceneStore.sessionPlane,
    }
  }

  /** Loads names and species data for `canonicalNames`; a load of either is a plant-names revision. */
  async refreshSpeciesCacheEntries(
    canonicalNames: string[],
    activeLocale: string,
  ): Promise<ScenePresentationRefreshResult> {
    const labelsChanged = await this._plantLabels.ensureEntries(canonicalNames, activeLocale)
    try {
      const loaded = await this._speciesCache.ensureEntries(canonicalNames, activeLocale)
      const changed = labelsChanged || loaded
      return { changed, plantNamesRevision: this._notePreparedPlantNames(changed), failure: null }
    } catch (error) {
      return { changed: labelsChanged, plantNamesRevision: this._notePreparedPlantNames(labelsChanged), failure: { error } }
    }
  }

  /** Loads names and species data for every placed species. */
  async refreshCurrentPresentationData(): Promise<ScenePresentationRefreshResult> {
    const canonicalNames = [...new Set(this._sceneStore.persisted.plants.map((plant) => plant.canonicalName))]
    if (canonicalNames.length === 0) {
      return { changed: false, plantNamesRevision: this._preparedPlantNamesRevision, failure: null }
    }
    return this.refreshSpeciesCacheEntries(canonicalNames, this._getLocale())
  }

  publishRefresh(result: ScenePresentationRefreshResult): boolean {
    if (result.plantNamesRevision <= this._publishedPlantNamesRevision) return false
    this._publishedPlantNamesRevision = result.plantNamesRevision
    this._onPlantNamesChanged()
    return true
  }

  private _notePreparedPlantNames(changed: boolean): number {
    if (changed) this._preparedPlantNamesRevision += 1
    return this._preparedPlantNamesRevision
  }
}

function editingAidsEqual(a: SceneEditingAids | null, b: SceneEditingAids | null): boolean {
  if (a === null || b === null) return a === b
  return a.grid.ink === b.grid.ink && a.grid.majorInk === b.grid.majorInk
}

function buildOverviewRendererSnapshot(
  scene: ScenePersistedState,
  speciesFocus: SceneRendererSnapshot['speciesFocus'],
): SceneRendererSnapshot {
  return {
    scene: {
      ...scene,
      plants: [],
      zones: [],
      annotations: [],
      measurementGuides: [],
      groups: [],
    },
    speciesFocus,
    selectionLabelPlantIds: new Set(),
    revealedAnnotationId: null,
    selectedPlantIds: new Set(),
    selectedZoneIds: new Set(),
    selectedAnnotationIds: new Set(),
    selectedMeasurementGuideIds: new Set(),
    highlightedPlantIds: new Set(),
    highlightedZoneIds: new Set(),
    speciesCache: new Map(),
    localizedCommonNames: new Map(),
    hoveredCanonicalName: null,
    hoverTarget: null,
  }
}

function getRendererHoverTarget(
  scene: ScenePersistedState,
  target: SceneDesignObjectTarget | null,
): SceneRendererHoverTarget | null {
  if (!target || !sceneContainsTarget(scene, target)) return null
  const state = isSceneTargetLayerLocked(scene, target)
    ? 'locked-layer'
    : isSceneDesignObjectLocked(scene, target)
      ? 'locked-design-object'
      : 'hover'
  return { ...target, state }
}
