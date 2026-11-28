import { describe, expect, it } from 'vitest'

import { DEFAULT_PLANT_DISPLAY } from './plant-display'
import type { PlantPresentationContext } from './plant-presentation'
import { createDefaultScenePersistedState, type ScenePersistedState } from './scene'
import { designOutlinePoints, sceneExtentPoints, selectionExtentPoints } from './scene-extent'

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
        canopySpreadM: 4,
        position: { x: 10, y: 12 },
        rotationDeg: null,
        notes: null,
        plantedDate: null,
        quantity: null,
      },
    ],
    zones: [
      {
        kind: 'zone',
        id: 'zone-rect',
        name: 'Orchard',
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
      {
        kind: 'zone',
        id: 'zone-ellipse',
        name: null,
        locked: false,
        zoneType: 'ellipse',
        points: [
          { x: 20, y: 15 },
          { x: 4, y: 2 },
        ],
        rotationDeg: 30,
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
        position: { x: 30, y: 25 },
        text: 'South slope',
        fontSize: 16,
        rotationDeg: 0,
      },
    ],
    measurementGuides: [
      {
        kind: 'measurement-guide',
        id: 'guide-1',
        locked: false,
        start: { x: -5, y: -2 },
        end: { x: 5, y: 2 },
      },
    ],
    groups: [
      {
        kind: 'group',
        id: 'group-1',
        name: null,
        locked: false,
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'zone', id: 'zone-rect' },
        ],
      },
    ],
  }
}

function makePlantContext(scene: ScenePersistedState): PlantPresentationContext {
  return {
    plants: scene.plants,
    pixelsPerMetre: 10,
    speciesCache: new Map(),
    localizedCommonNames: new Map(),
    plantDisplay: DEFAULT_PLANT_DISPLAY,
  }
}

describe('scene-extent', () => {
  it('collects footprint corners for plants, zones, and annotations', () => {
    const scene = makeScene()
    const points = sceneExtentPoints(scene, makePlantContext(scene))(10)
    // 1 plant (4 corners) + 2 zones (8 corners) + 1 annotation (4 corners) + 1 guide (2 endpoints) = 18 points
    expect(points).toHaveLength(18)
  })

  it('collects selection outlines for plants, zones, annotations, measurement guides, and groups', () => {
    const scene = makeScene()
    const plantContext = makePlantContext(scene)

    const plantPoints = selectionExtentPoints(scene, [{ kind: 'plant', id: 'plant-1' }], { plantContext })(10)
    expect(plantPoints).toHaveLength(32)

    const zonePoints = selectionExtentPoints(
      scene,
      [{ kind: 'zone', id: 'zone-rect' }, { kind: 'zone', id: 'zone-ellipse' }],
      { plantContext },
    )(10)
    expect(zonePoints.length).toBeGreaterThan(4)

    const annotationPoints = selectionExtentPoints(
      scene,
      [{ kind: 'annotation', id: 'annotation-1' }],
      { plantContext, revealedAnnotationId: 'annotation-1' },
    )(10)
    expect(annotationPoints).toHaveLength(4)

    const guidePoints = selectionExtentPoints(
      scene,
      [{ kind: 'measurement-guide', id: 'guide-1' }],
      { plantContext },
    )(10)
    expect(guidePoints).toEqual([{ x: -5, y: -2 }, { x: 5, y: 2 }])

    const groupPoints = selectionExtentPoints(
      scene,
      [{ kind: 'group', id: 'group-1' }],
      { plantContext },
    )(10)
    expect(groupPoints.length).toBe(36)
  })

  it('designOutlinePoints emits plant canopy spread polygons and falls back to position without positive spread (2.1-Q45)', () => {
    const withCanopy: ScenePersistedState = {
      ...createDefaultScenePersistedState(),
      plants: [
        {
          kind: 'plant',
          id: 'p-spread',
          locked: false,
          canonicalName: 'Juglans regia',
          commonName: 'Walnut',
          color: null,
          canopySpreadM: 12,
          position: { x: 10, y: 20 },
          rotationDeg: null,
          notes: null,
          plantedDate: null,
          quantity: null,
        },
      ],
    }
    const spreadPoints = designOutlinePoints(withCanopy)
    expect(spreadPoints).toHaveLength(32)
    expect(Math.max(...spreadPoints.map((p) => p.x))).toBeCloseTo(16, 9)
    expect(Math.min(...spreadPoints.map((p) => p.x))).toBeCloseTo(4, 9)
    expect(Math.max(...spreadPoints.map((p) => p.y))).toBeCloseTo(26, 9)
    expect(Math.min(...spreadPoints.map((p) => p.y))).toBeCloseTo(14, 9)

    const withoutCanopy: ScenePersistedState = {
      ...createDefaultScenePersistedState(),
      plants: [
        { ...withCanopy.plants[0]!, id: 'p-null', canopySpreadM: null },
        { ...withCanopy.plants[0]!, id: 'p-zero', canopySpreadM: 0, position: { x: 3, y: 4 } },
      ],
    }
    expect(designOutlinePoints(withoutCanopy)).toEqual([{ x: 10, y: 20 }, { x: 3, y: 4 }])
  })
})
