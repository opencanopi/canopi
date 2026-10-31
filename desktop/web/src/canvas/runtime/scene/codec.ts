// canvas/runtime/scene/codec.ts
// Owner of the CanopiFile serializer (no-canopifile-literal, ADR 0026; §18 F28) until 2b's
// platform/design-core.ts. Invariant: production code builds a CanopiFile only here and in the generated defaults.

import { allocateSpeciesCodes } from '../species-key'
import type {
  Annotation,
  CanopiFile,
  Layer,
  MeasurementGuide,
  ObjectGroup,
  PlacedPlant,
  Zone,
} from '../../../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../../generated/canopi-design-format'
import { DEFAULT_BUDGET_CURRENCY } from '../../../generated/known-canopi-keys'
import {
  createSessionPlane,
  DEFAULT_NEW_DESIGN_VIEW,
  sessionPlaneOriginForPoints,
  type GeoPosition,
  type SessionPlane,
} from '../../session-plane'
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

// Every stored lon/lat of a Design, used to centre its session plane.
export function designGeoPositions(file: CanopiFile): GeoPosition[] {
  const positions: GeoPosition[] = []
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
  emptyOrigin: GeoPosition = DEFAULT_NEW_DESIGN_VIEW,
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
  return {
    kind: 'layer',
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
  }
}

function serializeLayerEntity(layer: SceneLayerEntity): Layer {
  return {
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
  }
}

function cloneLayerEntity(layer: SceneLayerEntity): SceneLayerEntity {
  return {
    ...layer,
  }
}

function hydratePlantEntity(plant: PlacedPlant, plane: SessionPlane): ScenePlantEntity {
  return {
    kind: 'plant',
    id: plant.id,
    locked: plant.locked ?? false,
    canonicalName: plant.canonical_name,
    commonName: plant.common_name,
    color: plant.color,
    symbol: plant.symbol ?? null,
    pinnedName: plant.pinned_name ?? false,
    canopySpreadM: plant.scale,
    position: hydrateGeoPoint(plane, plant.position),
    rotationDeg: plant.rotation,
    notes: plant.notes,
    plantedDate: plant.planted_date,
    quantity: plant.quantity,
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
    // The file's `scale` field is the plant's canopy spread in metres.
    scale: plant.canopySpreadM,
    notes: plant.notes,
    planted_date: plant.plantedDate,
    quantity: plant.quantity,
  }
  if (plant.symbol != null) {
    serialized.symbol = plant.symbol
  }
  return serialized
}

function clonePlantEntity(plant: ScenePlantEntity): ScenePlantEntity {
  return {
    ...plant,
    position: { ...plant.position },
  }
}

function hydrateZoneEntity(zone: Zone, plane: SessionPlane): SceneZoneEntity {
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
    fillColor: zone.fill_color,
    notes: zone.notes,
  }
}

function serializeZoneEntity(zone: SceneZoneEntity, plane: SessionPlane): Zone {
  return {
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
}

function cloneZoneEntity(zone: SceneZoneEntity): SceneZoneEntity {
  return {
    ...zone,
    points: zone.points.map(clonePoint),
  }
}

function hydrateAnnotationEntity(annotation: Annotation, plane: SessionPlane): SceneAnnotationEntity {
  return {
    kind: 'annotation',
    id: annotation.id,
    locked: annotation.locked ?? false,
    annotationType: annotation.annotation_type,
    position: hydrateGeoPoint(plane, annotation.position),
    text: annotation.text,
    fontSize: annotation.font_size,
    rotationDeg: annotation.rotation,
  }
}

function serializeAnnotationEntity(annotation: SceneAnnotationEntity, plane: SessionPlane): Annotation {
  return {
    id: annotation.id,
    locked: annotation.locked,
    annotation_type: annotation.annotationType,
    position: serializeGeoPoint(plane, annotation.position),
    text: annotation.text,
    font_size: annotation.fontSize,
    rotation: annotation.rotationDeg,
  }
}

function cloneAnnotationEntity(annotation: SceneAnnotationEntity): SceneAnnotationEntity {
  return {
    ...annotation,
    position: clonePoint(annotation.position),
  }
}

function hydrateMeasurementGuideEntity(
  guide: MeasurementGuide,
  plane: SessionPlane,
): SceneMeasurementGuideEntity {
  return {
    kind: 'measurement-guide',
    id: guide.id,
    locked: guide.locked ?? false,
    start: hydrateGeoPoint(plane, guide.start),
    end: hydrateGeoPoint(plane, guide.end),
  }
}

function serializeMeasurementGuideEntity(guide: SceneMeasurementGuideEntity, plane: SessionPlane): MeasurementGuide {
  return {
    id: guide.id,
    locked: guide.locked,
    start: serializeGeoPoint(plane, guide.start),
    end: serializeGeoPoint(plane, guide.end),
  }
}

function cloneMeasurementGuideEntity(
  guide: SceneMeasurementGuideEntity,
): SceneMeasurementGuideEntity {
  return {
    ...guide,
    start: clonePoint(guide.start),
    end: clonePoint(guide.end),
  }
}

function hydrateGroupEntity(group: ObjectGroup): SceneObjectGroupEntity {
  return {
    kind: 'group',
    id: group.id,
    locked: group.locked ?? false,
    name: group.name,
    members: cloneSceneObjectGroupMembers(group.members),
  }
}

function serializeGroupEntity(group: SceneObjectGroupEntity): ObjectGroup {
  return {
    id: group.id,
    locked: group.locked,
    name: group.name,
    members: cloneSceneObjectGroupMembers(group.members),
  }
}

function cloneGroupEntity(group: SceneObjectGroupEntity): SceneObjectGroupEntity {
  return {
    ...group,
    members: cloneSceneObjectGroupMembers(group.members),
  }
}

function clonePoint(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: point.x,
    y: point.y,
  }
}
