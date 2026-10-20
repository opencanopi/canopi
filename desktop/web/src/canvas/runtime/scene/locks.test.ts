import { describe, expect, it } from 'vitest'

import {
  createDefaultScenePersistedState,
  isSceneDesignObjectLocked,
  lockedSceneGroupMembers,
  setSceneDesignObjectLocks,
  type ScenePersistedState,
} from './index'

function sceneWithGroup(): ScenePersistedState {
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
    ],
    zones: [
      {
        kind: 'zone',
        id: 'zone-1', name: null,
        locked: false,
        zoneType: 'rect',
        rotationDeg: 0,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
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
        position: { x: 20, y: 20 },
        text: 'Note',
        fontSize: 16,
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
          { kind: 'annotation', id: 'annotation-1' },
          { kind: 'plant', id: 'missing-member' },
        ],
      },
    ],
  }
}

describe('scene design object locks', () => {
  it('locks only the selected kind when Design Object identifiers collide', () => {
    const scene = sceneWithGroup()
    scene.plants[0]!.id = 'shared'
    scene.zones[0]!.id = 'shared'
    scene.annotations[0]!.id = 'shared'
    scene.measurementGuides = [{
      kind: 'measurement-guide',
      id: 'shared',
      locked: false,
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
    }]
    scene.groups = [{
      kind: 'group',
      id: 'shared',
      locked: false,
      name: null,
      members: [],
    }]

    setSceneDesignObjectLocks(
      scene,
      [{ kind: 'zone', id: 'shared' }],
      true,
    )

    expect(scene.plants[0]!.locked).toBe(false)
    expect(scene.zones[0]!.locked).toBe(true)
    expect(scene.annotations[0]!.locked).toBe(false)
    expect(scene.measurementGuides[0]!.locked).toBe(false)
    expect(scene.groups[0]!.locked).toBe(false)
  })

  it('treats a group as unlocked when all existing members are unlocked or missing', () => {
    const scene = sceneWithGroup()

    expect(isSceneDesignObjectLocked(scene, { kind: 'group', id: 'group-1' })).toBe(false)
  })

  it.each([
    ['plant member', 'plant-1'],
    ['zone member', 'zone-1'],
    ['annotation member', 'annotation-1'],
  ] as const)('treats a group as locked when its %s is locked', (_label, id) => {
    const scene = sceneWithGroup()
    lockMember(scene, id)

    expect(isSceneDesignObjectLocked(scene, { kind: 'group', id: 'group-1' })).toBe(true)
  })

  it('canopi-eon8.14.3: names a group\'s directly locked members, none for an unknown group', () => {
    const scene = sceneWithGroup()
    lockMember(scene, 'plant-1')
    lockMember(scene, 'annotation-1')

    expect(lockedSceneGroupMembers(scene, 'group-1')).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'annotation', id: 'annotation-1' },
    ])
    expect(lockedSceneGroupMembers(scene, 'no-group')).toEqual([])
  })

  it('treats a directly locked group as locked when members are unlocked', () => {
    const scene = sceneWithGroup()
    scene.groups = scene.groups.map((group) =>
      group.id === 'group-1' ? { ...group, locked: true } : group,
    )

    expect(isSceneDesignObjectLocked(scene, { kind: 'group', id: 'group-1' })).toBe(true)
  })
})

function lockMember(scene: ScenePersistedState, id: string): void {
  scene.plants = scene.plants.map((plant) =>
    plant.id === id ? { ...plant, locked: true } : plant,
  )
  scene.zones = scene.zones.map((zone) =>
    zone.id === id ? { ...zone, locked: true } : zone,
  )
  scene.annotations = scene.annotations.map((annotation) =>
    annotation.id === id ? { ...annotation, locked: true } : annotation,
  )
}
