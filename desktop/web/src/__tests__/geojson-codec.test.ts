import { describe, expect, it } from 'vitest'

import {
  GEOJSON_KIND_PROPERTY,
  GEOJSON_MAX_FEATURES,
  GeoJsonImportError,
  encodeDesignGeoJson,
  parseDesignGeoJson,
  serializeDesignGeoJson,
  type GeoJsonDesignObjects,
  type GeoJsonImportErrorCode,
} from '../app/geojson/codec'
import { geoAt } from './support/geo-design'

function designObjects(): GeoJsonDesignObjects {
  return {
    plants: [
      {
        id: 'plant-1',
        locked: false,
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: '#C44230',
        symbol: 'broadleaf',
        pinned_name: true,
        position: { lon: 2.349014123, lat: 48.864716987 },
        rotation: 15,
        canopy_spread_m: 4.5,
        notes: 'Keep pruned',
        planted_date: '2026-03-01',
        quantity: 3,
      },
    ],
    zones: [
      {
        id: 'Bed A', name: 'Bed A',
        locked: false,
        zone_type: 'polygon',
        points: [geoAt(0, 0), geoAt(10, 0), geoAt(10, 8)],
        rotation: 0,
        fill_color: '#88AA44',
        notes: 'Mulched',
      },
      {
        id: 'Pond', name: 'Pond',
        locked: false,
        zone_type: 'ellipse',
        points: [geoAt(20, 20), geoAt(30, 26)],
        rotation: 30,
        fill_color: null,
        notes: null,
      },
      {
        id: 'Terrace', name: 'Terrace',
        locked: false,
        zone_type: 'rect',
        points: [geoAt(40, 0), geoAt(50, 0), geoAt(50, 5), geoAt(40, 5)],
        rotation: 45,
        fill_color: null,
        notes: null,
      },
      {
        id: 'Hedge line', name: 'Hedge line',
        locked: false,
        zone_type: 'line',
        points: [geoAt(0, 30), geoAt(12, 31), geoAt(24, 30)],
        rotation: 0,
        fill_color: null,
        notes: null,
      },
    ],
    annotations: [
      {
        id: 'note-1',
        locked: false,
        annotation_type: 'text',
        position: geoAt(5, 5),
        text: 'Compost here',
        font_size: 18,
        rotation: null,
      },
    ],
    measurementGuides: [
      { id: 'guide-1', locked: false, start: geoAt(0, 40), end: geoAt(30, 40) },
    ],
    groups: [
      {
        id: 'group-1',
        locked: false,
        name: 'Orchard corner',
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'zone', id: 'Bed A' },
        ],
      },
    ],
  }
}

function expectRejected(text: string, code: GeoJsonImportErrorCode): void {
  let error: unknown = null
  try {
    parseDesignGeoJson(text)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(GeoJsonImportError)
  expect((error as GeoJsonImportError).code).toBe(code)
  expect((error as GeoJsonImportError).name).toBe('GeoJsonImportError')
}

function feature(geometry: unknown, properties: Record<string, unknown> | null = {}) {
  return { type: 'Feature', geometry, properties }
}

function collection(...features: unknown[]): string {
  return JSON.stringify({ type: 'FeatureCollection', features })
}

describe('GeoJSON codec export', () => {
  it('writes an RFC 7946 FeatureCollection in WGS84 with a kind on every feature', () => {
    const exported = encodeDesignGeoJson(designObjects())

    expect(exported.type).toBe('FeatureCollection')
    expect(exported).not.toHaveProperty('crs')
    expect(exported.features).toHaveLength(7)
    expect(exported.features.map((entry) => entry.properties[GEOJSON_KIND_PROPERTY])).toEqual([
      'plant',
      'zone',
      'zone',
      'zone',
      'zone',
      'annotation',
      'measurement_guide',
    ])
    expect(exported.features.map((entry) => entry.geometry.type)).toEqual([
      'Point',
      'Polygon',
      'Polygon',
      'Polygon',
      'LineString',
      'Point',
      'LineString',
    ])
    expect(exported.features[0]).toMatchObject({
      id: 'plant-1',
      geometry: { type: 'Point', coordinates: [2.349014123, 48.864716987] },
      properties: {
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: '#C44230',
        symbol: 'broadleaf',
        pinned_name: true,
        rotation: 15,
        canopy_spread_m: 4.5,
        notes: 'Keep pruned',
        planted_date: '2026-03-01',
        quantity: 3,
        group_ids: ['group-1'],
      },
    })
    expect(exported.canopi_groups).toEqual([{ id: 'group-1', name: 'Orchard corner', locked: false }])
  })

  it('closes polygon rings and exports the drawn outline of rotated rectangles and ellipses', () => {
    const exported = encodeDesignGeoJson(designObjects())
    const polygonRing = (index: number) => {
      const geometry = exported.features[index]!.geometry
      if (geometry.type !== 'Polygon') throw new Error('expected polygon')
      return geometry.coordinates[0]!
    }

    const bed = polygonRing(1)
    expect(bed).toHaveLength(4)
    expect(bed[0]).toEqual(bed[3])

    const pond = polygonRing(2)
    expect(pond).toHaveLength(65)
    expect(exported.features[2]!.properties.canopi_points).toHaveLength(2)

    const terrace = polygonRing(3)
    expect(terrace).toHaveLength(5)
    // A 45° rotation moves the drawn corners away from the stored frame.
    const stored = designObjects().zones[2]!.points
    expect(terrace[0]).not.toEqual([stored[0]!.lon, stored[0]!.lat])
    expect(exported.features[3]!.properties.canopi_points).toEqual(
      stored.map((point) => [point.lon, point.lat]),
    )
  })
})

describe('GeoJSON codec import', () => {
  it('round-trips exported objects and their properties', () => {
    const source = designObjects()
    const imported = parseDesignGeoJson(serializeDesignGeoJson(source))

    expect(imported.skipped).toBe(0)
    expect(imported.counts).toEqual({ plants: 1, zones: 4, annotations: 1, measurementGuides: 1 })
    expect(imported.objects.plants).toEqual(source.plants)
    expect(imported.objects.zones).toEqual(source.zones)
    expect(imported.objects.annotations).toEqual(source.annotations)
    expect(imported.objects.measurementGuides).toEqual(source.measurementGuides)
    expect(imported.objects.groups).toEqual(source.groups)
  })

  it('maps geometries to plants, annotations, zones and measurement guides', () => {
    const imported = parseDesignGeoJson(collection(
      feature({ type: 'Point', coordinates: [10, 20] }, { species: 'Corylus avellana' }),
      feature({ type: 'Point', coordinates: [10.1, 20.1, 55] }, { canonical_name: 'Juglans regia', quantity: 2 }),
      feature({ type: 'Point', coordinates: [10.2, 20.2] }, { name: 'Well' }),
      feature({ type: 'Polygon', coordinates: [[[10, 20], [10.001, 20], [10.001, 20.001], [10, 20]]] }, null),
      feature({ type: 'LineString', coordinates: [[10, 20], [10.002, 20]] }),
      feature({ type: 'LineString', coordinates: [[10, 20], [10.002, 20], [10.002, 20.003]] }, { name: 'Swale' }),
    ))

    expect(imported.counts).toEqual({ plants: 2, zones: 2, annotations: 1, measurementGuides: 1 })
    expect(imported.objects.plants.map((plant) => plant.canonical_name)).toEqual(['Corylus avellana', 'Juglans regia'])
    expect(imported.objects.plants[1]).toMatchObject({ position: { lon: 10.1, lat: 20.1 }, quantity: 2, common_name: null })
    expect(imported.objects.annotations[0]).toMatchObject({ text: 'Well', annotation_type: 'text', font_size: 16 })
    // An unnamed feature gives an unnamed zone; lists name it by its type and size.
    expect(imported.objects.zones[0]).toMatchObject({
      name: null,
      zone_type: 'polygon',
      points: [{ lon: 10, lat: 20 }, { lon: 10.001, lat: 20 }, { lon: 10.001, lat: 20.001 }],
    })
    expect(imported.objects.zones[1]).toMatchObject({ name: 'Swale', zone_type: 'line' })
    expect(imported.objects.measurementGuides[0]).toMatchObject({
      start: { lon: 10, lat: 20 },
      end: { lon: 10.002, lat: 20 },
    })
  })

  it('skips unsupported geometries and reports them by count', () => {
    const imported = parseDesignGeoJson(collection(
      feature({ type: 'Point', coordinates: [1, 2] }, { species: 'Ficus carica' }),
      feature({ type: 'MultiPolygon', coordinates: [] }),
      feature({ type: 'MultiPoint', coordinates: [[1, 2]] }),
      feature({ type: 'MultiLineString', coordinates: [] }),
      feature({ type: 'GeometryCollection', geometries: [] }),
      feature(null),
    ))

    expect(imported.counts.plants).toBe(1)
    expect(imported.skipped).toBe(5)
  })

  it.each<[unknown, number | null]>([
    [0, null], [-2, null], [Number.MAX_VALUE, Number.MAX_VALUE], ['3', null], [2.5, 2.5],
  ])('reads canopy_spread_m %s as a spread the Design format accepts', (spread, scale) => {
    const imported = parseDesignGeoJson(collection(
      feature({ type: 'Point', coordinates: [1, 2] }, { species: 'Foo bar', canopy_spread_m: spread }),
    ))
    expect(imported.objects.plants[0]?.canopy_spread_m).toBe(scale)
  })

  it.each<[unknown, number | null]>([
    [0, 0], [3, 3], [2.5, null], [-1, null], [4294967295, 4294967295], [4294967296, null], ['2', null],
  ])('reads quantity %s as a count the Design format accepts', (quantity, expected) => {
    const imported = parseDesignGeoJson(collection(
      feature({ type: 'Point', coordinates: [1, 2] }, { species: 'Malus domestica', quantity }),
    ))
    expect(imported.objects.plants[0]?.quantity).toBe(expected)
  })

  it('accepts a single Feature as the root', () => {
    const imported = parseDesignGeoJson(JSON.stringify(feature({ type: 'Point', coordinates: [3, 4] }, { text: 'Gate' })))
    expect(imported.objects.annotations).toHaveLength(1)
  })

  it('keeps identities unique within one file', () => {
    const imported = parseDesignGeoJson(collection(
      { ...feature({ type: 'Point', coordinates: [1, 2] }, { species: 'A a' }), id: 'dup' },
      { ...feature({ type: 'Point', coordinates: [1, 2] }, { species: 'A a' }), id: 'dup' },
    ))
    expect(new Set(imported.objects.plants.map((plant) => plant.id)).size).toBe(2)
  })

  it.each<[string, string, GeoJsonImportErrorCode]>([
    ['text that is not JSON', '{nope', 'invalid_json'],
    ['a bare array', '[]', 'unsupported_root'],
    ['a bare geometry', JSON.stringify({ type: 'Point', coordinates: [1, 2] }), 'unsupported_root'],
    ['a collection without features', JSON.stringify({ type: 'FeatureCollection' }), 'unsupported_root'],
    ['a non-feature entry', collection({ type: 'Point', coordinates: [1, 2] }), 'invalid_feature'],
    ['non-object properties', collection(feature({ type: 'Point', coordinates: [1, 2] }, 'x' as never)), 'invalid_feature'],
    ['non-numeric coordinates', collection(feature({ type: 'Point', coordinates: ['1', 2] })), 'invalid_geometry'],
    ['an open polygon ring', collection(feature({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] })), 'invalid_geometry'],
    ['a short polygon ring', collection(feature({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] })), 'invalid_geometry'],
    ['a one-position line', collection(feature({ type: 'LineString', coordinates: [[0, 0]] })), 'invalid_geometry'],
    ['a latitude beyond Web Mercator', collection(feature({ type: 'Point', coordinates: [0, 89] })), 'invalid_coordinates'],
    ['a longitude beyond 180°', collection(feature({ type: 'Point', coordinates: [181, 0] })), 'invalid_coordinates'],
    ['a malformed rectangle frame', collection(feature(
      { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      { zone_type: 'rect', canopi_points: [[0, 0]] },
    )), 'invalid_geometry'],
  ])('rejects %s with a named error', (_label, text, code) => {
    expectRejected(text, code)
  })

  it('rejects the whole file when any supported feature is malformed', () => {
    expectRejected(collection(
      feature({ type: 'Point', coordinates: [1, 2] }, { species: 'Ficus carica' }),
      feature({ type: 'Point', coordinates: [1, Number.NaN] }),
    ), 'invalid_geometry')
  })

  it('rejects files with more features than the import limit', () => {
    const features = Array.from({ length: GEOJSON_MAX_FEATURES + 1 }, () => feature(null))
    expectRejected(collection(...features), 'too_many_features')
  })
})
