import { afterEach, describe, expect, it } from 'vitest'
import type { SavedObjectStampPayload } from '../canvas/saved-object-stamp-payload'
import {
  composeSavedObjectStampCanopiFile,
  importedSavedObjectStampName,
  savedObjectStampPayloadFromCanopiFile,
} from '../app/saved-object-stamps/file'
import type { CanopiFile } from '../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import { roundGeoPosition } from '../canvas/runtime/scene'
import { createSessionPlane } from '../canvas/session-plane'
import { geoAt } from './support/geo-design'
import { locale } from '../app/settings/state'

// Portable stamp files place the arrangement around 0°/0°.
const stampPlane = createSessionPlane({ lon: 0, lat: 0 })

function stampGeo(x: number, y: number) {
  return roundGeoPosition(stampPlane.toGeo({ x, y }))
}

function expectPointNear(actual: { x: number; y: number } | undefined, expected: { x: number; y: number }) {
  expect(actual?.x).toBeCloseTo(expected.x, 3)
  expect(actual?.y).toBeCloseTo(expected.y, 3)
}

function canopiFile(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Imported guild',
    description: 'Do not import this as stamp metadata',
    plant_species_colors: { 'Malus domestica': '#112233' },
    plant_species_symbols: { 'Malus domestica': 'canopy' },
    layers: [
      { name: 'plants', visible: true, locked: true, opacity: 0.5 },
      { name: 'zones', visible: false, locked: false, opacity: 1 },
      { name: 'annotations', visible: true, locked: false, opacity: 1 },
    ],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'USD',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-02T00:00:00.000Z',
    extra: { guides: [{ id: 'guide-1', axis: 'h', lat: 23 }] },
    ...overrides,
  }
}

describe('Saved Object Stamp file composition', () => {
  afterEach(() => {
    locale.value = 'en'
  })

  it('exports a minimal Canopi file with only visible stamp geometry', () => {
    const payload: SavedObjectStampPayload = {
      version: 2,
      anchor: { x: 10, y: 20 },
      plants: [{
        id: 'plant-source',
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
        color: '#C44230',
        symbol: 'canopy',
        position: { x: 10, y: 20 },
        rotationDeg: 15,
        scale: 2,
      }],
      zones: [{
        id: 'zone-source',
        name: 'Kitchen bed',
        zoneType: 'polygon',
        points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }],
        rotationDeg: 5,
        fillColor: '#D8B35A',
      }],
      annotations: [{
        id: 'annotation-source',
        annotationType: 'text',
        position: { x: 12, y: 18 },
        text: 'Guild edge',
        fontSize: 14,
        rotationDeg: 10,
      }],
      groups: [{
        id: 'group-source',
        name: 'Guild',
        members: [
          { kind: 'plant', id: 'plant-source' },
          { kind: 'zone', id: 'zone-source' },
          { kind: 'annotation', id: 'annotation-source' },
        ],
      }],
    }

    const file = composeSavedObjectStampCanopiFile({
      name: 'Apple guild',
      payload,
      now: new Date('2026-06-19T12:00:00.000Z'),
    })

    expect(file).not.toHaveProperty('spatial_frame')
    expect(file).toMatchObject({
      version: CURRENT_CANOPI_FILE_VERSION,
      name: 'Apple guild',
      description: null,
      plant_species_colors: {},
      plant_species_symbols: {},
      consortiums: [],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      created_at: '2026-06-19T12:00:00.000Z',
      updated_at: '2026-06-19T12:00:00.000Z',
      extra: {},
    })
    expect(file.layers).toEqual([
      { name: 'plants', visible: true, locked: false, opacity: 1 },
      { name: 'zones', visible: true, locked: false, opacity: 1 },
      { name: 'annotations', visible: true, locked: false, opacity: 1 },
    ])
    expect(file.plants).toEqual([{
      id: 'plant-source',
      locked: false,
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      color: '#C44230',
      symbol: 'canopy',
      pinned_name: false,
      position: stampGeo(10, 20),
      rotation: 15,
      scale: 2,
      notes: null,
      planted_date: null,
      quantity: null,
    }])
    expect(file.zones).toEqual([{
      id: 'zone-source',
      name: 'Kitchen bed',
      locked: false,
      zone_type: 'polygon',
      points: [stampGeo(0, 0), stampGeo(4, 0), stampGeo(4, 4)],
      rotation: 5,
      fill_color: '#D8B35A',
      notes: null,
    }])
    expect(file.annotations).toEqual([{
      id: 'annotation-source',
      locked: false,
      annotation_type: 'text',
      position: stampGeo(12, 18),
      text: 'Guild edge',
      font_size: 14,
      rotation: 10,
    }])
    expect(file.groups).toEqual([{
      id: 'group-source',
      locked: false,
      name: 'Guild',
      members: [
        { kind: 'plant', id: 'plant-source' },
        { kind: 'zone', id: 'zone-source' },
        { kind: 'annotation', id: 'annotation-source' },
      ],
    }])
  })

  it('drops invalid captured groups during export', () => {
    const file = composeSavedObjectStampCanopiFile({
      name: 'Ungrouped stamp',
      payload: {
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [{
          id: 'plant-1',
          canonicalName: 'Malus domestica',
          commonName: null,
          color: null,
          symbol: null,
          position: { x: 0, y: 0 },
          rotationDeg: null,
          scale: null,
        }],
        zones: [],
        annotations: [],
        groups: [{
          id: 'group-1',
          name: null,
          members: [
            { kind: 'plant', id: 'plant-1' },
            { kind: 'zone', id: 'missing-zone' },
          ],
        }],
      },
      now: new Date('2026-06-19T12:00:00.000Z'),
    })

    expect(file.groups).toEqual([])
  })

  it('imports only visible geometry from a Canopi file and strips non-visual metadata', () => {
    const payload = savedObjectStampPayloadFromCanopiFile(canopiFile({
      plants: [{
        id: 'source-plant',
        locked: true,
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: '#C44230',
        symbol: 'canopy',
        position: geoAt(10, 20),
        rotation: 30,
        scale: 2,
        notes: 'nursery note',
        planted_date: '2026-04-01',
        quantity: 5,
      }],
      zones: [{
        id: 'Hidden bed', name: 'Hidden bed',
        locked: false,
        zone_type: 'polygon',
        points: [geoAt(0, 0), geoAt(4, 0), geoAt(4, 4)],
        rotation: 0,
        fill_color: '#D8B35A',
        notes: 'hidden zone note',
      }],
      annotations: [{
        id: 'note-1',
        locked: true,
        annotation_type: 'text',
        position: geoAt(14, 16),
        text: 'Guild edge',
        font_size: 14,
        rotation: 10,
      }],
      groups: [{
        id: 'group-1',
        locked: true,
        name: 'Visible pair',
        members: [
          { kind: 'plant', id: 'source-plant' },
          { kind: 'zone', id: 'Hidden bed' },
          { kind: 'annotation', id: 'note-1' },
        ],
      }],
    }))

    // Import reads the file through a plane centred on all of its objects
    // (authored x 0..14, y 0..20), so metres are relative to (7, 10).
    expectPointNear(payload?.anchor, { x: 5, y: 8 })
    expectPointNear(payload?.plants[0]?.position, { x: 3, y: 10 })
    expectPointNear(payload?.annotations[0]?.position, { x: 7, y: 6 })
    expect(payload).toEqual({
      version: 2,
      anchor: expect.any(Object),
      plants: [{
        id: 'source-plant',
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
        color: '#C44230',
        symbol: 'canopy',
        position: expect.any(Object),
        rotationDeg: 30,
        scale: 2,
      }],
      zones: [],
      annotations: [{
        id: 'note-1',
        annotationType: 'text',
        position: expect.any(Object),
        text: 'Guild edge',
        fontSize: 14,
        rotationDeg: 10,
      }],
      groups: [{
        id: 'group-1',
        name: 'Visible pair',
        members: [
          { kind: 'plant', id: 'source-plant' },
          { kind: 'annotation', id: 'note-1' },
        ],
      }],
    })
  })

  it('imports Plant Symbols inherited from species defaults as explicit stamp symbols', () => {
    const payload = savedObjectStampPayloadFromCanopiFile(canopiFile({
      plant_species_symbols: { 'Malus domestica': 'canopy' },
      plants: [{
        id: 'source-plant',
        locked: false,
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        symbol: null,
        position: geoAt(10, 20),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: null,
      }],
    }))

    expect(payload?.plants[0]?.symbol).toBe('canopy')
  })

  it('round-trips exported Zone group membership through a stamp import', () => {
    const file = composeSavedObjectStampCanopiFile({
      name: 'Zone pair',
      payload: {
        version: 2,
        anchor: { x: 0, y: 0 },
        plants: [{
          id: 'plant-source',
          canonicalName: 'Malus domestica',
          commonName: null,
          color: null,
          symbol: null,
          position: { x: 0, y: 0 },
          rotationDeg: null,
          scale: null,
        }],
        zones: [{
          id: 'zone-source',
          name: 'Kitchen bed',
          zoneType: 'rect',
          points: [{ x: 0, y: 0 }, { x: 4, y: 4 }],
          rotationDeg: 0,
          fillColor: null,
        }],
        annotations: [],
        groups: [{
          id: 'group-source',
          name: 'Plant and zone',
          members: [
            { kind: 'plant', id: 'plant-source' },
            { kind: 'zone', id: 'zone-source' },
          ],
        }],
      },
      now: new Date('2026-06-19T12:00:00.000Z'),
    })

    const payload = savedObjectStampPayloadFromCanopiFile(file)

    expect(file.groups[0]?.members).toEqual([
      { kind: 'plant', id: 'plant-source' },
      { kind: 'zone', id: 'zone-source' },
    ])
    expect(payload?.groups).toEqual([{
      id: 'group-source',
      name: 'Plant and zone',
      members: [
        { kind: 'plant', id: 'plant-source' },
        { kind: 'zone', id: 'zone-1' },
      ],
    }])
  })

  it('imports Elliptical Zone anchors from visible bounds instead of radii coordinates', () => {
    const payload = savedObjectStampPayloadFromCanopiFile(canopiFile({
      layers: [
        { name: 'plants', visible: false, locked: false, opacity: 1 },
        { name: 'zones', visible: true, locked: false, opacity: 1 },
      ],
      // A hidden plant still frames the file, placing the plane origin at (55, 53).
      plants: [{
        id: 'hidden-plant',
        locked: false,
        canonical_name: 'Malus domestica',
        common_name: null,
        color: null,
        position: geoAt(0, 0),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: null,
      }],
      // Ellipses are stored as the corners of their unrotated bounding box:
      // centre (100, 100), radii (10, 6).
      zones: [{
        id: 'Pond edge', name: 'Pond edge',
        locked: false,
        zone_type: 'ellipse',
        points: [geoAt(90, 94), geoAt(110, 106)],
        rotation: 0,
        fill_color: null,
        notes: null,
      }],
    }))

    expect(payload?.plants).toEqual([])
    expectPointNear(payload?.zones[0]?.points[0], { x: 45, y: 47 })
    expectPointNear(payload?.zones[0]?.points[1], { x: 10, y: 6 })
    expectPointNear(payload?.anchor, { x: 45, y: 47 })
  })

  it('rejects empty imports and falls back to a composition name in the interface language when the file name is blank (D12)', () => {
    locale.value = 'ru'
    const emptyPayload = savedObjectStampPayloadFromCanopiFile(canopiFile({
      name: '',
      plants: [],
      zones: [],
      annotations: [],
      groups: [],
    }))
    const visibleZonePayload = savedObjectStampPayloadFromCanopiFile(canopiFile({
      name: '  ',
      layers: [{ name: 'zones', visible: true, locked: false, opacity: 1 }],
      zones: [{
        id: 'Bed', name: 'Bed',
        locked: true,
        zone_type: 'rect',
        points: [geoAt(0, 0), geoAt(4, 4)],
        rotation: 0,
        fill_color: null,
        notes: null,
      }],
    }))

    expect(emptyPayload).toBeNull()
    expect(importedSavedObjectStampName(canopiFile({ name: '  ' }), visibleZonePayload!))
      .toBe('1 зона, 0 аннотаций')
  })

  it('counts a plantless stamp in the plural form each count takes, and names a plant stamp by its most frequent plants', () => {
    locale.value = 'ru'
    const at = { x: 0, y: 0 }
    const stamp = (zones: number, annotations: number, plants: readonly (string | null)[] = []): SavedObjectStampPayload => ({
      version: 2,
      anchor: at,
      plants: plants.map((commonName, index) => ({
        id: `plant-${index}`, canonicalName: `Species ${commonName ?? index}`, commonName, color: null, position: at, rotationDeg: null, scale: null,
      })),
      zones: Array.from({ length: zones }, (_, index) => ({
        id: `zone-${index}`, name: null, zoneType: 'rect', points: [at, { x: 1, y: 1 }], rotationDeg: 0, fillColor: null,
      })),
      annotations: Array.from({ length: annotations }, (_, index) => ({
        id: `note-${index}`, annotationType: 'text', position: at, text: 'Note', fontSize: 14, rotationDeg: null,
      })),
      groups: [],
    })
    const blank = canopiFile({ name: '' })

    expect(importedSavedObjectStampName(blank, stamp(3, 5))).toBe('3 зоны, 5 аннотаций')
    expect(importedSavedObjectStampName(blank, stamp(21, 22))).toBe('21 зона, 22 аннотации')
    expect(importedSavedObjectStampName(blank, stamp(1, 0, ['Pear', 'Apple', 'Apple', 'Plum', 'Fig', 'Fig'])))
      .toBe('Apple, Fig, Pear')
  })
})
