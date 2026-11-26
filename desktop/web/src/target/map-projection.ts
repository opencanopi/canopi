import type { GeoPoint, PanelTarget } from '../types/design'
import { createSessionPlane } from '../geo/session-plane'
import type { SceneZoneEntity } from '../canvas/runtime/scene'
import {
  getEllipticalZonePolygon,
  getRectangularZoneCorners,
} from '../canvas/runtime/zone-geometry'
import {
  indexTargetScene,
  resolveTargetsInScene,
  type TargetResolution,
  type TargetSceneIndex,
  type TargetSceneInput,
  type TargetScenePoint,
  type TargetZoneRef,
} from './identity'

type TargetMapProjectionPoint = TargetScenePoint

interface TargetMapPlantRef {
  readonly id: string
  readonly canonicalName: string
  readonly position: TargetMapProjectionPoint
}

interface TargetMapZoneRef {
  readonly id: string
  readonly zoneType?: string
  readonly points: readonly TargetMapProjectionPoint[]
  readonly rotationDeg?: number
}

export interface TargetMapProjectionScene {
  readonly plants: readonly TargetMapPlantRef[]
  readonly zones: readonly TargetMapZoneRef[]
}

interface TargetMapPlantFeature {
  readonly type: 'Feature'
  readonly geometry: {
    readonly type: 'Point'
    readonly coordinates: readonly [number, number]
  }
  readonly properties: {
    readonly kind: 'plant'
    readonly sceneId: string
  }
}

interface TargetMapPolygonZoneFeature {
  readonly type: 'Feature'
  readonly geometry: {
    readonly type: 'Polygon'
    readonly coordinates: readonly (readonly [number, number])[][]
  }
  readonly properties: {
    readonly kind: 'zone'
    readonly sceneId: string
  }
}

interface TargetMapLineZoneFeature {
  readonly type: 'Feature'
  readonly geometry: {
    readonly type: 'LineString'
    readonly coordinates: readonly (readonly [number, number])[]
  }
  readonly properties: {
    readonly kind: 'zone'
    readonly sceneId: string
  }
}

type TargetMapZoneFeature = TargetMapPolygonZoneFeature | TargetMapLineZoneFeature
export type TargetMapFeature = TargetMapPlantFeature | TargetMapZoneFeature

function isTargetSceneIndex(
  scene: TargetSceneInput | TargetSceneIndex,
): scene is TargetSceneIndex {
  return 'plantsById' in scene
}

/** The resolved Targets' map features; a plant without a position, or a zone with too few points, has none. */
export function projectTargetResolutionToMapFeatures(
  resolution: TargetResolution,
  location: GeoPoint,
): readonly TargetMapFeature[] {
  const features: TargetMapFeature[] = []
  const plane = createSessionPlane(location)

  const projectPoint = (point: TargetMapProjectionPoint): readonly [number, number] => {
    const geo = plane.toGeo(point)
    return [geo.lon, geo.lat]
  }

  for (const ref of resolution.resolvedRefs) {
    if (ref.kind === 'plant') {
      if (!ref.plant.position) continue
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: projectPoint(ref.plant.position),
        },
        properties: {
          kind: 'plant',
          sceneId: ref.plant.id,
        },
      })
      continue
    }

    if (ref.zone.zoneType === 'line') {
      const points = ref.zone.points
      if (!points || points.length < 2) continue
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: points.map(projectPoint),
        },
        properties: {
          kind: 'zone',
          sceneId: ref.zone.id,
        },
      })
      continue
    }

    const points = getZoneProjectionPoints(ref.zone)
    if (!points || points.length < 3) continue
    const ring = points.map(projectPoint)
    const first = ring[0]!
    const last = ring[ring.length - 1]!
    const closedRing = first[0] === last[0] && first[1] === last[1]
      ? ring
      : [...ring, first]

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [closedRing],
      },
      properties: {
        kind: 'zone',
        sceneId: ref.zone.id,
      },
    })
  }

  return features
}

export function projectTargetsToMapFeatures(
  values: readonly PanelTarget[],
  scene: TargetMapProjectionScene | TargetSceneIndex,
  location: GeoPoint,
): readonly TargetMapFeature[] {
  const index = isTargetSceneIndex(scene) ? scene : indexTargetScene(scene)
  return projectTargetResolutionToMapFeatures(resolveTargetsInScene(values, index), location)
}

function getZoneProjectionPoints(zone: TargetZoneRef): readonly TargetMapProjectionPoint[] | null {
  if (!zone.points) return null

  if (zone.zoneType === 'rect') {
    return getRectangularZoneCorners(targetZoneToSceneZone(zone))
  }

  if (zone.zoneType === 'ellipse') {
    return getEllipticalZonePolygon(targetZoneToSceneZone(zone))
  }

  return zone.points
}

function targetZoneToSceneZone(zone: TargetZoneRef): SceneZoneEntity {
  return {
    kind: 'zone',
    id: zone.id,
    name: null,
    locked: false,
    zoneType: zone.zoneType ?? 'polygon',
    points: zone.points ? zone.points.map((point) => ({ x: point.x, y: point.y })) : [],
    rotationDeg: zone.rotationDeg ?? 0,
    fillColor: null,
    notes: null,
  }
}
