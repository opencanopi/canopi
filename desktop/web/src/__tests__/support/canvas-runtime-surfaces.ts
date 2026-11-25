import { signal } from '@preact/signals'
import { setCanvasTool } from '../../canvas/session-state'
import type {
  CanvasCommandSurface,
  CanvasDocumentSurface,
  CanvasKeyboardPort,
  CanvasQuerySurface,
  CanvasRuntimeSurfaces,
} from '../../canvas/runtime/runtime'
import { createTestCanvasQuerySurface } from './canvas-query-surface'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K]
}

interface TestCanvasRuntimeSurfaceOptions {
  readonly commands?: CanvasCommandSurface
  readonly queries?: CanvasQuerySurface
  readonly documents?: CanvasDocumentSurface
  readonly keyboard?: CanvasKeyboardPort
}

export function createTestCanvasRuntimeSurfaces({
  commands = createTestCanvasCommandSurface(),
  queries = createTestCanvasQuerySurface(),
  documents = createTestCanvasDocumentSurface(),
  keyboard = createTestCanvasKeyboardPort(),
}: TestCanvasRuntimeSurfaceOptions = {}): CanvasRuntimeSurfaces {
  return { commands, queries, documents, keyboard }
}

/** A keyboard port that consumes nothing: the runtime surfaces' port before an interaction session exists. */
export function createTestCanvasKeyboardPort(overrides: Partial<CanvasKeyboardPort> = {}): CanvasKeyboardPort {
  return {
    host: document.createElement('div'),
    escapeLayers: () => [],
    escape: () => {},
    command: () => false,
    keyState: () => 'pass',
    holdsSelectionDeletes: () => false,
    ...overrides,
  }
}

export function createTestCanvasCommandSurface(
  overrides: DeepPartial<CanvasCommandSurface> = {},
): CanvasCommandSurface {
  const surface: CanvasCommandSurface = {
    speciesFocus: { focus: () => {} },
    tools: {
      setTool: () => {},
      plantRowSpacing: { input: () => {}, commit: () => {}, blur: () => {}, cancel: () => {} },
      plantRowPath: { finish: () => {}, setMode: () => {} },
    },
    viewport: {
      zoomIn: () => {},
      zoomOut: () => {},
      zoomBy: () => {},
      zoomToFit: () => {},
      returnToDesign: () => {},
      focusTemporaryBounds: () => false,
      frameBounds: () => false,
      returnFromTemporaryFocus: () => false,
      showPlace: () => false,
      setFramingInsets: () => {},
      setDesignPinExtent: () => {},
      zoomToSelection: () => {},
      resetNorth: () => {},
      rotateBy: () => {},
      beginRotation: () => ({ update: () => {}, end: () => {}, cancel: () => {} }),
      showCamera: () => {},
    },
    history: {
      canUndo: signal(false),
      canRedo: signal(false),
      undo: () => {},
      redo: () => {},
    },
    sceneEdits: {
      saveSelectionAsObjectStamp: () => {},
      importDesignObjects: () => ({ committed: false, createdCount: 0 }),
      copy: () => {},
      paste: () => {},
      pasteAt: () => {},
      canPaste: () => false,
      duplicateSelected: () => {},
      toggleSelectedPlantNamePins: () => {},
      deleteSelected: () => {},
      selectAll: () => {},
      selectSameSpecies: () => {},
      selectSpecies: () => {},
      clearSelection: () => {},
      bringToFront: () => {},
      sendToBack: () => {},
      lockSelected: () => {},
      unlockSelected: () => {},
      groupSelected: () => {},
      ungroupSelected: () => {},
      renameZone: () => false,
      rotateSelected: () => {},
      unlockAll: () => {},
      nudgeSelected: () => false,
      endNudge: () => {},
    },
    chrome: {
      toggleGrid: () => {},
      toggleSnapToGrid: () => {},
    },
    layers: {
      setSceneLayerVisibility: () => false,
      setSceneLayerOpacity: () => false,
      setSceneLayerLocked: () => false,
      presentLayers: () => undefined,
    },
    plantPresentation: {
      ensureSpeciesCacheEntries: async () => true,
      setSelectedPlantColor: () => 0,
      setSelectedPlantSymbol: () => 0,
      setPlantColorForSpecies: () => 0,
      setPlantSymbolForSpecies: () => 0,
    },
  }

  const setTool = overrides.tools?.setTool ?? surface.tools.setTool
  return {
    tools: {
      ...surface.tools,
      ...overrides.tools,
      plantRowSpacing: { ...surface.tools.plantRowSpacing, ...overrides.tools?.plantRowSpacing },
      plantRowPath: { ...surface.tools.plantRowPath!, ...overrides.tools?.plantRowPath },
      setTool: (name) => {
        setTool(name)
        setCanvasTool(name)
      },
    },
    speciesFocus: { ...surface.speciesFocus, ...overrides.speciesFocus },
    viewport: { ...surface.viewport, ...overrides.viewport },
    history: { ...surface.history, ...overrides.history },
    sceneEdits: { ...surface.sceneEdits, ...overrides.sceneEdits },
    chrome: { ...surface.chrome, ...overrides.chrome },
    layers: { ...surface.layers, ...overrides.layers },
    plantPresentation: { ...surface.plantPresentation, ...overrides.plantPresentation },
  }
}

export function createTestCanvasDocumentSurface(
  overrides: Partial<CanvasDocumentSurface> = {},
): CanvasDocumentSurface {
  const surface: CanvasDocumentSurface = {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection view is not configured in this test.') },
    showCanvasChrome: () => {},
    hideCanvasChrome: () => {},
    zoomToFit: () => {},
    loadDocument: () => {},
    replaceDocument: (_file, _token, finalizeReplacement) => {
      finalizeReplacement()
      return { callerFinalizerInvoked: true }
    },
    hasLoadedDocument: () => false,
    captureForPersistence: (metadata, doc) => ({
      content: { ...doc, name: metadata.name },
      isCurrent: () => true,
      acknowledgeSaved: () => 'applied',
    }),
    serializeSceneFields: () => ({}),
    replaySceneCommand: () => true,
    resize: () => {},
    destroy: () => {},
  }

  return { ...surface, ...overrides }
}
