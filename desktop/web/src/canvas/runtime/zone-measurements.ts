import type { GroundMeasure } from '../../geo/session-plane'
import { formatArea, formatLength, type UnitSystem } from '../../utils/format'
import type { ScenePoint } from './scene'
import { degreesToRadians, polygonArea, rotatePointAround } from './zone-geometry'

type ZoneMeasurementLabelKind = 'edge' | 'dimension' | 'area'

export interface ZoneMeasurementLabel {
  id: string
  kind: ZoneMeasurementLabelKind
  text: string
  worldPosition: ScenePoint
  worldStart?: ScenePoint
  worldEnd?: ScenePoint
}

export function createEllipticalZoneMeasurements(
  center: ScenePoint,
  radii: ScenePoint,
  rotationDeg: number,
  measure?: GroundMeasure,
  system: UnitSystem = 'metric',
  activeLocale = 'en',
): ZoneMeasurementLabel[] {
  const rx = Math.abs(radii.x)
  const ry = Math.abs(radii.y)
  const radians = degreesToRadians(rotationDeg)
  const scale = measure?.groundScaleAt(center)
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const width = (scale ? Math.hypot(rx * cos * scale.x, rx * sin * scale.y) : rx) * 2
  const height = (scale ? Math.hypot(-ry * sin * scale.x, ry * cos * scale.y) : ry) * 2
  if (width < 0.5 || height < 0.5) return []

  const widthPosition = rotatePointAround({ x: center.x, y: center.y - ry }, center, radians)
  const area = Math.PI * rx * ry * (scale ? scale.x * scale.y : 1)

  return [
    {
      id: 'ellipse-dimensions',
      kind: 'dimension',
      text: `${formatMetricDistance(width, system, activeLocale)} × ${formatMetricDistance(height, system, activeLocale)}`,
      worldPosition: widthPosition,
    },
    {
      id: 'area',
      kind: 'area',
      text: formatMetricArea(area, system, activeLocale),
      worldPosition: center,
    },
  ]
}

export function createRectangularZoneMeasurements(
  points: readonly ScenePoint[],
  measure?: GroundMeasure,
  system: UnitSystem = 'metric',
  activeLocale = 'en',
): ZoneMeasurementLabel[] {
  if (points.length < 4) return []
  const corners = points.slice(0, 4)
  return createPolygonalZoneMeasurements(corners, measure, system, activeLocale)
}

export function createLinearZoneMeasurements(
  start: ScenePoint,
  end: ScenePoint,
  measure?: GroundMeasure,
  system: UnitSystem = 'metric',
  activeLocale = 'en',
): ZoneMeasurementLabel[] {
  if (segmentLength(start, end, measure) < 0.5) return []
  return [createEdgeLabel('edge-0', start, end, measure, system, activeLocale)]
}

/** An open line while it is drawn (Profile): one edge per segment, the last one to the pointer. */
export function createPolylineDraftMeasurements(
  vertices: readonly ScenePoint[],
  activePoint: ScenePoint | null,
  measure?: GroundMeasure,
  system: UnitSystem = 'metric',
  activeLocale = 'en',
): ZoneMeasurementLabel[] {
  const previewPoints = draftPreviewPoints(vertices, activePoint)
  const labels: ZoneMeasurementLabel[] = []
  for (let index = 0; index < previewPoints.length - 1; index += 1) {
    labels.push(createEdgeLabel(`edge-${index}`, previewPoints[index]!, previewPoints[index + 1]!, measure, system, activeLocale))
  }
  return labels
}

/** A polygon while it is drawn: the open line's edges, then the closing edge and the area once it has one. */
export function createPolygonalZoneDraftMeasurements(
  vertices: readonly ScenePoint[],
  activePoint: ScenePoint | null,
  measure?: GroundMeasure,
  system: UnitSystem = 'metric',
  activeLocale = 'en',
): ZoneMeasurementLabel[] {
  const previewPoints = draftPreviewPoints(vertices, activePoint)
  const labels = createPolylineDraftMeasurements(vertices, activePoint, measure, system, activeLocale)

  if (previewPoints.length >= 3) {
    const area = measure ? measure.groundArea(previewPoints) : Math.abs(polygonArea(previewPoints))
    if (area >= 0.25) {
      labels.push(createEdgeLabel('edge-closing', previewPoints[previewPoints.length - 1]!, previewPoints[0]!, measure, system, activeLocale))
      labels.push({
        id: 'area',
        kind: 'area',
        text: formatMetricArea(area, system, activeLocale),
        worldPosition: averagePoint(previewPoints),
      })
    }
  }

  return labels
}

/** The placed points, then the pointer unless it is on the last one. */
function draftPreviewPoints(vertices: readonly ScenePoint[], activePoint: ScenePoint | null): ScenePoint[] {
  const last = vertices[vertices.length - 1]
  if (!last) return []
  return activePoint && !pointsEqual(last, activePoint) ? [...vertices, activePoint] : [...vertices]
}

/** A closed polygon's edges and area; none under 0.25 m². */
export function createPolygonalZoneMeasurements(
  points: readonly ScenePoint[],
  measure?: GroundMeasure,
  system: UnitSystem = 'metric',
  activeLocale = 'en',
): ZoneMeasurementLabel[] {
  if (points.length < 3) return []
  const area = measure ? measure.groundArea(points) : Math.abs(polygonArea(points))
  if (area < 0.25) return []

  const labels: ZoneMeasurementLabel[] = []
  for (let index = 0; index < points.length; index += 1) {
    labels.push(createEdgeLabel(`edge-${index}`, points[index]!, points[(index + 1) % points.length]!, measure, system, activeLocale))
  }

  labels.push({
    id: 'area',
    kind: 'area',
    text: formatMetricArea(area, system, activeLocale),
    worldPosition: averagePoint(points),
  })

  return labels
}

function createEdgeLabel(
  id: string,
  start: ScenePoint,
  end: ScenePoint,
  measure?: GroundMeasure,
  system: UnitSystem = 'metric',
  activeLocale = 'en',
): ZoneMeasurementLabel {
  return {
    id,
    kind: 'edge',
    text: formatMetricDistance(segmentLength(start, end, measure), system, activeLocale),
    worldPosition: midpoint(start, end),
    worldStart: start,
    worldEnd: end,
  }
}

export function formatMetricDistance(value: number, system: UnitSystem = 'metric', activeLocale = 'en'): string {
  return formatLength(Math.abs(value), system, activeLocale, { trimTrailingZeros: true })
}

export function formatMetricArea(value: number, system: UnitSystem = 'metric', activeLocale = 'en'): string {
  return formatArea(Math.abs(value), system, activeLocale, { trimTrailingZeros: true })
}

function segmentLength(a: ScenePoint, b: ScenePoint, measure?: GroundMeasure): number {
  return measure ? measure.groundLength(a, b) : Math.hypot(b.x - a.x, b.y - a.y)
}

function midpoint(a: ScenePoint, b: ScenePoint): ScenePoint {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
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

function pointsEqual(a: ScenePoint, b: ScenePoint): boolean {
  return Math.abs(a.x - b.x) < 0.0001 && Math.abs(a.y - b.y) < 0.0001
}
