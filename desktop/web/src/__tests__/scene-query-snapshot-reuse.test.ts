import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSceneCanvasQuerySurface } from '../canvas/runtime/query-surface'
import { SceneStore } from '../canvas/runtime/scene'
import { SceneRuntimePresentationController } from '../canvas/runtime/scene-runtime/presentation'
import {
  SceneRuntimeEditCoordinator,
} from '../canvas/runtime/scene-runtime/transactions'
import { createTestView } from './support/test-view'

function setup() {
  const store = new SceneStore()
  store.updatePersisted((draft) => {
    draft.plants = [0, 3].map((x, index) => ({
      kind: 'plant', id: String(index), locked: false,
      canonicalName: 'Malus domestica', commonName: null, color: null,
      canopySpreadM: null, position: { x, y: 0 },
      rotationDeg: null, scale: null, notes: null, plantedDate: null, quantity: null,
    }))
  })
  store.setSelection([{ kind: 'plant', id: '0' }])
  const camera = createTestView()
  const authority = new SceneRuntimeEditCoordinator({
    sceneStore: store,
    setSelection: (targets) => { store.setSelection(targets) },
    incrementSceneRevision: () => {}, syncCanvasSignalsFromScene: () => {}, invalidate: () => {},
  })
  const presentation = new SceneRuntimePresentationController({
    sceneStore: store, readPixelsPerMetre: () => camera.view().pixelsPerMetre, getLocale: () => 'en',
    resolveHighlightedTargets: () => ({ plantIds: [], zoneIds: [] }), onPlantNamesChanged: () => {},
  })
  const query = createSceneCanvasQuerySurface({
    sceneStore: store, frames: camera.frames, settledReader: authority, presentation,
    revision: { scene: signal(0), plantNames: signal(0), transientHistory: signal(0) },
    mutations: {
      getSelectedPlantColorContext: () => { throw new Error('unused') },
      getSelectedPlantSymbolContext: () => { throw new Error('unused') },
    },
  })
  return { store, camera, authority, query }
}

afterEach(() => vi.restoreAllMocks())

describe('scene query snapshot reuse', () => {
  it('reads whether the Scene holds objects from live edits without cloning a scene snapshot', () => {
    const { store, authority, query } = setup()
    const read = vi.spyOn(store, 'persisted', 'get')
    expect(query.sceneHasObjects()).toBe(true)
    expect(read).not.toHaveBeenCalled()
    const edit = authority.begin('delete')
    edit.mutate((draft) => { draft.plants = [] })
    read.mockClear()
    expect(query.sceneHasObjects()).toBe(false)
    expect(read).not.toHaveBeenCalled()
    edit.abort()
    expect(query.sceneHasObjects()).toBe(true)
  })

  it('observes live-preview movement, abort, commit, and viewport changes on each call', () => {
    const { authority, camera, query } = setup()
    const centerX = () => {
      const bounds = query.getDesignObjectSelection().bounds!
      return (bounds.minX + bounds.maxX) / 2
    }
    expect(centerX()).toBe(0)
    const aborted = authority.begin('move')
    aborted.mutate((draft) => { draft.plants[0]!.position.x = 10 })
    expect(centerX()).toBe(10)
    aborted.abort()
    expect(centerX()).toBe(0)
    const committed = authority.begin('move')
    committed.mutate((draft) => { draft.plants[0]!.position.x = 20 })
    expect(centerX()).toBe(20)
    committed.commit()
    expect(centerX()).toBe(20)
    const before = query.getDesignObjectSelection().bounds!
    camera.navigation.zoomIn()
    const after = query.getDesignObjectSelection().bounds!
    expect(after.maxX - after.minX).not.toBe(before.maxX - before.minX)
  })

  it('hands out a Scene snapshot frozen in dev builds and selection and print results no caller can change', () => {
    const { query } = setup()
    expect(() => { query.getSceneSnapshot().plants[0]!.position.x = 999 }).toThrow(TypeError)
    const selection = query.getDesignObjectSelection()
    Reflect.set(selection.editableTargets[0]!, 'id', 'escaped')
    Reflect.set(selection.bounds!, 'minX', 999)
    Reflect.set(query.capturePrintSnapshot()!.plants[0]!.position, 'x', 999)
    expect(query.getDesignObjectSelection().editableTargets).toEqual([{ kind: 'plant', id: '0' }])
    expect(query.getDesignObjectSelection().bounds!.minX).toBeLessThan(0)
    expect(query.getSceneSnapshot().plants[0]!.position.x).toBe(0)
    expect(query.capturePrintSnapshot()!.plants[0]!.position.x).toBe(0)
  })

  it('uses one snapshot for settled print capture and refuses live-preview capture', () => {
    const { store, authority, query } = setup()
    const read = vi.spyOn(store, 'persisted', 'get')
    expect(query.capturePrintSnapshot()?.plants).toHaveLength(2)
    expect(read).toHaveBeenCalledTimes(1)
    const edit = authority.begin('move')
    try {
      edit.mutate((draft) => { draft.plants[0]!.position.x = 10 })
      read.mockClear()
      expect(query.capturePrintSnapshot()).toBeNull()
      expect(read).not.toHaveBeenCalled()
    } finally {
      edit.abort()
    }
    expect(query.capturePrintSnapshot()?.plants[0]!.position.x).toBe(0)
  })

  it('avoids scene reads when nothing is selected and returns an empty model no caller can change', () => {
    const { store, query } = setup()
    store.setSelection([])
    const read = vi.spyOn(store, 'persisted', 'get')
    const empty = query.getDesignObjectSelection()
    expect(empty).toEqual({
      editableTargets: [], lockedTargets: [], blockedTargets: [], bounds: null,
      sameSpeciesReferenceCanonicalName: null, plantNamePinning: { plantIds: [], allPinned: false },
    })
    Reflect.set(empty.editableTargets, '0', { kind: 'plant', id: '0' })
    Reflect.set(empty.plantNamePinning.plantIds, '0', '0')
    expect(query.getDesignObjectSelection().editableTargets).toEqual([])
    expect(query.getDesignObjectSelection().plantNamePinning.plantIds).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('reads the Scene once for selection and its plant presentation', () => {
    const { store, query } = setup()
    const read = vi.spyOn(store, 'persisted', 'get')
    expect(query.getDesignObjectSelection().editableTargets).toEqual([{ kind: 'plant', id: '0' }])
    expect(read).toHaveBeenCalledTimes(1)
  })
})
