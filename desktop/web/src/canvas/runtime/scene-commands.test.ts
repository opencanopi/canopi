import { describe, expect, it } from 'vitest'
import {
  applySceneCommandPersistedPatch,
  createScenePatchCommand,
  type SceneCommandSnapshot,
} from './scene-commands'
import type { ScenePersistedState } from './scene'

function makePlant(id: string, x: number): ScenePersistedState['plants'][number] {
  return {
    kind: 'plant',
    id,
    locked: false,
    canonicalName: 'Malus domestica',
    commonName: 'Apple',
    color: null,
    canopySpreadM: 2,
    position: { x, y: 0 },
    rotationDeg: 0,
    notes: null,
    plantedDate: null,
    quantity: 1,
  }
}

function makePersisted(plants: ScenePersistedState['plants']): ScenePersistedState {
  return {
    plantSpeciesColors: {},
    plantSpeciesSymbols: {},
    plantSpeciesCodes: {},
    layers: [{ kind: 'layer', name: 'Default', visible: true, locked: false, opacity: 1 }],
    plants,
    zones: [],
    annotations: [],
    measurementGuides: [],
    groups: [],
  }
}

describe('createScenePatchCommand entity-level inverse deltas (2.1-M547)', () => {
  it('stores only the moved entity for an in-place edit without cloning untouched entities', () => {
    const basePlants = Array.from({ length: 500 }, (_, i) => makePlant(`p-${i}`, i))
    const movedPlants = basePlants.map((p, i) => (i === 42 ? { ...p, position: { x: 999, y: 0 } } : p))

    const before: SceneCommandSnapshot = { persisted: makePersisted(basePlants), selectedTargets: [] }
    const after: SceneCommandSnapshot = { persisted: makePersisted(movedPlants), selectedTargets: [] }

    const cmd = createScenePatchCommand('move-plant', before, after)
    expect(cmd).not.toBeNull()
    expect(cmd!.before.persisted).toBeUndefined()
    expect(cmd!.before.entityDeltas?.plants?.upsert).toHaveLength(1)
    expect(cmd!.before.entityDeltas?.plants?.order).toBeUndefined()
    expect(cmd!.after.entityDeltas?.plants?.upsert).toHaveLength(1)

    const state = makePersisted([...movedPlants])
    applySceneCommandPersistedPatch(state, cmd!.before)
    expect(state.plants[42]?.position.x).toBe(42)
    expect(state.plants).toHaveLength(500)

    applySceneCommandPersistedPatch(state, cmd!.after)
    expect(state.plants[42]?.position.x).toBe(999)
    expect(state.plants).toHaveLength(500)
  })

  it('round-trips add, delete, and reorder through entity deltas', () => {
    const p1 = makePlant('p-1', 1)
    const p2 = makePlant('p-2', 2)
    const p3 = makePlant('p-3', 3)

    const before: SceneCommandSnapshot = { persisted: makePersisted([p1, p2]), selectedTargets: [] }
    const after: SceneCommandSnapshot = { persisted: makePersisted([p3, p1]), selectedTargets: [] }

    const cmd = createScenePatchCommand('replace-and-reorder', before, after)
    expect(cmd).not.toBeNull()
    expect(cmd!.before.entityDeltas?.plants?.removeIds).toEqual(['p-3'])
    expect(cmd!.after.entityDeltas?.plants?.removeIds).toEqual(['p-2'])

    const state = makePersisted([p3, p1])
    applySceneCommandPersistedPatch(state, cmd!.before)
    expect(state.plants.map((p) => p.id)).toEqual(['p-1', 'p-2'])

    applySceneCommandPersistedPatch(state, cmd!.after)
    expect(state.plants.map((p) => p.id)).toEqual(['p-3', 'p-1'])
  })
})
