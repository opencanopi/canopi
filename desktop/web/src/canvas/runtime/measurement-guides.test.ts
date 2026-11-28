import { describe, expect, it } from 'vitest'

import { createTestView } from '../../__tests__/support/test-view'
import {
  createMeasurementGuidePresentation,
  MEASUREMENT_GUIDE_LABEL_OFFSET_PX,
  measurementGuideLabelPoseIn,
} from './measurement-guides'
import type { SceneMeasurementGuideEntity, ScenePoint } from './scene'

describe('createMeasurementGuidePresentation', () => {
  it('places labels centered, parallel, upright, and clear of the guide line', () => {
    const cases: Array<{
      name: string
      start: ScenePoint
      end: ScenePoint
      midpointWorld: ScenePoint
      rotationRad: number
      labelScreenPoint: ScenePoint
    }> = [
      {
        name: 'horizontal',
        start: { x: 0, y: 0 },
        end: { x: 40, y: 0 },
        midpointWorld: { x: 20, y: 0 },
        rotationRad: 0,
        labelScreenPoint: { x: 20, y: -MEASUREMENT_GUIDE_LABEL_OFFSET_PX },
      },
      {
        name: 'vertical',
        start: { x: 0, y: 0 },
        end: { x: 0, y: 40 },
        midpointWorld: { x: 0, y: 20 },
        rotationRad: Math.PI / 2,
        labelScreenPoint: { x: MEASUREMENT_GUIDE_LABEL_OFFSET_PX, y: 20 },
      },
      {
        name: 'diagonal',
        start: { x: 0, y: 0 },
        end: { x: 40, y: 40 },
        midpointWorld: { x: 20, y: 20 },
        rotationRad: Math.PI / 4,
        labelScreenPoint: {
          x: 20 + Math.SQRT1_2 * MEASUREMENT_GUIDE_LABEL_OFFSET_PX,
          y: 20 - Math.SQRT1_2 * MEASUREMENT_GUIDE_LABEL_OFFSET_PX,
        },
      },
      {
        name: 'reversed-angle',
        start: { x: 40, y: 0 },
        end: { x: 0, y: 40 },
        midpointWorld: { x: 20, y: 20 },
        rotationRad: -Math.PI / 4,
        labelScreenPoint: {
          x: 20 - Math.SQRT1_2 * MEASUREMENT_GUIDE_LABEL_OFFSET_PX,
          y: 20 - Math.SQRT1_2 * MEASUREMENT_GUIDE_LABEL_OFFSET_PX,
        },
      },
    ]

    // The label positions come from the frame: a bearing-0 view at 1 px/m with the plane origin at the screen origin.
    const view = createTestView({ viewport: { x: 0, y: 0, scale: 1 } })
    const frameView = view.view()
    for (const testCase of cases) {
      const guide = measurementGuide(testCase.start, testCase.end)
      const presentation = createMeasurementGuidePresentation(guide)
      const label = measurementGuideLabelPoseIn(guide, frameView)
      const startScreen = frameView.worldToScreen(testCase.start)
      const endScreen = frameView.worldToScreen(testCase.end)
      const midScreen = frameView.worldToScreen(testCase.midpointWorld)
      let expectedAngle = Math.atan2(endScreen.y - startScreen.y, endScreen.x - startScreen.x)
      if (expectedAngle > Math.PI / 2) expectedAngle -= Math.PI
      if (expectedAngle < -Math.PI / 2) expectedAngle += Math.PI
      const expectedPoint = {
        x: midScreen.x + Math.sin(expectedAngle) * MEASUREMENT_GUIDE_LABEL_OFFSET_PX,
        y: midScreen.y - Math.cos(expectedAngle) * MEASUREMENT_GUIDE_LABEL_OFFSET_PX,
      }
      expect(presentation, testCase.name).not.toBeNull()
      expect(label.rotationRad, testCase.name).toBeCloseTo(expectedAngle)
      expect(Math.abs(label.rotationRad), testCase.name).toBeLessThanOrEqual(Math.PI / 2)
      expect(label.point.x, testCase.name).toBeCloseTo(expectedPoint.x)
      expect(label.point.y, testCase.name).toBeCloseTo(expectedPoint.y)

      const labelDelta = Math.hypot(
        label.point.x - midScreen.x,
        label.point.y - midScreen.y,
      )
      expect(labelDelta, testCase.name).toBeCloseTo(MEASUREMENT_GUIDE_LABEL_OFFSET_PX)
    }
    view.dispose()
  })
})

function measurementGuide(start: ScenePoint, end: ScenePoint): SceneMeasurementGuideEntity {
  return {
    kind: 'measurement-guide',
    id: 'guide-1',
    locked: false,
    start,
    end,
  }
}
