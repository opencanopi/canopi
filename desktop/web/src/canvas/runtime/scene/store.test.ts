import { describe, expect, it } from 'vitest'
import type { CanopiFile } from '../../../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../../generated/canopi-design-format'
import { geoAt, storedGeoAt } from '../../../__tests__/support/geo-design'
import { consortiumTarget, speciesBudgetTarget, speciesTarget } from '../../../target'
import { SceneStore } from './store'
import { createDefaultScenePersistedState, createDefaultSceneSessionState } from './defaults'
import { serializeScenePersistedState } from './codec'
import { createSessionPlane } from '../../../geo/session-plane'
import { createScenePatchCommand } from '../scene-commands'

const TEST_FRAME_ORIGIN = { lon: 13, lat: 23 }

describe('scene store', () => {
  it('reads whether it holds objects', () => {
    const store = new SceneStore()
    store.updatePersisted((draft) => {
      draft.annotations.push({ kind: 'annotation', id: 'a', locked: false,
        annotationType: 'text', position: { x: 3, y: 4 }, text: 'Note', fontSize: 12, rotationDeg: 0 })
    })
    expect(store.hasObjects).toBe(true)
    store.updatePersisted((draft) => { draft.annotations = [] })
    expect(store.hasObjects).toBe(false)
  })

  it('hands out the stored Scene without a copy per read, frozen in dev builds; a write throws', () => {
    const store = new SceneStore()
    let writeAfterCommit = (): void => {}
    store.updatePersisted((draft) => {
      const guide = { kind: 'measurement-guide' as const, id: 'guide-1', locked: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
      draft.measurementGuides.push(guide)
      writeAfterCommit = () => { guide.end.x = 99 }
    })
    store.setSelection([{ kind: 'measurement-guide', id: 'guide-1' }])

    const scene = store.persisted
    expect(store.persisted).toBe(scene)
    expect(store.session).toBe(store.session)
    expect(Object.isFrozen(scene)).toBe(true)
    expect(Object.isFrozen(scene.measurementGuides[0]!.end)).toBe(true)
    expect(() => { scene.measurementGuides[0]!.end.x = 99 }).toThrow(TypeError)
    expect(() => { scene.layers.push(scene.layers[0]!) }).toThrow(TypeError)
    expect(writeAfterCommit).toThrow(TypeError)
    expect(() => { (store.session.selectedTargets[0] as { id: string }).id = 'escaped' }).toThrow(TypeError)
    expect(store.persisted.measurementGuides.map((guide) => guide.end)).toEqual([{ x: 10, y: 0 }])
    expect(store.session.selectedTargets).toEqual([{ kind: 'measurement-guide', id: 'guide-1' }])
  })

  it('gives a mutator its own copy, so the Scene read before the edit stays as it was', () => {
    const store = new SceneStore()
    const before = store.persisted
    store.updatePersisted((draft) => {
      const layer = draft.layers[0]!
      layer.visible = !layer.visible
    })
    expect(store.persisted).not.toBe(before)
    expect(store.persisted.layers[0]!.visible).toBe(!before.layers[0]!.visible)
  })

  it('a new species gets its code at commit', () => {
    const store = new SceneStore()
    store.updatePersisted((draft) => {
      draft.plants.push({ kind: 'plant', id: 'p', locked: false, canonicalName: 'Malus domestica', commonName: null,
        color: null, canopySpreadM: null, position: { x: 0, y: 0 }, rotationDeg: null, notes: null,
        plantedDate: null, quantity: null })
    })
    const codes = store.persisted.plantSpeciesCodes
    expect(codes).toEqual({ 'Malus domestica': 'MDO' })
    expect(store.persisted.plantSpeciesCodes).toBe(codes)
    expect(store.toCanopiFile().plant_species_codes).toEqual({ 'Malus domestica': 'MDO' })
  })

  it('a commit that changes nothing yields no command after a species that sorts first', () => {
    const store = new SceneStore()
    const plant = (id: string, canonicalName: string) => ({ kind: 'plant' as const, id, locked: false, canonicalName,
      commonName: null, color: null, canopySpreadM: null, position: { x: 0, y: 0 }, rotationDeg: null, notes: null,
      plantedDate: null, quantity: null })
    store.updatePersisted((draft) => { draft.plants.push(plant('m', 'Malus domestica'), plant('p', 'Prunus avium')) })
    store.updatePersisted((draft) => { draft.plants.push(plant('c', 'Corylus avellana')) })
    const snapshot = () => ({ persisted: store.persisted, selectedTargets: store.session.selectedTargets })

    const before = snapshot()
    store.updatePersisted(() => {})

    expect(createScenePatchCommand('noop', before, snapshot())).toBeNull()
    expect(Object.keys(store.persisted.plantSpeciesCodes)).toEqual(['Corylus avellana', 'Malus domestica', 'Prunus avium'])
  })

  it('owns typed selection targets and preserves first-seen typed order', () => {
    const store = new SceneStore()
    const plantTarget = { kind: 'plant' as const, id: 'shared-id' }
    const zoneTarget = { kind: 'zone' as const, id: 'shared-id' }

    store.setSelection([
      plantTarget,
      zoneTarget,
      { kind: 'plant', id: 'shared-id' },
    ])
    plantTarget.id = 'mutated-input'
    zoneTarget.id = 'mutated-input'

    expect(store.session.selectedTargets).toEqual([
      { kind: 'plant', id: 'shared-id' },
      { kind: 'zone', id: 'shared-id' },
    ])
  })

  it('hydrates and serializes CanopiFile data without crossing the session boundary', () => {
    const file: CanopiFile = {
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Demo',
      description: 'sample',
      plant_species_colors: {
        oak: '#228833',
      },
      plant_species_symbols: {
        'Quercus robur': 'tree',
      },
      layers: [
        { name: 'base', visible: true, locked: false, opacity: 1 },
      ],
      plants: [
        {
          id: 'plant-1',
          locked: false,
          canonical_name: 'Quercus robur',
          common_name: 'English oak',
          color: '#228833',
          symbol: 'square',
          pinned_name: false,
          position: storedGeoAt(12, 18),
          rotation: 45,
          scale: 1.2,
          notes: 'heritage tree',
          planted_date: '2025-04-01',
          quantity: 1,
        },
      ],
      zones: [
        {
          id: 'zone-a', name: null,
          locked: false,
          zone_type: 'rect',
          points: [
            storedGeoAt(0, 0),
            storedGeoAt(10, 0),
            storedGeoAt(10, 8),
            storedGeoAt(0, 8),
          ],
          rotation: 0,
          fill_color: '#ddeeff',
          notes: null,
        },
      ],
      annotations: [],
      measurement_guides: [{
        id: 'measurement-guide-1',
        locked: false,
        start: storedGeoAt(1, 1),
        end: storedGeoAt(4, 1),
      }],
      consortiums: [{ target: consortiumTarget('Quercus robur'), stratum: 'high', start_phase: 0, end_phase: 3 }],
      groups: [
        {
          id: 'group-1',
          locked: false,
          name: 'grouped',
          members: [{ kind: 'plant', id: 'plant-1' }],
        },
      ],
      timeline: [{ id: 't1', action_type: 'planting', description: 'Plant oak', start_date: '2026-04-01', end_date: '2026-04-02', recurrence: null, targets: [speciesTarget('Quercus robur')], depends_on: [], completed: false, order: 0 }],
      budget: [{ target: speciesBudgetTarget('Quercus robur'), category: 'plants', description: 'Quercus robur', quantity: 1, unit_cost: 25, currency: 'EUR' }],
      budget_currency: 'EUR',
      created_at: '2026-04-01T10:00:00.000Z',
      updated_at: '2026-04-01T12:00:00.000Z',
      extra: {
        guides: [{ id: 'guide-1', axis: 'h', lat: 22.9996 }],
      },
    }

    const store = new SceneStore().hydrate(file).setSelection([{ kind: 'plant', id: 'plant-1' }])

    expect(store.session.selectedTargets).toContainEqual({ kind: 'plant', id: 'plant-1' })
    expect(store.persisted.plants[0]).toMatchObject({
      canopySpreadM: 1.2,
    })

    store.updateSession((draft) => {
      draft.hoveredTarget = { kind: 'zone', id: 'zone-a' }
    })

    expect(store.session.hoveredTarget).toEqual({ kind: 'zone', id: 'zone-a' })

    // toCanopiFile serializes canvas-entity fields; non-canvas sections
    // (consortiums, timeline, budget) are emitted as empty placeholders —
    // even when the input file had non-empty values. This proves the codec
    // does not accidentally leak document-store data through the scene path.
    const roundTripped = store.toCanopiFile({ now: new Date(file.updated_at) })
    expect(roundTripped.plants).toEqual(file.plants)
    expect(roundTripped.zones).toEqual(file.zones)
    expect(roundTripped.annotations).toEqual(file.annotations)
    expect(roundTripped.measurement_guides).toEqual(file.measurement_guides)
    expect(roundTripped.groups).toEqual(file.groups)
    expect(roundTripped.layers).toEqual(file.layers)
    expect(roundTripped.plant_species_colors).toEqual(file.plant_species_colors)
    expect(roundTripped.plant_species_symbols).toEqual(file.plant_species_symbols)
    // `extra` is Design Edit's: a leftover key in the file never passes through the scene.
    expect(roundTripped).not.toHaveProperty('extra')
    expect(roundTripped.name).toBe('Untitled')
    expect(roundTripped.description).toBeNull()
    expect(roundTripped.version).toBe(CURRENT_CANOPI_FILE_VERSION)
    // Non-canvas sections must be empty placeholders, NOT the input values
    expect(roundTripped.consortiums).toEqual([])
    expect(roundTripped.timeline).toEqual([])
    expect(roundTripped.budget).toEqual([])
  })

  it('creates a usable default scene state', () => {
    const persisted = createDefaultScenePersistedState()
    const secondPersisted = createDefaultScenePersistedState()
    const session = createDefaultSceneSessionState()
    const firstLayer = persisted.layers[0]
    const secondLayer = secondPersisted.layers[0]
    if (!firstLayer || !secondLayer) throw new Error('canonical layer catalog is empty')

    expect(persisted.layers).toHaveLength(4)
    expect(firstLayer).not.toBe(secondLayer)
    expect(persisted.plantSpeciesSymbols).toEqual({})
    expect(persisted.layers.map((layer: { name: string; visible: boolean }) => [layer.name, layer.visible])).toEqual([
      ['zones', true],
      ['plants', true],
      ['measurement-guides', true],
      ['annotations', true],
    ])
    firstLayer.visible = false
    expect(secondLayer.visible).toBe(true)
    expect(persisted.plants).toHaveLength(0)
    expect(persisted.measurementGuides).toEqual([])
    expect(session.selectedTargets).toEqual([])
    expect(serializeScenePersistedState(persisted, createSessionPlane(TEST_FRAME_ORIGIN), { now: new Date('2026-04-02T00:00:00.000Z') }).version).toBe(CURRENT_CANOPI_FILE_VERSION)
  })

  it('normalizes and round-trips a Design without Measurement Guides', () => {
    const file = serializeScenePersistedState(createDefaultScenePersistedState(), createSessionPlane(TEST_FRAME_ORIGIN))
    delete file.measurement_guides

    const store = new SceneStore().hydrate(file)
    expect(store.persisted.measurementGuides).toEqual([])

    const normalizedFile = store.toCanopiFile()
    expect(normalizedFile.measurement_guides).toEqual([])

    const reloadedStore = new SceneStore().hydrate(normalizedFile)
    expect(reloadedStore.persisted.measurementGuides).toEqual([])
  })

  it('hydrates and serializes embedded Design Object lock state', () => {
    const file: CanopiFile = {
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Locked objects',
      description: null,
      plant_species_colors: {},
      layers: [],
      plants: [
        {
          id: 'plant-1',
          locked: true,
          canonical_name: 'Quercus robur',
          common_name: null,
          color: null,
          position: geoAt(1, 2),
          rotation: null,
          scale: null,
          notes: null,
          planted_date: null,
          quantity: null,
        },
      ],
      zones: [
        {
          id: 'zone-1', name: null,
          zone_type: 'polygon',
          points: [geoAt(0, 0)],
          rotation: 0,
          fill_color: null,
          notes: null,
          locked: true,
        },
      ],
      annotations: [
        {
          id: 'annotation-1',
          annotation_type: 'text',
          position: geoAt(3, 4),
          text: 'Note',
          font_size: 16,
          rotation: null,
          locked: true,
        },
      ],
      consortiums: [],
      groups: [
        {
          id: 'group-1',
          name: null,
          locked: true,
          members: [{ kind: 'plant', id: 'plant-1' }],
        },
      ],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      created_at: '2026-04-01T10:00:00.000Z',
      updated_at: '2026-04-01T12:00:00.000Z',
      extra: {},
    }

    const serialized = new SceneStore().hydrate(file).toCanopiFile({ now: new Date(file.updated_at) })

    expect(serialized.plants[0]?.locked).toBe(true)
    expect(serialized.zones[0]?.locked).toBe(true)
    expect(serialized.annotations[0]?.locked).toBe(true)
    expect(serialized.groups[0]?.locked).toBe(true)
  })

  it('hydrates and serializes shaped Zone orientation', () => {
    const file = {
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Oriented zones',
      description: null,
      plant_species_colors: {},
      layers: [],
      plants: [],
      zones: [
        {
          id: 'zone-1',
          name: null,
          locked: false,
          zone_type: 'rect',
          points: [
            geoAt(0, 0),
            geoAt(10, 0),
            geoAt(10, 5),
            geoAt(0, 5),
          ],
          rotation: 35,
          fill_color: null,
          notes: null,
        },
      ],
      annotations: [],
      consortiums: [],
      groups: [],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      created_at: '2026-04-01T10:00:00.000Z',
      updated_at: '2026-04-01T12:00:00.000Z',
      extra: {},
    } as CanopiFile

    const store = new SceneStore().hydrate(file)

    expect(store.persisted.zones[0]?.rotationDeg).toBe(35)
    expect(store.toCanopiFile({ now: new Date(file.updated_at) }).zones[0]?.rotation).toBe(35)
  })

  it('serializes runtime plant presentation metadata back into the existing placed-plant fields only', () => {
    const file: CanopiFile = {
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Demo',
      description: null,
      plant_species_colors: {},
      layers: [],
      plants: [
        {
          id: 'plant-1',
          locked: false,
          canonical_name: 'Quercus robur',
          common_name: 'English oak',
          color: null,
          pinned_name: false,
          position: storedGeoAt(12, 18),
          rotation: null,
          scale: 1.2,
          notes: null,
          planted_date: null,
          quantity: null,
        },
      ],
      zones: [],
      annotations: [],
      consortiums: [],
      groups: [],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      created_at: '2026-04-01T10:00:00.000Z',
      updated_at: '2026-04-01T12:00:00.000Z',
      extra: {},
    }

    const store = new SceneStore().hydrate(file)

    store.updatePersisted((draft) => {
      draft.plants[0]!.canopySpreadM = 2.4
    })

    const serialized = store.toCanopiFile({ now: new Date(file.updated_at) })

    expect(serialized.plants[0]).toEqual({
      ...file.plants[0],
      scale: 2.4,
    })
    expect(serialized.plants[0]).not.toHaveProperty('canopySpreadM')
  })

  it('writes no extra: the scene owns no extra key', () => {
    const file = serializeScenePersistedState(createDefaultScenePersistedState(), createSessionPlane(TEST_FRAME_ORIGIN), {
      now: new Date('2026-04-02T00:00:00.000Z'),
    })

    expect(file).not.toHaveProperty('extra')
  })
})
