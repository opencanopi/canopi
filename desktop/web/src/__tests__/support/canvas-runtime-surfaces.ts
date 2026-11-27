import { signal } from '@preact/signals'
import type { MapInputHandle, MapInputOutcome } from '../../canvas/runtime/interaction-types'
import type {
  CanvasCommandSurface,
  CanvasDocumentSurface,
  CanvasKeyboardPort,
  CanvasQuerySurface,
  CanvasRuntimeSurfaces,
  CanvasToolCommandSurface,
} from '../../canvas/runtime/runtime'
import { createTestCanvasQuerySurface, type TestCanvasQuerySurface } from './canvas-query-surface'

function createNoopMapInputHandle<T>(): MapInputHandle<T> {
  let resolveSettled!: (outcome: MapInputOutcome<T>) => void
  const settled = new Promise<MapInputOutcome<T>>((resolve) => {
    resolveSettled = resolve
  })
  let done = false
  return {
    settled,
    cancel(reason = 'tool-change') {
      if (done) return
      done = true
      resolveSettled({ kind: 'cancelled', reason })
    },
  }
}

function isTestQuerySurface(queries: CanvasQuerySurface): queries is TestCanvasQuerySurface {
  return 'setActiveTool' in queries && typeof (queries as Partial<TestCanvasQuerySurface>).setActiveTool === 'function'
}

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
  if (!isTestQuerySurface(queries)) {
    return { commands, queries, documents, keyboard }
  }
  const wiredCommands: CanvasCommandSurface = {
    ...commands,
    tools: {
      ...commands.tools,
      arm: (id, source, request) => {
        const handle = commands.tools.arm(id, source, request)
        queries.setActiveTool(id, source)
        return handle
      },
    },
  }
  return { commands: wiredCommands, queries, documents, keyboard }
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
      arm: () => createNoopMapInputHandle(),
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

  const arm: CanvasToolCommandSurface['arm'] = overrides.tools?.arm ?? ((_id, _source, request) => {
    const handle = createNoopMapInputHandle<never>()
    if (request?.onSettled) {
      void handle.settled.then((outcome) => request.onSettled!(outcome))
    }
    return handle
  })
  return {
    tools: {
      ...surface.tools,
      ...overrides.tools,
      plantRowSpacing: { ...surface.tools.plantRowSpacing, ...overrides.tools?.plantRowSpacing },
      plantRowPath: { ...surface.tools.plantRowPath!, ...overrides.tools?.plantRowPath },
      arm,
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
