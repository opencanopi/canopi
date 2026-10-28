// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currentCanvasCommandSurface,
  currentCanvasDocumentSurface,
  currentCanvasQuerySurface,
  currentCanvasTool,
  setCurrentCanvasSession,
} from '../canvas/session'
import { SceneCanvasRuntime } from '../canvas/runtime/scene-runtime'
import { createForwardingCanvasKeyboardPort } from '../canvas/runtime/keyboard-port'
import {
  createDefaultScenePersistedState,
  serializeScenePersistedState,
} from '../canvas/runtime/scene'
import { createSessionPlane, DEFAULT_NEW_DESIGN_VIEW } from '../canvas/session-plane'
import type {
  CanvasCommandSurface,
  CanvasDocumentSurface,
  CanvasQuerySurface,
  CanvasRuntimeSurfaces,
} from '../canvas/runtime/runtime'
import { createCanvasDocumentReplacementToken } from '../canvas/runtime/runtime'
import { createTestViewReadSurface } from './support/canvas-query-surface'
import { geoAt } from './support/geo-design'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'

function createQuerySurface() {
  return {
    revision: { scene: signal(0), plantNames: signal(0), transientHistory: signal(0) },
    sessionPlane: signal(createSessionPlane(DEFAULT_NEW_DESIGN_VIEW)),
    view: createTestViewReadSurface(),
    getSpeciesFocus: () => ({ canonicalName: null }),
    getPlantLabelCoverage: () => ({ labelled: 0, inView: 0 }),
    capturePrintSnapshot: () => null,
    captureViewScene: () => null,
    sceneHasObjects: () => false,
    getSceneSnapshot: () => createDefaultScenePersistedState(),
    getSelection: () => [],
    getDesignObjectSelection: () => ({
      editableTargets: [],
      lockedTargets: [],
      blockedTargets: [],
      bounds: null,
      sameSpeciesReferenceCanonicalName: null,
      plantNamePinning: { plantIds: [], allPinned: false },
    }),
    getSelectedPlantColorContext: () => ({
      plantIds: [],
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
    getPlacedPlants: () => [],
    getSettledPlacedPlants: () => [],
    getSettledDesignObjects: () => null,
    getLocalizedCommonNames: () => new Map<string, string | null>(),
    getEnglishFallbackNames: () => new Map<string, string>(),
    getSpeciesCache: () => new Map(),
    subscribePointerWorld: () => () => {},
  } satisfies CanvasQuerySurface
}

function createCommandSurface() {
  return {
    speciesFocus: { focus: () => {} },
    tools: {
      setTool: (_name: string) => {},
      plantRowSpacing: { input: () => {}, commit: () => {}, blur: () => {}, cancel: () => {} },
    },
    viewport: {
      zoomIn: () => {},
      zoomOut: () => {},
      zoomToFit: () => {},
      returnToDesign: () => {},
      focusTemporaryBounds: () => false,
      frameBounds: () => false,
      returnFromTemporaryFocus: () => false,
      showPlace: () => false,
      zoomBy: () => {},
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
  } satisfies CanvasCommandSurface
}

function createDocumentSurface() {
  return {
    presented: signal(true),
    attachInspectionTo: () => { throw new Error('Inspection is not used by this fixture.') },
    showCanvasChrome: () => {},
    hideCanvasChrome: () => {},
    zoomToFit: () => {},
    loadDocument: (_file) => {},
    replaceDocument: (_file, _token, finalizeReplacement: () => void) => {
      finalizeReplacement()
      return { callerFinalizerInvoked: true }
    },
    hasLoadedDocument: () => false,
    captureForPersistence: (metadata, doc) => ({
      content: { ...doc, name: metadata.name },
      isCurrent: () => true,
      acknowledgeSaved: () => 'applied',
    }),
    resize: () => {},
    destroy: () => {},
  } satisfies CanvasDocumentSurface
}

function createCanvasRuntimeSurfaces(runtime: SceneCanvasRuntime): CanvasRuntimeSurfaces {
  return {
    commands: runtime.commandSurface,
    queries: runtime.querySurface,
    documents: runtime.documentSurface,
    keyboard: createForwardingCanvasKeyboardPort(() => runtime.keyboardPort, document.createElement('div')),
  }
}

/** Two apples 10 m apart, as a Design file: a real runtime opens it as the user does. */
function twoApples(): CanopiFile {
  const plant = (id: string, x: number, y: number) => ({
    id, canonical_name: 'Malus domestica', common_name: 'Apple', color: null, position: geoAt(x, y, { lon: 0, lat: 0 }),
    rotation: null, scale: null, notes: null, planted_date: null, quantity: 1, locked: false,
  })
  return {
    version: CURRENT_CANOPI_FILE_VERSION, name: 'Coverage', description: null, plant_species_colors: {},
    layers: [{ name: 'plants', visible: true, locked: false, opacity: 1 }],
    plants: [plant('apple-a', 10, 10), plant('apple-b', 20, 20)],
    zones: [], annotations: [], consortiums: [], groups: [], timeline: [], budget: [], budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z', updated_at: '2026-04-02T00:00:00.000Z', extra: {},
  }
}

describe('canvas runtime surfaces', () => {
  afterEach(() => {
    setCurrentCanvasSession(null)
  })

  it('publishes explicit facades instead of the mounted runtime', () => {
    const runtime = new SceneCanvasRuntime()
    const surfaces = createCanvasRuntimeSurfaces(runtime)

    try {
      setCurrentCanvasSession(surfaces)

      expect(currentCanvasCommandSurface.value).toBe(surfaces.commands)
      expect(currentCanvasQuerySurface.value).toBe(surfaces.queries)
      expect(currentCanvasDocumentSurface.value).toBe(surfaces.documents)
      expect(currentCanvasCommandSurface.value).not.toBe(runtime)
      expect(currentCanvasQuerySurface.value).not.toBe(runtime)
      expect(currentCanvasDocumentSurface.value).not.toBe(runtime)
    } finally {
      runtime.destroy()
    }
  })

  it('routes representative command, query, and document behavior through role surfaces', () => {
    const runtime = new SceneCanvasRuntime()
    const surfaces = createCanvasRuntimeSurfaces(runtime)
    const file = serializeScenePersistedState(createDefaultScenePersistedState(), createSessionPlane(DEFAULT_NEW_DESIGN_VIEW))

    try {
      surfaces.commands.tools.setTool('hand')
      surfaces.documents.loadDocument(file)

      expect(currentCanvasTool.value).toBe('hand')
      expect(surfaces.documents.hasLoadedDocument()).toBe(true)
      expect(surfaces.queries.getSceneSnapshot()).toEqual(createDefaultScenePersistedState())
    } finally {
      runtime.destroy()
    }
  })

  it('keeps read-only query consumers away from commands and document lifecycle', () => {
    const querySurface = createQuerySurface()

    expect(querySurface.getSceneSnapshot().plants).toEqual([])
    expect(querySurface.view.captureView().screen).toMatchObject({ width: 400, height: 300 })
    // @ts-expect-error query surfaces cannot issue tool commands.
    querySurface.setTool
    // @ts-expect-error query surfaces cannot replace documents.
    querySurface.replaceDocument
  })

  it('keeps command consumers away from scene queries and document serialization', () => {
    const commandSurface = createCommandSurface()

    commandSurface.tools.setTool('hand')
    expect(commandSurface.history.canUndo.value).toBe(false)
    // @ts-expect-error command surfaces do not expose flat tool commands.
    commandSurface.setTool
    // @ts-expect-error command surfaces cannot read scene snapshots.
    commandSurface.getSceneSnapshot
    // @ts-expect-error command surfaces cannot capture documents for persistence.
    commandSurface.captureForPersistence
  })

  it('keeps document consumers away from panel queries and toolbar commands', () => {
    const documentSurface = createDocumentSurface()
    const file = serializeScenePersistedState(createDefaultScenePersistedState(), createSessionPlane(DEFAULT_NEW_DESIGN_VIEW))
    const replacementToken = createCanvasDocumentReplacementToken()

    if (false) {
      // @ts-expect-error document replacement requires a pre-release finalizer.
      documentSurface.replaceDocument(file, replacementToken)
    }
    documentSurface.replaceDocument(file, replacementToken, () => {})
    const persistence = documentSurface.captureForPersistence({ name: 'Doc' }, file)
    expect(persistence.content.name).toBe('Doc')
    expect(persistence.acknowledgeSaved()).toBe('applied')
    // @ts-expect-error document surfaces cannot read placed plant lists.
    documentSurface.getPlacedPlants
    // @ts-expect-error document surfaces cannot issue tool commands.
    documentSurface.setTool
  })

  it('reports whether a runtime has loaded a document without caller monkey-patching', () => {
    const runtime = new SceneCanvasRuntime()
    const surfaces = createCanvasRuntimeSurfaces(runtime)
    const file = serializeScenePersistedState(createDefaultScenePersistedState(), createSessionPlane(DEFAULT_NEW_DESIGN_VIEW))

    try {
      expect(surfaces.documents.hasLoadedDocument()).toBe(false)
      surfaces.documents.loadDocument(file)
      expect(surfaces.documents.hasLoadedDocument()).toBe(true)
    } finally {
      runtime.destroy()
    }
  })

  it('offers Undo and Redo only once the Scene is settled: an open edit greys both, and they come back when it ends', () => {
    const runtime = new SceneCanvasRuntime()
    const { commands, documents } = createCanvasRuntimeSurfaces(runtime)
    try {
      documents.loadDocument(twoApples())
      commands.sceneEdits.selectAll()
      commands.sceneEdits.duplicateSelected()
      commands.sceneEdits.duplicateSelected()
      commands.history.undo()
      commands.sceneEdits.selectAll()
      expect([commands.history.canUndo.value, commands.history.canRedo.value]).toEqual([true, true])

      // A keyboard nudge series holds one Scene Edit open until it ends: neither command may run meanwhile.
      expect(commands.sceneEdits.nudgeSelected({ x: 1, y: 0 })).toBe(true)
      expect([commands.history.canUndo.value, commands.history.canRedo.value]).toEqual([false, false])

      // Aborted, the Scene settles back where it was, and both commands return without another edit.
      commands.sceneEdits.endNudge({ abort: true })
      expect([commands.history.canUndo.value, commands.history.canRedo.value]).toEqual([true, true])
    } finally {
      runtime.destroy()
    }
  })

  it('canopi-knon: label coverage counts no plants while Plants is at opacity 0', async () => {
    const runtime = new SceneCanvasRuntime()
    runtime.connectRenderTarget({ setSnapshot: vi.fn(), setDraft: vi.fn(), requestRender: vi.fn() })
    const container = document.createElement('div')
    document.body.appendChild(container)
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 })
    try {
      await runtime.init(container)
      runtime.documentSurface.loadDocument(twoApples())
      runtime.commandSurface.viewport.zoomToFit()
      // Shown, both apples are in view: the chip has plants to count.
      expect(runtime.querySurface.getPlantLabelCoverage().inView).toBe(2)

      // At opacity 0 the user sees no plant, so none counts as in view or unlabelled.
      expect(runtime.commandSurface.layers.setSceneLayerOpacity('plants', 0)).toBe(true)
      expect(runtime.querySurface.getPlantLabelCoverage()).toEqual({ labelled: 0, inView: 0 })
    } finally {
      runtime.destroy()
      container.remove()
    }
  })
})
