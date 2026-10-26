import { describe, expect, it } from 'vitest'
import type { TargetMapProjectionScene } from '../target'
import { MANUAL_TARGET, speciesTarget, targetIdentity, projectTargetsToMapFeatures } from '../target'

const NONE_TARGET = { kind: 'none' } as const
import { geoToMercator } from '../canvas/projection'
import type { ViewCamera } from '../canvas/runtime/view/types'
import { createSessionPlane } from '../canvas/session-plane'
import { projectTargetResolutionToMapFeatures } from '../target/map-projection'
import type { PanelTarget } from '../types/design'
import { createTestView } from './support/test-view'

const LOCATION = { lat: 48.8566, lon: 2.3522 }
const MAPLIBRE_WORLD_TILE_SIZE = 512

function projectWorldToCanvasScreen(
  viewport: { x: number; y: number; scale: number },
  world: { x: number; y: number },
) {
  return {
    x: viewport.x + world.x * viewport.scale,
    y: viewport.y + world.y * viewport.scale,
  }
}

function projectGeoToMapScreen(
  lng: number,
  lat: number,
  camera: ViewCamera,
  screenSize: { width: number; height: number },
) {
  const point = geoToMercator(lng, lat)
  const center = geoToMercator(camera.center.lon, camera.center.lat)
  const worldSizePx = MAPLIBRE_WORLD_TILE_SIZE * (2 ** camera.zoom)
  const deltaX = (point.x - center.x) * worldSizePx
  const deltaY = (point.y - center.y) * worldSizePx

  return {
    x: screenSize.width / 2 + deltaX,
    y: screenSize.height / 2 + deltaY,
  }
}

function createScene(overrides: Partial<TargetMapProjectionScene> = {}): TargetMapProjectionScene {
  return {
    plants: [
      { id: 'plant-1', canonicalName: 'Malus domestica', position: { x: 0, y: 0 } },
      { id: 'plant-2', canonicalName: 'Prunus avium', position: { x: 12, y: -6 } },
      { id: 'plant-3', canonicalName: 'Malus domestica', position: { x: 10, y: 20 } },
    ],
    zones: [
      {
        id: 'orchard',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ],
      },
      {
        id: 'too-small',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
      },
    ],
    ...overrides,
  }
}

describe('projectTargetsToMapFeatures', () => {
  it('projects an identity resolution through the map adapter interface', () => {
    const resolution = targetIdentity.resolve(
      [speciesTarget('Malus domestica'), { kind: 'zone', zone_id: 'orchard' }],
      targetIdentity.indexScene(createScene()),
    )

    const result = projectTargetResolutionToMapFeatures(resolution, LOCATION)

    expect(result.map((feature) => feature.properties)).toEqual([
      { kind: 'plant', sceneId: 'plant-1' },
      { kind: 'plant', sceneId: 'plant-3' },
      { kind: 'zone', sceneId: 'orchard' },
    ])
  })

  it('projects a species target to all matching plant point features in scene order', () => {
    const result = projectTargetsToMapFeatures(
      [speciesTarget('Malus domestica')],
      createScene(),
      LOCATION,
    )

    expect(result.map((feature) => feature.properties)).toEqual([
      { kind: 'plant', sceneId: 'plant-1' },
      { kind: 'plant', sceneId: 'plant-3' },
    ])

    const first = result[0]
    const second = result[1]
    expect(first?.geometry.type).toBe('Point')
    expect(first?.geometry.coordinates[0]).toBeCloseTo(LOCATION.lon, 10)
    expect(first?.geometry.coordinates[1]).toBeCloseTo(LOCATION.lat, 10)
    expect(second?.geometry.type).toBe('Point')
    expect(second?.geometry.coordinates[0]).toBeGreaterThan(LOCATION.lon)
    expect(second?.geometry.coordinates[1]).toBeLessThan(LOCATION.lat)
  })

  it('projects a placed plant target without also projecting same-species plants', () => {
    const result = projectTargetsToMapFeatures(
      [{ kind: 'placed_plant', plant_id: 'plant-2' }],
      createScene(),
      LOCATION,
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.properties).toEqual({ kind: 'plant', sceneId: 'plant-2' })
  })

  it('projects a zone target to a closed polygon and keeps colliding IDs typed', () => {
    const result = projectTargetsToMapFeatures(
      [
        { kind: 'zone', zone_id: 'plant-1' },
        { kind: 'placed_plant', plant_id: 'orchard' },
      ],
      createScene({
        plants: [
          { id: 'plant-1', canonicalName: 'Malus domestica', position: { x: 0, y: 0 } },
          { id: 'orchard', canonicalName: 'Prunus avium', position: { x: 8, y: 8 } },
        ],
        zones: [
          {
            id: 'plant-1',
            points: [
              { x: 0, y: 0 },
              { x: 4, y: 0 },
              { x: 4, y: 4 },
            ],
          },
          {
            id: 'orchard',
            points: [
              { x: 0, y: 0 },
              { x: 6, y: 0 },
              { x: 6, y: 6 },
            ],
          },
        ],
      }),
      LOCATION,
    )

    expect(result.map((feature) => feature.properties)).toEqual([
      { kind: 'zone', sceneId: 'plant-1' },
      { kind: 'plant', sceneId: 'orchard' },
    ])

    const zone = result.find((feature) => feature.properties.kind === 'zone')
    expect(zone?.geometry.type).toBe('Polygon')
    const ring = zone?.geometry.type === 'Polygon' ? zone.geometry.coordinates[0] : []
    expect(ring).toHaveLength(4)
    expect(ring?.[0]).toEqual(ring?.[ring.length - 1])
  })

  it('projects a Linear Zone target to a line feature', () => {
    const result = projectTargetsToMapFeatures(
      [{ kind: 'zone', zone_id: 'hedgerow' }],
      createScene({
        zones: [
          {
            id: 'hedgerow',
            zoneType: 'line',
            points: [
              { x: 0, y: 0 },
              { x: 12, y: -6 },
            ],
          },
        ],
      }),
      LOCATION,
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.properties).toEqual({ kind: 'zone', sceneId: 'hedgerow' })
    expect(result[0]?.geometry).toMatchObject({
      type: 'LineString',
    })
  })

  it('projects a rotated rectangular Zone target to its oriented polygon', () => {
    const result = projectTargetsToMapFeatures(
      [{ kind: 'zone', zone_id: 'rotated-bed' }],
      createScene({
        zones: [{
          id: 'rotated-bed',
          zoneType: 'rect',
          rotationDeg: 90,
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 4 },
            { x: 0, y: 4 },
          ],
        }],
      }),
      LOCATION,
    )
    const expected = projectTargetsToMapFeatures(
      [{ kind: 'zone', zone_id: 'rotated-bed' }],
      createScene({
        zones: [{
          id: 'rotated-bed',
          zoneType: 'polygon',
          points: [
            { x: 7, y: -3 },
            { x: 7, y: 7 },
            { x: 3, y: 7 },
            { x: 3, y: -3 },
          ],
        }],
      }),
      LOCATION,
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.geometry.type).toBe('Polygon')
    expect(result[0]).toEqual(expected[0])
  })

  it('projects a rotated elliptical Zone target to its oriented polygon', () => {
    const result = projectTargetsToMapFeatures(
      [{ kind: 'zone', zone_id: 'ellipse-bed' }],
      createScene({
        zones: [{
          id: 'ellipse-bed',
          zoneType: 'ellipse',
          rotationDeg: 90,
          points: [
            { x: 0, y: 0 },
            { x: 4, y: 1 },
          ],
        }],
      }),
      LOCATION,
    )
    const expectedMajorAxisPoint = projectTargetsToMapFeatures(
      [{ kind: 'placed_plant', plant_id: 'edge' }],
      createScene({
        plants: [
          { id: 'edge', canonicalName: 'Malus domestica', position: { x: 0, y: 4 } },
        ],
        zones: [],
      }),
      LOCATION,
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.geometry.type).toBe('Polygon')
    const ring = result[0]?.geometry.type === 'Polygon'
      ? result[0].geometry.coordinates[0]
      : []
    const expected = expectedMajorAxisPoint[0]?.geometry.type === 'Point'
      ? expectedMajorAxisPoint[0].geometry.coordinates
      : null

    expect(ring).toHaveLength(49)
    expect(ring?.[0]?.[0]).toBeCloseTo(expected![0], 10)
    expect(ring?.[0]?.[1]).toBeCloseTo(expected![1], 10)
    expect(ring?.[0]).toEqual(ring?.[ring.length - 1])
  })

  it('reports missing scene-backed targets and treats manual and none as intentionally empty', () => {
    const missingSpecies = speciesTarget('Pyrus communis')
    const missingPlant: PanelTarget = { kind: 'placed_plant', plant_id: 'missing-plant' }
    const missingZone: PanelTarget = { kind: 'zone', zone_id: 'missing-zone' }

    const result = projectTargetsToMapFeatures(
      [MANUAL_TARGET, NONE_TARGET, missingSpecies, missingPlant, missingZone],
      createScene(),
      LOCATION,
    )

    expect(result).toEqual([])
  })

  it('skips zones with fewer than three points instead of emitting invalid polygons', () => {
    const result = projectTargetsToMapFeatures(
      [{ kind: 'zone', zone_id: 'too-small' }],
      createScene(),
      LOCATION,
    )

    expect(result).toEqual([])
  })

  it('projects session plane metres north-up: x east, y south', () => {
    const result = projectTargetsToMapFeatures(
      [{ kind: 'placed_plant', plant_id: 'plant-2' }],
      createScene(),
      LOCATION,
    )

    expect(result).toHaveLength(1)
    const point = result[0]
    expect(point?.geometry.type).toBe('Point')
    const coords = point?.geometry.type === 'Point' ? point.geometry.coordinates : null
    // plant-2 sits 12 m east and 6 m north of the origin.
    expect(coords![0]).toBeGreaterThan(LOCATION.lon)
    expect(coords![1]).toBeGreaterThan(LOCATION.lat)
  })

  it('keeps projected plant overlays screen-locked to the same canonical map frame', () => {
    const scene = createScene()
    const viewport = { x: -180, y: 64, scale: 2.4 }
    const screenSize = { width: 1200, height: 800 }
    // The map camera the canvas viewport corresponds to, on the session plane at the Design's location.
    const view = createTestView({ screen: screenSize, viewport, plane: createSessionPlane(LOCATION) })
    const { camera } = view.view()
    view.dispose()
    const result = projectTargetsToMapFeatures(
      [{ kind: 'placed_plant', plant_id: 'plant-2' }],
      scene,
      LOCATION,
    )

    expect(result).toHaveLength(1)
    const plant = scene.plants.find((entry) => entry.id === 'plant-2')
    const feature = result[0]
    expect(plant).toBeDefined()
    expect(feature?.geometry.type).toBe('Point')
    const coordinates = feature?.geometry.type === 'Point' ? feature.geometry.coordinates : null
    const mapScreen = coordinates
      ? projectGeoToMapScreen(coordinates[0], coordinates[1], camera, screenSize)
      : null
    const canvasScreen = projectWorldToCanvasScreen(viewport, plant!.position)

    expect(mapScreen).not.toBeNull()
    expect(mapScreen!.x).toBeCloseTo(canvasScreen.x, 6)
    expect(mapScreen!.y).toBeCloseTo(canvasScreen.y, 6)
  })
})
