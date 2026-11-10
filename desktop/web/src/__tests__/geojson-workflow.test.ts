// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CanopiFile } from '../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanvasRuntimeSurfaces } from '../canvas/runtime/runtime'
import {
  createGeoJsonWorkflow,
  geoJsonNoticeText,
  type GeoJsonFileAdapter,
  type GeoJsonNotice,
} from '../app/geojson/workflow'
import { t } from '../i18n'
import { geoAt } from './support/geo-design'
import { createLiveTestCanvasRuntimeHost, type CanvasRuntimeHost } from './support/live-canvas-runtime'

const LAYERS: CanopiFile['layers'] = [
  { name: 'plants', visible: true, locked: false, opacity: 1 },
  { name: 'zones', visible: true, locked: false, opacity: 1 },
  { name: 'annotations', visible: true, locked: false, opacity: 1 },
]

function designFile(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'GeoJSON demo',
    description: null,
    plant_species_colors: {},
    layers: LAYERS.map((layer) => ({ ...layer })),
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    extra: {},
    ...overrides,
  }
}

function sourceDesign(): CanopiFile {
  return designFile({
    plants: [
      {
        id: 'apple',
        locked: false,
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: '#C44230',
        symbol: null,
        pinned_name: false,
        position: { lon: 13.000012345, lat: 23.000054321 },
        rotation: null,
        scale: 5,
        notes: 'North side',
        planted_date: '2026-02-11',
        quantity: 2,
      },
    ],
    zones: [
      {
        id: 'zone-bed', name: 'Bed',
        locked: false,
        zone_type: 'polygon',
        points: [geoAt(0, 0), geoAt(8, 0), geoAt(8, 6), geoAt(0, 6)],
        rotation: 0,
        fill_color: '#88AA44',
        notes: null,
      },
      {
        id: 'zone-pond', name: null,
        locked: false,
        zone_type: 'ellipse',
        points: [geoAt(20, 20), geoAt(26, 24)],
        rotation: 20,
        fill_color: null,
        notes: 'Liner',
      },
    ],
    annotations: [
      {
        id: 'label',
        locked: false,
        annotation_type: 'text',
        position: geoAt(3, 3),
        text: 'Herbs',
        font_size: 16,
        rotation: null,
      },
    ],
    measurement_guides: [{ id: 'guide', locked: false, start: geoAt(0, 30), end: geoAt(15, 30) }],
    groups: [{
      id: 'group',
      locked: false,
      name: 'Kitchen garden',
      members: [{ kind: 'plant', id: 'apple' }, { kind: 'zone', id: 'zone-bed' }],
    }],
  })
}

const hosts: CanvasRuntimeHost[] = []

function mountDesign(file: CanopiFile): CanvasRuntimeSurfaces {
  const host = createLiveTestCanvasRuntimeHost()
  hosts.push(host)
  host.surfaces.documents.loadDocument(file)
  return host.surfaces
}

function memoryFiles(text: string | null = null) {
  const written: { text: string; fileName: string }[] = []
  const files: GeoJsonFileAdapter = {
    pickGeoJsonFile: vi.fn(async () => text === null ? null : { name: 'input.geojson', text }),
    writeGeoJsonFile: vi.fn(async (content: string, fileName: string) => {
      written.push({ text: content, fileName })
      return 'written' as const
    }),
  }
  return { files, written }
}

function workflowFor(surfaces: CanvasRuntimeSurfaces, files: GeoJsonFileAdapter) {
  const notices: GeoJsonNotice[] = []
  const workflow = createGeoJsonWorkflow({
    files,
    notify: (notice) => { notices.push(notice) },
    designName: () => 'Kitchen / garden',
    canvas: () => surfaces,
  })
  return { workflow, notices }
}

async function exportText(file: CanopiFile): Promise<string> {
  const surfaces = mountDesign(file)
  const { files, written } = memoryFiles()
  const { workflow } = workflowFor(surfaces, files)
  await expect(workflow.exportGeoJson()).resolves.toEqual({ status: 'written', featureCount: 5 })
  expect(written[0]!.fileName).toBe('Kitchen _ garden.geojson')
  return written[0]!.text
}

// Imported zones get new ids; the display name (or its absence) and the type order them.
function sortZones<T extends { name: string | null; zone_type: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => `${a.name ?? ''}:${a.zone_type}`.localeCompare(`${b.name ?? ''}:${b.zone_type}`))
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.destroy()
})

describe('GeoJSON workflow through the scene runtime', () => {
  it('exports the canonical lon/lat of every design object', async () => {
    const source = sourceDesign()
    const collection = JSON.parse(await exportText(source))

    expect(collection.type).toBe('FeatureCollection')
    const plant = collection.features.find((feature: { id: string }) => feature.id === 'apple')
    // Unedited objects export their stored lon/lat exactly.
    expect(plant.geometry.coordinates).toEqual([13.000012345, 23.000054321])
  })

  it('round-trips export into another Design as one undoable edit', async () => {
    const source = sourceDesign()
    const text = await exportText(source)
    const target = mountDesign(designFile({
      plants: [{
        id: 'existing',
        locked: false,
        canonical_name: 'Ficus carica',
        common_name: null,
        color: null,
        position: geoAt(100, 100),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: null,
      }],
    }))
    const before = target.queries.getSettledDesignObjects()!
    const { files } = memoryFiles(text)
    const { workflow, notices } = workflowFor(target, files)

    const outcome = await workflow.importGeoJson()

    expect(outcome).toEqual({
      status: 'imported',
      counts: { plants: 1, zones: 2, annotations: 1, measurementGuides: 1 },
      skipped: 0,
    })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toEqual({
      tone: 'info',
      title: 'geojson.importTitle',
      message: 'geojson.importSummary',
      params: { plants: 1, zones: 2, annotations: 1, guides: 1 },
    })
    expect(geoJsonNoticeText(notices[0]!)).toBe(t('geojson.importSummary', { plants: 1, zones: 2, annotations: 1, guides: 1 }))

    const after = target.queries.getSettledDesignObjects()!
    expect(after.plants).toHaveLength(2)
    const imported = after.plants.find((plant) => plant.canonical_name === 'Malus domestica')!
    const original = source.plants[0]!
    expect(imported.id).not.toBe('apple')
    expect(imported).toMatchObject({
      common_name: 'Apple',
      color: '#C44230',
      scale: 5,
      notes: 'North side',
      planted_date: '2026-02-11',
      quantity: 2,
    })
    expect(Math.abs(imported.position.lon - original.position.lon)).toBeLessThanOrEqual(1e-9)
    expect(Math.abs(imported.position.lat - original.position.lat)).toBeLessThanOrEqual(1e-9)

    const zones = sortZones(after.zones)
    const sourceZones = sortZones(source.zones)
    expect(zones.map((zone) => [zone.name, zone.zone_type, zone.rotation, zone.fill_color, zone.notes])).toEqual(
      sourceZones.map((zone) => [zone.name, zone.zone_type, zone.rotation, zone.fill_color, zone.notes]),
    )
    zones.forEach((zone, zoneIndex) => {
      zone.points.forEach((point, pointIndex) => {
        const expected = sourceZones[zoneIndex]!.points[pointIndex]!
        expect(Math.abs(point.lon - expected.lon)).toBeLessThanOrEqual(1e-9)
        expect(Math.abs(point.lat - expected.lat)).toBeLessThanOrEqual(1e-9)
      })
    })
    expect(after.annotations).toHaveLength(1)
    expect(after.annotations[0]).toMatchObject({ text: 'Herbs', font_size: 16 })
    expect(after.measurementGuides).toHaveLength(1)
    const guide = after.measurementGuides[0]!
    expect(Math.abs(guide.end.lon - source.measurement_guides![0]!.end.lon)).toBeLessThanOrEqual(1e-9)
    expect(after.groups).toHaveLength(1)
    expect(after.groups[0]).toMatchObject({ name: 'Kitchen garden' })
    expect(after.groups[0]!.members).toEqual([
      { kind: 'plant', id: imported.id },
      { kind: 'zone', id: zones.find((zone) => zone.name === 'Bed')!.id },
    ])

    expect(target.commands.history.canUndo.value).toBe(true)
    target.commands.history.undo()
    expect(target.queries.getSettledDesignObjects()).toEqual(before)
    expect(target.commands.history.canUndo.value).toBe(false)
  })

  it('rejects malformed input with a named error and leaves the Design untouched', async () => {
    const target = mountDesign(sourceDesign())
    const before = target.queries.getSettledDesignObjects()
    const { files } = memoryFiles(JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { species: 'Ficus carica' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 95] }, properties: {} },
      ],
    }))
    const { workflow, notices } = workflowFor(target, files)

    await expect(workflow.importGeoJson()).resolves.toEqual({ status: 'rejected', code: 'invalid_coordinates' })

    expect(notices).toEqual([{
      tone: 'error',
      title: 'geojson.importTitle',
      message: 'geojson.errors.invalid_coordinates',
      params: { feature: 2, max: expect.any(Number) },
    }])
    expect(geoJsonNoticeText(notices[0]!)).toBe(t('geojson.errors.invalid_coordinates', notices[0]!.params))
    expect(target.queries.getSettledDesignObjects()).toEqual(before)
    expect(target.commands.history.canUndo.value).toBe(false)
  })

  it('reports skipped unsupported geometries without mutating when nothing is importable', async () => {
    const target = mountDesign(sourceDesign())
    const { files } = memoryFiles(JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [] }, properties: {} },
        { type: 'Feature', geometry: { type: 'GeometryCollection', geometries: [] }, properties: {} },
      ],
    }))
    const { workflow, notices } = workflowFor(target, files)

    await expect(workflow.importGeoJson()).resolves.toEqual({ status: 'empty', skipped: 2 })
    expect(notices[0]).toMatchObject({
      message: 'geojson.importNothing',
      detail: { message: 'geojson.importSkipped', params: { count: 2 } },
    })
    expect(geoJsonNoticeText(notices[0]!)).toBe(`${t('geojson.importNothing')} ${t('geojson.importSkipped', { count: 2 })}`)
    expect(target.commands.history.canUndo.value).toBe(false)
  })

  it('does nothing when the picker is cancelled', async () => {
    const target = mountDesign(sourceDesign())
    const { files } = memoryFiles(null)
    const { workflow, notices } = workflowFor(target, files)

    await expect(workflow.importGeoJson()).resolves.toEqual({ status: 'cancelled' })
    expect(notices).toEqual([])
  })

  it('does not import into a Design that replaced the one the picker was opened for', async () => {
    const text = await exportText(sourceDesign())
    const target = mountDesign(designFile())
    const before = target.queries.getSettledDesignObjects()
    let identity: object = {}
    const { files } = memoryFiles(text)
    vi.mocked(files.pickGeoJsonFile).mockImplementationOnce(async () => {
      // Another Design opens on the same canvas while the picker is up.
      identity = {}
      return { name: 'input.geojson', text }
    })
    const notices: GeoJsonNotice[] = []
    const workflow = createGeoJsonWorkflow({
      files,
      notify: (notice) => { notices.push(notice) },
      designName: () => 'Replaced',
      canvas: () => target,
      sessionIdentity: () => identity,
    })

    await expect(workflow.importGeoJson()).resolves.toEqual({ status: 'unavailable' })
    expect(target.queries.getSettledDesignObjects()).toEqual(before)
    expect(target.commands.history.canUndo.value).toBe(false)
    expect(notices).toEqual([])
  })

  it('is unavailable without a mounted canvas runtime', async () => {
    const { files } = memoryFiles('{}')
    const workflow = createGeoJsonWorkflow({
      files,
      notify: vi.fn(),
      designName: () => 'Untitled',
      canvas: () => null,
    })

    expect(workflow.isAvailable()).toBe(false)
    await expect(workflow.importGeoJson()).resolves.toEqual({ status: 'unavailable' })
    await expect(workflow.exportGeoJson()).resolves.toEqual({ status: 'unavailable' })
    expect(files.pickGeoJsonFile).not.toHaveBeenCalled()
  })
})
