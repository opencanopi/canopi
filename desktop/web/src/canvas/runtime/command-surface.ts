import type { SpeciesFocusCommands } from './species-key'
import { computed, type ReadonlySignal } from '@preact/signals'
import { setCanvasTool } from '../session-state'
import type { ToolId } from './interaction-types'
import type {
  CanvasRuntimeSavedObjectStampAdapter,
  CanvasRuntimeSettingsAdapter,
} from './app-adapter'
import type { SceneRuntimePresentationController } from './scene-runtime/presentation'
import { getDesignObjectSelectionModel } from './scene-runtime/selection'
import type {
  CanvasChromeCommandSurface,
  CanvasCommandSurface,
  CanvasDesignObjectImportReceipt,
  CanvasDesignObjects,
  CanvasHistoryCommandSurface,
  CanvasLayerCommandSurface,
  CanvasPlantPresentationCommandSurface,
  CanvasPlantRowPathCommands,
  CanvasPlantRowSpacingField,
  CanvasSceneEditCommandSurface,
  CanvasToolCommandSurface,
  CanvasViewportCommandSurface,
} from './runtime'
import {
  hydrateScenePersistedStateInFrame,
  type SceneLayerEntity,
  type ScenePoint,
  type SceneStateReader,
} from './scene'
import {
  applySceneDragDeltaToDraft,
  captureSceneDragState,
  createSceneDragState,
  type SceneDragState,
} from './scene-runtime/drag-state'
import { createSceneArrangementPlacement } from './scene-runtime/arrangement-placement'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import { DEFAULT_BUDGET_CURRENCY } from '../../generated/known-canopi-keys'
import type { SceneRuntimeMutationController } from './scene-runtime/mutations'
import {
  SceneEditBusyError,
  type SceneCommandAdmission,
  type SceneEditCoordinator,
  type SceneEditTransaction,
  type SceneHistoryCommands,
  type SettledSceneReader,
} from './scene-runtime/transactions'

const DESIGN_OBJECTS_NOT_IMPORTED: CanvasDesignObjectImportReceipt = Object.freeze({
  committed: false,
  createdCount: 0,
})
type SceneLayerEdit = Partial<Pick<SceneLayerEntity, 'visible' | 'locked' | 'opacity'>>

interface SceneCanvasCommandSurfaceOptions {
  readonly speciesFocus: SpeciesFocusCommands
  readonly sceneStore: SceneStateReader
  /** The view's navigation over the runtime's driver host: the viewport commands, as they are. */
  readonly viewNavigation: CanvasViewportCommandSurface
  /** The live frame's px/m, which sizes screen-sized notes and plants. */
  readonly readViewScale: () => number
  readonly history: SceneHistoryCommands
  readonly commandAdmission: SceneCommandAdmission
  readonly settledReader: SettledSceneReader
  readonly savedObjectStamps?: CanvasRuntimeSavedObjectStampAdapter
  readonly transientHistory: {
    readonly revision: ReadonlySignal<number>
    readonly canUndo: () => boolean
    readonly canRedo: () => boolean
    readonly undo: () => boolean
    readonly redo: () => boolean
  }
  readonly mutations: Pick<
    SceneRuntimeMutationController,
    | 'copy'
    | 'paste'
    | 'pasteAt'
    | 'canPaste'
    | 'duplicateSelected'
    | 'toggleSelectedPlantNamePins'
    | 'deleteSelected'
    | 'selectAll'
    | 'selectSameSpecies'
    | 'selectSpecies'
    | 'clearSelection'
    | 'bringToFront'
    | 'sendToBack'
    | 'lockSelected'
    | 'unlockSelected'
    | 'unlockAll'
    | 'groupSelected'
    | 'ungroupSelected'
    | 'renameZone'
    | 'rotateSelected'
    | 'setSelectedPlantColor'
    | 'setSelectedPlantSymbol'
    | 'setPlantColorForSpecies'
    | 'setPlantSymbolForSpecies'
  >
  readonly sceneEdits: SceneEditCoordinator
  readonly presentation: Pick<
    SceneRuntimePresentationController,
    | 'createPlantPresentationContext'
    | 'getLocalizedCommonNames'
    | 'refreshSpeciesCacheEntries'
    | 'publishRefresh'
    | 'presentLayers'
  >
  readonly settings: Pick<
    CanvasRuntimeSettingsAdapter,
    'toggleGridVisible' | 'toggleSnapToGrid'
  >
  readonly setInteractionTool: (id: ToolId) => void
  /** The tool the interaction session has armed now, or null without a session. */
  readonly readInteractionTool: () => ToolId | null
  /** The active interaction session's Plant a row spacing field. */
  readonly plantRowSpacing: CanvasPlantRowSpacingField
  /** The active interaction session's Plant a row path commands (the tool card's check button and mode switch). */
  readonly plantRowPath: CanvasPlantRowPathCommands
  readonly invalidate: () => void
  readonly isRuntimeActive: () => boolean
  readonly isSpatialEditingEnabled: () => boolean
}

export function createSceneCanvasCommandSurface(
  options: SceneCanvasCommandSurfaceOptions,
): CanvasCommandSurface {
  return new SceneCanvasCommandRole(options)
}

class SceneCanvasCommandRole implements CanvasCommandSurface {
  readonly speciesFocus: SpeciesFocusCommands
  readonly tools: CanvasToolCommandSurface
  readonly viewport: CanvasViewportCommandSurface
  readonly history: CanvasHistoryCommandSurface
  readonly sceneEdits: CanvasSceneEditCommandSurface
  readonly chrome: CanvasChromeCommandSurface
  readonly layers: CanvasLayerCommandSurface
  readonly plantPresentation: CanvasPlantPresentationCommandSurface

  /** The open keyboard nudge series: one Scene Edit until `endNudge()`. */
  private nudge: { readonly edit: SceneEditTransaction; readonly state: SceneDragState; total: ScenePoint } | null = null

  constructor(private readonly options: SceneCanvasCommandSurfaceOptions) {
    const canUndo = computed(() => {
      void options.transientHistory.revision.value
      void options.settledReader.revision.value
      return options.settledReader.readWhenSettled(
        () => options.transientHistory.canUndo()
          || options.history.canUndo.value,
        false,
      )
    })
    const canRedo = computed(() => {
      void options.transientHistory.revision.value
      void options.settledReader.revision.value
      return options.settledReader.readWhenSettled(
        () => options.transientHistory.canRedo()
          || options.history.canRedo.value,
        false,
      )
    })

    this.speciesFocus = options.speciesFocus
    this.tools = {
      setTool: (id) => this.setTool(id),
      plantRowSpacing: options.plantRowSpacing,
      plantRowPath: options.plantRowPath,
    }
    // View commands go to navigation as they are: every frame the camera publishes redraws the view and the chrome placed
    // against it, so a refused move redraws nothing.
    this.viewport = options.viewNavigation
    this.history = {
      canUndo,
      canRedo,
      undo: () => this.undo(),
      redo: () => this.redo(),
    }
    // Save as stamp exists only where the edition saves stamps (2.1-Q150): menus and the palette read this field.
    const savedObjectStamps = options.savedObjectStamps
    this.sceneEdits = {
      ...(savedObjectStamps
        ? { saveSelectionAsObjectStamp: () => this.saveSelectionAsObjectStamp(savedObjectStamps) }
        : {}),
      importDesignObjects: (objects) => this.importDesignObjects(objects),
      copy: () => this.options.mutations.copy(),
      paste: () => this.runSpatialEdit(() => this.options.mutations.paste()),
      pasteAt: (point) => this.runSpatialEdit(() => this.options.mutations.pasteAt(point)),
      canPaste: () => this.options.isSpatialEditingEnabled() && this.options.mutations.canPaste(),
      duplicateSelected: () => this.runSpatialEdit(() => this.options.mutations.duplicateSelected()),
      toggleSelectedPlantNamePins: () => this.options.mutations.toggleSelectedPlantNamePins(),
      deleteSelected: () => this.runSpatialEdit(() => this.options.mutations.deleteSelected()),
      selectAll: () => this.options.mutations.selectAll(),
      selectSameSpecies: () => this.options.mutations.selectSameSpecies(),
      selectSpecies: (canonicalNames) => this.options.mutations.selectSpecies(canonicalNames),
      clearSelection: () => this.options.mutations.clearSelection(),
      bringToFront: () => this.runSpatialEdit(() => this.options.mutations.bringToFront()),
      sendToBack: () => this.runSpatialEdit(() => this.options.mutations.sendToBack()),
      lockSelected: () => this.runSpatialEdit(() => this.options.mutations.lockSelected()),
      unlockSelected: () => this.runSpatialEdit(() => this.options.mutations.unlockSelected()),
      unlockAll: () => this.runSpatialEdit(() => this.options.mutations.unlockAll()),
      groupSelected: () => this.runSpatialEdit(() => this.options.mutations.groupSelected()),
      ungroupSelected: () => this.runSpatialEdit(() => this.options.mutations.ungroupSelected()),
      renameZone: (zoneId, name) => this.options.mutations.renameZone(zoneId, name),
      rotateSelected: (degrees) => this.runSpatialEdit(() => this.options.mutations.rotateSelected(degrees)),
      nudgeSelected: (delta) => this.nudgeSelected(delta),
      endNudge: (options) => this.endNudge(options),
    }
    this.chrome = {
      toggleGrid: () => this.options.settings.toggleGridVisible(),
      toggleSnapToGrid: () => this.options.settings.toggleSnapToGrid(),
    }
    this.layers = {
      setSceneLayerVisibility: (name, visible) => this.setSceneLayerState(name, { visible }),
      setSceneLayerOpacity: (name, opacity) => this.setSceneLayerOpacity(name, opacity),
      setSceneLayerLocked: (name, locked) => this.setSceneLayerState(name, { locked }),
      presentLayers: (names) => {
        if (this.options.presentation.presentLayers(names)) this.options.invalidate()
      },
    }
    this.plantPresentation = {
      ensureSpeciesCacheEntries: (canonicalNames, activeLocale) =>
        this.ensureSpeciesCacheEntries(canonicalNames, activeLocale),
      setSelectedPlantColor: (color) => this.options.mutations.setSelectedPlantColor(color),
      setSelectedPlantSymbol: (symbol) => this.options.mutations.setSelectedPlantSymbol(symbol),
      setPlantColorForSpecies: (canonicalName, color) =>
        this.options.mutations.setPlantColorForSpecies(canonicalName, color),
      setPlantSymbolForSpecies: (canonicalName, symbol) =>
        this.options.mutations.setPlantSymbolForSpecies(canonicalName, symbol),
    }
  }

  private setTool(id: ToolId): void {
    try {
      this.options.setInteractionTool(id)
    } catch (error) {
      // A failed switch leaves the session on the tool it kept or fell back to (Select after a failed activation,
      // the tool being left when leaving it failed): the app's own tool state follows the session, not the request.
      const kept = this.options.readInteractionTool()
      if (kept) setCanvasTool(kept)
      throw error
    }
    setCanvasTool(id)
  }

  private nudgeSelected(delta: ScenePoint): boolean {
    if (!this.options.isSpatialEditingEnabled() || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return false
    if (!this.nudge) {
      const scene = this.options.sceneStore.persisted
      const viewportScale = this.options.readViewScale()
      const selection = getDesignObjectSelectionModel(scene, this.options.sceneStore.session.selectedTargets, {
        annotationViewportScale: viewportScale,
        plantContext: this.options.presentation.createPlantPresentationContext(viewportScale),
      })
      if (selection.editableTargets.length === 0) return false
      const state = createSceneDragState()
      captureSceneDragState(state, scene, selection.editableTargets)
      let edit: SceneEditTransaction
      try {
        edit = this.options.sceneEdits.begin('keyboard-nudge')
      } catch (error) {
        // Another edit owns the Scene (a drag in progress): the key does nothing.
        if (error instanceof SceneEditBusyError) return false
        throw error
      }
      this.nudge = { edit, state, total: { x: 0, y: 0 } }
    }
    const series = this.nudge
    // Sum in whole micrometres: equal and opposite steps must cancel exactly,
    // or a series that returns home would still record an edit.
    series.total = {
      x: roundToMicrometre(series.total.x + delta.x),
      y: roundToMicrometre(series.total.y + delta.y),
    }
    const total = series.total
    series.edit.mutate((draft) => applySceneDragDeltaToDraft(draft, series.state, total))
    this.options.invalidate()
    return true
  }

  private endNudge(options: { readonly abort?: boolean } = {}): void {
    const series = this.nudge
    if (!series) return
    this.nudge = null
    if (options.abort || (series.total.x === 0 && series.total.y === 0)) series.edit.abort()
    else series.edit.commit()
    this.options.invalidate()
  }

  private saveSelectionAsObjectStamp(savedObjectStamps: CanvasRuntimeSavedObjectStampAdapter): void {
    this.options.commandAdmission.runWhenSettled(() => {
      const scene = this.options.sceneStore.persisted
      const viewportScale = this.options.readViewScale()
      const selection = getDesignObjectSelectionModel(
        scene,
        this.options.sceneStore.session.selectedTargets,
        {
          annotationViewportScale: viewportScale,
          plantContext: this.options.presentation.createPlantPresentationContext(viewportScale),
        },
      )
      void savedObjectStamps.saveCurrentSelection({
        scene,
        selection,
        localizedCommonNames: new Map(this.options.presentation.getLocalizedCommonNames()),
      })
    }, undefined)
  }

  // Hydrates through a frame at the runtime's own plane origin, so imported
  // lon/lat land in the same session-plane metres as the open Design.
  private importDesignObjects(objects: CanvasDesignObjects): CanvasDesignObjectImportReceipt {
    return this.options.commandAdmission.runWhenSettled(() => {
      const scene = hydrateScenePersistedStateInFrame(
        {
          version: CURRENT_CANOPI_FILE_VERSION,
          name: '',
          description: null,
          plant_species_colors: {},
          layers: [],
          plants: [...objects.plants],
          zones: [...objects.zones],
          annotations: [...objects.annotations],
          measurement_guides: [...objects.measurementGuides],
          consortiums: [],
          groups: [...objects.groups],
          timeline: [],
          budget: [],
          budget_currency: DEFAULT_BUDGET_CURRENCY,
          created_at: '',
          updated_at: '',
        },
        this.options.sceneStore.sessionPlane,
      )
      const receipt = createSceneArrangementPlacement({ sceneEdits: this.options.sceneEdits }).place({
        template: {
          plants: scene.plants.map((entity) => ({ sourceId: entity.id, entity })),
          zones: scene.zones.map((entity) => ({ sourceId: entity.id, entity })),
          annotations: scene.annotations.map((entity) => ({ sourceId: entity.id, entity })),
          measurementGuides: scene.measurementGuides.map((entity) => ({ sourceId: entity.id, entity })),
          groups: scene.groups.map((entity) => ({ sourceId: entity.id, entity })),
        },
        translateBy: { x: 0, y: 0 },
        historyType: 'import-design-objects',
      })
      return { committed: receipt.committed, createdCount: receipt.createdCount }
    }, DESIGN_OBJECTS_NOT_IMPORTED)
  }

  private runSpatialEdit(operation: () => void): void {
    if (!this.options.isSpatialEditingEnabled()) return
    operation()
  }

  private undo(): void {
    this.options.commandAdmission.runWhenSettled(() => {
      if (this.options.transientHistory.undo()) return
      this.options.history.undo()
    }, undefined)
  }

  private redo(): void {
    this.options.commandAdmission.runWhenSettled(() => {
      if (this.options.transientHistory.redo()) return
      this.options.history.redo()
    }, undefined)
  }

  private setSceneLayerOpacity(name: string, opacity: number): boolean {
    return this.options.commandAdmission.runWhenSettled(() => {
      if (!Number.isFinite(opacity)) return false
      return this.setSceneLayerStateWhenSettled(name, {
        opacity: Math.min(1, Math.max(0, opacity)),
      })
    }, false)
  }

  private setSceneLayerState(name: string, edit: SceneLayerEdit): boolean {
    return this.options.commandAdmission.runWhenSettled(
      () => this.setSceneLayerStateWhenSettled(name, edit),
      false,
    )
  }

  private setSceneLayerStateWhenSettled(name: string, edit: SceneLayerEdit): boolean {
    return this.options.sceneEdits.run('scene-layer-settings', (tx) => {
      tx.mutate((draft) => {
        const layer = draft.layers.find((entry) => entry.name === name)
        if (!layer) return
        if (edit.visible !== undefined) layer.visible = edit.visible
        if (edit.locked !== undefined) layer.locked = edit.locked
        if (edit.opacity !== undefined) layer.opacity = edit.opacity
      })
    })
  }

  private async ensureSpeciesCacheEntries(
    canonicalNames: string[],
    activeLocale: string,
  ): Promise<boolean> {
    if (!this.options.isRuntimeActive()) return false
    const result = await this.options.presentation.refreshSpeciesCacheEntries(canonicalNames, activeLocale)
    if (!this.options.isRuntimeActive()) {
      if (result.failure) throw result.failure.error
      return false
    }
    const plantNamesPublished = this.options.presentation.publishRefresh(result)
    if (result.failure) {
      if (result.changed || plantNamesPublished) this.options.invalidate()
      throw result.failure.error
    }
    if (result.changed || plantNamesPublished) this.options.invalidate()
    return result.changed || plantNamesPublished
  }
}

function roundToMicrometre(metres: number): number {
  return Math.round(metres * 1e6) / 1e6 || 0
}
