import {
  parseSavedObjectStampPayload,
  type SavedObjectStampPlant,
  type SavedObjectStampZone,
} from '../../canvas/saved-object-stamp-payload'
import {
  getZoneOutlinePoints,
  isZoneClosed,
  polygonArea,
} from '../../canvas/runtime/zone-geometry'
import type { ScenePoint, SceneZoneEntity } from '../../canvas/runtime/scene'

export const SAVED_OBJECT_STAMP_THUMBNAIL_WIDTH = 180
export const SAVED_OBJECT_STAMP_THUMBNAIL_HEIGHT = 150

const DEFAULT_PADDING_PX = 14
const DEFAULT_MAX_ZONES = 3
const DEFAULT_MAX_PLANT_MARKS = 24
const DEFAULT_MAX_ANNOTATIONS = 4

export interface SavedObjectStampThumbnailOptions {
  readonly width?: number
  readonly height?: number
  readonly padding?: number
  readonly maxZones?: number
  readonly maxPlantMarks?: number
  readonly maxAnnotations?: number
}

export interface SavedObjectStampThumbnailSignature {
  readonly width: number
  readonly height: number
  readonly fallback: boolean
  readonly zones: readonly SavedObjectStampThumbnailZone[]
  readonly plants: readonly SavedObjectStampThumbnailPlant[]
  readonly annotations: readonly SavedObjectStampThumbnailAnnotation[]
}

interface SavedObjectStampThumbnailZone {
  readonly points: readonly ScenePoint[]
  readonly closed: boolean
  readonly fillColor: string | null
}

interface SavedObjectStampThumbnailPlant {
  readonly x: number
  readonly y: number
  readonly radius: number
  readonly color: string | null
  readonly symbol: string | null
  readonly count: number
  readonly cluster: boolean
}

interface SavedObjectStampThumbnailAnnotation {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

interface ResolvedThumbnailOptions {
  readonly width: number
  readonly height: number
  readonly padding: number
  readonly maxZones: number
  readonly maxPlantMarks: number
  readonly maxAnnotations: number
}

interface ZoneCandidate {
  readonly zone: SavedObjectStampZone
  readonly points: readonly ScenePoint[]
  readonly area: number
  readonly closed: boolean
}

interface PlantCandidate {
  readonly plant: SavedObjectStampPlant
  readonly position: ScenePoint
}

interface PlantCell {
  readonly row: number
  readonly column: number
  readonly plants: PlantCandidate[]
}

export function createSavedObjectStampThumbnailSignature(
  payloadJson: string,
  options: SavedObjectStampThumbnailOptions = {},
): SavedObjectStampThumbnailSignature {
  const resolved = resolveThumbnailOptions(options)
  const payload = parseSavedObjectStampPayload(payloadJson)
  if (!payload) return fallbackSignature(resolved)

  const zoneCandidates = payload.zones
    .map(zoneCandidate)
    .filter((zone): zone is ZoneCandidate => zone !== null)
  const plants = payload.plants
    .filter((plant): plant is SavedObjectStampPlant & { position: ScenePoint } => isFinitePoint(plant.position))
    .map((plant) => ({ plant, position: plant.position }))
  const annotations = payload.annotations.filter((annotation) => isFinitePoint(annotation.position))
  const worldPoints = [
    ...zoneCandidates.flatMap((zone) => zone.points),
    ...plants.map((plant) => plant.position),
    ...annotations.map((annotation) => annotation.position),
  ]

  if (worldPoints.length === 0) return fallbackSignature(resolved)

  const project = createProjector(worldPoints, resolved)

  return {
    width: resolved.width,
    height: resolved.height,
    fallback: false,
    zones: zoneCandidates
      .slice()
      .sort((left, right) => right.area - left.area)
      .slice(0, resolved.maxZones)
      .map((candidate) => ({
        points: candidate.points.map(project),
        closed: candidate.closed,
        fillColor: candidate.zone.fillColor,
      })),
    plants: plantMarks(plants, project, resolved),
    annotations: annotations
      .slice(0, resolved.maxAnnotations)
      .map((annotation) => annotationStroke(project(annotation.position), annotation.rotationDeg ?? 0)),
  }
}

function resolveThumbnailOptions(options: SavedObjectStampThumbnailOptions): ResolvedThumbnailOptions {
  const width = positiveNumberOr(options.width, SAVED_OBJECT_STAMP_THUMBNAIL_WIDTH)
  const height = positiveNumberOr(options.height, SAVED_OBJECT_STAMP_THUMBNAIL_HEIGHT)
  return {
    width,
    height,
    padding: Math.min(
      Math.max(0, positiveNumberOr(options.padding, DEFAULT_PADDING_PX)),
      Math.floor(Math.min(width, height) / 2),
    ),
    maxZones: positiveIntegerOr(options.maxZones, DEFAULT_MAX_ZONES),
    maxPlantMarks: positiveIntegerOr(options.maxPlantMarks, DEFAULT_MAX_PLANT_MARKS),
    maxAnnotations: positiveIntegerOr(options.maxAnnotations, DEFAULT_MAX_ANNOTATIONS),
  }
}

function fallbackSignature(options: ResolvedThumbnailOptions): SavedObjectStampThumbnailSignature {
  return {
    width: options.width,
    height: options.height,
    fallback: true,
    zones: [],
    plants: [],
    annotations: [],
  }
}

function zoneCandidate(zone: SavedObjectStampZone): ZoneCandidate | null {
  const points = zonePreviewPoints(zone).filter(isFinitePoint)
  if (points.length < 2) return null

  return {
    zone,
    points,
    area: Math.abs(polygonArea(points)),
    closed: isZoneClosed(zone),
  }
}

function zonePreviewPoints(zone: SavedObjectStampZone): readonly ScenePoint[] {
  return getZoneOutlinePoints(sceneZoneFromSavedZone(zone), 18)
}

function sceneZoneFromSavedZone(zone: SavedObjectStampZone): SceneZoneEntity {
  return {
    kind: 'zone',
    id: zone.id,
    name: zone.name,
    locked: false,
    zoneType: zone.zoneType,
    points: zone.points.map((point) => ({ ...point })),
    rotationDeg: zone.rotationDeg,
    fillColor: zone.fillColor,
    notes: null,
  }
}

function plantMarks(
  plants: readonly PlantCandidate[],
  project: (point: ScenePoint) => ScenePoint,
  options: ResolvedThumbnailOptions,
): readonly SavedObjectStampThumbnailPlant[] {
  if (plants.length <= options.maxPlantMarks) {
    return plants.map(({ plant, position }) => plantMark(plant, project(position), 1))
  }

  return clusterPlantMarks(plants, project, options)
}

function plantMark(
  plant: Pick<SavedObjectStampPlant, 'color' | 'symbol'>,
  point: ScenePoint,
  count: number,
): SavedObjectStampThumbnailPlant {
  return {
    x: point.x,
    y: point.y,
    radius: count === 1 ? 4 : roundMetric(Math.min(7, 3.6 + Math.log2(count) * 0.8)),
    color: plant.color,
    symbol: plant.symbol ?? null,
    count,
    cluster: count > 1,
  }
}

function clusterPlantMarks(
  plants: readonly PlantCandidate[],
  project: (point: ScenePoint) => ScenePoint,
  options: ResolvedThumbnailOptions,
): readonly SavedObjectStampThumbnailPlant[] {
  const bounds = boundsForPoints(plants.map((plant) => plant.position))
  const { columns, rows } = plantGrid(bounds, options.maxPlantMarks)
  const cells = new Map<string, PlantCell>()

  for (const plant of plants) {
    const column = clampIndex(
      Math.floor(((plant.position.x - bounds.minX) / Math.max(bounds.width, 1)) * columns),
      columns,
    )
    const row = clampIndex(
      Math.floor(((plant.position.y - bounds.minY) / Math.max(bounds.height, 1)) * rows),
      rows,
    )
    const key = `${row}:${column}`
    const existing = cells.get(key)
    if (existing) {
      existing.plants.push(plant)
    } else {
      cells.set(key, { row, column, plants: [plant] })
    }
  }

  return [...cells.values()]
    .sort((left, right) => left.row - right.row || left.column - right.column)
    .map((cell) => {
      const dominant = dominantPlantIdentity(cell.plants)
      const point = project(averagePoint(dominant.members.map((plant) => plant.position)))
      return plantMark(dominant.plant.plant, point, cell.plants.length)
    })
}

function plantGrid(
  bounds: ReturnType<typeof boundsForPoints>,
  maxPlantMarks: number,
): { columns: number, rows: number } {
  const aspect = Math.max(0.25, Math.min(4, bounds.width / Math.max(bounds.height, 1)))
  let columns = Math.max(1, Math.min(maxPlantMarks, Math.round(Math.sqrt(maxPlantMarks * aspect))))
  let rows = Math.max(1, Math.ceil(maxPlantMarks / columns))

  while (columns * rows > maxPlantMarks) {
    if (columns >= rows) columns -= 1
    else rows -= 1
  }

  return { columns: Math.max(1, columns), rows: Math.max(1, rows) }
}

function dominantPlantIdentity(plants: readonly PlantCandidate[]): {
  readonly plant: PlantCandidate
  readonly members: readonly PlantCandidate[]
} {
  const groups = new Map<string, PlantCandidate[]>()
  for (const plant of plants) {
    const key = `${plant.plant.color ?? ''}|${plant.plant.symbol ?? ''}|${plant.plant.canonicalName}`
    const group = groups.get(key)
    if (group) group.push(plant)
    else groups.set(key, [plant])
  }

  const dominant = [...groups.values()]
    .sort((left, right) => right.length - left.length)[0]
  const members = dominant && dominant.length > 0 ? dominant : plants
  return {
    plant: members[0]!,
    members,
  }
}

function annotationStroke(center: ScenePoint, rotationDeg: number): SavedObjectStampThumbnailAnnotation {
  const halfLength = 10
  const radians = (rotationDeg * Math.PI) / 180
  const dx = Math.cos(radians) * halfLength
  const dy = Math.sin(radians) * halfLength
  return {
    x1: roundMetric(center.x - dx),
    y1: roundMetric(center.y - dy),
    x2: roundMetric(center.x + dx),
    y2: roundMetric(center.y + dy),
  }
}

function createProjector(
  points: readonly ScenePoint[],
  options: ResolvedThumbnailOptions,
): (point: ScenePoint) => ScenePoint {
  const bounds = boundsForPoints(points)
  const availableWidth = Math.max(1, options.width - options.padding * 2)
  const availableHeight = Math.max(1, options.height - options.padding * 2)
  const scale = Math.min(
    availableWidth / Math.max(bounds.width, 1),
    availableHeight / Math.max(bounds.height, 1),
  )
  const offsetX = (options.width - bounds.width * scale) / 2
  const offsetY = (options.height - bounds.height * scale) / 2

  return (point: ScenePoint) => ({
    x: roundMetric(offsetX + (point.x - bounds.minX) * scale),
    y: roundMetric(offsetY + (point.y - bounds.minY) * scale),
  })
}

function boundsForPoints(points: readonly ScenePoint[]): {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  readonly width: number
  readonly height: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function averagePoint(points: readonly ScenePoint[]): ScenePoint {
  const total = points.reduce((sum, point) => ({
    x: sum.x + point.x,
    y: sum.y + point.y,
  }), { x: 0, y: 0 })
  return {
    x: total.x / points.length,
    y: total.y / points.length,
  }
}

function isFinitePoint(point: ScenePoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function clampIndex(index: number, size: number): number {
  return Math.max(0, Math.min(size - 1, index))
}

function positiveNumberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10
}
