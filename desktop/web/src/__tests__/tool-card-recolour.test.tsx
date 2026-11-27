// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locale } from '../app/settings/state'
import { ToolCard } from '../components/canvas/ToolCard'
import { createSceneCanvasQuerySurface } from '../canvas/runtime/query-surface'
import { SceneStore } from '../canvas/runtime/scene'
import { SceneRuntimeMutationController } from '../canvas/runtime/scene-runtime/mutations'
import { SceneRuntimePresentationController } from '../canvas/runtime/scene-runtime/presentation'
import {
  SceneRuntimeEditCoordinator,
} from '../canvas/runtime/scene-runtime/transactions'
import { setCurrentCanvasSession } from '../canvas/session'
import { IDLE_CANVAS_TOOL_GUIDANCE, setCanvasToolGuidance } from '../canvas/session-state'
import type { ToolHostState } from '../canvas/runtime/interaction-ports'
import {
  createTestCanvasCommandSurface,
  createTestCanvasDocumentSurface,
  createTestCanvasKeyboardPort,
} from './support/canvas-runtime-surfaces'
import { createTestView } from './support/test-view'

const APPLE = { canonical_name: 'Malus domestica', common_name: 'Apple', stratum: 'high', width_max_m: 6 }

/** The runtime's real query surface over a Scene with one apple, its revision bumped by every committed Scene Edit, and
 *  the real mutation controller that the Species Key's colour swatch calls. */
function runtimeOverOneApple() {
  const store = new SceneStore()
  store.updatePersisted((draft) => {
    draft.plants = [{
      kind: 'plant', id: 'apple', locked: false,
      canonicalName: 'Malus domestica', commonName: 'Apple', color: '#b06045',
      canopySpreadM: null, position: { x: 0, y: 0 },
      rotationDeg: null, notes: null, plantedDate: null, quantity: null,
    }]
    draft.plantSpeciesColors = { 'Malus domestica': '#b06045' }
  })
  const revision = { scene: signal(0), plantNames: signal(0), transientHistory: signal(0) }
  const camera = createTestView()
  const edits = new SceneRuntimeEditCoordinator({
    sceneStore: store,
    setSelection: (targets) => { store.setSelection(targets) },
    incrementSceneRevision: () => { revision.scene.value += 1 },
    syncCanvasSignalsFromScene: () => {}, invalidate: () => {},
  })
  const presentation = new SceneRuntimePresentationController({
    sceneStore: store, readPixelsPerMetre: () => camera.view().pixelsPerMetre, getLocale: () => 'en',
    resolveHighlightedTargets: () => ({ plantIds: [], zoneIds: [] }), onPlantNamesChanged: () => {},
  })
  const mutations = new SceneRuntimeMutationController({
    sceneStore: store,
    selection: { set: (targets) => { store.setSelection(targets) } },
    sceneEdits: edits, commandAdmission: edits, settledReader: edits,
    presentation: {
      getViewportScale: () => 1,
      createPlantPresentationContext: (scale = 1) => presentation.createPlantPresentationContext(scale),
      getLocalizedCommonNames: () => presentation.getLocalizedCommonNames(),
      getSuggestedPlantColor: () => null,
    },
    invalidateScene: () => {},
  })
  const queries = createSceneCanvasQuerySurface({
    sceneStore: store, frames: camera.frames, settledReader: edits, presentation, revision, mutations,
  })
  return { queries, mutations }
}

describe('Tool card after a Species Key recolour', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCanvasToolGuidance(IDLE_CANVAS_TOOL_GUIDANCE)
    setCurrentCanvasSession(null)
  })

  it('with Place plants armed, the card glyph takes the species\' new colour', async () => {
    const { queries, mutations } = runtimeOverOneApple()
    queries.bindToolState(signal<ToolHostState>({
      id: 'plant-stamp',
      source: { kind: 'species', species: APPLE },
      stampId: null,
    }))
    setCurrentCanvasSession({
      commands: createTestCanvasCommandSurface(),
      queries,
      documents: createTestCanvasDocumentSurface(),
      keyboard: createTestCanvasKeyboardPort(),
    })
    await act(() => render(<ToolCard />, container))
    const lead = () => container.querySelector<HTMLElement>('[data-tool-card-lead="species"]')!
    expect(lead().style.color).toBe('rgb(176, 96, 69)')

    await act(() => { mutations.setPlantColorForSpecies('Malus domestica', '#2f6f4e') })

    expect(lead().style.color).toBe('rgb(47, 111, 78)')
  })
})
