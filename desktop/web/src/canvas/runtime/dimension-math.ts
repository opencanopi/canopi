// canvas/runtime/dimension-math.ts
// Pure true-ground dimension readers and writers for Edit dimensions (2.1-Q149, 2.1-Q153, 2.1-Q160, 2.1-Q353).
// Every length goes through SessionPlane.groundLength and every centre through SessionPlane.toGeoPoint / toPlane;
// polygons expose side lengths, interior angles, and centre lat/lon only (no per-vertex coordinates, no target area).

import type { GeoPoint } from '../../types/design'
import type { SessionPlane } from '../../geo/session-plane'
import {
  buildFramedZonePoints,
  getZoneAxisFrame,
  getZoneOutlinePoints,
  getZoneWorldBounds,
  isFramedZone,
  isLineZone,
  isPolygonZone,
} from './zone-geometry'
import type {
  SceneMeasurementGuideEntity,
  ScenePersistedState,
  ScenePoint,
  SceneZoneEntity,
} from './scene'

export interface RectEllipseDimensions {
  readonly widthM: number
  readonly heightM: number
  readonly rotationDeg: number
  readonly center: GeoPoint
}

export interface LineDimensions {
  readonly lengthM: number
  readonly angleDeg: number
  readonly center: GeoPoint
}

export interface PolygonDimensions {
  readonly sideLengthsM: readonly number[]
  readonly interiorAnglesDeg: readonly number[]
  readonly center: GeoPoint
}

export interface ZoneDimensionEdit {
  readonly widthM?: number
  readonly heightM?: number
  readonly lengthM?: number
  readonly rotationDeg?: number
  readonly angleDeg?: number
  readonly center?: GeoPoint
  readonly sideIndex?: number
  readonly sideLengthM?: number
  readonly cornerIndex?: number
  readonly cornerAngleDeg?: number
}

export interface GuideDimensionEdit {
  readonly lengthM?: number
  readonly angleDeg?: number
  readonly center?: GeoPoint
}

function directionalGroundFactor(plane: SessionPlane, origin: ScenePoint, ux: number, uy: number): number {
  const probe: ScenePoint = { x: origin.x + ux, y: origin.y + uy }
  const g = plane.groundLength(origin, probe)
  return g > 1e-9 ? g : 1
}

function normalizeDeg(deg: number): number {
  const m = ((deg % 360) + 360) % 360
  return Math.abs(m - 360) < 1e-9 ? 0 : m
}

export function readRectOrEllipseDimensions(
  zone: SceneZoneEntity,
  plane: SessionPlane,
): RectEllipseDimensions | null {
  if (!isFramedZone(zone)) return null
  const frame = getZoneAxisFrame(zone)
  if (!frame) return null
  const { center, halfWidth, halfHeight, rotationDeg } = frame
  const rad = (rotationDeg * Math.PI) / 180
  const ux = Math.cos(rad)
  const uy = Math.sin(rad)
  const vx = -uy
  const vy = ux
  const pLeft: ScenePoint = { x: center.x - ux * halfWidth, y: center.y - uy * halfWidth }
  const pRight: ScenePoint = { x: center.x + ux * halfWidth, y: center.y + uy * halfWidth }
  const pTop: ScenePoint = { x: center.x - vx * halfHeight, y: center.y - vy * halfHeight }
  const pBottom: ScenePoint = { x: center.x + vx * halfHeight, y: center.y + vy * halfHeight }
  return {
    widthM: plane.groundLength(pLeft, pRight),
    heightM: plane.groundLength(pTop, pBottom),
    rotationDeg: normalizeDeg(rotationDeg),
    center: plane.toGeoPoint(center),
  }
}

function applyRectOrEllipseDimensions(
  zone: SceneZoneEntity,
  edit: ZoneDimensionEdit,
  plane: SessionPlane,
): SceneZoneEntity | null {
  const current = readRectOrEllipseDimensions(zone, plane)
  const frame = getZoneAxisFrame(zone)
  if (!current || !frame) return null

  const nextWidthM = edit.widthM !== undefined && Number.isFinite(edit.widthM) && edit.widthM > 0 ? edit.widthM : current.widthM
  const nextHeightM = edit.heightM !== undefined && Number.isFinite(edit.heightM) && edit.heightM > 0 ? edit.heightM : current.heightM
  const nextRotationDeg = edit.rotationDeg !== undefined && Number.isFinite(edit.rotationDeg) ? normalizeDeg(edit.rotationDeg) : current.rotationDeg
  const nextCenter: ScenePoint = edit.center ? plane.toPlane(edit.center) : frame.center

  const rad = (nextRotationDeg * Math.PI) / 180
  const ux = Math.cos(rad)
  const uy = Math.sin(rad)
  const halfW = nextWidthM / (2 * directionalGroundFactor(plane, nextCenter, ux, uy))
  const halfH = nextHeightM / (2 * directionalGroundFactor(plane, nextCenter, -uy, ux))
  const points = buildFramedZonePoints(zone, nextCenter, halfW, halfH)
  if (!points) return null
  return { ...zone, points, rotationDeg: nextRotationDeg }
}

export function readSegmentDimensions(
  start: ScenePoint,
  end: ScenePoint,
  plane: SessionPlane,
): LineDimensions {
  const center: ScenePoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const angleDeg = normalizeDeg((Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI)
  return {
    lengthM: plane.groundLength(start, end),
    angleDeg,
    center: plane.toGeoPoint(center),
  }
}

function applySegmentDimensions(
  start: ScenePoint,
  end: ScenePoint,
  edit: GuideDimensionEdit,
  plane: SessionPlane,
): readonly [ScenePoint, ScenePoint] {
  const current = readSegmentDimensions(start, end, plane)
  const nextLengthM = edit.lengthM !== undefined && Number.isFinite(edit.lengthM) && edit.lengthM > 0 ? edit.lengthM : current.lengthM
  const nextAngleDeg = edit.angleDeg !== undefined && Number.isFinite(edit.angleDeg) ? normalizeDeg(edit.angleDeg) : current.angleDeg
  const nextCenter: ScenePoint = edit.center ? plane.toPlane(edit.center) : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }

  const rad = (nextAngleDeg * Math.PI) / 180
  const ux = Math.cos(rad)
  const uy = Math.sin(rad)
  const half = nextLengthM / (2 * directionalGroundFactor(plane, nextCenter, ux, uy))
  return [
    { x: nextCenter.x - ux * half, y: nextCenter.y - uy * half },
    { x: nextCenter.x + ux * half, y: nextCenter.y + uy * half },
  ]
}

export function readPolygonDimensions(
  zone: SceneZoneEntity,
  plane: SessionPlane,
): PolygonDimensions | null {
  if (!isPolygonZone(zone)) return null
  const pts = getZoneOutlinePoints(zone)
  if (pts.length < 3) return null
  const n = pts.length
  const sideLengthsM: number[] = []
  const interiorAnglesDeg: number[] = []
  let sumX = 0
  let sumY = 0
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n]!
    const curr = pts[i]!
    const next = pts[(i + 1) % n]!
    sumX += curr.x
    sumY += curr.y
    sideLengthsM.push(plane.groundLength(curr, next))
    const ax = prev.x - curr.x
    const ay = prev.y - curr.y
    const bx = next.x - curr.x
    const by = next.y - curr.y
    const mag = Math.hypot(ax, ay) * Math.hypot(bx, by)
    const cos = mag > 1e-12 ? Math.max(-1, Math.min(1, (ax * bx + ay * by) / mag)) : 1
    interiorAnglesDeg.push((Math.acos(cos) * 180) / Math.PI)
  }
  const bounds = getZoneWorldBounds(zone)
  const centerPlane: ScenePoint = bounds
    ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    : { x: sumX / n, y: sumY / n }
  return { sideLengthsM, interiorAnglesDeg, center: plane.toGeoPoint(centerPlane) }
}

function applyPolygonDimensions(
  zone: SceneZoneEntity,
  edit: ZoneDimensionEdit,
  plane: SessionPlane,
): SceneZoneEntity | null {
  if (!isPolygonZone(zone)) return null
  const pts = zone.points.map((p) => ({ x: p.x, y: p.y }))
  const n = pts.length
  if (n < 3) return null

  if (edit.center) {
    const current = readPolygonDimensions(zone, plane)
    if (!current) return null
    const oldCenter = plane.toPlane(current.center)
    const newCenter = plane.toPlane(edit.center)
    const dx = newCenter.x - oldCenter.x
    const dy = newCenter.y - oldCenter.y
    return { ...zone, points: pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
  }

  if (edit.sideIndex !== undefined && edit.sideIndex >= 0 && edit.sideIndex < n && edit.sideLengthM !== undefined && Number.isFinite(edit.sideLengthM) && edit.sideLengthM > 0) {
    const a = pts[edit.sideIndex]!
    const nextIdx = (edit.sideIndex + 1) % n
    const b = pts[nextIdx]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1e-9) return null
    const ux = (b.x - a.x) / len
    const uy = (b.y - a.y) / len
    const planeLen = edit.sideLengthM / directionalGroundFactor(plane, a, ux, uy)
    pts[nextIdx] = { x: a.x + ux * planeLen, y: a.y + uy * planeLen }
    return { ...zone, points: pts }
  }

  if (edit.cornerIndex !== undefined && edit.cornerIndex >= 0 && edit.cornerIndex < n && edit.cornerAngleDeg !== undefined && Number.isFinite(edit.cornerAngleDeg) && edit.cornerAngleDeg > 1 && edit.cornerAngleDeg < 179) {
    const prev = pts[(edit.cornerIndex - 1 + n) % n]!
    const curr = pts[edit.cornerIndex]!
    const nextIdx = (edit.cornerIndex + 1) % n
    const next = pts[nextIdx]!
    const inAngle = Math.atan2(prev.y - curr.y, prev.x - curr.x)
    const cross = (prev.x - curr.x) * (next.y - curr.y) - (prev.y - curr.y) * (next.x - curr.x)
    const targetOut = inAngle + (cross >= 0 ? 1 : -1) * ((edit.cornerAngleDeg * Math.PI) / 180)
    const ux = Math.cos(targetOut)
    const uy = Math.sin(targetOut)
    const planeLen = plane.groundLength(curr, next) / directionalGroundFactor(plane, curr, ux, uy)
    pts[nextIdx] = { x: curr.x + ux * planeLen, y: curr.y + uy * planeLen }
    return { ...zone, points: pts }
  }

  return null
}

function applyZoneDimensionEdit(
  zone: SceneZoneEntity,
  edit: ZoneDimensionEdit,
  plane: SessionPlane,
): SceneZoneEntity | null {
  if (isFramedZone(zone)) return applyRectOrEllipseDimensions(zone, edit, plane)
  if (isLineZone(zone) && zone.points.length >= 2) {
    const [start, end] = applySegmentDimensions(zone.points[0]!, zone.points[zone.points.length - 1]!, edit, plane)
    return { ...zone, points: [start, end] }
  }
  if (isPolygonZone(zone)) return applyPolygonDimensions(zone, edit, plane)
  return null
}

function applyGuideDimensionEdit(
  guide: SceneMeasurementGuideEntity,
  edit: GuideDimensionEdit,
  plane: SessionPlane,
): SceneMeasurementGuideEntity {
  const [start, end] = applySegmentDimensions(guide.start, guide.end, edit, plane)
  return { ...guide, start, end }
}

export interface ZoneStyleEdit {
  readonly fillColor?: string | null
  readonly strokeColor?: string | null
  readonly opacity?: number | null
}

export interface PlantFieldEdit {
  readonly canopySpreadM?: number
  readonly notes?: string | null
  readonly plantedDate?: string | null
  readonly quantity?: number
}

export interface PlantSpeciesReplacement {
  readonly canonicalName: string
  readonly commonName?: string | null
  /** Optional mature canopy spread in metres from the species catalog; omitted/null/<=0 when sparse. */
  readonly canopySpreadM?: number | null
  /** When true and `canopySpreadM` is finite & > 0, adopt the replacement species' spread; otherwise keep existing spread. */
  readonly adoptSpeciesSpread?: boolean
}

export interface AnnotationFieldEdit {
  readonly text?: string
  readonly fontSize?: number
}

export function prepareSetZoneStyle(
  persisted: ScenePersistedState,
  zoneId: string,
  style: ZoneStyleEdit,
): ((draft: ScenePersistedState) => void) | null {
  const zone = persisted.zones.find((c) => c.id === zoneId)
  if (!zone) return null
  const fillColor = style.fillColor !== undefined ? style.fillColor : zone.fillColor
  const strokeColor = style.strokeColor !== undefined ? style.strokeColor : (zone.strokeColor ?? null)
  const opacity = style.opacity !== undefined
    ? (style.opacity === null ? null : Math.min(1, Math.max(0, style.opacity)))
    : (zone.opacity ?? null)
  if (fillColor === zone.fillColor && strokeColor === (zone.strokeColor ?? null) && opacity === (zone.opacity ?? null)) return null
  return (draft) => {
    draft.zones = draft.zones.map((c) => c.id === zoneId ? { ...c, fillColor, strokeColor, opacity } : c)
  }
}

export function prepareEditZoneDimensions(
  persisted: ScenePersistedState,
  plane: SessionPlane,
  zoneId: string,
  edit: ZoneDimensionEdit,
): ((draft: ScenePersistedState) => void) | null {
  const zone = persisted.zones.find((c) => c.id === zoneId)
  if (!zone) return null
  const updated = applyZoneDimensionEdit(zone, edit, plane)
  if (!updated) return null
  return (draft) => {
    draft.zones = draft.zones.map((c) => c.id === zoneId ? updated : c)
  }
}

export function prepareEditGuideDimensions(
  persisted: ScenePersistedState,
  plane: SessionPlane,
  guideId: string,
  edit: GuideDimensionEdit,
): ((draft: ScenePersistedState) => void) | null {
  const guide = persisted.measurementGuides.find((c) => c.id === guideId)
  if (!guide) return null
  const updated = applyGuideDimensionEdit(guide, edit, plane)
  return (draft) => {
    draft.measurementGuides = draft.measurementGuides.map((c) => c.id === guideId ? updated : c)
  }
}

export function prepareEditPlantFields(
  persisted: ScenePersistedState,
  plantId: string,
  edit: PlantFieldEdit,
): ((draft: ScenePersistedState) => void) | null {
  const plant = persisted.plants.find((c) => c.id === plantId)
  if (!plant) return null
  const canopySpreadM = edit.canopySpreadM !== undefined && Number.isFinite(edit.canopySpreadM) && edit.canopySpreadM > 0
    ? edit.canopySpreadM : plant.canopySpreadM
  const notes = edit.notes !== undefined ? edit.notes : plant.notes
  const plantedDate = edit.plantedDate !== undefined ? edit.plantedDate : plant.plantedDate
  const quantity = edit.quantity !== undefined && Number.isInteger(edit.quantity) && edit.quantity >= 1
    ? edit.quantity : plant.quantity
  if (canopySpreadM === plant.canopySpreadM && notes === plant.notes && plantedDate === plant.plantedDate && quantity === plant.quantity) return null
  return (draft) => {
    draft.plants = draft.plants.map((c) => c.id === plantId ? { ...c, canopySpreadM, notes, plantedDate, quantity } : c)
  }
}

export function prepareEditAnnotationFields(
  persisted: ScenePersistedState,
  annotationId: string,
  edit: AnnotationFieldEdit,
): ((draft: ScenePersistedState) => void) | null {
  const note = persisted.annotations.find((c) => c.id === annotationId)
  if (!note) return null
  const text = edit.text !== undefined ? edit.text : note.text
  const fontSize = edit.fontSize !== undefined && Number.isFinite(edit.fontSize) && edit.fontSize >= 8 && edit.fontSize <= 96
    ? edit.fontSize : note.fontSize
  if (text === note.text && fontSize === note.fontSize) return null
  return (draft) => {
    draft.annotations = draft.annotations.map((c) => c.id === annotationId ? { ...c, text, fontSize } : c)
  }
}

export function prepareReplacePlantsSpecies(
  persisted: ScenePersistedState,
  plantIds: readonly string[],
  replacement: PlantSpeciesReplacement,
): ((draft: ScenePersistedState) => void) | null {
  const canonicalName = replacement.canonicalName.trim()
  if (!canonicalName || plantIds.length === 0) return null
  const targetIds = new Set(plantIds)
  const lockedGroupPlantIds = new Set<string>()
  for (const group of persisted.groups) {
    if (!group.locked) continue
    for (const member of group.members) {
      if (member.kind === 'plant') lockedGroupPlantIds.add(member.id)
    }
  }
  const commonName = replacement.commonName?.trim() || null
  const validSpread = replacement.adoptSpeciesSpread === true
    && typeof replacement.canopySpreadM === 'number'
    && Number.isFinite(replacement.canopySpreadM)
    && replacement.canopySpreadM > 0
    ? replacement.canopySpreadM
    : undefined

  let changed = false
  const nextPlants = persisted.plants.map((plant) => {
    if (!targetIds.has(plant.id) || plant.locked || lockedGroupPlantIds.has(plant.id)) return plant
    const nextSpread = validSpread !== undefined ? validSpread : plant.canopySpreadM
    if (
      plant.canonicalName === canonicalName
      && plant.commonName === commonName
      && plant.canopySpreadM === nextSpread
    ) {
      return plant
    }
    changed = true
    return {
      ...plant,
      canonicalName,
      commonName,
      canopySpreadM: nextSpread,
    }
  })
  if (!changed) return null
  return (draft) => {
    draft.plants = nextPlants
  }
}

export function prepareSetSpeciesCode(
  persisted: ScenePersistedState,
  canonicalName: string,
  code: string,
): ((draft: ScenePersistedState) => void) | null {
  const normalized = code.trim().toUpperCase()
  if (!/^[A-Z]{1,6}[0-9]{0,6}$/.test(normalized)) return null
  if (persisted.plantSpeciesCodes[canonicalName] === normalized) return null
  for (const [species, existing] of Object.entries(persisted.plantSpeciesCodes)) {
    if (species !== canonicalName && existing === normalized) return null
  }
  return (draft) => {
    draft.plantSpeciesCodes = { ...draft.plantSpeciesCodes, [canonicalName]: normalized }
  }
}
