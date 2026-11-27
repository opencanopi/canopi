import { describe, expect, it } from 'vitest'
import {
  createToolSceneSource,
  measurementGuide,
  plantEntity,
  rectZone,
  sceneStoreWith,
  textNote,
} from '../../../__tests__/support/tool-harness'
import { buildPlantPresentationEntries } from '../plant-presentation'
import type { SceneStore } from '../scene'
import type { WorldPoint, WorldQuad } from '../../../geo/view/types'
import { hitTestTopLevel, hitTestVisibleTopLevel } from './hit-testing'
import { createToolScene } from './spatial-index'

function orchardStore(): SceneStore {
  return sceneStoreWith({
    plants: [
      plantEntity('p1', 'Malus domestica', { x: 0, y: 0 }, { commonName: 'Apple' }),
      plantEntity('p2', 'Pyrus communis', { x: 1, y: 0 }),
      plantEntity('p3', 'Prunus avium', { x: 20, y: 20 }),
      plantEntity('p4', 'Ficus carica', { x: 40, y: 40 }, { locked: true }),
    ],
    zones: [
      rectZone('z1', [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }]),
      rectZone('z2', [{ x: 18, y: 18 }, { x: 24, y: 18 }, { x: 24, y: 24 }, { x: 18, y: 24 }]),
    ],
    annotations: [textNote('a1', { x: 30, y: 0 }, 'Compost')],
    measurementGuides: [measurementGuide('m1', { x: 0, y: 30 }, { x: 10, y: 30 })],
    groups: [{
      kind: 'group',
      id: 'g1',
      locked: false,
      name: null,
      members: [{ kind: 'plant', id: 'p3' }, { kind: 'zone', id: 'z2' }],
    }],
  })
}

function samplePoints(): WorldPoint[] {
  const points: WorldPoint[] = []
  for (let x = -5; x <= 45; x += 1.25) {
    for (let y = -5; y <= 45; y += 1.25) points.push({ x, y })
  }
  return points
}

describe('ToolScene over today\'s hit tests', () => {
  it('hitAt is hitTestTopLevel for its pointer exactly', () => {
    const store = orchardStore()
    store.setSelection([{ kind: 'annotation', id: 'a1' }])
    const source = createToolSceneSource(store, { pixelsPerMetre: () => 4 })
    const scene = createToolScene(source)

    for (const point of samplePoints()) {
      const expected = hitTestTopLevel(
        store.persisted,
        point,
        4,
        'mouse',
        source.speciesCache(),
        source.plantContext,
        store.session.selectedTargets,
        store.session.hoveredTarget,
      )
      expect(scene.hitAt(point, { pointer: 'mouse' }), `${point.x},${point.y}`).toEqual(expected ? { kind: 'object', target: expected } : null)
    }
    // Object locks are the caller's to reject: a locked plant is still hit.
    expect(scene.hitAt({ x: 40, y: 40 }, { pointer: 'mouse' })).toEqual({ kind: 'object', target: { kind: 'plant', id: 'p4' } })
  })

  it('includeLocked is today\'s hitTestVisibleTopLevel, which the host\'s hover reads', () => {
    const store = orchardStore()
    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => layer.name === 'plants' ? { ...layer, locked: true } : layer)
    })
    const source = createToolSceneSource(store, { pixelsPerMetre: () => 4 })
    const scene = createToolScene(source)

    expect(scene.hitAt({ x: 0, y: 0 }, { pointer: 'mouse' })).toBeNull()
    for (const point of samplePoints()) {
      const expected = hitTestVisibleTopLevel(
        store.persisted,
        point,
        4,
        'mouse',
        source.speciesCache(),
        source.plantContext,
        store.session.selectedTargets,
        store.session.hoveredTarget,
      )
      expect(scene.hitAt(point, { pointer: 'mouse', includeLocked: true }), `${point.x},${point.y}`)
        .toEqual(expected ? { kind: 'object', target: expected } : null)
    }
  })

  it('reads the frame scale at every query, so screen-sized plants hit as drawn', () => {
    let pixelsPerMetre = 40
    const scene = createToolScene(createToolSceneSource(orchardStore(), { pixelsPerMetre: () => pixelsPerMetre }))
    // Between p1 and p2: at 40 px/m the symbols are small, at 4 px/m they cover the gap.
    const between = { x: 0.5, y: 0.3 }

    expect(scene.hitAt(between, { pointer: 'mouse' })).toBeNull()
    pixelsPerMetre = 4
    expect(scene.hitAt(between, { pointer: 'mouse' })).not.toBeNull()
  })

  it('zoneEdge answers the nearest zone edge within the pointer\'s pick tolerance at the frame\'s scale', () => {
    let pixelsPerMetre = 4
    const scene = createToolScene(createToolSceneSource(orchardStore(), { pixelsPerMetre: () => pixelsPerMetre }))

    // z1's north edge runs along y = 5 from x = 5 to 15: 1.5 m is 6 px at 4 px/m, 12 px at 8 px/m.
    expect(scene.hitAt({ x: 10, y: 3.5 }, { pointer: 'mouse', zoneEdge: true }))
      .toEqual({ kind: 'zone-edge', zoneId: 'z1', edgeIndex: 0, distancePx: expect.closeTo(6, 6) })
    pixelsPerMetre = 8
    expect(scene.hitAt({ x: 10, y: 3.5 }, { pointer: 'mouse', zoneEdge: true })).toBeNull()
    expect(scene.hitAt({ x: 10, y: 3.5 }, { pointer: 'touch', zoneEdge: true }))
      .toEqual({ kind: 'zone-edge', zoneId: 'z1', edgeIndex: 0, distancePx: expect.closeTo(12, 6) })
  })

  it('a quad at 45 hits plants by their circles and shapes by their polygons, never a hidden layer', () => {
    const pixelsPerMetre = 20
    // A diamond: the band of a square screen box seen at 45°. Its world box is [-10, 10]², which today's query read.
    const diamond: WorldQuad = [{ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 }, { x: 0, y: -10 }]
    const probe = createToolScene(createToolSceneSource(sceneStoreWith({}), { pixelsPerMetre: () => pixelsPerMetre }))
    const radius = probe.plantPresentation(plantEntity('probe', 'Malus domestica', { x: 0, y: 0 })).radiusPx / pixelsPerMetre
    // Off the diamond's south-east edge (x + y = 10) by 0.85 radius along the diagonal: the plant's square reaches the
    // diamond, its circle does not. Off the north-west edge by half a radius, the circle reaches it. (The plants stay far
    // enough apart that their spacing leaves the probe's radius alone.)
    const offEdge = 5 + radius * 0.85
    const store = sceneStoreWith({
      plants: [
        plantEntity('centre', 'Malus domestica', { x: 0, y: 0 }),
        plantEntity('box-corner', 'Malus domestica', { x: 8, y: 8 }),
        plantEntity('square-only', 'Malus domestica', { x: offEdge, y: offEdge }),
        plantEntity('circle-crosses', 'Malus domestica', { x: -5 - radius * 0.5, y: -5 - radius * 0.5 }),
      ],
      zones: [
        rectZone('in-box-corner', [{ x: -9, y: -9 }, { x: -7, y: -9 }, { x: -7, y: -7 }, { x: -9, y: -7 }]),
        rectZone('across-edge', [{ x: -8, y: 6 }, { x: -2, y: 6 }, { x: -2, y: 9 }, { x: -8, y: 9 }]),
      ],
      measurementGuides: [
        measurementGuide('in-box', { x: 9, y: -9 }, { x: 9, y: -6 }),
        measurementGuide('crossing', { x: 3, y: -12 }, { x: 3, y: -4 }),
      ],
    })
    const scene = createToolScene(createToolSceneSource(store, { pixelsPerMetre: () => pixelsPerMetre }))

    expect(scene.hitInQuad(diamond)).toEqual([
      { kind: 'object', target: { kind: 'plant', id: 'centre' } },
      { kind: 'object', target: { kind: 'plant', id: 'circle-crosses' } },
      { kind: 'object', target: { kind: 'measurement-guide', id: 'crossing' } },
      { kind: 'object', target: { kind: 'zone', id: 'across-edge' } },
    ])

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => layer.name === 'zones' ? { ...layer, visible: false } : layer)
    })
    expect(scene.hitInQuad(diamond)).toEqual([
      { kind: 'object', target: { kind: 'plant', id: 'centre' } },
      { kind: 'object', target: { kind: 'plant', id: 'circle-crosses' } },
      { kind: 'object', target: { kind: 'measurement-guide', id: 'crossing' } },
    ])
  })

  it('nearestPlant keeps the first plant in scene order on a tie, as Place plants does today', () => {
    const store = sceneStoreWith({
      plants: [
        plantEntity('b', 'Malus domestica', { x: 3, y: 4 }),
        plantEntity('a', 'Malus domestica', { x: -3, y: 4 }),
        plantEntity('c', 'Malus domestica', { x: 10, y: 0 }),
      ],
    })
    const scene = createToolScene(createToolSceneSource(store))

    expect(scene.nearestPlant({ x: 0, y: 0 })).toEqual({
      plant: store.persisted.plants[0],
      distanceM: store.sessionPlane.groundLength({ x: 0, y: 0 }, { x: 3, y: 4 }),
    })

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => layer.name === 'plants' ? { ...layer, visible: false } : layer)
    })
    expect(scene.nearestPlant({ x: 0, y: 0 })).toBeNull()

    store.updatePersisted((draft) => {
      draft.layers = draft.layers.map((layer) => layer.name === 'plants' ? { ...layer, visible: true, opacity: 0 } : layer)
    })
    expect(scene.nearestPlant({ x: 0, y: 0 })).toBeNull()
  })

  it('names a plant in today\'s order and gives its display colour and symbol radius', () => {
    const store = orchardStore()
    const localizedCommonNames = new Map<string, string | null>([['Pyrus communis', 'Poirier']])
    const source = createToolSceneSource(store, { pixelsPerMetre: () => 4, localizedCommonNames })
    const scene = createToolScene(source)
    const [apple, pear] = store.persisted.plants
    const entries = buildPlantPresentationEntries(
      store.persisted.plants,
      { ...source.plantContext(4), plants: store.persisted.plants },
      new Set(),
    )

    expect(scene.plantPresentation(apple!)).toEqual({
      commonName: 'Apple',
      color: entries[0]!.color,
      radiusPx: entries[0]!.radiusScreenPx,
    })
    expect(scene.plantPresentation(pear!).commonName).toBe('Poirier')
    expect(scene.plantPresentation({ ...apple!, commonName: null }).commonName).toBe('Malus domestica')
  })

  it('reads the scene, the selection and the selection model live', () => {
    const store = orchardStore()
    const source = createToolSceneSource(store, { pixelsPerMetre: () => 4 })
    const scene = createToolScene(source)

    expect(scene.selection()).toEqual([])
    expect(scene.selectionModel().editableTargets).toEqual([])
    store.setSelection([{ kind: 'zone', id: 'z1' }])
    expect(scene.selection()).toEqual([{ kind: 'zone', id: 'z1' }])
    expect(scene.selectionModel().editableTargets).toEqual([{ kind: 'zone', id: 'z1' }])

    store.updatePersisted((draft) => {
      draft.zones = []
    })
    expect(scene.persisted.zones).toEqual([])
    expect(scene.isLayerOpenForCreation('zones')).toBe(true)
  })
})
