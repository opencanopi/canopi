import type { PlantStampSource } from '../../stamp-drag-data'
import {
  resolvePlantSymbolId,
  type ScenePersistedState,
  type ScenePlantEntity,
  type ScenePoint,
} from '../scene'
import { createUuid } from '../../../utils/ids'
import { polygonArea } from '../zone-geometry'
import { newZoneId } from '../zone-identity'

/** An unturned box in the session plane: a zone's `rotationDeg` turns it about its centre (zone-geometry.ts), as
 *  ToolView.screenAlignedRect's centre, width and height describe it. */
interface SceneRect {
  x: number
  y: number
  width: number
  height: number
}

/** `rect` is the unturned box; `rotationDeg` turns it about its centre (screenAlignedRect's rotationDeg). */
export function appendRectangleZoneToDraft(
  draft: ScenePersistedState,
  rect: SceneRect,
  rotationDeg: number,
): string {
  const zoneId = newZoneId()
  draft.zones = [
    ...draft.zones,
    {
      kind: 'zone',
      id: zoneId,
      name: null,
      zoneType: 'rect',
      rotationDeg,
      points: [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.width, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height },
        { x: rect.x, y: rect.y + rect.height },
      ],
      fillColor: null,
      notes: null,
      locked: false,
    },
  ]
  return zoneId
}

/** `rect` is the unturned box the ellipse fills; `rotationDeg` turns it about its centre (screenAlignedRect's rotationDeg). */
export function appendEllipseZoneToDraft(
  draft: ScenePersistedState,
  rect: SceneRect,
  rotationDeg: number,
): string {
  const zoneId = newZoneId()
  draft.zones = [
    ...draft.zones,
    {
      kind: 'zone',
      id: zoneId,
      name: null,
      zoneType: 'ellipse',
      rotationDeg,
      points: [
        { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        { x: rect.width / 2, y: rect.height / 2 },
      ],
      fillColor: null,
      notes: null,
      locked: false,
    },
  ]
  return zoneId
}

export function appendLineZoneToDraft(
  draft: ScenePersistedState,
  start: ScenePoint,
  end: ScenePoint,
): string | null {
  if (!isValidLine(start, end)) return null

  const zoneId = newZoneId()
  draft.zones = [
    ...draft.zones,
    {
      kind: 'zone',
      id: zoneId,
      name: null,
      zoneType: 'line',
      rotationDeg: 0,
      points: [
        { x: start.x, y: start.y },
        { x: end.x, y: end.y },
      ],
      fillColor: null,
      notes: null,
      locked: false,
    },
  ]
  return zoneId
}

export function appendMeasurementGuideToDraft(
  draft: ScenePersistedState,
  start: ScenePoint,
  end: ScenePoint,
): string | null {
  if (!isValidLine(start, end)) return null

  const guideId = `measurement-guide-${createUuid()}`
  draft.measurementGuides = [
    ...draft.measurementGuides,
    {
      kind: 'measurement-guide',
      id: guideId,
      locked: false,
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
    },
  ]
  return guideId
}

export function appendPolygonZoneToDraft(
  draft: ScenePersistedState,
  points: readonly ScenePoint[],
): string | null {
  if (!isValidPolygon(points)) return null

  const zoneId = newZoneId()
  draft.zones = [
    ...draft.zones,
    {
      kind: 'zone',
      id: zoneId,
      name: null,
      zoneType: 'polygon',
      rotationDeg: 0,
      points: points.map((point) => ({ x: point.x, y: point.y })),
      fillColor: null,
      notes: null,
      locked: false,
    },
  ]
  return zoneId
}

export function appendPlantStampSourceToDraft(
  draft: ScenePersistedState,
  source: PlantStampSource,
  world: ScenePoint,
): string {
  const plant = plantEntityFromStampSource(draft, source, world, createUuid())
  draft.plants = [...draft.plants, plant]
  return plant.id
}

/** The plant a Place plants click would add at `world`, with the species' colour and symbol. Pure. */
export function plantEntityFromStampSource(
  scene: Pick<ScenePersistedState, 'plantSpeciesSymbols' | 'plantSpeciesColors'>,
  source: PlantStampSource,
  world: ScenePoint,
  id: string,
): ScenePlantEntity {
  const hasSpeciesSymbol = Object.prototype.hasOwnProperty.call(
    scene.plantSpeciesSymbols,
    source.canonical_name,
  )
  const speciesSymbol = hasSpeciesSymbol
    ? resolvePlantSymbolId(scene.plantSpeciesSymbols[source.canonical_name])
    : null
  return {
    kind: 'plant',
    id,
    canonicalName: source.canonical_name,
    commonName: source.common_name,
    color: scene.plantSpeciesColors[source.canonical_name] ?? null,
    ...(speciesSymbol ? { symbol: speciesSymbol } : {}),
    canopySpreadM: source.width_max_m,
    position: world,
    rotationDeg: null,
    notes: null,
    plantedDate: null,
    quantity: 1,
    locked: false,
  }
}

/** `rotationDeg` null keeps the note level with north; a note is drawn at `rotationDeg − bearing` on screen. */
export function appendTextAnnotationToDraft(
  draft: ScenePersistedState,
  position: ScenePoint,
  text: string,
  rotationDeg: number | null,
): string {
  const id = createUuid()
  draft.annotations = [
    ...draft.annotations,
    {
      kind: 'annotation',
      id,
      annotationType: 'text',
      position,
      text,
      fontSize: 16,
      rotationDeg,
      locked: false,
    },
  ]
  return id
}

function isValidPolygon(points: readonly ScenePoint[]): boolean {
  return points.length >= 3 && Math.abs(polygonArea(points)) >= 0.25
}

function isValidLine(start: ScenePoint, end: ScenePoint): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) >= 0.5
}
