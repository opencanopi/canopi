// canvas/runtime/zone-geometry.ts
// Owner of the zone kernel (zone-decoding-only-in-kernel, ADR 0024; §18 F33). Invariant: a
// zone shape is decoded only here; callers ask it for outlines, measures and paths.

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

/** A zone's area and perimeter in the session plane's metres. */
export interface ZoneMeasure {
  /** Null for a line zone, which encloses nothing. */
  readonly areaM2: number | null
  /** The distance around the zone; a line zone's length. */
  readonly perimeterM: number
}

/** Pure: a zone's area and perimeter (Ramanujan's approximation for an ellipse); null without enough points. */
export function measureZone(zone: SceneZoneEntity): ZoneMeasure | null {
  if (zone.zoneType === 'ellipse') {
    if (zone.points.length < 2) return null
    const a = Math.abs(zone.points[1]!.x)
    const b = Math.abs(zone.points[1]!.y)
    return { areaM2: Math.PI * a * b, perimeterM: Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))) }
  }
  const points = zone.zoneType === 'rect' ? getRectangularZoneCorners(zone) : zone.points
  if (!points || points.length < 2) return null
  if (zone.zoneType === 'line') return { areaM2: null, perimeterM: pathLength(points, false) }
  if (points.length < 3) return null
  return { areaM2: Math.abs(polygonArea(points)), perimeterM: pathLength(points, true) }
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

function pathLength(points: readonly ScenePoint[], closed: boolean): number {
  let length = 0
  const segments = closed ? points.length : points.length - 1
  for (let index = 0; index < segments; index += 1) {
    const start = points[index]!
    const end = points[(index + 1) % points.length]!
    length += Math.hypot(end.x - start.x, end.y - start.y)
  }
  return length
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
