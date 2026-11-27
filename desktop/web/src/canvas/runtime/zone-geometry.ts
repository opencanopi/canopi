// canvas/runtime/zone-geometry.ts
// Owner of the zone kernel (zone-decoding-only-in-kernel, ADR 0024; §18 F33). Invariant: a
// zone shape is decoded only here; callers ask it for outlines, measures and paths.

import { groundPolylineLength, type GroundMeasure, type Metres, type SquareMetres } from '../../geo/session-plane'
import type { ScenePoint, SceneZoneEntity } from './scene'

export interface ZoneWorldBounds {
  x: number
  y: number
  width: number
  height: number
}

export function getZoneWorldBounds(zone: SceneZoneEntity): ZoneWorldBounds | null {
  if (zone.zoneType === 'rect' && zone.points.length >= 4) {
    const corners = getRectangularZoneCorners(zone)
    return corners ? pointsBounds(corners) : null
  }

  if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
    const center = zone.points[0]!
    const radii = zone.points[1]!
    const rotationRad = degreesToRadians(zone.rotationDeg)
    const cos = Math.cos(rotationRad)
    const sin = Math.sin(rotationRad)
    const halfWidth = Math.sqrt((Math.abs(radii.x) * cos) ** 2 + (Math.abs(radii.y) * sin) ** 2)
    const halfHeight = Math.sqrt((Math.abs(radii.x) * sin) ** 2 + (Math.abs(radii.y) * cos) ** 2)
    return {
      x: cleanMetric(center.x - halfWidth),
      y: cleanMetric(center.y - halfHeight),
      width: cleanMetric(halfWidth * 2),
      height: cleanMetric(halfHeight * 2),
    }
  }

  if (zone.points.length === 0) return null
  return pointsBounds(zone.points)
}

export function getRectangularZoneCorners(zone: SceneZoneEntity): ScenePoint[] | null {
  if (zone.zoneType !== 'rect' || zone.points.length < 4) return null
  const bounds = pointsBounds(zone.points.slice(0, 4))
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ]
  const rotationRad = degreesToRadians(zone.rotationDeg)
  if (Math.abs(rotationRad) < 0.000001) return corners
  return corners.map((point) => rotatePointAround(point, center, rotationRad))
}

export function getEllipticalZonePolygon(zone: SceneZoneEntity, segmentCount = 48): ScenePoint[] | null {
  if (zone.zoneType !== 'ellipse' || zone.points.length < 2) return null
  const center = zone.points[0]!
  const radii = zone.points[1]!
  const rotationRad = degreesToRadians(zone.rotationDeg)
  const points: ScenePoint[] = []
  for (let index = 0; index < segmentCount; index += 1) {
    const theta = (index / segmentCount) * Math.PI * 2
    const local = {
      x: center.x + Math.cos(theta) * Math.abs(radii.x),
      y: center.y + Math.sin(theta) * Math.abs(radii.y),
    }
    points.push(rotatePointAround(local, center, rotationRad))
  }
  return points
}

/** A zone's area and perimeter in true ground metres. */
export interface ZoneMeasure {
  /** Null for a line zone, which encloses nothing. */
  readonly areaM2: SquareMetres | null
  /** The distance around the zone; a line zone's length. */
  readonly perimeterM: Metres
}

/** Pure: a zone's true WGS84 ground area and perimeter (Ramanujan II for an ellipse); null without enough points. */
export function measureZone(zone: SceneZoneEntity, measure: GroundMeasure): ZoneMeasure | null {
  if (zone.zoneType === 'ellipse') {
    if (zone.points.length < 2) return null
    const center = zone.points[0]!
    const rx = Math.abs(zone.points[1]!.x)
    const ry = Math.abs(zone.points[1]!.y)
    const s = measure.groundScaleAt(center)
    const rad = degreesToRadians(zone.rotationDeg)
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const a = Math.hypot(rx * cos * s.x, rx * sin * s.y)
    const b = Math.hypot(-ry * sin * s.x, ry * cos * s.y)
    const sum = a + b
    const h = sum > 0 ? ((a - b) / sum) ** 2 : 0
    return {
      areaM2: (Math.PI * rx * ry * s.x * s.y) as SquareMetres,
      perimeterM: (Math.PI * sum * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))) as Metres,
    }
  }
  const points = zone.zoneType === 'rect' ? getRectangularZoneCorners(zone) : zone.points
  if (!points || points.length < 2) return null
  if (zone.zoneType === 'line') {
    return { areaM2: null, perimeterM: groundPolylineLength(measure, points, false) }
  }
  if (points.length < 3) return null
  return {
    areaM2: measure.groundArea(points),
    perimeterM: groundPolylineLength(measure, points, true),
  }
}

/** The shoelace area of a closed polygon, signed by its winding. */
export function polygonArea(points: readonly ScenePoint[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    twiceArea += current.x * next.y - next.x * current.y
  }
  return twiceArea / 2
}

/** A point turned about a centre, with near-zero values snapped to 0. */
export function rotatePointAround(point: ScenePoint, center: ScenePoint, radians: number): ScenePoint {
  const dx = point.x - center.x
  const dy = point.y - center.y
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: cleanMetric(center.x + dx * cos - dy * sin),
    y: cleanMetric(center.y + dx * sin + dy * cos),
  }
}

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** Axis-aligned bounds of plane points, with near-zero values snapped to 0. */
export function pointsBounds(points: readonly ScenePoint[]): { x: number; y: number; width: number; height: number } {
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
    x: cleanMetric(minX),
    y: cleanMetric(minY),
    width: cleanMetric(maxX - minX),
    height: cleanMetric(maxY - minY),
  }
}

function cleanMetric(value: number): number {
  return Math.abs(value) < 0.0000001 ? 0 : value
}

/**
 * Accumulator for a screen-aligned bounding box at `bearingDeg` (2.1-Q89):
 * projects points, spans, and zones onto the screen's right/down axes
 * (`right = (cos θ, sin θ)`, `down = (-sin θ, cos θ)`), returning the box centre in world metres.
 */
export interface ScreenAlignedBounds {
  addPoint(point: ScenePoint): void
  addPoints(points: readonly ScenePoint[]): void
  addSpan(centre: ScenePoint, halfU: number, halfV: number): void
  addZone(zone: SceneZoneEntity): void
  center(): ScenePoint | null
}

export function createScreenAlignedBounds(bearingDeg: number): ScreenAlignedBounds {
  const rad = degreesToRadians(bearingDeg)
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity

  const addSpan = (centre: ScenePoint, halfU: number, halfV: number): void => {
    const u = centre.x * cos + centre.y * sin
    const v = -centre.x * sin + centre.y * cos
    minU = Math.min(minU, u - halfU)
    maxU = Math.max(maxU, u + halfU)
    minV = Math.min(minV, v - halfV)
    maxV = Math.max(maxV, v + halfV)
  }

  const addPoint = (point: ScenePoint): void => {
    addSpan(point, 0, 0)
  }

  const addPoints = (points: readonly ScenePoint[]): void => {
    for (const point of points) addSpan(point, 0, 0)
  }

  const addZone = (zone: SceneZoneEntity): void => {
    if (zone.points.length === 0) return
    if (zone.zoneType === 'rect' && zone.points.length >= 4) {
      const corners = getRectangularZoneCorners(zone)
      if (corners) addPoints(corners)
      return
    }
    if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
      const centre = zone.points[0]!
      const radii = zone.points[1]!
      const zRad = degreesToRadians(zone.rotationDeg)
      const major = { x: Math.cos(zRad) * Math.abs(radii.x), y: Math.sin(zRad) * Math.abs(radii.x) }
      const minor = { x: -Math.sin(zRad) * Math.abs(radii.y), y: Math.cos(zRad) * Math.abs(radii.y) }
      addSpan(
        centre,
        Math.hypot(major.x * cos + major.y * sin, minor.x * cos + minor.y * sin),
        Math.hypot(-major.x * sin + major.y * cos, -minor.x * sin + minor.y * cos),
      )
      return
    }
    addPoints(zone.points)
  }

  const center = (): ScenePoint | null => {
    if (!Number.isFinite(minU)) return null
    const uMid = (minU + maxU) / 2
    const vMid = (minV + maxV) / 2
    return {
      x: uMid * cos - vMid * sin,
      y: uMid * sin + vMid * cos,
    }
  }

  return { addPoint, addPoints, addSpan, addZone, center }
}
