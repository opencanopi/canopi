import { describe, expect, it } from 'vitest'
import {
  hydrateSceneFromDesign,
  SceneStore,
  serializeScenePersistedState,
} from '../canvas/runtime/scene'
import {
  createEllipticalZoneMeasurements,
  createRectangularZoneMeasurements,
} from '../canvas/runtime/zone-measurements'
import { createSessionPlane } from '../geo/session-plane'
import { decodeCanopiDesign } from './support/design-wire'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { geoAt } from './support/geo-design'

const ORIGIN = { lon: 2.294481, lat: 48.858370 }

function currentDesign(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Geo garden',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    plant_species_codes: {},
    layers: [{ name: 'plants', visible: true, locked: false, opacity: 1 }],
    plants: [
      plant('p1', { lon: 2.294481234, lat: 48.858370123 }),
      plant('p2', { lon: 2.29452, lat: 48.85831 }),
      plant('p3', { lon: 2.2946, lat: 48.8584 }),
    ],
    zones: [
      {
        id: 'bed', name: 'bed', locked: false, zone_type: 'rect',
        points: [
          { lon: 2.29440, lat: 48.85845 },
          { lon: 2.29450, lat: 48.85845 },
          { lon: 2.29450, lat: 48.85838 },
          { lon: 2.29440, lat: 48.85838 },
        ],
        rotation: 30, fill_color: null, notes: null,
      },
      {
        id: 'pond', name: 'pond', locked: false, zone_type: 'ellipse',
        points: [{ lon: 2.29455, lat: 48.85842 }, { lon: 2.29462, lat: 48.85836 }],
        rotation: 0, fill_color: null, notes: null,
      },
    ],
    annotations: [{
      id: 'n1', locked: false, annotation_type: 'text',
      position: { lon: 2.29447, lat: 48.85833 },
      text: 'Well', font_size: 14, rotation: null,
    }],
    measurement_guides: [{
      id: 'g1', locked: false,
      start: { lon: 2.29441, lat: 48.85832 },
      end: { lon: 2.29458, lat: 48.85832 },
    }],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-09-25T00:00:00.000Z',
    updated_at: '2026-09-25T00:00:00.000Z',
    extra: {},
    ...overrides,
  }
}

function plant(id: string, position: { lon: number; lat: number }): CanopiFile['plants'][number] {
  return {
    id, locked: false, canonical_name: 'Malus domestica', common_name: null, color: null,
    pinned_name: false, position, rotation: null, canopy_spread_m: null, notes: null, planted_date: null, quantity: null,
  }
}

const SCENE_FIELDS = ['plants', 'zones', 'annotations', 'measurement_guides'] as const

function sceneFields(file: CanopiFile): string {
  return JSON.stringify(SCENE_FIELDS.map((key) => file[key]))
}

describe('geolocated design codec', () => {
  it('writes every unedited position on the 1e-9° grid back unchanged', () => {
    const file = currentDesign()
    const store = new SceneStore().hydrate(file)
    expect(sceneFields(store.toCanopiFile())).toBe(sceneFields(file))
  })

  it('centres the session plane on the objects', () => {
    const { plane, persisted } = hydrateSceneFromDesign(currentDesign())
    const xs = persisted.plants.map((p) => p.position.x)
    expect(Math.abs(plane.origin.lon - 2.29451)).toBeLessThan(0.0001)
    expect(Math.min(...xs)).toBeLessThan(0)
    expect(Math.max(...xs)).toBeGreaterThan(0)
  })

  it('rewrites only the edited plant, rounded to 1e-9 degree', () => {
    const file = currentDesign()
    const store = new SceneStore().hydrate(file)
    store.updatePersisted((draft) => {
      draft.plants[0]!.position = { x: draft.plants[0]!.position.x + 1.25, y: draft.plants[0]!.position.y }
    })
    const saved = store.toCanopiFile()
    expect(saved.plants[1]).toEqual(file.plants[1])
    expect(saved.plants[2]).toEqual(file.plants[2])
    expect(saved.zones).toEqual(file.zones)
    const moved = saved.plants[0]!.position
    expect(moved).not.toEqual(file.plants[0]!.position)
    expect(Math.round(moved.lon * 1e9) / 1e9).toBe(moved.lon)
    expect(Math.round(moved.lat * 1e9) / 1e9).toBe(moved.lat)
    const plane = createSessionPlane(file.plants[0]!.position)
    const shift = plane.toPlane(moved)
    expect(shift.x).toBeCloseTo(1.25, 3)
    expect(Math.abs(shift.y)).toBeLessThan(1e-3)
  })

  it('writes an unedited position on the 1e-9° grid unchanged after open, chained re-origins and save', () => {
    const file = currentDesign()
    const store = new SceneStore().hydrate(file)
    const farCentre = store.sessionPlane.toGeo({ x: 12_000, y: -3_000 })
    store.commitReorigin(store.beginReorigin(farCentre))
    expect(store.sessionPlane.origin).toEqual(farCentre)
    expect(Math.abs(store.persisted.plants[0]!.position.x + 12_000)).toBeLessThan(100)
    expect(sceneFields(store.toCanopiFile())).toBe(sceneFields(file))
    store.commitReorigin(store.beginReorigin(file.plants[1]!.position))
    expect(sceneFields(store.toCanopiFile())).toBe(sceneFields(file))
  })

  it('writes a position with more decimals rounded once, then unchanged', () => {
    const offGrid = { lon: 2.2944812345678, lat: 48.8583701234567 }
    const file = currentDesign({ plants: [plant('p1', offGrid), ...currentDesign().plants.slice(1)] })
    const once = new SceneStore().hydrate(file).toCanopiFile()
    expect(once.plants[0]!.position).toEqual({ lon: 2.294481235, lat: 48.858370123 })
    const store = new SceneStore().hydrate(once)
    store.commitReorigin(store.beginReorigin(store.sessionPlane.toGeo({ x: 15_000, y: 4_000 })))
    expect(sceneFields(store.toCanopiFile())).toBe(sceneFields(once))
  })

  it('writes a latitude at the Web Mercator limit as the largest 1e-9° grid value the decoder admits', () => {
    const atLimit = (lat: number) => currentDesign({
      plants: [plant('pole', { lon: 10, lat }), plant('near', { lon: 10.01, lat: Math.sign(lat) * 85.05 })],
      zones: [], annotations: [], measurement_guides: [],
    })
    for (const lat of [85.0511287798066, -85.0511287798066]) {
      const saved = new SceneStore().hydrate(atLimit(lat)).toCanopiFile()
      expect(saved.plants[0]!.position.lat).toBe(Math.sign(lat) * 85.051128779)
      expect(() => decodeCanopiDesign(JSON.parse(JSON.stringify(saved)))).not.toThrow()
    }
  })

  it('a point at lon 181 saves as 180 and the file reopens', () => {
    const file = currentDesign({
      plants: [plant('east', { lon: 179.5, lat: 0 })],
      zones: [], annotations: [], measurement_guides: [],
    })
    const store = new SceneStore().hydrate(file)
    const plane = createSessionPlane(file.plants[0]!.position)
    const target = plane.toPlane({ lon: 181, lat: 0 })
    store.updatePersisted((draft) => {
      draft.plants[0]!.position = { x: draft.plants[0]!.position.x + target.x, y: draft.plants[0]!.position.y }
    })
    const saved = store.toCanopiFile()
    expect(saved.plants[0]!.position.lon).toBe(180)
    const reopened = decodeCanopiDesign(JSON.parse(JSON.stringify(saved)))
    expect(new SceneStore().hydrate(reopened).toCanopiFile().plants[0]!.position.lon).toBe(180)
  })

  it('writes 10k unedited grid positions and ellipses unchanged across 20 chained re-origins', () => {
    let seed = 0x2f6a91
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const onGrid = (min: number, max: number) => Math.round((min + random() * (max - min)) * 1e9) / 1e9
    const near = () => ({ lon: onGrid(-0.2, 0.2) + 2.29, lat: onGrid(-0.2, 0.2) + 48.86 })
    const grid = (point: { lon: number; lat: number }) => ({
      lon: Math.round(point.lon * 1e9) / 1e9, lat: Math.round(point.lat * 1e9) / 1e9,
    })
    const plants = Array.from({ length: 6_000 }, (_, i) => plant(`p${i}`, grid(near())))
    plants.push(plant('limit', { lon: 2.29, lat: 85.051128779 }))
    const zones = Array.from({ length: 2_000 }, (_, i) => ({
      ...currentDesign().zones[1]!, id: `e${i}`, points: [grid(near()), grid(near())],
    }))
    const file = currentDesign({ plants, zones, annotations: [], measurement_guides: [] })
    const store = new SceneStore().hydrate(file)
    for (let step = 0; step < 20; step += 1) {
      store.commitReorigin(store.beginReorigin(grid(near())))
    }
    const saved = store.toCanopiFile()
    const mismatches = [...SCENE_FIELDS].reduce((count, key) => count + (saved[key] as unknown[])
      .filter((item, i) => JSON.stringify(item) !== JSON.stringify((file[key] as unknown[])[i])).length, 0)
    expect(mismatches).toBe(0)
  })

  it('stores ellipses as opposite unrotated bounding-box corners', () => {
    const file = currentDesign()
    const { persisted, plane } = hydrateSceneFromDesign(file)
    const pond = persisted.zones.find((zone) => zone.id === 'pond')!
    const [first, second] = file.zones[1]!.points.map((point) => plane.toPlane(point))
    expect(pond.points[0]!.x).toBeCloseTo((first!.x + second!.x) / 2, 9)
    expect(pond.points[1]!.x).toBeCloseTo((second!.x - first!.x) / 2, 9)
    expect(pond.points[1]!.y).toBeCloseTo((second!.y - first!.y) / 2, 9)
  })

  it('writes new objects with rounded lon/lat', () => {
    const store = new SceneStore(() => ORIGIN)
    store.updatePersisted((draft) => {
      draft.annotations.push({
        kind: 'annotation', id: 'fresh', locked: false, annotationType: 'text',
        position: { x: 3.3333333, y: -7.7777777 }, text: 'New', fontSize: 12, rotationDeg: null,
      })
    })
    const position = store.toCanopiFile().annotations[0]!.position
    expect(String(position.lon).split('.')[1]!.length).toBeLessThanOrEqual(9)
    expect(String(position.lat).split('.')[1]!.length).toBeLessThanOrEqual(9)
    expect(createSessionPlane(ORIGIN).toPlane(position).x).toBeCloseTo(3.3333333, 3)
  })

  it('keeps zone measurements of a metre fixture after conversion to lon/lat', () => {
    // A former metre fixture authored around 45°N, converted by the test-only helper.
    const origin = { lon: 5.72, lat: 45.18 }
    const rect = [{ x: 0, y: 0 }, { x: 12.5, y: 0 }, { x: 12.5, y: 8 }, { x: 0, y: 8 }]
    const file = currentDesign({
      plants: [],
      annotations: [],
      measurement_guides: [],
      extra: {},
      zones: [
        {
          id: 'rect', name: 'rect', locked: false, zone_type: 'rect', rotation: 0, fill_color: null, notes: null,
          points: rect.map((point) => geoAt(point.x, point.y, origin)),
        },
        {
          id: 'ellipse', name: 'ellipse', locked: false, zone_type: 'ellipse', rotation: 0, fill_color: null, notes: null,
          points: [geoAt(20, 0, origin), geoAt(26, 4, origin)],
        },
      ],
    })
    const zones = hydrateSceneFromDesign(file).persisted.zones
    const labels = (items: { text: string }[]) => items.map((item) => item.text)
    expect(labels(createRectangularZoneMeasurements(zones[0]!.points)))
      .toEqual(labels(createRectangularZoneMeasurements(rect)))
    expect(labels(createEllipticalZoneMeasurements(zones[1]!.points[0]!, zones[1]!.points[1]!, zones[1]!.rotationDeg)))
      .toEqual(labels(createEllipticalZoneMeasurements({ x: 23, y: 2 }, { x: 3, y: 2 }, 0)))
  })

  it('serializes with an explicit frame so saved content never depends on hidden state', () => {
    const { persisted, plane } = hydrateSceneFromDesign(currentDesign())
    const saved = serializeScenePersistedState(persisted, plane)
    expect(saved.version).toBe(10)
    expect('spatial_frame' in saved).toBe(false)
  })
})
