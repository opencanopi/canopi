// canvas/runtime/scene/codec.ts
// Owner of the CanopiFile serializer (no-canopifile-literal, ADR 0026; §18 F28) until 2b's
// platform/design-core.ts. Invariant: production code builds a CanopiFile only here and in the generated defaults.

import type { GeoPointV10 } from '../../../generated/contracts'

import { allocateSpeciesCodes } from '../species-key'
import type {
  Annotation,
  CanopiFile,
  Layer,
  MeasurementGuide,
  ObjectGroup,
  ObjectGroupMember,
  PlacedPlant,
  Zone,
} from '../../../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../../generated/canopi-design-format'
import { DEFAULT_BUDGET_CURRENCY } from '../../../generated/known-canopi-keys'
import {
  createSessionPlane,
  DEFAULT_NEW_DESIGN_VIEW,
  sessionPlaneOriginForPoints,
  type SessionPlane,
} from '../../../geo/session-plane'
import {
  hydrateGeoEllipse,
  hydrateGeoPoint,
  serializeGeoEllipse,
  serializeGeoPoint,
} from './geo-frame'
import type {
  SceneAnnotationEntity,
  SceneLayerEntity,
  SceneMeasurementGuideEntity,
  SceneObjectGroupEntity,
  ScenePersistedState,
  ScenePlantEntity,
  ScenePreservedGroupMember,
  SceneSessionState,
  SceneZoneEntity,
} from './types'
import {
  cloneSceneDesignObjectTarget,
  normalizeSceneDesignObjectTargets,
} from './design-object-targets'
import { cloneSceneObjectGroupMembers } from './group-members'

export interface SceneSerializeOptions {
  now?: Date
}

export interface SceneHydration {
  readonly persisted: ScenePersistedState
  readonly plane: SessionPlane
}

const LAYER_KNOWN_KEYS = new Set(['name', 'visible', 'locked', 'opacity'])
const PLANT_KNOWN_KEYS = new Set([
  'id', 'locked', 'canonical_name', 'common_name', 'color', 'symbol', 'pinned_name',
  'position', 'rotation', 'canopy_spread_m', 'notes', 'planted_date', 'quantity',
])
const ZONE_KNOWN_KEYS = new Set([
  'id', 'name', 'locked', 'zone_type', 'points', 'rotation', 'fill_color', 'stroke_color', 'opacity', 'notes',
])
const ANNOTATION_KNOWN_KEYS = new Set([
  'id', 'locked', 'annotation_type', 'position', 'text', 'font_size', 'rotation',
])
const GUIDE_KNOWN_KEYS = new Set(['id', 'locked', 'start', 'end'])
const GROUP_KNOWN_KEYS = new Set(['id', 'locked', 'name', 'members'])
const GROUP_MEMBER_KNOWN_KEYS = new Set(['kind', 'id'])

function extractUnknownKeys(
  wire: object,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  let unknown: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(wire)) {
    if (knownKeys.has(key)) continue
    if (!unknown) unknown = {}
    Object.defineProperty(unknown, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
  return unknown
}

function withUnknownFields<T extends object>(
  known: T,
  unknownFields: Record<string, unknown> | undefined,
): T {
  if (!unknownFields) return known
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(unknownFields)) {
    Object.defineProperty(out, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
  return Object.assign(out, known)
}

function cloneUnknownFields(
  unknownFields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!unknownFields) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(unknownFields)) {
    Object.defineProperty(out, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
  return out
}

// Every stored lon/lat of a Design, used to centre its session plane.
export function designGeoPositions(file: CanopiFile): GeoPointV10[] {
  const positions: GeoPointV10[] = []
  for (const plant of file.plants) positions.push(plant.position)
  for (const zone of file.zones) positions.push(...zone.points)
  for (const annotation of file.annotations ?? []) positions.push(annotation.position)
  for (const guide of file.measurement_guides ?? []) positions.push(guide.start, guide.end)
  return positions
}

// Builds the session plane at the centre of the Design's objects (or at
// `emptyOrigin` for a Design without objects) and hydrates plane metres.
export function hydrateSceneFromDesign(
  file: CanopiFile,
  emptyOrigin: GeoPointV10 = DEFAULT_NEW_DESIGN_VIEW,
): SceneHydration {
  const plane = createSessionPlane(sessionPlaneOriginForPoints(designGeoPositions(file), emptyOrigin))
  return { persisted: hydrateScenePersistedStateInFrame(file, plane), plane }
}

export function hydrateScenePersistedStateInFrame(file: CanopiFile, plane: SessionPlane): ScenePersistedState {
  return {
    plantSpeciesColors: { ...file.plant_species_colors },
    plantSpeciesSymbols: { ...(file.plant_species_symbols ?? {}) },
    plantSpeciesCodes: allocateSpeciesCodes(file.plant_species_codes ?? {}, file.plants.map((plant) => plant.canonical_name)),
    layers: file.layers.map(hydrateLayerEntity),
    plants: file.plants.map((plant) => hydratePlantEntity(plant, plane)),
    zones: file.zones.map((zone) => hydrateZoneEntity(zone, plane)),
    annotations: (file.annotations ?? []).map((annotation) => hydrateAnnotationEntity(annotation, plane)),
    measurementGuides: (file.measurement_guides ?? []).map((guide) => hydrateMeasurementGuideEntity(guide, plane)),
    groups: (file.groups ?? []).map(hydrateGroupEntity),
  }
}

export function serializeScenePersistedState(
  state: ScenePersistedState,
  plane: SessionPlane,
  options: SceneSerializeOptions = {},
): CanopiFile {
  const now = options.now ?? new Date()

  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Untitled',
    description: null,
    plant_species_colors: { ...state.plantSpeciesColors },
    plant_species_symbols: { ...state.plantSpeciesSymbols },
    plant_species_codes: { ...state.plantSpeciesCodes },
    layers: state.layers.map(serializeLayerEntity),
    plants: state.plants.map((plant) => serializePlantEntity(plant, plane)),
    zones: state.zones.map((zone) => serializeZoneEntity(zone, plane)),
    annotations: state.annotations.map((annotation) => serializeAnnotationEntity(annotation, plane)),
    measurement_guides: state.measurementGuides.map((guide) => serializeMeasurementGuideEntity(guide, plane)),
    consortiums: [],
    groups: state.groups.map(serializeGroupEntity),
    timeline: [],
    budget: [],
    budget_currency: DEFAULT_BUDGET_CURRENCY,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }
}

export function cloneScenePersistedState(state: ScenePersistedState): ScenePersistedState {
  return {
    ...state,
    plantSpeciesColors: { ...state.plantSpeciesColors },
    plantSpeciesSymbols: { ...state.plantSpeciesSymbols },
    plantSpeciesCodes: { ...state.plantSpeciesCodes },
    layers: state.layers.map(cloneLayerEntity),
    plants: state.plants.map(clonePlantEntity),
    zones: state.zones.map(cloneZoneEntity),
    annotations: state.annotations.map(cloneAnnotationEntity),
    measurementGuides: state.measurementGuides.map(cloneMeasurementGuideEntity),
    groups: state.groups.map(cloneGroupEntity),
  }
}

export function cloneSceneSessionState(state: SceneSessionState): SceneSessionState {
  return {
    ...state,
    selectedTargets: normalizeSceneDesignObjectTargets(state.selectedTargets),
    speciesFocus: { ...state.speciesFocus },
    hoveredTarget: state.hoveredTarget
      ? cloneSceneDesignObjectTarget(state.hoveredTarget)
      : null,
  }
}

function hydrateLayerEntity(layer: Layer): SceneLayerEntity {
  const unknownFields = extractUnknownKeys(layer, LAYER_KNOWN_KEYS)
  return {
    kind: 'layer',
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked ?? false,
    opacity: layer.opacity,
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function serializeLayerEntity(layer: SceneLayerEntity): Layer {
  return withUnknownFields({
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
  }, layer.unknownFields)
}

function cloneLayerEntity(layer: SceneLayerEntity): SceneLayerEntity {
  const unknownFields = cloneUnknownFields(layer.unknownFields)
  return {
    ...layer,
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function hydratePlantEntity(plant: PlacedPlant, plane: SessionPlane): ScenePlantEntity {
  const unknownFields = extractUnknownKeys(plant, PLANT_KNOWN_KEYS)
  return {
    kind: 'plant',
    id: plant.id,
    locked: plant.locked ?? false,
    canonicalName: plant.canonical_name,
    commonName: plant.common_name ?? null,
    color: plant.color ?? null,
    symbol: plant.symbol ?? null,
    pinnedName: plant.pinned_name ?? false,
    canopySpreadM: plant.canopy_spread_m ?? null,
    position: hydrateGeoPoint(plane, plant.position),
    rotationDeg: plant.rotation ?? null,
    notes: plant.notes ?? null,
    plantedDate: plant.planted_date ?? null,
    quantity: plant.quantity ?? null,
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function serializePlantEntity(plant: ScenePlantEntity, plane: SessionPlane): PlacedPlant {
  const serialized: PlacedPlant = {
    id: plant.id,
    locked: plant.locked,
    canonical_name: plant.canonicalName,
    common_name: plant.commonName,
    color: plant.color,
    pinned_name: plant.pinnedName === true,
    position: serializeGeoPoint(plane, plant.position),
    rotation: plant.rotationDeg,
    canopy_spread_m: plant.canopySpreadM,
    notes: plant.notes,
    planted_date: plant.plantedDate,
    quantity: plant.quantity,
  }
  if (plant.symbol != null) {
    serialized.symbol = plant.symbol
  }
  return withUnknownFields(serialized, plant.unknownFields)
}

function clonePlantEntity(plant: ScenePlantEntity): ScenePlantEntity {
  const unknownFields = cloneUnknownFields(plant.unknownFields)
  return {
    ...plant,
    position: { ...plant.position },
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function hydrateZoneEntity(zone: Zone, plane: SessionPlane): SceneZoneEntity {
  const unknownFields = extractUnknownKeys(zone, ZONE_KNOWN_KEYS)
  return {
    kind: 'zone',
    id: zone.id,
    name: zone.name ?? null,
    locked: zone.locked ?? false,
    zoneType: zone.zone_type,
    points: zone.zone_type === 'ellipse' && zone.points.length >= 2
      ? hydrateGeoEllipse(plane, [zone.points[0]!, zone.points[1]!])
      : zone.points.map((point) => hydrateGeoPoint(plane, point)),
    rotationDeg: zone.rotation ?? 0,
    fillColor: zone.fill_color ?? null,
    ...(zone.stroke_color !== undefined ? { strokeColor: zone.stroke_color } : {}),
    ...(zone.opacity !== undefined ? { opacity: zone.opacity } : {}),
    notes: zone.notes ?? null,
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function serializeZoneEntity(zone: SceneZoneEntity, plane: SessionPlane): Zone {
  const serialized: Zone = {
    id: zone.id,
    name: zone.name,
    locked: zone.locked,
    zone_type: zone.zoneType,
    points: zone.zoneType === 'ellipse' && zone.points.length >= 2
      ? serializeGeoEllipse(plane, zone.points[0]!, zone.points[1]!)
      : zone.points.map((point) => serializeGeoPoint(plane, point)),
    rotation: zone.rotationDeg,
    fill_color: zone.fillColor,
    notes: zone.notes,
  }
  if (zone.strokeColor !== undefined) serialized.stroke_color = zone.strokeColor
  if (zone.opacity !== undefined) serialized.opacity = zone.opacity
  return withUnknownFields(serialized, zone.unknownFields)
}

function cloneZoneEntity(zone: SceneZoneEntity): SceneZoneEntity {
  const unknownFields = cloneUnknownFields(zone.unknownFields)
  return {
    ...zone,
    points: zone.points.map(clonePoint),
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function hydrateAnnotationEntity(annotation: Annotation, plane: SessionPlane): SceneAnnotationEntity {
  const unknownFields = extractUnknownKeys(annotation, ANNOTATION_KNOWN_KEYS)
  return {
    kind: 'annotation',
    id: annotation.id,
    locked: annotation.locked ?? false,
    annotationType: annotation.annotation_type,
    position: hydrateGeoPoint(plane, annotation.position),
    text: annotation.text,
    fontSize: annotation.font_size,
    rotationDeg: annotation.rotation ?? null,
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function serializeAnnotationEntity(annotation: SceneAnnotationEntity, plane: SessionPlane): Annotation {
  return withUnknownFields({
    id: annotation.id,
    locked: annotation.locked,
    annotation_type: annotation.annotationType,
    position: serializeGeoPoint(plane, annotation.position),
    text: annotation.text,
    font_size: annotation.fontSize,
    rotation: annotation.rotationDeg,
  }, annotation.unknownFields)
}

function cloneAnnotationEntity(annotation: SceneAnnotationEntity): SceneAnnotationEntity {
  const unknownFields = cloneUnknownFields(annotation.unknownFields)
  return {
    ...annotation,
    position: clonePoint(annotation.position),
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function hydrateMeasurementGuideEntity(
  guide: MeasurementGuide,
  plane: SessionPlane,
): SceneMeasurementGuideEntity {
  const unknownFields = extractUnknownKeys(guide, GUIDE_KNOWN_KEYS)
  return {
    kind: 'measurement-guide',
    id: guide.id,
    locked: guide.locked ?? false,
    start: hydrateGeoPoint(plane, guide.start),
    end: hydrateGeoPoint(plane, guide.end),
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function serializeMeasurementGuideEntity(guide: SceneMeasurementGuideEntity, plane: SessionPlane): MeasurementGuide {
  return withUnknownFields({
    id: guide.id,
    locked: guide.locked,
    start: serializeGeoPoint(plane, guide.start),
    end: serializeGeoPoint(plane, guide.end),
  }, guide.unknownFields)
}

function cloneMeasurementGuideEntity(
  guide: SceneMeasurementGuideEntity,
): SceneMeasurementGuideEntity {
  const unknownFields = cloneUnknownFields(guide.unknownFields)
  return {
    ...guide,
    start: clonePoint(guide.start),
    end: clonePoint(guide.end),
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function isConcreteGroupMemberKind(kind: string): kind is 'plant' | 'zone' | 'annotation' {
  return kind === 'plant' || kind === 'zone' || kind === 'annotation'
}

function memberKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

function hydrateGroupEntity(group: ObjectGroup): SceneObjectGroupEntity {
  const unknownFields = extractUnknownKeys(group, GROUP_KNOWN_KEYS)
  const concreteMembers: SceneObjectGroupEntity['members'] = []
  const wireMembers: ScenePreservedGroupMember[] = []
  let needsWireMembers = false
  for (const member of group.members) {
    const memberUnknown = extractUnknownKeys(member, GROUP_MEMBER_KNOWN_KEYS)
    wireMembers.push({
      kind: member.kind,
      id: member.id,
      ...(memberUnknown !== undefined ? { unknownFields: memberUnknown } : {}),
    })
    if (isConcreteGroupMemberKind(member.kind)) {
      concreteMembers.push({ kind: member.kind, id: member.id })
      if (memberUnknown !== undefined) needsWireMembers = true
    } else {
      needsWireMembers = true
    }
  }
  return {
    kind: 'group',
    id: group.id,
    locked: group.locked ?? false,
    name: group.name ?? null,
    members: concreteMembers,
    ...(needsWireMembers ? { wireMembers } : {}),
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function serializeGroupEntity(group: SceneObjectGroupEntity): ObjectGroup {
  const members: ObjectGroupMember[] = []
  if (group.wireMembers && group.wireMembers.length > 0) {
    const activeConcrete = new Set(group.members.map((m) => memberKey(m.kind, m.id)))
    const emittedConcrete = new Set<string>()
    for (const wire of group.wireMembers) {
      if (isConcreteGroupMemberKind(wire.kind)) {
        const key = memberKey(wire.kind, wire.id)
        if (!activeConcrete.has(key)) continue
        emittedConcrete.add(key)
      }
      members.push(
        withUnknownFields({ kind: wire.kind, id: wire.id } as ObjectGroupMember, wire.unknownFields),
      )
    }
    for (const member of group.members) {
      const key = memberKey(member.kind, member.id)
      if (!emittedConcrete.has(key)) {
        members.push({ kind: member.kind, id: member.id })
      }
    }
  } else {
    members.push(...cloneSceneObjectGroupMembers(group.members))
  }
  return withUnknownFields({
    id: group.id,
    locked: group.locked,
    name: group.name,
    members,
  }, group.unknownFields)
}

function cloneGroupEntity(group: SceneObjectGroupEntity): SceneObjectGroupEntity {
  const unknownFields = cloneUnknownFields(group.unknownFields)
  return {
    ...group,
    members: cloneSceneObjectGroupMembers(group.members),
    ...(group.wireMembers
      ? {
          wireMembers: group.wireMembers.map((member) => {
            const memberUnknown = cloneUnknownFields(member.unknownFields)
            return {
              kind: member.kind,
              id: member.id,
              ...(memberUnknown !== undefined ? { unknownFields: memberUnknown } : {}),
            }
          }),
        }
      : {}),
    ...(unknownFields !== undefined ? { unknownFields } : {}),
  }
}

function clonePoint(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: point.x,
    y: point.y,
  }
}
