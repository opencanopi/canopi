import { describe, expect, it, vi } from 'vitest'

import type { CanopiFile } from '../../../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../../generated/canopi-design-format'
import { geoAt } from '../../../__tests__/support/geo-design'
import {
  resolvePlantSymbolForPlant,
  lockedSceneDesignObjectTargets,
  sceneHasLockedDesignObjects,
  SceneStore,
  type SceneDesignObjectTarget,
} from '../scene'
import { SceneHistory } from '../scene-history'
import { SceneRuntimeMutationController } from './mutations'
import { SceneRuntimeEditCoordinator } from './transactions'

function makeFile(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Mutation demo',
    description: null,
    plant_species_colors: {},
    layers: [
      { name: 'plants', visible: true, locked: false, opacity: 1 },
      { name: 'zones', visible: true, locked: false, opacity: 1 },
      { name: 'annotations', visible: true, locked: false, opacity: 1 },
    ],
    plants: [
      {
        id: 'plant-1',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        position: geoAt(10, 10),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
      {
        id: 'plant-2',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        position: geoAt(20, 20),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
    ],
    zones: [
      {
        id: 'zone-1', name: null,
        zone_type: 'rect',
        rotation: 0,
        points: [
          geoAt(0, 0),
          geoAt(5, 0),
          geoAt(5, 5),
          geoAt(0, 5),
        ],
        fill_color: null,
        notes: null,
        locked: false,
      },
    ],
    annotations: [
      {
        id: 'annotation-1',
        annotation_type: 'text',
        position: geoAt(50, 60),
        text: 'Note',
        font_size: 20,
        rotation: null,
        locked: false,
      },
    ],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    extra: {},
  }
}

function createController(file = makeFile()) {
  const sceneStore = new SceneStore().hydrate(file)
  const state = {
    invalidations: 0,
    dirtyTypes: [] as string[],
    plantSpeciesColorSyncs: 0,
  }
  const setSelection = (targets: Iterable<SceneDesignObjectTarget>) => {
    sceneStore.setSelection(targets)
  }
  const history = new SceneHistory()
  const record = history.record.bind(history)
  vi.spyOn(history, 'record').mockImplementation((command, transaction) => {
    state.dirtyTypes.push(command.type)
    return record(command, transaction)
  })
  const sceneEdits = new SceneRuntimeEditCoordinator({
    sceneStore,
    history,
    setSelection,
    incrementSceneRevision: () => {},
    syncCanvasSignalsFromScene: () => {
      state.plantSpeciesColorSyncs += 1
    },
    invalidate: () => {
      state.invalidations += 1
    },
  })
  const controller = new SceneRuntimeMutationController({
    sceneStore,
    selection: {
      set: setSelection,
    },
    sceneEdits,
    commandAdmission: sceneEdits,
    settledReader: sceneEdits,
    presentation: {
      getViewportScale: () => 1,
      createPlantPresentationContext: (viewportScale = 1) => ({
        pixelsPerMetre: viewportScale,
        speciesCache: new Map(),
        localizedCommonNames: new Map(),
      }),
      getLocalizedCommonNames: () => new Map(),
      getSuggestedPlantColor: (canonicalName) => canonicalName === 'Malus domestica' ? '#C44230' : null,
    },
    invalidateScene: () => {
      state.invalidations += 1
    },
  })

  return { controller, sceneStore, sceneEdits, state }
}

describe('scene runtime mutation controller', () => {
  it('copy, move the source, paste twice: each paste is the copy as it was, and the pastes share nothing', () => {
    const { controller, sceneStore } = createController()
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-1' }, { kind: 'zone', id: 'zone-1' }])
    const source = sceneStore.persisted
    const plantAt = source.plants.find((plant) => plant.id === 'plant-1')!.position
    const zoneAt = source.zones.find((zone) => zone.id === 'zone-1')!.points

    controller.copy()
    sceneStore.updatePersisted((draft) => {
      const plant = draft.plants.find((entry) => entry.id === 'plant-1')!
      plant.position.x += 40
      const zone = draft.zones.find((entry) => entry.id === 'zone-1')!
      zone.points[0]!.y += 40
    })
    controller.paste()
    controller.paste()

    const scene = sceneStore.persisted
    const pastedPlants = scene.plants.filter((plant) => !['plant-1', 'plant-2'].includes(plant.id))
    const pastedZones = scene.zones.filter((zone) => zone.id !== 'zone-1')
    expect(pastedPlants.map((plant) => plant.position.x)).toEqual([plantAt.x + 1, plantAt.x + 2])
    expect(pastedPlants.map((plant) => plant.position.y)).toEqual([plantAt.y, plantAt.y])
    expect(pastedZones.map((zone) => zone.points[0]!.y)).toEqual([zoneAt[0]!.y, zoneAt[0]!.y])
    expect(pastedZones.map((zone) => zone.points[0]!.x)).toEqual([zoneAt[0]!.x + 1, zoneAt[0]!.x + 2])

    // Moving the first paste leaves the second where it was.
    sceneStore.updatePersisted((draft) => {
      draft.plants.find((entry) => entry.id === pastedPlants[0]!.id)!.position.y += 7
      draft.zones.find((entry) => entry.id === pastedZones[0]!.id)!.points[1]!.y += 7
    })
    const after = sceneStore.persisted
    expect(after.plants.find((entry) => entry.id === pastedPlants[1]!.id)!.position).toEqual(pastedPlants[1]!.position)
    expect(after.zones.find((entry) => entry.id === pastedZones[1]!.id)!.points).toEqual(pastedZones[1]!.points)
  })

  it('Cut (copy then delete, as the Edit command runs it) does nothing while an edit owns the Scene, and once settled copies before it deletes', () => {
    const { controller, sceneStore, sceneEdits } = createController()
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-1' }])
    const pending = sceneEdits.begin('move-selection')

    controller.copy()
    controller.deleteSelected()

    pending.abort()
    expect(sceneStore.persisted.plants.map((plant) => plant.id)).toEqual(['plant-1', 'plant-2'])
    expect(controller.canPaste()).toBe(false)

    controller.copy()
    controller.deleteSelected()

    expect(sceneStore.persisted.plants.map((plant) => plant.id)).toEqual(['plant-2'])
    expect(sceneStore.session.selectedTargets).toEqual([])
    controller.paste()
    const pasted = sceneStore.persisted.plants.filter((plant) => plant.id !== 'plant-2')
    expect(pasted.map((plant) => plant.canonicalName)).toEqual(['Malus domestica'])
  })

  it('on a selection mixing locked and unlocked objects, Cut, Duplicate and Lock act on the unlocked part and silently leave the locked one (U59)', () => {
    const file = makeFile()
    file.zones = file.zones.map((zone) => ({ ...zone, locked: true }))
    const { controller, sceneStore } = createController(file)
    const mixed = [{ kind: 'plant' as const, id: 'plant-1' }, { kind: 'zone' as const, id: 'zone-1' }]

    sceneStore.setSelection(mixed)
    controller.duplicateSelected()
    expect(sceneStore.persisted.plants).toHaveLength(3)
    expect(sceneStore.persisted.zones.map((zone) => zone.id)).toEqual(['zone-1'])

    // Cut, as the Edit command runs it: the clipboard holds the plant only, the locked zone stays, the selection clears.
    sceneStore.setSelection(mixed)
    controller.copy()
    controller.deleteSelected()
    expect(sceneStore.persisted.plants.map((plant) => plant.id)).not.toContain('plant-1')
    expect(sceneStore.persisted.zones.map((zone) => [zone.id, zone.locked])).toEqual([['zone-1', true]])
    expect(sceneStore.session.selectedTargets).toEqual([])
    const before = sceneStore.persisted.plants.length
    controller.paste()
    expect(sceneStore.persisted.plants).toHaveLength(before + 1)
    expect(sceneStore.persisted.zones).toHaveLength(1)

    // Lock locks the rest.
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-2' }, { kind: 'zone', id: 'zone-1' }])
    controller.lockSelected()
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-2')?.locked).toBe(true)
    expect(sceneStore.persisted.zones[0]!.locked).toBe(true)
  })

  it('locks only the typed selected Design Object when raw ids collide', () => {
    const file = makeFile()
    file.plants = file.plants.map((plant, index) =>
      index === 0 ? { ...plant, id: 'shared-id' } : plant,
    )
    file.zones = file.zones.map((zone, index) =>
      index === 0 ? { ...zone, id: 'shared-id' } : zone,
    )
    const { controller, sceneStore } = createController(file)
    sceneStore.setSelection([{ kind: 'zone', id: 'shared-id' }])

    controller.lockSelected()

    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'shared-id')?.locked).toBe(false)
    expect(sceneStore.persisted.zones.find((zone) => zone.id === 'shared-id')?.locked).toBe(true)
    expect(sceneStore.session.selectedTargets).toEqual([])
  })

  it('deletes only the typed selected Design Object when raw ids collide', () => {
    const file = makeFile()
    file.plants[0] = { ...file.plants[0]!, id: 'shared-id' }
    file.zones[0] = { ...file.zones[0]!, id: 'shared-id' }
    const { controller, sceneStore } = createController(file)
    sceneStore.setSelection([{ kind: 'zone', id: 'shared-id' }])

    controller.deleteSelected()

    expect(sceneStore.persisted.plants.some((plant) => plant.id === 'shared-id')).toBe(true)
    expect(sceneStore.persisted.zones.some((zone) => zone.id === 'shared-id')).toBe(false)
    expect(sceneStore.session.selectedTargets).toEqual([])
  })

  it('duplicates only the typed selected Design Object when raw ids collide', () => {
    const file = makeFile()
    file.plants[0] = { ...file.plants[0]!, id: 'shared-id' }
    file.zones[0] = { ...file.zones[0]!, id: 'shared-id' }
    const { controller, sceneStore } = createController(file)
    sceneStore.setSelection([{ kind: 'zone', id: 'shared-id' }])

    controller.duplicateSelected()

    expect(sceneStore.persisted.plants).toHaveLength(file.plants.length)
    expect(sceneStore.persisted.zones).toHaveLength(file.zones.length + 1)
    expect(sceneStore.session.selectedTargets).toEqual([
      expect.objectContaining({ kind: 'zone' }),
    ])
    expect(sceneStore.session.selectedTargets[0]?.id).not.toBe('shared-id')
  })

  it('does not delete selected groups that contain locked members', () => {
    const file = makeFile()
    file.plants = file.plants.map((plant) =>
      plant.id === 'plant-1' ? { ...plant, locked: true } : plant,
    )
    file.groups = [
      {
        id: 'group-1',
        name: null,
        locked: false,
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'plant', id: 'plant-2' },
        ],
      },
    ]
    const { controller, sceneStore, state } = createController(file)
    sceneStore.setSelection([{ kind: 'group', id: 'group-1' }])

    controller.deleteSelected()

    expect(sceneStore.persisted.groups).toHaveLength(1)
    expect(sceneStore.persisted.plants).toHaveLength(2)
    expect(sceneStore.session.selectedTargets).toEqual([{ kind: 'group', id: 'group-1' }])
    expect(state.dirtyTypes).toEqual([])
    expect(state.invalidations).toBe(0)
  })

  it('does not ungroup or reorder selected groups that contain locked members', () => {
    const file = makeFile()
    file.plants = file.plants.map((plant) =>
      plant.id === 'plant-1' ? { ...plant, locked: true } : plant,
    )
    file.groups = [
      {
        id: 'group-1',
        name: null,
        locked: false,
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'plant', id: 'plant-2' },
        ],
      },
      {
        id: 'group-2',
        name: null,
        locked: false,
        members: [{ kind: 'plant', id: 'missing-member' }],
      },
    ]
    const { controller, sceneStore, state } = createController(file)
    sceneStore.setSelection([{ kind: 'group', id: 'group-1' }])

    controller.ungroupSelected()
    controller.bringToFront()
    controller.sendToBack()

    expect(sceneStore.persisted.groups.map((group) => group.id)).toEqual(['group-1', 'group-2'])
    expect(sceneStore.persisted.plants).toHaveLength(2)
    expect(sceneStore.session.selectedTargets).toEqual([{ kind: 'group', id: 'group-1' }])
    expect(state.dirtyTypes).toEqual([])
    expect(state.invalidations).toBe(0)
  })

  it('does not duplicate selected groups that contain locked members', () => {
    const file = makeFile()
    file.plants = file.plants.map((plant) =>
      plant.id === 'plant-1' ? { ...plant, locked: true } : plant,
    )
    file.groups = [
      {
        id: 'group-1',
        name: null,
        locked: false,
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'plant', id: 'plant-2' },
        ],
      },
    ]
    const { controller, sceneStore, state } = createController(file)
    sceneStore.setSelection([{ kind: 'group', id: 'group-1' }])

    controller.duplicateSelected()

    expect(sceneStore.persisted.groups).toHaveLength(1)
    expect(sceneStore.persisted.plants).toHaveLength(2)
    expect(sceneStore.session.selectedTargets).toEqual([{ kind: 'group', id: 'group-1' }])
    expect(state.dirtyTypes).toEqual([])
    expect(state.invalidations).toBe(0)
  })

  it('does not delete a selected Design Object after its Layer becomes locked', () => {
    const file = makeFile()
    file.layers = file.layers.map((layer) =>
      layer.name === 'zones' ? { ...layer, locked: true } : layer,
    )
    const { controller, sceneStore, state } = createController(file)
    sceneStore.setSelection([{ kind: 'zone', id: 'zone-1' }])

    controller.deleteSelected()

    expect(sceneStore.persisted.zones.map((zone) => zone.id)).toEqual(['zone-1'])
    expect(sceneStore.session.selectedTargets).toEqual([{ kind: 'zone', id: 'zone-1' }])
    expect(state.dirtyTypes).toEqual([])
    expect(state.invalidations).toBe(0)
  })

  it('selectAll skips grouped members and locked entities', () => {
    const file = makeFile()
    file.groups = [
      {
        id: 'group-1',
        name: null,
        locked: false,
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'plant', id: 'plant-2' },
        ],
      },
    ]
    file.zones = file.zones.map((zone) =>
      zone.id === 'zone-1' ? { ...zone, locked: true } : zone,
    )
    const { controller, sceneStore, state } = createController(file)

    controller.selectAll()

    expect(sceneStore.session.selectedTargets).toEqual([
      { kind: 'annotation', id: 'annotation-1' },
      { kind: 'group', id: 'group-1' },
    ])
    expect(state.invalidations).toBe(1)
  })

  it('selectAll skips groups that contain locked members', () => {
    const file = makeFile()
    file.plants = file.plants.map((plant) =>
      plant.id === 'plant-1' ? { ...plant, locked: true } : plant,
    )
    file.groups = [
      {
        id: 'group-1',
        name: null,
        locked: false,
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'plant', id: 'plant-2' },
        ],
      },
    ]
    const { controller, sceneStore, state } = createController(file)

    controller.selectAll()

    expect(sceneStore.session.selectedTargets).toEqual([
      { kind: 'zone', id: 'zone-1' },
      { kind: 'annotation', id: 'annotation-1' },
    ])
    expect(state.invalidations).toBe(1)
  })

  it('selectAll reads layer visibility from the scene store', () => {
    const file = makeFile()
    file.layers = file.layers.map((layer) =>
      layer.name === 'annotations' ? { ...layer, visible: false } : layer,
    )
    const { controller, sceneStore } = createController(file)

    controller.selectAll()

    expect(sceneStore.session.selectedTargets).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'plant', id: 'plant-2' },
      { kind: 'zone', id: 'zone-1' },
    ])
  })

  it('selectAll skips Design Objects on locked Layers', () => {
    const file = makeFile()
    file.layers = file.layers.map((layer) =>
      layer.name === 'plants' ? { ...layer, locked: true } : layer,
    )
    const { controller, sceneStore } = createController(file)

    controller.selectAll()

    expect(sceneStore.session.selectedTargets).toEqual([
      { kind: 'zone', id: 'zone-1' },
      { kind: 'annotation', id: 'annotation-1' },
    ])
  })

  it('groups mixed concrete Design Objects into typed Object Group members', () => {
    const { controller, sceneStore, state } = createController()
    sceneStore.setSelection([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'zone', id: 'zone-1' },
      { kind: 'annotation', id: 'annotation-1' },
    ])

    controller.groupSelected()

    expect(sceneStore.persisted.groups).toHaveLength(1)
    const group = sceneStore.persisted.groups[0]!
    expect(group.members).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'zone', id: 'zone-1' },
      { kind: 'annotation', id: 'annotation-1' },
    ])
    expect(sceneStore.session.selectedTargets).toEqual([{ kind: 'group', id: group.id }])
    expect(state.dirtyTypes).toEqual(['group-selected'])
  })

  it('flattens one selected Object Group into its existing identity when grouping with another object', () => {
    const file = makeFile()
    file.groups = [{
      id: 'group-1',
      name: 'Guild',
      locked: false,
      members: [
        { kind: 'plant', id: 'plant-1' },
        { kind: 'zone', id: 'zone-1' },
      ],
    }]
    const { controller, sceneStore } = createController(file)
    sceneStore.setSelection([
      { kind: 'group', id: 'group-1' },
      { kind: 'annotation', id: 'annotation-1' },
    ])

    controller.groupSelected()

    expect(sceneStore.persisted.groups).toEqual([{
      kind: 'group',
      id: 'group-1',
      name: 'Guild',
      locked: false,
      members: [
        { kind: 'plant', id: 'plant-1' },
        { kind: 'zone', id: 'zone-1' },
        { kind: 'annotation', id: 'annotation-1' },
      ],
    }])
    expect(sceneStore.session.selectedTargets).toEqual([{ kind: 'group', id: 'group-1' }])
  })

  it('merges multiple selected Object Groups into the topmost selected group', () => {
    const file = makeFile()
    file.groups = [
      {
        id: 'group-low',
        name: 'Low',
        locked: false,
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'zone', id: 'zone-1' },
        ],
      },
      {
        id: 'group-top',
        name: 'Top',
        locked: false,
        members: [
          { kind: 'plant', id: 'plant-2' },
          { kind: 'annotation', id: 'annotation-1' },
        ],
      },
    ]
    const { controller, sceneStore } = createController(file)
    sceneStore.setSelection([
      { kind: 'group', id: 'group-low' },
      { kind: 'group', id: 'group-top' },
    ])

    controller.groupSelected()

    expect(sceneStore.persisted.groups).toEqual([{
      kind: 'group',
      id: 'group-top',
      name: 'Top',
      locked: false,
      members: [
        { kind: 'plant', id: 'plant-1' },
        { kind: 'zone', id: 'zone-1' },
        { kind: 'plant', id: 'plant-2' },
        { kind: 'annotation', id: 'annotation-1' },
      ],
    }])
    expect(sceneStore.session.selectedTargets).toEqual([{ kind: 'group', id: 'group-top' }])
  })

  it('selectSameSpecies selects eligible same-Species plants without dirtying the document', () => {
    const file = makeFile()
    file.plants = [
      ...file.plants,
      {
        id: 'plant-3',
        canonical_name: 'Pyrus communis',
        common_name: 'Pear',
        color: null,
        position: geoAt(30, 30),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
      {
        id: 'plant-4',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        position: geoAt(40, 40),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: true,
      },
      {
        id: 'plant-5',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        position: geoAt(50, 50),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
    ]
    file.groups = [{
      id: 'group-1',
      name: null,
      locked: false,
      members: [{ kind: 'plant', id: 'plant-5' }],
    }]
    const { controller, sceneStore, state } = createController(file)
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-1' }])

    controller.selectSameSpecies()

    expect(sceneStore.session.selectedTargets).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'plant', id: 'plant-2' },
    ])
    expect(state.dirtyTypes).toEqual([])
    expect(state.invalidations).toBe(1)
  })

  it('selectSpecies replaces the selection with selectable plants of every named species', () => {
    const file = makeFile()
    file.plants = [
      ...file.plants,
      {
        id: 'plant-3',
        canonical_name: 'Pyrus communis',
        common_name: 'Pear',
        color: null,
        position: geoAt(30, 30),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
      {
        id: 'plant-4',
        canonical_name: 'Pyrus communis',
        common_name: 'Pear',
        color: null,
        position: geoAt(40, 40),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: true,
      },
    ]
    const { controller, sceneStore, state } = createController(file)
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-1' }])

    controller.selectSpecies(['Pyrus communis', 'Malus domestica', 'Unknown species'])

    expect(sceneStore.session.selectedTargets).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'plant', id: 'plant-2' },
      { kind: 'plant', id: 'plant-3' },
    ])
    expect(state.dirtyTypes).toEqual([])
    controller.selectSpecies(['Unknown species'])
    expect(sceneStore.session.selectedTargets).toHaveLength(3)
  })

  it('selectSpecies with one name selects that species as the chip and the key panel ask', () => {
    const file = makeFile()
    const plant = file.plants[0]!
    file.plants = [
      ...file.plants,
      { ...plant, id: 'plant-3', canonical_name: 'Pyrus communis', position: geoAt(30, 30) },
      { ...plant, id: 'plant-4', position: geoAt(40, 40), locked: true },
      { ...plant, id: 'plant-5', position: geoAt(50, 50) },
    ]
    file.groups = [{ id: 'group-1', name: null, locked: false, members: [{ kind: 'plant', id: 'plant-5' }] }]
    const { controller, sceneStore, state } = createController(file)
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-3' }])

    controller.selectSpecies([plant.canonical_name])

    expect(sceneStore.session.selectedTargets).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'plant', id: 'plant-2' },
    ])
    expect(state.dirtyTypes).toEqual([])
    expect(state.invalidations).toBe(1)
    controller.selectSpecies([plant.canonical_name])
    expect(state.invalidations).toBe(1)
  })

  it('rotates the selection about its centre as one undoable edit', () => {
    const { controller, sceneStore, state } = createController()
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-1' }, { kind: 'plant', id: 'plant-2' }])
    const [first, second] = sceneStore.persisted.plants.map((plant) => plant.position)
    const centre = { x: (first!.x + second!.x) / 2, y: (first!.y + second!.y) / 2 }

    controller.rotateSelected(90)

    const [rotatedFirst, rotatedSecond] = sceneStore.persisted.plants.map((plant) => plant.position)
    // Clockwise on the map (the plane's y grows southward): north of the centre turns to east.
    const turned = (point: { x: number; y: number }) => ({
      x: centre.x - (point.y - centre.y),
      y: centre.y + (point.x - centre.x),
    })
    expect(rotatedFirst!.x).toBeCloseTo(turned(first!).x)
    expect(rotatedFirst!.y).toBeCloseTo(turned(first!).y)
    expect(rotatedSecond!.x).toBeCloseTo(turned(second!).x)
    expect(rotatedSecond!.y).toBeCloseTo(turned(second!).y)
    expect(state.dirtyTypes).toEqual(['rotate-selected'])
  })

  it('turns a rectangle zone and keeps its shape', () => {
    const { controller, sceneStore } = createController()
    sceneStore.setSelection([{ kind: 'zone', id: 'zone-1' }])

    controller.rotateSelected(-30)

    expect(sceneStore.persisted.zones[0]!.rotationDeg).toBeCloseTo(330)
  })

  it('turns a measurement guide\'s ends with the rest of the selection (canopi-xjym)', () => {
    const file = makeFile()
    file.measurement_guides = [{ id: 'guide-1', start: geoAt(0, 0), end: geoAt(4, 0), locked: false }]
    const { controller, sceneStore, state } = createController(file)
    sceneStore.setSelection([{ kind: 'measurement-guide', id: 'guide-1' }])
    const { start, end } = sceneStore.persisted.measurementGuides[0]!
    const centre = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }

    controller.rotateSelected(90)

    // Clockwise on the map (the plane's y grows southward): a west-east guide turns north-south.
    const turned = sceneStore.persisted.measurementGuides[0]!
    expect(turned.start.x).toBeCloseTo(centre.x)
    expect(turned.start.y).toBeCloseTo(centre.y - (end.x - start.x) / 2)
    expect(turned.end.x).toBeCloseTo(centre.x)
    expect(turned.end.y).toBeCloseTo(centre.y + (end.x - start.x) / 2)
    expect(state.dirtyTypes).toEqual(['rotate-selected'])

    sceneStore.setSelection([{ kind: 'measurement-guide', id: 'guide-1' }, { kind: 'plant', id: 'plant-1' }])
    const plantBefore = { ...sceneStore.persisted.plants[0]!.position }
    controller.rotateSelected(45)
    expect(sceneStore.persisted.plants[0]!.position).not.toEqual(plantBefore)
    expect(sceneStore.persisted.measurementGuides[0]!.start).not.toEqual(turned.start)
  })

  it('never rotates locked objects, and ignores a zero or non-finite angle', () => {
    const file = makeFile()
    file.plants[1] = { ...file.plants[1]!, locked: true }
    const { controller, sceneStore, state } = createController(file)
    const before = sceneStore.persisted.plants.map((plant) => ({ ...plant.position }))
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-1' }, { kind: 'plant', id: 'plant-2' }])

    controller.rotateSelected(45)
    sceneStore.setSelection([{ kind: 'zone', id: 'zone-1' }])
    controller.rotateSelected(0)
    controller.rotateSelected(Number.NaN)
    controller.rotateSelected(360)

    expect(sceneStore.persisted.plants.map((plant) => plant.position)).toEqual(before)
    expect(sceneStore.persisted.zones[0]!.rotationDeg).toBe(0)
    expect(state.dirtyTypes).toEqual([])
  })

  it('canopi-eon8.14.3: Unlock on a group holding a locked member clears its lock and its members\' in one undo step (2.1-Q178)', () => {
    const file = makeFile()
    file.plants[1] = { ...file.plants[1]!, locked: true }
    file.zones[0] = { ...file.zones[0]!, locked: true }
    file.groups = [{
      id: 'group-1',
      locked: true,
      name: null,
      members: [{ kind: 'plant', id: 'plant-1' }, { kind: 'plant', id: 'plant-2' }],
    }]
    const { controller, sceneStore, sceneEdits, state } = createController(file)
    sceneStore.setSelection([{ kind: 'group', id: 'group-1' }])

    controller.unlockSelected()

    expect(sceneStore.persisted.groups[0]!.locked).toBe(false)
    expect(sceneStore.persisted.plants.map((plant) => plant.locked)).toEqual([false, false])
    // An object outside the group keeps its lock.
    expect(sceneStore.persisted.zones[0]!.locked).toBe(true)
    expect(state.dirtyTypes).toEqual(['unlock-selected'])

    expect(sceneEdits.undo()).toBe(true)
    expect(sceneStore.persisted.groups[0]!.locked).toBe(true)
    expect(sceneStore.persisted.plants.map((plant) => plant.locked)).toEqual([false, true])
  })

  it('unlocks every locked object in the Design as one edit, and does nothing when none is locked', () => {
    const file = makeFile()
    file.plants[1] = { ...file.plants[1]!, locked: true }
    file.zones[0] = { ...file.zones[0]!, locked: true }
    file.groups = [{ id: 'group-1', locked: true, name: null, members: [{ kind: 'annotation', id: 'annotation-1' }] }]
    file.annotations[0] = { ...file.annotations[0]!, locked: true }
    file.measurement_guides = [{ id: 'guide-1', start: geoAt(0, 0), end: geoAt(4, 0), locked: true }]
    const { controller, sceneStore, state } = createController(file)
    expect(lockedSceneDesignObjectTargets(sceneStore.persisted)).toEqual([
      { kind: 'plant', id: 'plant-2' },
      { kind: 'zone', id: 'zone-1' },
      { kind: 'annotation', id: 'annotation-1' },
      { kind: 'measurement-guide', id: 'guide-1' },
      { kind: 'group', id: 'group-1' },
    ])
    expect(sceneHasLockedDesignObjects(sceneStore.persisted)).toBe(true)

    controller.unlockAll()

    expect(sceneStore.persisted.plants.map((plant) => plant.locked)).toEqual([false, false])
    expect(sceneStore.persisted.zones[0]!.locked).toBe(false)
    expect(sceneStore.persisted.groups[0]!.locked).toBe(false)
    expect(sceneStore.persisted.annotations[0]!.locked).toBe(false)
    expect(sceneStore.persisted.measurementGuides[0]!.locked).toBe(false)
    expect(sceneHasLockedDesignObjects(sceneStore.persisted)).toBe(false)
    controller.unlockAll()
    expect(state.dirtyTypes).toEqual(['unlock-all'])
  })

  it('clears the selection without editing the Design', () => {
    const { controller, sceneStore, state } = createController()
    sceneStore.setSelection([{ kind: 'plant', id: 'plant-1' }, { kind: 'zone', id: 'Z01' }])

    controller.clearSelection()

    expect(sceneStore.session.selectedTargets).toEqual([])
    expect(state.dirtyTypes).toEqual([])
    controller.clearSelection()
    expect(sceneStore.session.selectedTargets).toEqual([])
  })

  it('updates species colors through the presentation seam', () => {
    const { controller, sceneStore, state } = createController()

    const changed = controller.setPlantColorForSpecies('Malus domestica', '#C44230')

    expect(changed).toBe(2)
    expect(sceneStore.persisted.plantSpeciesColors).toEqual({
      'Malus domestica': '#C44230',
    })
    expect(state.plantSpeciesColorSyncs).toBe(1)
    expect(state.dirtyTypes).toEqual(['set-plant-color-for-species'])
    expect(state.invalidations).toBe(1)
  })

  it('updates selected plant symbols through the presentation seam', () => {
    const { controller, sceneStore, state } = createController()
    sceneStore.setSelection([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'plant', id: 'plant-2' },
    ])

    const changed = controller.setSelectedPlantSymbol('conifer')

    expect(changed).toBe(2)
    expect(sceneStore.persisted.plants.map((plant) => plant.symbol)).toEqual(['conifer', 'conifer'])
    expect(controller.getSelectedPlantSymbolContext()).toMatchObject({
      plantIds: ['plant-1', 'plant-2'],
      sharedCurrentSymbol: 'conifer',
      sharedEffectiveSymbol: 'conifer',
      canClearSelectedSymbol: true,
    })
    expect(state.dirtyTypes).toEqual(['set-selected-plant-symbol'])
    expect(state.invalidations).toBe(1)
  })

  it('clears selected plant symbols back to inherited symbols', () => {
    const file = makeFile()
    file.plant_species_symbols = { 'Malus domestica': 'canopy' }
    file.plants = file.plants.map((plant) => ({ ...plant, symbol: 'conifer' }))
    const { controller, sceneStore, state } = createController(file)
    sceneStore.setSelection([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'plant', id: 'plant-2' },
    ])

    const changed = controller.setSelectedPlantSymbol(null)

    expect(changed).toBe(2)
    expect(sceneStore.persisted.plants.map((plant) => plant.symbol ?? null)).toEqual([null, null])
    expect(controller.getSelectedPlantSymbolContext()).toMatchObject({
      sharedCurrentSymbol: null,
      sharedEffectiveSymbol: 'canopy',
      inheritedSymbol: 'canopy',
      canClearSelectedSymbol: false,
    })
    expect(state.dirtyTypes).toEqual(['set-selected-plant-symbol'])
  })

  it('updates species symbols through the presentation seam and treats round as an explicit default', () => {
    const { controller, sceneStore, state } = createController()
    sceneStore.setSelection([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'plant', id: 'plant-2' },
    ])

    const changed = controller.setPlantSymbolForSpecies('Malus domestica', 'round')

    expect(changed).toBe(2)
    expect(sceneStore.persisted.plantSpeciesSymbols).toEqual({
      'Malus domestica': 'round',
    })
    expect(sceneStore.persisted.plants.map((plant) => plant.symbol)).toEqual(['round', 'round'])
    expect(controller.getSelectedPlantSymbolContext()).toMatchObject({
      singleSpeciesDefaultSymbol: 'round',
      inheritedSymbol: 'round',
    })
    expect(state.dirtyTypes).toEqual(['set-plant-symbol-for-species'])
    expect(state.invalidations).toBe(1)
  })

  it('does not resymbol locked Plants through species-wide symbol edits', () => {
    const file = makeFile()
    file.plants = file.plants.map((plant) =>
      plant.id === 'plant-2' ? { ...plant, locked: true } : plant,
    )
    const { controller, sceneStore, state } = createController(file)

    const changed = controller.setPlantSymbolForSpecies('Malus domestica', 'canopy')
    const lockedPlant = sceneStore.persisted.plants.find((plant) => plant.id === 'plant-2')!

    expect(changed).toBe(1)
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-1')?.symbol).toBe('canopy')
    expect(lockedPlant.symbol).toBe('round')
    expect(resolvePlantSymbolForPlant(lockedPlant, sceneStore.persisted.plantSpeciesSymbols)).toBe('round')
    expect(sceneStore.persisted.plantSpeciesSymbols).toEqual({
      'Malus domestica': 'canopy',
    })
    expect(state.dirtyTypes).toEqual(['set-plant-symbol-for-species'])
  })

  it('does not resymbol Plants inside locked Object Groups through species-wide symbol edits', () => {
    const file = makeFile()
    file.groups = [{
      id: 'group-1',
      name: null,
      locked: true,
      members: [{ kind: 'plant', id: 'plant-2' }],
    }]
    const { controller, sceneStore, state } = createController(file)

    const changed = controller.setPlantSymbolForSpecies('Malus domestica', 'canopy')
    const groupedPlant = sceneStore.persisted.plants.find((plant) => plant.id === 'plant-2')!

    expect(changed).toBe(1)
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-1')?.symbol).toBe('canopy')
    expect(groupedPlant.symbol).toBe('round')
    expect(resolvePlantSymbolForPlant(groupedPlant, sceneStore.persisted.plantSpeciesSymbols)).toBe('round')
    expect(state.dirtyTypes).toEqual(['set-plant-symbol-for-species'])
  })

  it('does not create a species symbol edit while the Plants Layer is locked', () => {
    const file = makeFile()
    file.layers = file.layers.map((layer) =>
      layer.name === 'plants' ? { ...layer, locked: true } : layer,
    )
    const { controller, sceneStore, state } = createController(file)

    const changed = controller.setPlantSymbolForSpecies('Malus domestica', 'canopy')

    expect(changed).toBe(0)
    expect(sceneStore.persisted.plants.map((plant) => plant.symbol ?? null)).toEqual([null, null])
    expect(sceneStore.persisted.plantSpeciesSymbols).toEqual({})
    expect(state.dirtyTypes).toEqual([])
    expect(state.invalidations).toBe(0)
  })

  it('does not recolor locked Plants through species-wide color edits', () => {
    const file = makeFile()
    file.plants = file.plants.map((plant) =>
      plant.id === 'plant-2' ? { ...plant, locked: true } : plant,
    )
    const { controller, sceneStore, state } = createController(file)

    const changed = controller.setPlantColorForSpecies('Malus domestica', '#C44230')

    expect(changed).toBe(1)
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-1')?.color).toBe('#C44230')
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-2')?.color).toBeNull()
    expect(sceneStore.persisted.plantSpeciesColors).toEqual({
      'Malus domestica': '#C44230',
    })
    expect(state.plantSpeciesColorSyncs).toBe(1)
    expect(state.dirtyTypes).toEqual(['set-plant-color-for-species'])
  })

  it('does not recolor Plants inside locked Object Groups through species-wide color edits', () => {
    const file = makeFile()
    file.groups = [{
      id: 'group-1',
      name: null,
      locked: true,
      members: [{ kind: 'plant', id: 'plant-2' }],
    }]
    const { controller, sceneStore, state } = createController(file)

    const changed = controller.setPlantColorForSpecies('Malus domestica', '#C44230')

    expect(changed).toBe(1)
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-1')?.color).toBe('#C44230')
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-2')?.color).toBeNull()
    expect(sceneStore.persisted.plantSpeciesColors).toEqual({
      'Malus domestica': '#C44230',
    })
    expect(state.plantSpeciesColorSyncs).toBe(1)
    expect(state.dirtyTypes).toEqual(['set-plant-color-for-species'])
  })

  it('does not recolor Plants inside Object Groups locked by another member', () => {
    const file = makeFile()
    file.plants = [
      ...file.plants,
      {
        id: 'plant-3',
        canonical_name: 'Pyrus communis',
        common_name: 'Pear',
        color: null,
        position: geoAt(30, 30),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: true,
      },
    ]
    file.groups = [{
      id: 'group-1',
      name: null,
      locked: false,
      members: [
        { kind: 'plant', id: 'plant-2' },
        { kind: 'plant', id: 'plant-3' },
      ],
    }]
    const { controller, sceneStore, state } = createController(file)

    const changed = controller.setPlantColorForSpecies('Malus domestica', '#C44230')

    expect(changed).toBe(1)
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-1')?.color).toBe('#C44230')
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-2')?.color).toBeNull()
    expect(sceneStore.persisted.plants.find((plant) => plant.id === 'plant-3')?.color).toBeNull()
    expect(sceneStore.persisted.plantSpeciesColors).toEqual({
      'Malus domestica': '#C44230',
    })
    expect(state.plantSpeciesColorSyncs).toBe(1)
    expect(state.dirtyTypes).toEqual(['set-plant-color-for-species'])
  })

  it('does not create a species color edit while the Plants Layer is locked', () => {
    const file = makeFile()
    file.layers = file.layers.map((layer) =>
      layer.name === 'plants' ? { ...layer, locked: true } : layer,
    )
    const { controller, sceneStore, state } = createController(file)

    const changed = controller.setPlantColorForSpecies('Malus domestica', '#C44230')

    expect(changed).toBe(0)
    expect(sceneStore.persisted.plants.map((plant) => plant.color)).toEqual([null, null])
    expect(sceneStore.persisted.plantSpeciesColors).toEqual({})
    expect(state.plantSpeciesColorSyncs).toBe(0)
    expect(state.dirtyTypes).toEqual([])
    expect(state.invalidations).toBe(0)
  })

  it('sets a species default color when no placed Plants of that species exist', () => {
    const file = makeFile()
    file.plants = []
    const { controller, sceneStore, state } = createController(file)

    const changed = controller.setPlantColorForSpecies('Malus domestica', '#C44230')

    expect(changed).toBe(0)
    expect(sceneStore.persisted.plantSpeciesColors).toEqual({
      'Malus domestica': '#C44230',
    })
    expect(state.plantSpeciesColorSyncs).toBe(1)
    expect(state.dirtyTypes).toEqual(['set-plant-color-for-species'])
  })
})
