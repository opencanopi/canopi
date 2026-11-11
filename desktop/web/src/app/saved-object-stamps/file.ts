import { SAVED_OBJECT_STAMP_PAYLOAD_VERSION, type SavedObjectStampPayload } from '../../canvas/saved-object-stamp-payload'
import type { ObjectGroup, CanopiFile } from '../../types/design'
import {
  designGeoPositions,
  hydrateGeoEllipse,
  hydrateGeoPoint,
  resolvePlantSymbolId,
  serializeGeoEllipse,
  serializeGeoPoint,
  type ScenePoint,
} from '../../canvas/runtime/scene'
import { getZoneWorldBounds } from '../../canvas/runtime/zone-geometry'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import { createSessionPlane, sessionPlaneOriginForPoints, type SessionPlane } from '../../canvas/session-plane'
import { t } from '../../i18n'

// A stamp is a relative arrangement in metres. Its portable `.canopi` file
// places that arrangement around 0°/0°; import reads it back through a plane
// centred on the file's own objects, so any current-version Design can be imported.
const STAMP_FILE_ORIGIN = { lon: 0, lat: 0 } as const

interface ComposeSavedObjectStampCanopiFileOptions {
  readonly name: string
  readonly payload: SavedObjectStampPayload
  readonly now?: Date
}

const STAMP_FILE_LAYERS: CanopiFile['layers'] = [
  { name: 'plants', visible: true, locked: false, opacity: 1 },
  { name: 'zones', visible: true, locked: false, opacity: 1 },
  { name: 'annotations', visible: true, locked: false, opacity: 1 },
]

export function composeSavedObjectStampCanopiFile({
  name,
  payload,
  now = new Date(),
}: ComposeSavedObjectStampCanopiFileOptions): CanopiFile {
  const timestamp = now.toISOString()
  const plane = createSessionPlane(STAMP_FILE_ORIGIN)
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: STAMP_FILE_LAYERS.map((layer) => ({ ...layer })),
    plants: payload.plants.map((plant) => ({
      id: plant.id,
      locked: false,
      canonical_name: plant.canonicalName,
      common_name: plant.commonName,
      color: plant.color,
      symbol: plant.symbol ?? null,
      pinned_name: false,
      position: serializeGeoPoint(plane, plant.position),
      rotation: plant.rotationDeg,
      scale: plant.scale,
      notes: null,
      planted_date: null,
      quantity: null,
    })),
    zones: payload.zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      locked: false,
      zone_type: zone.zoneType,
      points: stampZonePointsToGeo(plane, zone),
      rotation: zone.rotationDeg,
      fill_color: zone.fillColor,
      notes: null,
    })),
    annotations: payload.annotations.map((annotation) => ({
      id: annotation.id,
      locked: false,
      annotation_type: annotation.annotationType,
      position: serializeGeoPoint(plane, annotation.position),
      text: annotation.text,
      font_size: annotation.fontSize,
      rotation: annotation.rotationDeg,
    })),
    consortiums: [],
    groups: validCapturedGroups(payload),
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: timestamp,
    updated_at: timestamp,
    extra: {},
  }
}

export function savedObjectStampPayloadFromCanopiFile(file: CanopiFile): SavedObjectStampPayload | null {
  const plane = createSessionPlane(sessionPlaneOriginForPoints(designGeoPositions(file), STAMP_FILE_ORIGIN))
  const idMap = new Map<string, string>()
  const plants = layerVisible(file, 'plants')
    ? file.plants
      .filter((plant) => plant.canonical_name.trim().length > 0)
      .map((plant, index) => {
        const id = nonEmptyString(plant.id) ?? `plant-${index + 1}`
        if (nonEmptyString(plant.id)) idMap.set(memberKey({ kind: 'plant', id: plant.id }), id)
        return {
          id,
          canonicalName: plant.canonical_name,
          commonName: plant.common_name,
          color: plant.color ?? null,
          symbol: resolvePlantSymbolId(plant.symbol ?? file.plant_species_symbols?.[plant.canonical_name]),
          position: hydrateGeoPoint(plane, plant.position),
          rotationDeg: plant.rotation,
          scale: plant.scale,
        }
      })
    : []
  const zones = layerVisible(file, 'zones')
    ? file.zones
      .filter((zone) => zone.id.trim().length > 0 && zone.points.length > 0)
      .map((zone, index) => {
        const id = `zone-${index + 1}`
        idMap.set(memberKey({ kind: 'zone', id: zone.id }), id)
        return {
          id,
          name: zone.name,
          zoneType: zone.zone_type,
          points: stampZonePointsFromGeo(plane, zone),
          rotationDeg: zone.rotation,
          fillColor: zone.fill_color,
        }
      })
    : []
  const annotations = layerVisible(file, 'annotations')
    ? file.annotations
      .filter((annotation) => annotation.id.trim().length > 0 && annotation.text.trim().length > 0)
      .map((annotation, index) => {
        const id = annotation.id || `annotation-${index + 1}`
        idMap.set(memberKey({ kind: 'annotation', id: annotation.id }), id)
        return {
          id,
          annotationType: annotation.annotation_type,
          position: hydrateGeoPoint(plane, annotation.position),
          text: annotation.text,
          fontSize: annotation.font_size,
          rotationDeg: annotation.rotation,
        }
      })
    : []

  if (plants.length + zones.length + annotations.length === 0) return null

  return {
    version: SAVED_OBJECT_STAMP_PAYLOAD_VERSION,
    anchor: anchorForPayloadObjects(plants, zones, annotations),
    plants,
    zones,
    annotations,
    groups: file.groups
      .map((group, index) => ({
        id: nonEmptyString(group.id) ?? `group-${index + 1}`,
        name: group.name,
        members: group.members
          .map((member) => {
            const id = idMap.get(memberKey(member))
            return id ? { kind: member.kind, id } : null
          })
          .filter((member): member is NonNullable<typeof member> => member !== null),
      }))
      .filter((group) => group.members.length >= 2),
  }
}

export function importedSavedObjectStampName(
  file: CanopiFile,
  payload: SavedObjectStampPayload,
): string {
  return file.name.trim() || defaultSavedObjectStampName(payload)
}

function stampZonePointsToGeo(
  plane: SessionPlane,
  zone: SavedObjectStampPayload['zones'][number],
): CanopiFile['zones'][number]['points'] {
  return zone.zoneType === 'ellipse' && zone.points.length >= 2
    ? serializeGeoEllipse(plane, zone.points[0]!, zone.points[1]!)
    : zone.points.map((point) => serializeGeoPoint(plane, point))
}

function stampZonePointsFromGeo(plane: SessionPlane, zone: CanopiFile['zones'][number]): ScenePoint[] {
  return zone.zone_type === 'ellipse' && zone.points.length >= 2
    ? hydrateGeoEllipse(plane, [zone.points[0]!, zone.points[1]!])
    : zone.points.map((point) => hydrateGeoPoint(plane, point))
}

function validCapturedGroups(payload: SavedObjectStampPayload): ObjectGroup[] {
  const exportedMembersByPayloadKey = new Map<string, ObjectGroup['members'][number]>([
    ...payload.plants.map((plant) => [
      memberKey({ kind: 'plant', id: plant.id }),
      { kind: 'plant' as const, id: plant.id },
    ] as const),
    ...payload.zones.map((zone) => [
      memberKey({ kind: 'zone', id: zone.id }),
      { kind: 'zone' as const, id: zone.id },
    ] as const),
    ...payload.annotations.map((annotation) => [
      memberKey({ kind: 'annotation', id: annotation.id }),
      { kind: 'annotation' as const, id: annotation.id },
    ] as const),
  ])

  return payload.groups
    .map((group): ObjectGroup => ({
      id: group.id,
      locked: false,
      name: group.name,
      members: group.members
        .map((member) => exportedMembersByPayloadKey.get(memberKey(member)) ?? null)
        .filter((member): member is ObjectGroup['members'][number] => member !== null),
    }))
    .filter((group) => group.members.length >= 2)
}

function memberKey(member: { readonly kind: string; readonly id: string }): string {
  return `${member.kind}:${member.id}`
}

function layerVisible(file: CanopiFile, name: string): boolean {
  return file.layers.find((layer) => layer.name === name)?.visible !== false
}

function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function anchorForPayloadObjects(
  plants: SavedObjectStampPayload['plants'],
  zones: SavedObjectStampPayload['zones'],
  annotations: SavedObjectStampPayload['annotations'],
): ScenePoint {
  const points = [
    ...plants.map((plant) => plant.position),
    ...zones.flatMap(zoneAnchorPoints),
    ...annotations.map((annotation) => annotation.position),
  ]
  if (points.length === 0) return { x: 0, y: 0 }
  const bounds = points.reduce((current, point) => ({
    minX: Math.min(current.minX, point.x),
    minY: Math.min(current.minY, point.y),
    maxX: Math.max(current.maxX, point.x),
    maxY: Math.max(current.maxY, point.y),
  }), {
    minX: points[0]!.x,
    minY: points[0]!.y,
    maxX: points[0]!.x,
    maxY: points[0]!.y,
  })
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  }
}

function zoneAnchorPoints(zone: SavedObjectStampPayload['zones'][number]): ScenePoint[] {
  const bounds = getZoneWorldBounds({
    kind: 'zone',
    id: zone.id,
    name: zone.name,
    locked: false,
    zoneType: zone.zoneType,
    points: zone.points.map((point) => ({ ...point })),
    rotationDeg: zone.rotationDeg,
    fillColor: zone.fillColor,
    notes: null,
  })
  if (!bounds) return []
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ]
}

/**
 * The name a stamp gets when it has none (a saved selection, an imported file with a blank name): its three most
 * frequent plant names, each in the interface language when `localizedNames` has it, else its zone and annotation
 * counts in the locale's plural forms ("1 zone, 0 annotations"; Russian "5 зон"), from the same plural keys as the
 * Saved stamps summary.
 */
export function defaultSavedObjectStampName(
  payload: SavedObjectStampPayload,
  localizedNames: ReadonlyMap<string, string | null> = new Map(),
): string {
  if (payload.plants.length > 0) {
    const counts = new Map<string, { count: number; firstIndex: number }>()
    payload.plants.forEach((plant, index) => {
      const name = localizedNames.get(plant.canonicalName) ?? plant.commonName ?? plant.canonicalName
      const current = counts.get(name)
      counts.set(name, current
        ? { ...current, count: current.count + 1 }
        : { count: 1, firstIndex: index })
    })
    return [...counts.entries()]
      .sort(([, left], [, right]) => right.count - left.count || left.firstIndex - right.firstIndex)
      .slice(0, 3)
      .map(([name]) => name)
      .join(', ')
  }

  return t('savedObjectStamps.defaultNameParts', {
    zones: t('savedObjectStamps.summaryZone', { count: payload.zones.length }),
    annotations: t('savedObjectStamps.summaryAnnotation', { count: payload.annotations.length }),
  })
}
