import type { SceneMeasurementGuideEntity, ScenePoint } from './scene'
import type { ViewTransform } from '../../geo/view/types'
import { formatMetricDistance, type ZoneMeasurementLabel } from './zone-measurements'

export const MEASUREMENT_GUIDE_DASH_PX = 6
export const MEASUREMENT_GUIDE_GAP_PX = 4
export const MEASUREMENT_GUIDE_TICK_HALF_PX = 5
export const MEASUREMENT_GUIDE_LABEL_FONT_SIZE_PX = 11
const MEASUREMENT_GUIDE_LABEL_CLEARANCE_PX = 4
export const MEASUREMENT_GUIDE_LABEL_OFFSET_PX =
  MEASUREMENT_GUIDE_LABEL_FONT_SIZE_PX / 2 + MEASUREMENT_GUIDE_LABEL_CLEARANCE_PX

/** A guide in world metres; its label's place on screen comes from a view (`measurementGuideLabelPoseIn`). */
export interface MeasurementGuidePresentation {
  readonly text: string
  readonly normalWorld: ScenePoint
  readonly lengthWorld: number
}

/** A guide's text and world geometry, or null for a guide too short to measure. */
export function createMeasurementGuidePresentation(
  guide: SceneMeasurementGuideEntity,
): MeasurementGuidePresentation | null {
  const dx = guide.end.x - guide.start.x
  const dy = guide.end.y - guide.start.y
  const lengthWorld = Math.hypot(dx, dy)
  if (lengthWorld < 0.5) return null

  return {
    text: formatMetricDistance(lengthWorld),
    normalWorld: {
      x: dy / lengthWorld,
      y: -dx / lengthWorld,
    },
    lengthWorld,
  }
}

/** A guide's label in `view`: from its projected ends and midpoint (`measurementGuideLabelPose`). */
export function measurementGuideLabelPoseIn(
  guide: SceneMeasurementGuideEntity,
  view: Pick<ViewTransform, 'worldToScreen'>,
): { readonly point: ScenePoint; readonly rotationRad: number } {
  const midpoint = { x: (guide.start.x + guide.end.x) / 2, y: (guide.start.y + guide.end.y) / 2 }
  return measurementGuideLabelPose(view.worldToScreen(guide.start), view.worldToScreen(guide.end), view.worldToScreen(midpoint))
}

/**
 * A guide's label from the guide's projected ends and midpoint, in any view: parallel to the guide, turned to read
 * upright, and offset to the side the upright text faces.
 */
function measurementGuideLabelPose(
  screenStart: ScenePoint,
  screenEnd: ScenePoint,
  screenMidpoint: ScenePoint,
): { readonly point: ScenePoint; readonly rotationRad: number } {
  const rotationRad = normalizeUprightLabelRotation(Math.atan2(screenEnd.y - screenStart.y, screenEnd.x - screenStart.x))
  return {
    point: {
      x: screenMidpoint.x + Math.sin(rotationRad) * MEASUREMENT_GUIDE_LABEL_OFFSET_PX,
      y: screenMidpoint.y - Math.cos(rotationRad) * MEASUREMENT_GUIDE_LABEL_OFFSET_PX,
    },
    rotationRad,
  }
}

function normalizeUprightLabelRotation(angleRad: number): number {
  if (angleRad > Math.PI / 2) return angleRad - Math.PI
  if (angleRad < -Math.PI / 2) return angleRad + Math.PI
  return angleRad
}

export function createMeasurementGuideDraftMeasurements(
  start: ScenePoint,
  end: ScenePoint,
): ZoneMeasurementLabel[] {
  const lengthWorld = Math.hypot(end.x - start.x, end.y - start.y)
  if (lengthWorld < 0.5) return []

  return [{
    id: 'measurement-guide-length',
    kind: 'dimension',
    text: formatMetricDistance(lengthWorld),
    worldPosition: {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    },
  }]
}
