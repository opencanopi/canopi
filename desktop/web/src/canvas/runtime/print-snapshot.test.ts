import { describe, expect, it } from 'vitest'

import { DEFAULT_PLANT_DISPLAY } from './plant-display'
import { buildCanvasPrintSnapshot } from './print-snapshot'
import { createDefaultScenePersistedState, type ScenePersistedState } from './scene'

describe('buildCanvasPrintSnapshot', () => {
  it('snapshots plants, zones, annotations, measurement guides, and optional plane origin', () => {
    const scene: ScenePersistedState = {
      ...createDefaultScenePersistedState(),
      plants: [
        {
          kind: 'plant',
          id: 'plant-1',
          locked: false,
          canonicalName: 'Malus domestica',
          commonName: 'Apple',
          color: '#228b22',
          canopySpreadM: 4,
          position: { x: 2, y: 3 },
          rotationDeg: null,
          notes: null,
          plantedDate: null,
          quantity: null,
          pinnedName: true,
        },
      ],
      zones: [
        {
          kind: 'zone',
          id: 'zone-1',
          name: 'Orchard',
          locked: false,
          zoneType: 'rect',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 8 },
            { x: 0, y: 8 },
          ],
          rotationDeg: 0,
          fillColor: '#4a7c59',
          notes: null,
        },
      ],
      annotations: [
        {
          kind: 'annotation',
          id: 'ann-1',
          locked: false,
          annotationType: 'text',
          position: { x: 5, y: 6 },
          text: 'North fence',
          fontSize: 18,
          rotationDeg: 15,
        },
      ],
      measurementGuides: [
        {
          kind: 'measurement-guide',
          id: 'guide-1',
          locked: false,
          start: { x: 0, y: 0 },
          end: { x: 10, y: 0 },
        },
      ],
    }

    const snapshot = buildCanvasPrintSnapshot(
      scene,
      {
        plants: scene.plants,
        pixelsPerMetre: 10,
        speciesCache: new Map(),
        localizedCommonNames: new Map(),
        plantDisplay: DEFAULT_PLANT_DISPLAY,
      },
      { origin: { lon: 3.8772, lat: 43.6112 } },
    )

    expect(snapshot.planeOrigin).toEqual({ lon: 3.8772, lat: 43.6112 })
    expect(snapshot.plants).toHaveLength(1)
    expect(snapshot.zones).toHaveLength(1)
    expect(snapshot.annotations).toEqual([
      { id: 'ann-1', position: { x: 5, y: 6 }, text: 'North fence', fontSize: 18, rotation: 15 },
    ])
    expect(snapshot.measurements).toEqual([
      { id: 'guide-1', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
    ])
  })

  it('rejects unsupported zone fill colors', () => {
    const scene: ScenePersistedState = {
      ...createDefaultScenePersistedState(),
      zones: [
        {
          kind: 'zone',
          id: 'zone-bad',
          name: null,
          locked: false,
          zoneType: 'rect',
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 4 },
            { x: 0, y: 4 },
          ],
          rotationDeg: 0,
          fillColor: 'url(#evil)',
          notes: null,
        },
      ],
    }

    expect(() =>
      buildCanvasPrintSnapshot(scene, {
        plants: [],
        pixelsPerMetre: 10,
        speciesCache: new Map(),
        localizedCommonNames: new Map(),
        plantDisplay: DEFAULT_PLANT_DISPLAY,
      }),
    ).toThrow('unsupported-print-color')
  })
})
