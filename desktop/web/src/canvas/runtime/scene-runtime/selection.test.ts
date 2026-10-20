// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_PLANT_DISPLAY, getCanvasPlantDisplay, setCanvasPlantDisplay } from '../plant-display'

import {
  createDefaultScenePersistedState,
  type SceneDesignObjectTarget,
  type ScenePersistedState,
} from '../scene'
import { selectionCommandAvailability } from '../interaction/contextual-selection-actions'
import { getDesignObjectSelectionModel, projectSceneSelectionEntityIds } from './selection'

function makeScene(): ScenePersistedState {
  return {
    ...createDefaultScenePersistedState(),
    plants: [
      {
        kind: 'plant',
        id: 'plant-1',
        locked: false,
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
        color: null,
        canopySpreadM: null,
        position: { x: 10, y: 10 },
        rotationDeg: null,
        notes: null,
        plantedDate: null,
        quantity: null,
      },
      {
        kind: 'plant',
        id: 'plant-2',
        locked: true,
        canonicalName: 'Pyrus communis',
        commonName: 'Pear',
        color: null,
        canopySpreadM: null,
        position: { x: 30, y: 30 },
        rotationDeg: null,
        notes: null,
        plantedDate: null,
        quantity: null,
      },
    ],
    zones: [
      {
        kind: 'zone',
        id: 'zone-1', name: null,
        locked: false,
        zoneType: 'rect',
        points: [
          { x: 0, y: 0 },
          { x: 8, y: 0 },
          { x: 8, y: 6 },
          { x: 0, y: 6 },
        ],
        rotationDeg: 0,
        fillColor: null,
        notes: null,
      },
    ],
    annotations: [
      {
        kind: 'annotation',
        id: 'annotation-1',
        locked: false,
        annotationType: 'text',
        position: { x: 50, y: 60 },
        text: 'Note',
        fontSize: 20,
        rotationDeg: null,
      },
    ],
    groups: [
      {
        kind: 'group',
        id: 'group-1',
        locked: false,
        name: null,
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'zone', id: 'zone-1' },
        ],
      },
    ],
  }
}

function readModel(scene: ScenePersistedState, selectedTargets: readonly SceneDesignObjectTarget[], scale = 1) {
  return getDesignObjectSelectionModel(scene, selectedTargets, {
    annotationViewportScale: scale,
    plantContext: {
      pixelsPerMetre: scale,
      speciesCache: new Map(),
      localizedCommonNames: new Map(),
    },
  })
}

describe('scene design object selection model', () => {
  afterEach(() => {
    delete window.__CANOPI_SELECTION_MODEL_BUILDS__
    setCanvasPlantDisplay(DEFAULT_PLANT_DISPLAY)
  })

  it('the same Scene, selection and scale build the model once; a zoom, an edit or a symbol-size change builds it again', () => {
    const scene = makeScene()
    const selection: SceneDesignObjectTarget[] = [{ kind: 'plant', id: 'plant-2' }, { kind: 'annotation', id: 'annotation-1' }]
    window.__CANOPI_SELECTION_MODEL_BUILDS__ = 0

    const model = readModel(scene, selection, 4)
    expect(readModel(scene, selection, 4)).toBe(model)
    expect(window.__CANOPI_SELECTION_MODEL_BUILDS__).toBe(1)
    expect(Object.isFrozen(model.lockedTargets)).toBe(true)

    const zoomed = readModel(scene, selection, 8)
    expect(zoomed.bounds).not.toEqual(model.bounds)
    const editedScene = { ...scene, plants: [...scene.plants] }
    const edited = readModel(editedScene, selection, 8)
    expect(edited).not.toBe(zoomed)
    setCanvasPlantDisplay({ ...getCanvasPlantDisplay(), symbolScale: 2 })
    const resized = readModel(editedScene, selection, 8)
    expect(window.__CANOPI_SELECTION_MODEL_BUILDS__).toBe(4)
    expect(resized).not.toBe(edited)
  })

  it('two Scenes read in turn each keep their memoised model', () => {
    // The workspace and the snapshot or print map read their own Scenes in turn.
    const workspace = makeScene()
    const snapshot = makeScene()
    const selection: SceneDesignObjectTarget[] = [{ kind: 'plant', id: 'plant-2' }]
    window.__CANOPI_SELECTION_MODEL_BUILDS__ = 0

    const workspaceModel = readModel(workspace, selection, 4)
    const snapshotModel = readModel(snapshot, selection, 4)
    expect(readModel(workspace, selection, 4)).toBe(workspaceModel)
    expect(readModel(snapshot, selection, 4)).toBe(snapshotModel)
    expect(window.__CANOPI_SELECTION_MODEL_BUILDS__).toBe(2)
  })

  it('projects large typed selections with a linear entity scan', () => {
    const scene = makeScene()
    const plantCount = 100
    let idReads = 0
    scene.groups = []
    scene.plants = Array.from({ length: plantCount }, (_, index) => {
      const id = `plant-${index}`
      const plant = {
        ...scene.plants[0]!,
        id,
      }
      Object.defineProperty(plant, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          idReads += 1
          return id
        },
      })
      return plant
    })

    const projected = projectSceneSelectionEntityIds(
      scene,
      Array.from({ length: plantCount }, (_, index) => ({
        kind: 'plant' as const,
        id: `plant-${index}`,
      })),
    )

    expect(projected.selectedPlantIds.size).toBe(plantCount)
    expect(idReads).toBeLessThanOrEqual(plantCount * 3)
  })

  it('preserves intended kinds for missing selected targets with colliding raw ids', () => {
    const model = readModel(makeScene(), [
      { kind: 'annotation', id: 'missing-shared' },
      { kind: 'zone', id: 'missing-shared' },
    ])

    expect(model.blockedTargets).toEqual([
      {
        target: { kind: 'annotation', id: 'missing-shared' },
        reason: 'structural',
      },
      {
        target: { kind: 'zone', id: 'missing-shared' },
        reason: 'structural',
      },
    ])
  })

  it('keeps grouped members out of editable top-level selection', () => {
    const model = readModel(makeScene(), [
      { kind: 'group', id: 'group-1' },
      { kind: 'plant', id: 'plant-1' },
    ])

    expect(model.editableTargets).toEqual([{ kind: 'group', id: 'group-1' }])
    expect(model.blockedTargets).toContainEqual({
      target: { kind: 'plant', id: 'plant-1' },
      reason: 'structural',
    })
  })

  it('reports directly locked Design Objects as selected locked targets with bounds', () => {
    const model = readModel(makeScene(), [{ kind: 'plant', id: 'plant-2' }])

    expect(model.editableTargets).toEqual([])
    expect(model.lockedTargets).toEqual([{ kind: 'plant', id: 'plant-2' }])
    expect(model.blockedTargets).toEqual([{
      target: { kind: 'plant', id: 'plant-2' },
      reason: 'locked-design-object',
    }])
    expect(model.bounds?.minX).toBeLessThan(30)
    expect(model.bounds?.minY).toBeLessThan(30)
    expect(model.bounds?.maxX).toBeGreaterThan(30)
    expect(model.bounds?.maxY).toBeGreaterThan(30)
  })

  it('canopi-eon8.14.3: reports a group holding a locked member as a selected locked target with bounds', () => {
    const scene = makeScene()
    scene.plants[0] = { ...scene.plants[0]!, locked: true }

    const model = readModel(scene, [{ kind: 'group', id: 'group-1' }])

    expect(model.editableTargets).toEqual([])
    expect(model.lockedTargets).toEqual([{ kind: 'group', id: 'group-1' }])
    expect(model.blockedTargets).toEqual([{
      target: { kind: 'group', id: 'group-1' },
      reason: 'locked-design-object',
    }])
    // The same bounds as the unlocked group's: the selection frame still shows it.
    expect(model.bounds).toEqual(readModel(makeScene(), [{ kind: 'group', id: 'group-1' }]).bounds)
    // Its commands: Unlock, and nothing that changes it (app/canvas-commands/edit-availability.test.ts, eon8.14.3).
    expect(selectionCommandAvailability(model)).toMatchObject({
      copy: false,
      edit: false,
      group: false,
      ungroup: false,
      rotate: false,
      unlock: true,
      saveAsStamp: true,
    })
  })

  it('uses plant Visual Footprint bounds for selected plants', () => {
    const scene = makeScene()
    scene.groups = []
    scene.plants = scene.plants.filter((plant) => plant.id === 'plant-1')

    const model = readModel(scene, [{ kind: 'plant', id: 'plant-1' }])

    expect(model.editableTargets).toEqual([{ kind: 'plant', id: 'plant-1' }])
    expect(model.bounds?.minX).toBeLessThan(10)
    expect(model.bounds?.minY).toBeLessThan(10)
    expect(model.bounds?.maxX).toBeGreaterThan(10)
    expect(model.bounds?.maxY).toBeGreaterThan(10)
  })

  it('uses oriented Zone geometry for selected Zone bounds', () => {
    const scene = makeScene()
    scene.groups = []
    scene.zones[0] = {
      ...scene.zones[0]!,
      rotationDeg: 90,
    }

    const model = readModel(scene, [{ kind: 'zone', id: 'zone-1' }])

    expect(model.bounds?.minX).toBeCloseTo(1)
    expect(model.bounds?.minY).toBeCloseTo(-1)
    expect(model.bounds?.maxX).toBeCloseTo(7)
    expect(model.bounds?.maxY).toBeCloseTo(7)
  })

  it('uses rotated annotation readable bounds for selected Annotation bounds', () => {
    const scene = makeScene()
    scene.groups = []
    scene.annotations[0] = {
      ...scene.annotations[0]!,
      position: { x: 10, y: 20 },
      text: 'ABCD',
      fontSize: 10,
      rotationDeg: 90,
    }

    const model = readModel(scene, [{ kind: 'annotation', id: 'annotation-1' }])

    expect(model.bounds?.minX).toBeCloseTo(-2.5)
    expect(model.bounds?.minY).toBeCloseTo(20)
    expect(model.bounds?.maxX).toBeCloseTo(10)
    expect(model.bounds?.maxY).toBeCloseTo(44)
  })

  it('reports hidden Layer selections without editable bounds', () => {
    const scene = makeScene()
    scene.groups = []
    scene.layers = scene.layers.map((layer) =>
      layer.name === 'zones' ? { ...layer, visible: false } : layer,
    )

    const model = readModel(scene, [{ kind: 'zone', id: 'zone-1' }])

    expect(model.editableTargets).toEqual([])
    expect(model.blockedTargets).toEqual([{
      target: { kind: 'zone', id: 'zone-1' },
      reason: 'structural',
    }])
    expect(model.bounds).toBeNull()
  })

  it('reports a same-Species reference only for clear editable plant selections', () => {
    const scene = makeScene()
    scene.groups = []

    expect(readModel(scene, [{ kind: 'plant', id: 'plant-1' }]).sameSpeciesReferenceCanonicalName)
      .toBe('Malus domestica')

    scene.plants[1] = {
      ...scene.plants[1]!,
      locked: false,
    }
    expect(readModel(scene, [
      { kind: 'plant', id: 'plant-1' },
      { kind: 'plant', id: 'plant-2' },
    ]).sameSpeciesReferenceCanonicalName)
      .toBeNull()
    expect(readModel(scene, [
      { kind: 'plant', id: 'plant-1' },
      { kind: 'zone', id: 'zone-1' },
    ]).sameSpeciesReferenceCanonicalName)
      .toBeNull()
  })

  it('combines Object Group member geometry with an overview Annotation marker', () => {
    const model = readModel(makeScene(), [
      { kind: 'group', id: 'group-1' },
      { kind: 'annotation', id: 'annotation-1' },
    ])

    expect(model.editableTargets).toEqual([
      { kind: 'group', id: 'group-1' },
      { kind: 'annotation', id: 'annotation-1' },
    ])
    expect(model.bounds).toEqual({
      minX: 0,
      minY: 0,
      maxX: 54,
      maxY: 64,
    })
  })

  it('blocks a cross-Layer Object Group when any member Layer is hidden', () => {
    const scene = makeScene()
    scene.layers = scene.layers.map((layer) =>
      layer.name === 'zones' ? { ...layer, visible: false } : layer,
    )

    const groupModel = readModel(scene, [{ kind: 'group', id: 'group-1' }])
    expect(groupModel.editableTargets).toEqual([])
    expect(groupModel.blockedTargets).toEqual([{
      target: { kind: 'group', id: 'group-1' },
      reason: 'structural',
    }])
    expect(groupModel.bounds).toBeNull()

    const visibleMemberModel = readModel(scene, [{ kind: 'plant', id: 'plant-1' }])
    expect(visibleMemberModel.editableTargets).toEqual([])
    expect(visibleMemberModel.blockedTargets).toEqual([{
      target: { kind: 'plant', id: 'plant-1' },
      reason: 'structural',
    }])
  })

  it('treats an Object Group on a locked member Layer as a structural blocker', () => {
    const scene = makeScene()
    scene.layers = scene.layers.map((layer) =>
      layer.name === 'zones' ? { ...layer, locked: true } : layer,
    )

    const model = readModel(scene, [{ kind: 'group', id: 'group-1' }])

    expect(model.editableTargets).toEqual([])
    expect(model.lockedTargets).toEqual([])
    expect(model.blockedTargets).toEqual([{
      target: { kind: 'group', id: 'group-1' },
      reason: 'structural',
    }])
  })
})
