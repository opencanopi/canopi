import { describe, expect, it } from 'vitest'
import {
  cloneScenePersistedState,
  hydrateSceneFromDesign,
  serializeScenePersistedState,
} from './codec'
import { makeTestDesign } from '../../../__tests__/support/session-core-fixture'
import { decodeCanopiDesign, encodeCanopiDesign } from '../../../__tests__/support/design-wire'

function withExtra<T extends object>(item: T, extra: Record<string, unknown>): T {
  return Object.assign({}, item, extra)
}

describe('scene codec lossless v10 preservation', () => {
  it('preserves ext bags, zone stroke_color/opacity, and measurement_guide group members across hydrate, clone, and serialize', () => {
    const input = makeTestDesign({
      layers: [
        withExtra({ name: 'plants', visible: true, locked: false, opacity: 0.9 }, { ext: { customLayer: 1 }, future_layer_flag: true }),
      ],
      plants: [
        withExtra({
          id: 'plant-1',
          locked: false,
          canonical_name: 'Malus domestica',
          common_name: 'Apple',
          color: null,
          symbol: null,
          pinned_name: false,
          position: { lon: 2.2945, lat: 48.8584 },
          rotation: 15,
          canopy_spread_m: 1.5,
          notes: 'North row',
          planted_date: '2026-03-01',
          quantity: 3,
        }, { ext: { customPlant: true }, future_plant_tag: 'orchard' }),
      ],
      zones: [
        withExtra({
          id: 'zone-1',
          locked: false,
          zone_type: 'polygon' as const,
          name: 'Meadow',
          points: [
            { lon: 2.2944, lat: 48.8583 },
            { lon: 2.2946, lat: 48.8583 },
            { lon: 2.2945, lat: 48.8585 },
          ],
          fill_color: '#3A6EA5',
          stroke_color: '#1E3A5F',
          opacity: 0.45,
          rotation: 0,
          notes: null,
        }, { ext: { customZone: 'keep' }, future_zone_meta: { slope: 5 } }),
      ],
      annotations: [
        withExtra({
          id: 'ann-1',
          locked: false,
          annotation_type: 'label',
          position: { lon: 2.2945, lat: 48.8584 },
          text: 'Swale',
          font_size: 14,
          rotation: 0,
        }, { ext: { customAnnotation: 42 }, future_ann_flag: 'yes' }),
      ],
      measurement_guides: [
        withExtra({
          id: 'guide-1',
          locked: false,
          start: { lon: 2.2944, lat: 48.8584 },
          end: { lon: 2.2946, lat: 48.8584 },
        }, { ext: { customGuide: 'm' }, future_guide_unit: 'metric' }),
      ],
      groups: [
        withExtra({
          id: 'group-1',
          locked: false,
          name: 'Guild',
          members: [
            withExtra({ kind: 'measurement_guide' as const, id: 'guide-1' }, { role: 'span' }),
            withExtra({ kind: 'plant' as const, id: 'plant-1' }, { role: 'anchor', ext: { weight: 2 } }),
          ],
        }, { ext: { customGroup: ['a'] }, future_group_key: 'guild-v2' }),
      ],
    })

    const { persisted, plane } = hydrateSceneFromDesign(input)
    const cloned = cloneScenePersistedState(persisted)
    // Simulate a real scene edit (moving the plant) before serializing + encoding through DesignCore.
    cloned.plants[0]!.position = { x: cloned.plants[0]!.position.x + 2, y: cloned.plants[0]!.position.y - 1 }
    const out = serializeScenePersistedState(cloned, plane)
    const roundTripped = decodeCanopiDesign(encodeCanopiDesign(out))

    const layer = roundTripped.layers[0]
    const plant = roundTripped.plants[0]
    const zone = roundTripped.zones[0]
    const annotation = roundTripped.annotations[0]
    const guide = roundTripped.measurement_guides?.[0]
    const group = roundTripped.groups[0]
    if (!layer || !plant || !zone || !annotation || !guide || !group) {
      throw new Error('expected hydrated scene entities to serialize back')
    }

    expect(Reflect.get(layer, 'ext')).toEqual({ customLayer: 1 })
    expect(Reflect.get(layer, 'future_layer_flag')).toBe(true)
    expect(Reflect.get(plant, 'ext')).toEqual({ customPlant: true })
    expect(Reflect.get(plant, 'future_plant_tag')).toBe('orchard')
    expect(plant.canopy_spread_m).toBe(1.5)
    expect(zone.stroke_color).toBe('#1E3A5F')
    expect(zone.opacity).toBe(0.45)
    expect(Reflect.get(zone, 'ext')).toEqual({ customZone: 'keep' })
    expect(Reflect.get(zone, 'future_zone_meta')).toEqual({ slope: 5 })
    expect(Reflect.get(annotation, 'ext')).toEqual({ customAnnotation: 42 })
    expect(Reflect.get(annotation, 'future_ann_flag')).toBe('yes')
    expect(Reflect.get(guide, 'ext')).toEqual({ customGuide: 'm' })
    expect(Reflect.get(guide, 'future_guide_unit')).toBe('metric')
    // Exact member order (measurement_guide first, then plant) AND per-member unknown flat keys preserved!
    expect(group.members).toEqual([
      { kind: 'measurement_guide', id: 'guide-1', role: 'span' },
      { kind: 'plant', id: 'plant-1', role: 'anchor', ext: { weight: 2 } },
    ])
    expect(Reflect.get(group, 'ext')).toEqual({ customGroup: ['a'] })
    expect(Reflect.get(group, 'future_group_key')).toBe('guild-v2')
  })
})
