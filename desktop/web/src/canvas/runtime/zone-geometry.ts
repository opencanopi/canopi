// canvas/runtime/zone-geometry.ts
// Owner of the zone kernel (zone-decoding-only-in-kernel, ADR 0024; §18 F33). Invariant: a
// zone shape is decoded only here; callers ask it for outlines, measures and paths.

import { groundPolylineLength, type GroundMeasure, type Metres, type PlanePoint, type SquareMetres } from '../../geo/session-plane'
import { bearingCosSin } from '../../geo/view/navigation-policy'
import type { PrintBounds, PrintPoint, PrintZone } from '../print'

type ScenePoint = PlanePoint

interface SceneZoneEntity {
  readonly kind?: 'zone'
  readonly id?: string
  readonly name?: string | null
  readonly locked?: boolean
  readonly zoneType: string
  readonly points: readonly ScenePoint[]
  readonly rotationDeg: number
  readonly fillColor: string | null
  readonly notes?: string | null
}

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
  const [cos, sin] = bearingCosSin(bearingDeg)
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

/** Shape kind of a runtime or wire zone. */
type ZoneShapeKind = 'polygon' | 'rect' | 'ellipse' | 'line'
type ZoneLike = { readonly zoneType?: string; readonly zone_type?: string }
type ZoneWithPointsLike = ZoneLike & { readonly points: readonly unknown[] }

function zoneShapeOf(zone: ZoneLike): string {
  return zone.zoneType ?? zone.zone_type ?? 'polygon'
}

export function isZoneClosed(zone: ZoneLike): boolean {
  return zoneShapeOf(zone) !== 'line'
}

export function isLineZone(zone: ZoneLike): boolean {
  return zoneShapeOf(zone) === 'line'
}

export function isPolygonZone(zone: ZoneLike): boolean {
  return zoneShapeOf(zone) === 'polygon'
}

export function isFramedZone(zone: ZoneLike): boolean {
  const kind = zoneShapeOf(zone)
  return kind === 'rect' || kind === 'ellipse'
}

export function isEllipseZoneWithRadii(zone: ZoneWithPointsLike): boolean {
  return zoneShapeOf(zone) === 'ellipse' && zone.points.length >= 2
}

export function dispatchZoneByShape<Z extends ZoneLike, T>(
  zone: Z,
  handlers: {
    readonly rect: (zone: Z) => T
    readonly ellipse: (zone: Z) => T
    readonly polygon: (zone: Z) => T
    readonly line: (zone: Z) => T
  },
): T {
  switch (zoneShapeOf(zone) as ZoneShapeKind) {
    case 'rect':
      return handlers.rect(zone)
    case 'ellipse':
      return handlers.ellipse(zone)
    case 'line':
      return handlers.line(zone)
    case 'polygon':
      return handlers.polygon(zone)
  }
}

export interface ZoneAxisFrame {
  readonly center: ScenePoint
  readonly halfWidth: number
  readonly halfHeight: number
  readonly rotationDeg: number
}

/** Axis frame (centre, half-extents, rotation) for a `rect` or `ellipse` zone; null otherwise. */
export function getZoneAxisFrame(zone: SceneZoneEntity): ZoneAxisFrame | null {
  if (zone.zoneType === 'rect' && zone.points.length >= 4) {
    const bounds = pointsBounds(zone.points.slice(0, 4))
    return {
      center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      halfWidth: bounds.width / 2,
      halfHeight: bounds.height / 2,
      rotationDeg: zone.rotationDeg,
    }
  }
  if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
    return {
      center: { x: zone.points[0]!.x, y: zone.points[0]!.y },
      halfWidth: Math.abs(zone.points[1]!.x),
      halfHeight: Math.abs(zone.points[1]!.y),
      rotationDeg: zone.rotationDeg,
    }
  }
  return null
}

/** Builds stored zone points for a `rect` (4 unrotated corners) or `ellipse` (`[center, radii]`). */
export function buildFramedZonePoints(
  zone: Pick<SceneZoneEntity, 'zoneType'>,
  center: ScenePoint,
  halfWidth: number,
  halfHeight: number,
): ScenePoint[] | null {
  if (zone.zoneType === 'rect') {
    return [
      { x: center.x - halfWidth, y: center.y - halfHeight },
      { x: center.x + halfWidth, y: center.y - halfHeight },
      { x: center.x + halfWidth, y: center.y + halfHeight },
      { x: center.x - halfWidth, y: center.y + halfHeight },
    ]
  }
  if (zone.zoneType === 'ellipse') {
    return [
      { x: center.x, y: center.y },
      { x: halfWidth, y: halfHeight },
    ]
  }
  return null
}

export function getZoneOutlinePoints(zone: SceneZoneEntity, ellipseSegments = 48): ScenePoint[] {
  if (zone.zoneType === 'rect') return getRectangularZoneCorners(zone) ?? []
  if (zone.zoneType === 'ellipse') return getEllipticalZonePolygon(zone, ellipseSegments) ?? []
  return [...zone.points]
}

export interface ZoneOutlineTarget {
  rect(x: number, y: number, width: number, height: number): void
  ellipse(cx: number, cy: number, rx: number, ry: number, rotationDeg: number): void
  polyline(points: readonly ScenePoint[], closed: boolean): void
}

/** Traces a zone's outline into a 2D or Pixi target without callers decoding `zoneType`. */
export function traceZoneOutline(zone: SceneZoneEntity, target: ZoneOutlineTarget): boolean {
  if (zone.zoneType === 'rect' && zone.points.length >= 4) {
    if (Math.abs(zone.rotationDeg) > 0.000001) {
      const corners = getRectangularZoneCorners(zone)
      if (!corners) return false
      target.polyline(corners, true)
      return true
    }
    const start = zone.points[0]!
    const end = zone.points[2]!
    target.rect(start.x, start.y, end.x - start.x, end.y - start.y)
    return true
  }
  if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
    const center = zone.points[0]!
    const radii = zone.points[1]!
    target.ellipse(center.x, center.y, Math.abs(radii.x), Math.abs(radii.y), zone.rotationDeg)
    return true
  }
  if (zone.points.length < 2) return false
  target.polyline(zone.points, zone.zoneType !== 'line')
  return true
}

/** Translates a zone's stored points, preserving ellipse radii at index 1. */
export function translateZonePoints(
  zone: Pick<SceneZoneEntity, 'zoneType' | 'points'>,
  delta: ScenePoint,
  startPoints: readonly ScenePoint[] = zone.points,
): ScenePoint[] {
  if (zone.zoneType === 'ellipse' && startPoints.length >= 2) {
    return [
      { x: startPoints[0]!.x + delta.x, y: startPoints[0]!.y + delta.y },
      { ...startPoints[1]! },
    ]
  }
  return startPoints.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y }))
}

/** Rotates a zone around `pivot` by `deltaDeg`, preserving rect/ellipse framing. */
export function rotateZoneGeometry(
  start: { readonly zoneType: SceneZoneEntity['zoneType']; readonly points: readonly ScenePoint[]; readonly rotationDeg: number },
  pivot: ScenePoint,
  deltaDeg: number,
  normalizeDeg: (deg: number) => number,
): { readonly points: ScenePoint[]; readonly rotationDeg: number } {
  const rad = degreesToRadians(deltaDeg)
  if (start.zoneType === 'ellipse' && start.points.length >= 2) {
    return {
      points: [rotatePointAround(start.points[0]!, pivot, rad), { ...start.points[1]! }],
      rotationDeg: normalizeDeg(start.rotationDeg + deltaDeg),
    }
  }
  if (start.zoneType === 'rect' && start.points.length >= 4) {
    const bounds = pointsBounds(start.points.slice(0, 4))
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    const nextCenter = rotatePointAround(center, pivot, rad)
    const hw = bounds.width / 2
    const hh = bounds.height / 2
    return {
      points: [
        { x: nextCenter.x - hw, y: nextCenter.y - hh },
        { x: nextCenter.x + hw, y: nextCenter.y - hh },
        { x: nextCenter.x + hw, y: nextCenter.y + hh },
        { x: nextCenter.x - hw, y: nextCenter.y + hh },
      ],
      rotationDeg: normalizeDeg(start.rotationDeg + deltaDeg),
    }
  }
  return {
    points: start.points.map((point) => rotatePointAround(point, pivot, rad)),
    rotationDeg: start.rotationDeg,
  }
}

/** Points that bound a zone for scene-extent and selection-hull calculations. */
export function getZoneExtentPoints(zone: SceneZoneEntity): ScenePoint[] {
  if (zone.zoneType === 'rect' && zone.points.length >= 4) {
    return getRectangularZoneCorners(zone) ?? [...zone.points]
  }
  if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
    return getEllipticalZonePolygon(zone, 16) ?? [...zone.points]
  }
  return [...zone.points]
}

/** Line segments of a zone's outline (empty for ellipses, which hit-test analytically). */
export function getZoneEdges(zone: SceneZoneEntity): [ScenePoint, ScenePoint][] {
  if (zone.zoneType === 'line' && zone.points.length >= 2) return [[zone.points[0]!, zone.points[1]!]]
  if (zone.zoneType === 'polygon' && zone.points.length >= 3) {
    return zone.points.map((point, index) => [point, zone.points[(index + 1) % zone.points.length]!])
  }
  if (zone.zoneType === 'rect' && zone.points.length >= 4) {
    const corners = getRectangularZoneCorners(zone)
    return corners ? corners.map((point, index) => [point, corners[(index + 1) % corners.length]!]) : []
  }
  return []
}

/** Sampled outline for edge/distance hit-testing. */
export function getZoneHitOutline(
  zone: SceneZoneEntity,
  ellipseSegments = 32,
): { readonly points: readonly ScenePoint[]; readonly closed: boolean } | null {
  if (zone.zoneType === 'line' && zone.points.length >= 2) {
    return { points: zone.points, closed: false }
  }
  if (zone.zoneType === 'rect' && zone.points.length >= 4) {
    const corners = getRectangularZoneCorners(zone)
    return corners ? { points: corners, closed: true } : null
  }
  if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
    const polygon = getEllipticalZonePolygon(zone, ellipseSegments)
    return polygon ? { points: polygon, closed: true } : null
  }
  if (zone.zoneType === 'polygon' && zone.points.length >= 3) {
    return { points: zone.points, closed: true }
  }
  return null
}

// ---------------------------------------------------------------------------
// Print / PDF zone kernel (shared by print-snapshot.ts & app/canvas-pdf/)
// ---------------------------------------------------------------------------

/** Builds SVG path, structured PrintZone geometry, and fill for print/PDF export. */
export function buildPrintZoneShape(
  zone: SceneZoneEntity,
): { readonly path: string; readonly geometry: PrintZone['geometry']; readonly fill: string | null } {
  const points = getRectangularZoneCorners(zone) ?? zone.points
  if (zone.zoneType === 'ellipse' && points.length >= 2) {
    const center = points[0]!
    const rx = Math.abs(points[1]!.x)
    const ry = Math.abs(points[1]!.y)
    return {
      path: ellipseSvgPath(center.x, center.y, rx, ry, zone.rotationDeg),
      geometry: { kind: 'ellipse', center: { ...center }, radii: { x: rx, y: ry }, rotation: zone.rotationDeg },
      fill: zone.fillColor,
    }
  }
  const closed = zone.zoneType !== 'line'
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ') + (closed ? ' Z' : '')
  const kind = zone.zoneType === 'line' ? 'line' : zone.zoneType === 'rect' ? 'rect' : 'polygon'
  return {
    path,
    geometry: { kind, points: points.map((p) => ({ ...p })) },
    fill: closed ? zone.fillColor : null,
  }
}

// Cubic ellipse representation is shared by PDF and preview, including rotation.
function ellipseSvgPath(cx: number, cy: number, rx: number, ry: number, rotation: number): string {
  const k = 0.5522847498307936
  const angle = degreesToRadians(rotation)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const point = (x: number, y: number) => `${cx + x * rx * cos - y * ry * sin} ${cy + x * rx * sin + y * ry * cos}`
  return `M${point(1, 0)} C${point(1, k)} ${point(k, 1)} ${point(0, 1)} C${point(-k, 1)} ${point(-1, k)} ${point(-1, 0)} C${point(-1, -k)} ${point(-k, -1)} ${point(0, -1)} C${point(k, -1)} ${point(1, -k)} ${point(1, 0)} Z`
}

export function isPrintEllipseGeometry(
  geometry: PrintZone['geometry'],
): geometry is Extract<PrintZone['geometry'], { readonly kind: 'ellipse' }> {
  return geometry.kind === 'ellipse'
}

export function isPrintLineGeometry(geometry: PrintZone['geometry']): boolean {
  return geometry.kind === 'line'
}

export function isPrintRectGeometry(geometry: PrintZone['geometry']): boolean {
  return geometry.kind === 'rect'
}

/** Turns a PrintZone's geometry into a rotated PDF page frame and computes its bounds. */
export function turnPrintZoneGeometry(
  geometry: PrintZone['geometry'],
  toFrame: (point: PrintPoint) => PrintPoint,
  angleDeg: number,
): { readonly geometry: PrintZone['geometry']; readonly bounds: PrintBounds } {
  if (geometry.kind === 'ellipse') {
    const next: PrintZone['geometry'] = {
      ...geometry,
      center: toFrame(geometry.center),
      rotation: geometry.rotation - angleDeg,
    }
    const a = degreesToRadians(next.rotation)
    const { x: rx, y: ry } = next.radii
    const hx = Math.hypot(rx * Math.cos(a), ry * Math.sin(a))
    const hy = Math.hypot(rx * Math.sin(a), ry * Math.cos(a))
    return {
      geometry: next,
      bounds: { x: next.center.x - hx, y: next.center.y - hy, width: 2 * hx, height: 2 * hy },
    }
  }
  const points = geometry.points.map(toFrame)
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    geometry: { ...geometry, points },
    bounds: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
  }
}

/** Analytic/polygonal point-in-zone test for PDF print zones. */
export function isPointInPrintZoneGeometry(geometry: PrintZone['geometry'], point: PrintPoint): boolean {
  if (geometry.kind === 'ellipse') {
    const a = -degreesToRadians(geometry.rotation)
    const dx = point.x - geometry.center.x
    const dy = point.y - geometry.center.y
    return ((dx * Math.cos(a) - dy * Math.sin(a)) / geometry.radii.x) ** 2
      + ((dx * Math.sin(a) + dy * Math.cos(a)) / geometry.radii.y) ** 2 <= 1 + 1e-8
  }
  if (geometry.kind === 'line') return false
  let inside = false
  for (let i = 0, j = geometry.points.length - 1; i < geometry.points.length; j = i++) {
    const a = geometry.points[i]!
    const b = geometry.points[j]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (length > 0 && Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / length < 1e-6
      && (point.x - a.x) * (point.x - b.x) + (point.y - a.y) * (point.y - b.y) <= 1e-8) return true
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
