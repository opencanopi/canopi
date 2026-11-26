// ---------------------------------------------------------------------------
// GeoJSON codec for design objects (RFC 7946).
//
// Pure translation between persisted design objects (WGS84 lon/lat, the
// `.canopi` shapes) and a GeoJSON FeatureCollection. No DOM, IPC or
// runtime access: callers read objects from the runtime's canonical form and
// hand decoded objects back to a runtime import transaction.
//
// Export writes one Feature per object with `canopi_kind` plus its domain
// properties. Rectangle and ellipse zones export their drawn (rotated) outline
// as the Polygon and keep their stored corners in `canopi_points`, so a Canopi
// round trip restores the exact shape while other GIS tools see the outline.
//
// Import maps: Point with `species`/`canonical_name` -> plant; other Point ->
// annotation; Polygon -> zone; two-position LineString -> measurement guide;
// longer LineString or `canopi_kind: "zone"` LineString -> line zone. Other
// geometries (Multi*, GeometryCollection, null) are skipped and counted.
// Any malformed supported feature rejects the whole file before mutation.
// ---------------------------------------------------------------------------

import type { GeoPoint, Annotation, MeasurementGuide, ObjectGroup, PlacedPlant, Zone } from '../../types/design'
import { WEB_MERCATOR_MAX_LATITUDE_DEG } from '../../generated/canopi-design-format'
import {
  createSessionPlane,
  roundGeoDegrees,
  type PlanePoint,
} from '../../geo/session-plane'
import {
  getEllipticalZonePolygon,
  getRectangularZoneCorners,
} from '../../canvas/runtime/zone-geometry'

export const GEOJSON_KIND_PROPERTY = 'canopi_kind'
export const GEOJSON_MAX_FEATURES = 20_000

const DEFAULT_ANNOTATION_FONT_SIZE = 16
const ELLIPSE_OUTLINE_SEGMENTS = 64

/** Design objects in their persisted lon/lat form. */
export interface GeoJsonDesignObjects {
  readonly plants: readonly PlacedPlant[]
  readonly zones: readonly Zone[]
  readonly annotations: readonly Annotation[]
  readonly measurementGuides: readonly MeasurementGuide[]
  readonly groups: readonly ObjectGroup[]
}

type GeoJsonPosition = [number, number]

type GeoJsonGeometry =
  | { type: 'Point'; coordinates: GeoJsonPosition }
  | { type: 'LineString'; coordinates: GeoJsonPosition[] }
  | { type: 'Polygon'; coordinates: GeoJsonPosition[][] }

interface GeoJsonFeature {
  type: 'Feature'
  id: string
  geometry: GeoJsonGeometry
  properties: Record<string, unknown>
}

interface GeoJsonGroupRecord {
  id: string
  name: string | null
  locked: boolean
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
  canopi_groups: GeoJsonGroupRecord[]
}

export type GeoJsonImportErrorCode =
  | 'invalid_json'
  | 'unsupported_root'
  | 'too_many_features'
  | 'invalid_feature'
  | 'invalid_geometry'
  | 'invalid_coordinates'

export class GeoJsonImportError extends Error {
  constructor(
    readonly code: GeoJsonImportErrorCode,
    readonly featureIndex: number | null = null,
    message = `GeoJSON import rejected: ${code}${featureIndex === null ? '' : ` (feature ${featureIndex})`}`,
  ) {
    super(message)
    this.name = 'GeoJsonImportError'
  }
}

export interface GeoJsonImportCounts {
  readonly plants: number
  readonly zones: number
  readonly annotations: number
  readonly measurementGuides: number
}

export interface GeoJsonDecodeResult {
  readonly objects: GeoJsonDesignObjects
  readonly counts: GeoJsonImportCounts
  /** Features whose geometry Canopi does not import (Multi*, collections, null). */
  readonly skipped: number
}

// --- export ----------------------------------------------------------------

export function encodeDesignGeoJson(objects: GeoJsonDesignObjects): GeoJsonFeatureCollection {
  const groupIdsByMember = new Map<string, string[]>()
  for (const group of objects.groups) {
    for (const member of group.members) {
      const key = memberKey(member.kind, member.id)
      const ids = groupIdsByMember.get(key) ?? []
      ids.push(group.id)
      groupIdsByMember.set(key, ids)
    }
  }
  const groupIds = (kind: string, id: string) => [...(groupIdsByMember.get(memberKey(kind, id)) ?? [])]

  const features: GeoJsonFeature[] = []
  for (const plant of objects.plants) {
    features.push({
      type: 'Feature',
      id: plant.id,
      geometry: { type: 'Point', coordinates: position(plant.position) },
      properties: {
        [GEOJSON_KIND_PROPERTY]: 'plant',
        canonical_name: plant.canonical_name,
        common_name: plant.common_name,
        color: plant.color ?? null,
        symbol: plant.symbol ?? null,
        pinned_name: plant.pinned_name === true,
        rotation: plant.rotation,
        canopy_spread_m: plant.canopy_spread_m,
        notes: plant.notes,
        planted_date: plant.planted_date,
        quantity: plant.quantity,
        locked: plant.locked,
        group_ids: groupIds('plant', plant.id),
      },
    })
  }
  for (const zone of objects.zones) {
    const properties: Record<string, unknown> = {
      [GEOJSON_KIND_PROPERTY]: 'zone',
      name: zone.name,
      zone_type: zone.zone_type,
      fill_color: zone.fill_color,
      notes: zone.notes,
      rotation: zone.rotation,
      locked: zone.locked,
      group_ids: groupIds('zone', zone.id),
    }
    if (zone.zone_type === 'rect' || zone.zone_type === 'ellipse') {
      properties.canopi_points = zone.points.map(position)
    }
    features.push({
      type: 'Feature',
      id: zone.id,
      geometry: zoneGeometry(zone),
      properties,
    })
  }
  for (const annotation of objects.annotations) {
    features.push({
      type: 'Feature',
      id: annotation.id,
      geometry: { type: 'Point', coordinates: position(annotation.position) },
      properties: {
        [GEOJSON_KIND_PROPERTY]: 'annotation',
        annotation_type: annotation.annotation_type,
        text: annotation.text,
        font_size: annotation.font_size,
        rotation: annotation.rotation,
        locked: annotation.locked,
        group_ids: groupIds('annotation', annotation.id),
      },
    })
  }
  objects.measurementGuides.forEach((guide, index) => {
    features.push({
      type: 'Feature',
      id: guide.id ?? `measurement-guide-${index + 1}`,
      geometry: { type: 'LineString', coordinates: [position(guide.start), position(guide.end)] },
      properties: {
        [GEOJSON_KIND_PROPERTY]: 'measurement_guide',
        locked: guide.locked ?? false,
      },
    })
  })

  return {
    type: 'FeatureCollection',
    features,
    canopi_groups: objects.groups.map((group) => ({
      id: group.id,
      name: group.name,
      locked: group.locked,
    })),
  }
}

export function serializeDesignGeoJson(objects: GeoJsonDesignObjects): string {
  return `${JSON.stringify(encodeDesignGeoJson(objects), null, 2)}\n`
}

function position(point: GeoPoint): GeoJsonPosition {
  return [point.lon, point.lat]
}

function memberKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`
}

function zoneGeometry(zone: Zone): GeoJsonGeometry {
  if (zone.zone_type === 'line') {
    return { type: 'LineString', coordinates: zone.points.map(position) }
  }
  const outline = drawnZoneOutline(zone) ?? zone.points.map(position)
  return { type: 'Polygon', coordinates: [closeRing(outline)] }
}

// Rectangles and ellipses store an unrotated frame plus a rotation; their drawn
// outline comes from the runtime's zone geometry in a local plane at the zone.
function drawnZoneOutline(zone: Zone): GeoJsonPosition[] | null {
  if (zone.zone_type !== 'rect' && zone.zone_type !== 'ellipse') return null
  const anchor = zone.points[0]
  if (!anchor) return null
  const plane = createSessionPlane(anchor)
  const planePoints = zone.points.map((point) => plane.toPlane(point))
  let outline: PlanePoint[] | null
  if (zone.zone_type === 'rect') {
    outline = getRectangularZoneCorners({ ...zoneEntityFrame(zone), points: planePoints.map(copyPoint) })
  } else {
    const [first, second] = planePoints
    if (!first || !second) return null
    const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    const radii = { x: (second.x - first.x) / 2, y: (second.y - first.y) / 2 }
    outline = getEllipticalZonePolygon(
      { ...zoneEntityFrame(zone), points: [center, radii] },
      ELLIPSE_OUTLINE_SEGMENTS,
    )
  }
  if (!outline) return null
  return outline.map((point) => {
    const geo = plane.toGeo(point)
    return [roundGeoDegrees(geo.lon), roundGeoDegrees(geo.lat)]
  })
}

function zoneEntityFrame(zone: Zone) {
  return {
    kind: 'zone' as const,
    id: zone.id,
    name: zone.name,
    locked: zone.locked,
    zoneType: zone.zone_type,
    rotationDeg: zone.rotation,
    fillColor: zone.fill_color,
    notes: zone.notes,
  }
}

function copyPoint(point: PlanePoint): { x: number; y: number } {
  return { x: point.x, y: point.y }
}

function closeRing(points: GeoJsonPosition[]): GeoJsonPosition[] {
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return points
  if (first[0] === last[0] && first[1] === last[1]) return points
  return [...points, [first[0], first[1]]]
}

// --- import ----------------------------------------------------------------

export interface GeoJsonDecodeOptions {
  /** Identity for features without an `id`; defaults to a per-kind counter. */
  readonly createId?: (kind: 'plant' | 'zone' | 'annotation' | 'measurement-guide') => string
}

export function parseDesignGeoJson(text: string, options: GeoJsonDecodeOptions = {}): GeoJsonDecodeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new GeoJsonImportError('invalid_json')
  }
  return decodeDesignGeoJson(parsed, options)
}

function decodeDesignGeoJson(value: unknown, options: GeoJsonDecodeOptions = {}): GeoJsonDecodeResult {
  const features = rootFeatures(value)
  if (features.length > GEOJSON_MAX_FEATURES) throw new GeoJsonImportError('too_many_features')

  let generated = 0
  const createId = options.createId ?? ((kind) => `geojson-${kind}-${++generated}`)
  const ids = new UniqueIds()
  const plants: PlacedPlant[] = []
  const zones: Zone[] = []
  const annotations: Annotation[] = []
  const measurementGuides: MeasurementGuide[] = []
  const membersByGroup = new Map<string, ObjectGroup['members']>()
  let skipped = 0

  const addMemberships = (properties: Record<string, unknown>, member: ObjectGroup['members'][number]) => {
    for (const groupId of stringArray(properties.group_ids)) {
      const members = membersByGroup.get(groupId) ?? []
      members.push(member)
      membersByGroup.set(groupId, members)
    }
  }

  features.forEach((feature, index) => {
    if (!isRecord(feature) || feature.type !== 'Feature' || !('geometry' in feature)) {
      throw new GeoJsonImportError('invalid_feature', index)
    }
    const rawProperties = feature.properties ?? null
    if (rawProperties !== null && !isRecord(rawProperties)) throw new GeoJsonImportError('invalid_feature', index)
    const properties: Record<string, unknown> = rawProperties ?? {}
    const geometry = feature.geometry
    if (geometry === null) {
      skipped += 1
      return
    }
    if (!isRecord(geometry) || typeof geometry.type !== 'string') {
      throw new GeoJsonImportError('invalid_geometry', index)
    }
    const kind = properties[GEOJSON_KIND_PROPERTY]
    const featureId = featureIdentity(feature.id, properties.id)

    switch (geometry.type) {
      case 'Point': {
        const point = readPosition(geometry.coordinates, index)
        const species = stringOrNull(properties.canonical_name) ?? stringOrNull(properties.species)
        if (species !== null && kind !== 'annotation') {
          const id = ids.claim(featureId ?? createId('plant'))
          plants.push({
            id,
            locked: booleanOr(properties.locked, false),
            canonical_name: species,
            common_name: stringOrNull(properties.common_name),
            color: stringOrNull(properties.color),
            symbol: stringOrNull(properties.symbol),
            pinned_name: booleanOr(properties.pinned_name, false),
            position: point,
            rotation: finiteOrNull(properties.rotation),
            canopy_spread_m: positiveOrNull(properties.canopy_spread_m),
            notes: stringOrNull(properties.notes),
            planted_date: stringOrNull(properties.planted_date),
            quantity: countOrNull(properties.quantity),
          })
          addMemberships(properties, { kind: 'plant', id })
          return
        }
        const id = ids.claim(featureId ?? createId('annotation'))
        annotations.push({
          id,
          locked: booleanOr(properties.locked, false),
          annotation_type: stringOrNull(properties.annotation_type) ?? 'text',
          position: point,
          text: annotationText(properties, featureId),
          font_size: positiveOr(properties.font_size, DEFAULT_ANNOTATION_FONT_SIZE),
          rotation: finiteOrNull(properties.rotation),
        })
        addMemberships(properties, { kind: 'annotation', id })
        return
      }
      case 'LineString': {
        const line = readLine(geometry.coordinates, index)
        if (kind !== 'zone' && line.length === 2) {
          measurementGuides.push({
            id: ids.claim(featureId ?? createId('measurement-guide')),
            locked: booleanOr(properties.locked, false),
            start: line[0]!,
            end: line[1]!,
          })
          return
        }
        const id = ids.claim(featureId ?? createId('zone'))
        zones.push({
          id,
          name: nonEmptyString(properties.name),
          locked: booleanOr(properties.locked, false),
          zone_type: 'line',
          points: line,
          rotation: finiteOr(properties.rotation, 0),
          fill_color: stringOrNull(properties.fill_color),
          notes: stringOrNull(properties.notes),
        })
        addMemberships(properties, { kind: 'zone', id })
        return
      }
      case 'Polygon': {
        const outline = readPolygonOutline(geometry.coordinates, index)
        const zoneType = stringOrNull(properties.zone_type)
        const framed = zoneType === 'rect' || zoneType === 'ellipse'
          ? readFramePoints(properties.canopi_points, zoneType, index)
          : null
        const id = ids.claim(featureId ?? createId('zone'))
        zones.push({
          id,
          name: nonEmptyString(properties.name),
          locked: booleanOr(properties.locked, false),
          zone_type: framed ? zoneType! : 'polygon',
          points: framed ?? outline,
          rotation: framed ? finiteOr(properties.rotation, 0) : polygonRotation(zoneType, properties.rotation),
          fill_color: stringOrNull(properties.fill_color),
          notes: stringOrNull(properties.notes),
        })
        addMemberships(properties, { kind: 'zone', id })
        return
      }
      default:
        skipped += 1
    }
  })

  return {
    objects: {
      plants,
      zones,
      annotations,
      measurementGuides,
      groups: decodeGroups(value, membersByGroup),
    },
    counts: {
      plants: plants.length,
      zones: zones.length,
      annotations: annotations.length,
      measurementGuides: measurementGuides.length,
    },
    skipped,
  }
}

function rootFeatures(value: unknown): readonly unknown[] {
  if (!isRecord(value)) throw new GeoJsonImportError('unsupported_root')
  if (value.type === 'FeatureCollection') {
    if (!Array.isArray(value.features)) throw new GeoJsonImportError('unsupported_root')
    return value.features
  }
  if (value.type === 'Feature') return [value]
  throw new GeoJsonImportError('unsupported_root')
}

function decodeGroups(
  root: unknown,
  membersByGroup: ReadonlyMap<string, ObjectGroup['members']>,
): ObjectGroup[] {
  const records = new Map<string, { name: string | null; locked: boolean }>()
  if (isRecord(root) && Array.isArray(root.canopi_groups)) {
    for (const record of root.canopi_groups) {
      if (!isRecord(record) || typeof record.id !== 'string') continue
      records.set(record.id, {
        name: stringOrNull(record.name),
        locked: booleanOr(record.locked, false),
      })
    }
  }
  const groups: ObjectGroup[] = []
  for (const [id, members] of membersByGroup) {
    if (members.length < 2) continue
    const record = records.get(id)
    groups.push({ id, locked: record?.locked ?? false, name: record?.name ?? null, members: [...members] })
  }
  return groups
}

function readPosition(value: unknown, index: number): GeoPoint {
  if (!Array.isArray(value) || value.length < 2) throw new GeoJsonImportError('invalid_geometry', index)
  const [lon, lat] = value
  if (typeof lon !== 'number' || typeof lat !== 'number') throw new GeoJsonImportError('invalid_geometry', index)
  if (
    !Number.isFinite(lon)
    || !Number.isFinite(lat)
    || Math.abs(lon) > 180
    || Math.abs(lat) > WEB_MERCATOR_MAX_LATITUDE_DEG
  ) {
    throw new GeoJsonImportError('invalid_coordinates', index)
  }
  return { lon, lat }
}

function readLine(value: unknown, index: number): GeoPoint[] {
  if (!Array.isArray(value) || value.length < 2) throw new GeoJsonImportError('invalid_geometry', index)
  return value.map((entry) => readPosition(entry, index))
}

// RFC 7946 rings are closed with at least four positions. Canopi zones have no
// holes, so only the exterior ring is imported; the closing position is dropped.
function readPolygonOutline(value: unknown, index: number): GeoPoint[] {
  if (!Array.isArray(value) || value.length === 0) throw new GeoJsonImportError('invalid_geometry', index)
  const ring = value[0]
  if (!Array.isArray(ring) || ring.length < 4) throw new GeoJsonImportError('invalid_geometry', index)
  for (const hole of value.slice(1)) {
    if (!Array.isArray(hole)) throw new GeoJsonImportError('invalid_geometry', index)
    hole.forEach((entry) => readPosition(entry, index))
  }
  const points = ring.map((entry) => readPosition(entry, index))
  const first = points[0]!
  const last = points[points.length - 1]!
  if (first.lon !== last.lon || first.lat !== last.lat) throw new GeoJsonImportError('invalid_geometry', index)
  return points.slice(0, -1)
}

function readFramePoints(value: unknown, zoneType: 'rect' | 'ellipse', index: number): GeoPoint[] | null {
  if (value === undefined || value === null) return null
  const expected = zoneType === 'rect' ? 4 : 2
  if (!Array.isArray(value) || value.length !== expected) throw new GeoJsonImportError('invalid_geometry', index)
  return value.map((entry) => readPosition(entry, index))
}

// A Canopi polygon keeps its stored rotation; any other outline is drawn as-is.
function polygonRotation(zoneType: string | null, rotation: unknown): number {
  return zoneType === 'polygon' ? finiteOr(rotation, 0) : 0
}

function annotationText(properties: Record<string, unknown>, featureId: string | null): string {
  for (const key of ['text', 'name', 'label', 'title']) {
    const text = nonEmptyString(properties[key])
    if (text !== null) return text
  }
  return featureId ?? '•'
}

function featureIdentity(id: unknown, propertyId: unknown): string | null {
  if (typeof id === 'string' && id.length > 0) return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return nonEmptyString(propertyId)
}

class UniqueIds {
  private readonly _used = new Set<string>()

  claim(base: string): string {
    let candidate = base
    let suffix = 2
    while (this._used.has(candidate)) {
      candidate = `${base} (${suffix})`
      suffix += 1
    }
    this._used.add(candidate)
    return candidate
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// The Design format admits a plant spread only above 0 and a quantity only
// as a u32, so an imported value outside those ranges is dropped.
function positiveOrNull(value: unknown): number | null {
  const number = finiteOrNull(value)
  return number !== null && number > 0 ? number : null
}

const MAX_PLANT_QUANTITY = 0xffff_ffff

function countOrNull(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_PLANT_QUANTITY
    ? value as number
    : null
}

function finiteOr(value: unknown, fallback: number): number {
  return finiteOrNull(value) ?? fallback
}

function positiveOr(value: unknown, fallback: number): number {
  const number = finiteOrNull(value)
  return number !== null && number > 0 ? number : fallback
}
