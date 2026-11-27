import { describe, expect, it } from 'vitest'

import type { PointerKind } from '../interaction-types'
import type { PlantPresentationContext } from '../plant-presentation'
import type { ScenePersistedState, ScenePoint, SceneZoneEntity } from '../scene'
import { hitTestTopLevel, hitTestVisibleTopLevel, hitZoneEdge, queryQuadTopLevel, zoneEdgeSegment } from './hit-testing'

function createScene(): ScenePersistedState {
  return {
    plantSpeciesColors: {},
    plantSpeciesSymbols: {},
    plantSpeciesCodes: {},
    layers: [
      { kind: 'layer', name: 'plants', visible: true, locked: false, opacity: 1 },
      { kind: 'layer', name: 'zones', visible: true, locked: false, opacity: 1 },
    ],
    plants: [{
      kind: 'plant',
      locked: false,
      id: 'plant-1',
      canonicalName: 'Malus domestica',
      commonName: 'Apple',
      color: null,
      canopySpreadM: null,
      position: { x: 10, y: 20 },
      rotationDeg: null,
      notes: null,
      plantedDate: null,
      quantity: null,
    }],
    zones: [],
    annotations: [],
    measurementGuides: [],
    groups: [],
  }
}

/** A band level with the world axes, as its four corners. */
function box(rect: { x: number; y: number; width: number; height: number }): ScenePoint[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ]
}

function getPlantContext(viewportScale: number): PlantPresentationContext {
  return {
    pixelsPerMetre: viewportScale,
    speciesCache: new Map(),
  }
}

describe('scene hit testing', () => {
  it('keeps a crowded annotation discoverable without letting its hidden text steal a plant hit at working zoom', () => {
    const scene = createScene()
    scene.annotations = [{ kind: 'annotation', id: 'note', annotationType: 'text',
      position: { x: 0, y: 20 }, text: 'A long note over the plant', fontSize: 16, rotationDeg: null, locked: false }]
    expect(hitTestTopLevel(scene, { x: 10, y: 20 }, 20, 'mouse', new Map(), getPlantContext))
      .toEqual({ kind: 'plant', id: 'plant-1' })
    expect(hitTestTopLevel(scene, { x: 0, y: 20 }, 20, 'mouse', new Map(), getPlantContext))
      .toEqual({ kind: 'annotation', id: 'note' })
    expect(queryQuadTopLevel(scene, box({ x: 5, y: 20, width: .1, height: .1 }), 20, new Map(), getPlantContext))
      .toEqual([])
    expect(hitTestTopLevel(scene, { x: 5, y: 20 }, 20, 'mouse', new Map(), getPlantContext, [], { kind: 'annotation', id: 'note' }))
      .toEqual({ kind: 'annotation', id: 'note' })
    expect(hitTestVisibleTopLevel(scene, { x: 5, y: 20 }, 20, 'mouse', new Map(), getPlantContext, [], { kind: 'annotation', id: 'note' }))
      .toEqual({ kind: 'annotation', id: 'note' })
  })

  it('chooses the closest visible plant when dense position marks share pointer padding', () => {
    const scene = createScene()
    scene.plants = [
      { ...scene.plants[0]!, id: 'a', position: { x: 0, y: 0 } },
      { ...scene.plants[0]!, id: 'b', position: { x: .27, y: 0 } },
    ]
    expect(hitTestTopLevel(scene, { x: 0, y: 0 }, 10, 'mouse', new Map(), getPlantContext))
      .toEqual({ kind: 'plant', id: 'a' })
    expect(queryQuadTopLevel(scene, box({ x: -.3, y: 0, width: .01, height: .01 }), 10, new Map(), getPlantContext))
      .toEqual([])
  })

  it('hits the overview note marker without letting hidden text steal a plant hit', () => {
    const scene = createScene()
    scene.annotations = [{ kind: 'annotation', id: 'note', annotationType: 'text',
      position: { x: 0, y: 20 }, text: 'A long note over the plant', fontSize: 16, rotationDeg: null, locked: false }]
    expect(hitTestTopLevel(scene, { x: -6, y: 20 }, 1, 'mouse', new Map(), getPlantContext))
      .toEqual({ kind: 'annotation', id: 'note' })
    expect(hitTestTopLevel(scene, { x: 10, y: 20 }, 1, 'mouse', new Map(), getPlantContext))
      .toEqual({ kind: 'plant', id: 'plant-1' })
    expect(queryQuadTopLevel(scene, box({ x: 30, y: 22, width: 2, height: 2 }), 1, new Map(), getPlantContext))
      .toEqual([])
  })

  it('uses the symbolic Placed Plant Visual Footprint for band selection bounds', () => {
    const scene = createScene()
    const targets = queryQuadTopLevel(
      scene,
      box({ x: 10.34, y: 20, width: 0.01, height: 0.01 }),
      10,
      new Map(),
      getPlantContext,
    )

    expect(targets).toEqual([{ kind: 'plant', id: 'plant-1' }])
  })

  it('detects visible locked-Layer targets for hover without making them editable', () => {
    const scene = createScene()
    scene.layers = [{ kind: 'layer', name: 'plants', visible: true, locked: true, opacity: 1 }]

    expect(hitTestTopLevel(scene, { x: 10, y: 20 }, 10, 'mouse', new Map(), getPlantContext))
      .toBeNull()
    expect(hitTestVisibleTopLevel(scene, { x: 10, y: 20 }, 10, 'mouse', new Map(), getPlantContext))
      .toEqual({ kind: 'plant', id: 'plant-1' })
  })

  it('hides hidden-Layer targets from editable and hover hit testing', () => {
    const scene = createScene()
    scene.layers = [{ kind: 'layer', name: 'plants', visible: false, locked: false, opacity: 1 }]

    expect(hitTestTopLevel(scene, { x: 10, y: 20 }, 10, 'mouse', new Map(), getPlantContext))
      .toBeNull()
    expect(hitTestVisibleTopLevel(scene, { x: 10, y: 20 }, 10, 'mouse', new Map(), getPlantContext))
      .toBeNull()
  })

  it('hit-tests rotated Rectangular Zones by oriented boundary proximity', () => {
    const scene = createScene()
    scene.plants = []
    scene.zones = [{
      kind: 'zone',
      id: 'zone-1', name: null,
      locked: false,
      zoneType: 'rect',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 4 },
        { x: 0, y: 4 },
      ],
      rotationDeg: 45,
      fillColor: null,
      notes: null,
    }]

    expect(hitTestTopLevel(scene, { x: 6.4, y: 0.6 }, 10, 'mouse', new Map(), getPlantContext))
      .toEqual({ kind: 'zone', id: 'zone-1' })
    expect(hitTestTopLevel(scene, { x: 5, y: 2 }, 10, 'mouse', new Map(), getPlantContext))
      .toBeNull()
    expect(hitTestTopLevel(scene, { x: -5, y: -5 }, 10, 'mouse', new Map(), getPlantContext))
      .toBeNull()
  })

  it('band-selects rotated Rectangular Zones by their oriented outline', () => {
    const scene = createScene()
    scene.plants = []
    scene.zones = [{
      kind: 'zone',
      id: 'zone-1', name: null,
      locked: false,
      zoneType: 'rect',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 4 },
        { x: 0, y: 4 },
      ],
      rotationDeg: 45,
      fillColor: null,
      notes: null,
    }]

    // (canopi-qd2k) By its outline: a band around a turned corner selects it, a band wholly inside it does not.
    expect(queryQuadTopLevel(scene, box({ x: 6.6, y: 6.6, width: 1, height: 1 }), 1, new Map(), getPlantContext))
      .toEqual([{ kind: 'zone', id: 'zone-1' }])
    expect(queryQuadTopLevel(scene, box({ x: 5, y: 2, width: 0.01, height: 0.01 }), 1, new Map(), getPlantContext))
      .toEqual([])
    expect(queryQuadTopLevel(scene, box({ x: 1, y: 1, width: 0.01, height: 0.01 }), 1, new Map(), getPlantContext))
      .toEqual([])
  })

  it('hit-tests rotated Elliptical Zones by oriented boundary proximity', () => {
    const scene = createScene()
    scene.plants = []
    scene.zones = [{
      kind: 'zone',
      id: 'zone-1', name: null,
      locked: false,
      zoneType: 'ellipse',
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 1 },
      ],
      rotationDeg: 90,
      fillColor: null,
      notes: null,
    }]

    expect(hitTestTopLevel(scene, { x: 0, y: 4 }, 10, 'mouse', new Map(), getPlantContext))
      .toEqual({ kind: 'zone', id: 'zone-1' })
    expect(hitTestTopLevel(scene, { x: 0, y: 0 }, 10, 'mouse', new Map(), getPlantContext))
      .toBeNull()
    expect(hitTestTopLevel(scene, { x: 3, y: 0 }, 10, 'mouse', new Map(), getPlantContext))
      .toBeNull()
  })

  it('keeps large Elliptical Zone boundary hits screen-stable at high zoom', () => {
    const scene = createScene()
    scene.plants = []
    scene.zones = [{
      kind: 'zone',
      id: 'zone-1', name: null,
      locked: false,
      zoneType: 'ellipse',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      rotationDeg: 0,
      fillColor: null,
      notes: null,
    }]
    const midpointBetweenFixedSamplesRad = (3.75 * Math.PI) / 180

    expect(hitTestTopLevel(
      scene,
      {
        x: Math.cos(midpointBetweenFixedSamplesRad) * 100,
        y: Math.sin(midpointBetweenFixedSamplesRad) * 100,
      },
      100,
      'mouse', new Map(),
      getPlantContext,
    )).toEqual({ kind: 'zone', id: 'zone-1' })
  })

  it('band-selects rotated Elliptical Zones by their oriented outline', () => {
    const scene = createScene()
    scene.plants = []
    scene.zones = [{
      kind: 'zone',
      id: 'zone-1', name: null,
      locked: false,
      zoneType: 'ellipse',
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 1 },
      ],
      rotationDeg: 90,
      fillColor: null,
      notes: null,
    }]

    // (canopi-qd2k) By its outline: a band across its turned end selects it, a band wholly inside it does not.
    expect(queryQuadTopLevel(scene, box({ x: -0.5, y: 3.5, width: 1, height: 1 }), 1, new Map(), getPlantContext))
      .toEqual([{ kind: 'zone', id: 'zone-1' }])
    expect(queryQuadTopLevel(scene, box({ x: 0, y: 3, width: 0.01, height: 0.01 }), 1, new Map(), getPlantContext))
      .toEqual([])
    expect(queryQuadTopLevel(scene, box({ x: 3, y: 0, width: 0.01, height: 0.01 }), 1, new Map(), getPlantContext))
      .toEqual([])
  })

  it('hit-tests selected rotated text annotations by their oriented text geometry', () => {
    const scene = createScene()
    scene.plants = []
    scene.annotations = [{
      kind: 'annotation',
      id: 'annotation-1',
      locked: false,
      annotationType: 'text',
      position: { x: 10, y: 20 },
      text: 'ABCD',
      fontSize: 10,
      rotationDeg: 90,
    }]

    expect(hitTestTopLevel(scene, { x: 0, y: 30 }, 1, 'mouse', new Map(), getPlantContext, [{ kind: 'annotation', id: 'annotation-1' }]))
      .toEqual({ kind: 'annotation', id: 'annotation-1' })
    expect(hitTestTopLevel(scene, { x: 20, y: 25 }, 1, 'mouse', new Map(), getPlantContext, [{ kind: 'annotation', id: 'annotation-1' }]))
      .toBeNull()
    expect(queryQuadTopLevel(scene, box({ x: 0, y: 30, width: 0.01, height: 0.01 }), 1, new Map(), getPlantContext, [{ kind: 'annotation', id: 'annotation-1' }]))
      .toEqual([{ kind: 'annotation', id: 'annotation-1' }])
    expect(queryQuadTopLevel(scene, box({ x: 20, y: 25, width: 0.01, height: 0.01 }), 1, new Map(), getPlantContext, [{ kind: 'annotation', id: 'annotation-1' }]))
      .toEqual([])
  })

  it('hits a shown note anywhere inside its drawn outline: the text plus 4 px each side and 2 px above and below', () => {
    const scene = createScene()
    scene.plants = []
    // At 1 px/m under jsdom's 0.6 em estimate: a 24 px by 12.5 px text box from (10, 20).
    scene.annotations = [{ kind: 'annotation', id: 'note', locked: false, annotationType: 'text',
      position: { x: 10, y: 20 }, text: 'ABCD', fontSize: 10, rotationDeg: 0 }]
    const selected = [{ kind: 'annotation' as const, id: 'note' }]
    const hit = (x: number, y: number) => hitTestTopLevel(scene, { x, y }, 1, 'mouse', new Map(), getPlantContext, selected)

    for (const inside of [{ x: 6.5, y: 26 }, { x: 37.5, y: 26 }, { x: 20, y: 18.5 }, { x: 20, y: 34 }]) {
      expect(hit(inside.x, inside.y), `(${inside.x}, ${inside.y})`).toEqual({ kind: 'annotation', id: 'note' })
    }
    for (const outside of [{ x: 5.5, y: 26 }, { x: 38.5, y: 26 }, { x: 20, y: 17.5 }, { x: 20, y: 35 }]) {
      expect(hit(outside.x, outside.y), `(${outside.x}, ${outside.y})`).toBeNull()
    }
  })

  it('band-selects revealed rotated text annotations by their oriented geometry instead of empty AABB corners', () => {
    const scene = createScene()
    scene.plants = []
    scene.annotations = [{
      kind: 'annotation',
      id: 'annotation-1',
      locked: false,
      annotationType: 'text',
      position: { x: 0, y: 0 },
      text: 'ABCD',
      fontSize: 10,
      rotationDeg: 45,
    }]

    expect(hitTestTopLevel(scene, { x: 16, y: 2 }, 1, 'mouse', new Map(), getPlantContext, [{ kind: 'annotation', id: 'annotation-1' }]))
      .toBeNull()
    expect(queryQuadTopLevel(scene, box({ x: 16, y: 2, width: 0.01, height: 0.01 }), 1, new Map(), getPlantContext, [{ kind: 'annotation', id: 'annotation-1' }]))
      .toEqual([])
    expect(queryQuadTopLevel(scene, box({ x: 8, y: 8, width: 0.01, height: 0.01 }), 1, new Map(), getPlantContext, [{ kind: 'annotation', id: 'annotation-1' }]))
      .toEqual([{ kind: 'annotation', id: 'annotation-1' }])
  })
  it('a zero-length zone or guide is hit within tolerance', () => {
    const scene = createScene()
    scene.plants = []
    scene.layers.push({ kind: 'layer', name: 'measurement-guides', visible: true, locked: false, opacity: 1 })
    // At 10 000 px/m the 6 px line tolerance is 0.6 mm.
    const scale = 10_000
    const hit = (x: number, y: number) =>
      hitTestTopLevel(scene, { x, y }, scale, 'mouse', new Map(), getPlantContext)

    // A guide pressed out without a drag: its two ends meet.
    scene.measurementGuides = [{ kind: 'measurement-guide', id: 'dot', locked: false, start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }]
    expect(hit(0.0005, 0)).toEqual({ kind: 'measurement-guide', id: 'dot' })
    expect(hit(0.0007, 0)).toBeNull()

    // A 0.9 mm line zone (shorter than a millimetre): 4 px past its far end is near it, though 13 px from its start.
    scene.measurementGuides = []
    scene.zones = [{
      kind: 'zone', id: 'stub', name: null, locked: false, zoneType: 'line',
      points: [{ x: 10, y: 0 }, { x: 10.0009, y: 0 }], rotationDeg: 0, fillColor: null, notes: null,
    }]
    expect(hit(10.0013, 0)).toEqual({ kind: 'zone', id: 'stub' })
    expect(hit(10.0016, 0)).toBeNull()
  })

  it('the edge, nearest the point, of the polygon, rectangle or line zone the visible pick reaches by its line', () => {
    const zone = (id: string, zoneType: SceneZoneEntity['zoneType'], points: ScenePoint[], rotationDeg = 0): SceneZoneEntity =>
      ({ kind: 'zone', id, name: null, locked: false, zoneType, points, rotationDeg, fillColor: null, notes: null })
    const scene = createScene()
    scene.plants = []
    scene.layers = [
      { kind: 'layer', name: 'plants', visible: true, locked: false, opacity: 1 },
      { kind: 'layer', name: 'zones', visible: true, locked: false, opacity: 1 },
    ]
    scene.zones = [
      zone('triangle', 'polygon', [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }]),
      // A 10 × 4 bed turned 90° about its centre (5, 32): its long edges run north-south at x = 3 and x = 7.
      zone('bed', 'rect', [{ x: 0, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 34 }, { x: 0, y: 34 }], 90),
      zone('hedge', 'line', [{ x: 40, y: 0 }, { x: 40, y: 20 }]),
      zone('pond', 'ellipse', [{ x: 70, y: 10 }, { x: 5, y: 3 }]),
    ]
    const at = (x: number, y: number, pointer: PointerKind = 'mouse', scale = 2, pick: Parameters<typeof hitZoneEdge>[4] = 'visible') =>
      hitZoneEdge(scene, { x, y }, scale, pointer, pick, new Map(), getPlantContext)

    // The hypotenuse (edge 1) is nearer than the bottom edge (edge 0); 2 px/m: distances read in pixels.
    expect(at(10, 9)).toEqual({ zoneId: 'triangle', edgeIndex: 1, distancePx: expect.closeTo(Math.SQRT2, 6) })
    expect(at(10, -3)).toEqual({ zoneId: 'triangle', edgeIndex: 0, distancePx: expect.closeTo(6, 6) })
    // Beyond a mouse's 6 px, within a finger's 16 px; deep inside a zone: no edge.
    expect(at(10, -5)).toBeNull()
    expect(at(10, -5, 'touch')).toEqual({ zoneId: 'triangle', edgeIndex: 0, distancePx: expect.closeTo(10, 6) })
    expect(at(6, 6)).toBeNull()
    // The rectangle by its turned corners.
    const bedEdge = at(7.5, 32)!
    expect(bedEdge).toMatchObject({ zoneId: 'bed', distancePx: expect.closeTo(1, 6) })
    const [a, b] = zoneEdgeSegment(scene.zones[1]!, bedEdge.edgeIndex)!
    expect(a.x).toBeCloseTo(7, 6)
    expect(b.x).toBeCloseTo(7, 6)
    expect(Math.abs(b.y - a.y)).toBeCloseTo(10, 6)
    expect(at(41, 10)).toEqual({ zoneId: 'hedge', edgeIndex: 0, distancePx: expect.closeTo(2, 6) })
    // A line zone keeps its 6 px pick for a finger too: 8 px from it, no edge.
    expect(at(44, 10, 'touch')).toBeNull()
    expect(zoneEdgeSegment(scene.zones[2]!, 0)).toEqual([{ x: 40, y: 0 }, { x: 40, y: 20 }])
    // An ellipse has no edge.
    expect(at(75, 10)).toBeNull()
    expect(zoneEdgeSegment(scene.zones[3]!, 0)).toBeNull()

    // A locked layer still offers its edges to the visible pick, as the menu still names its zone: turning the view moves
    // no object. The editable pick (Select's double-click corner) offers none there. A hidden layer offers none.
    scene.layers = scene.layers.map((layer) => layer.name === 'zones' ? { ...layer, locked: true } : layer)
    expect(at(10, 9)).toEqual({ zoneId: 'triangle', edgeIndex: 1, distancePx: expect.closeTo(Math.SQRT2, 6) })
    expect(at(10, 9, 'mouse', 2, 'editable')).toBeNull()
    scene.layers = scene.layers.map((layer) => layer.name === 'zones' ? { ...layer, locked: false, visible: false } : layer)
    expect(at(10, 9)).toBeNull()
  })

  it('treats a layer at opacity 0 as hidden for selection and visible picking', () => {
    const scene = createScene()
    scene.layers = scene.layers.map((layer) => layer.name === 'plants' ? { ...layer, visible: true, opacity: 0 } : layer)
    const plantPos = scene.plants[0]!.position
    expect(hitTestTopLevel(scene, plantPos, 10, 'mouse', new Map(), getPlantContext)).toBeNull()
    expect(hitTestVisibleTopLevel(scene, plantPos, 10, 'mouse', new Map(), getPlantContext)).toBeNull()
    expect(queryQuadTopLevel(scene, box({ x: plantPos.x - 5, y: plantPos.y - 5, width: 10, height: 10 }), 10, new Map(), getPlantContext)).toEqual([])
  })
})
