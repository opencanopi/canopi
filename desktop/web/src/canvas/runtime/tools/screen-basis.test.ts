import { describe, expect, it } from 'vitest'
import { createTestView } from '../../../__tests__/support/test-view'
import { createSessionPlane } from '../../../geo/session-plane'
import { applyToolConstraint } from './constraints'
import { measureLabelShapes } from './measure-labels'
import { createPolygonalZoneMeasurements } from '../zone-measurements'
import { screenBasisOf, screenCoordsToWorldDelta, worldDeltaToScreenCoords } from './screen-basis'

describe('screen-basis dual-basis mapping on the real WGS84 ellipsoid', () => {
  it('round-trips world and screen deltas at 30° bearing across latitudes', () => {
    for (const origin of [{ lon: 0, lat: 0 }, { lon: 2.35, lat: 48.85 }, { lon: 18.06, lat: 65 }]) {
      const testView = createTestView({
        plane: createSessionPlane(origin),
        camera: { center: origin, zoom: 18, bearingDeg: 30 },
      })
      const view = testView.view()
      const basis = screenBasisOf(view)
      for (const delta of [{ x: 12, y: 0 }, { x: 0, y: -7.5 }, { x: 8.3, y: 5.1 }]) {
        const screen = worldDeltaToScreenCoords(basis, delta)
        const roundTripped = screenCoordsToWorldDelta(basis, screen)
        expect(roundTripped.x, `lat ${origin.lat}`).toBeCloseTo(delta.x, 12)
        expect(roundTripped.y, `lat ${origin.lat}`).toBeCloseTo(delta.y, 12)
      }
      testView.dispose()
    }
  })

  it('snaps direction constraints to exact screen angles at 30° bearing on lat 0 (not skewed by ellipsoid anisotropy)', () => {
    const plane = createSessionPlane({ lon: 0, lat: 0 })
    const testView = createTestView({
      plane,
      camera: { center: { lon: 0, lat: 0 }, zoom: 18, bearingDeg: 30 },
    })
    const view = testView.view()
    const basis = screenBasisOf(view)
    const origin = { x: 5, y: 7 }

    for (const targetAngleDeg of [0, 45, 90, -45, 135]) {
      const rad = (targetAngleDeg * Math.PI) / 180
      // Perturb 4° off the target screen direction and verify it snaps back to the exact screen angle.
      const perturbedRad = rad + (4 * Math.PI) / 180
      const probeDelta = screenCoordsToWorldDelta(basis, {
        x: Math.cos(perturbedRad) * 20,
        y: Math.sin(perturbedRad) * 20,
      })
      const probe = { x: origin.x + probeDelta.x, y: origin.y + probeDelta.y }
      const snapped = applyToolConstraint({ kind: 'direction', origin, stepDeg: 45 }, probe, basis)

      // Exact screen direction (not just length): screen delta lies on the targetAngleDeg ray.
      const snappedScreen = view.worldDeltaToScreen({ x: snapped.x - origin.x, y: snapped.y - origin.y })
      const actualAngleRad = Math.atan2(snappedScreen.y, snappedScreen.x)
      const angleDiff = Math.atan2(Math.sin(actualAngleRad - rad), Math.cos(actualAngleRad - rad))
      expect(angleDiff, `target ${targetAngleDeg}°`).toBeCloseTo(0, 10)
      expect(Math.hypot(snapped.x - origin.x, snapped.y - origin.y), `length ${targetAngleDeg}°`)
        .toBeCloseTo(Math.hypot(probeDelta.x, probeDelta.y), 10)
    }

    testView.dispose()
  })

  it('places polygon edge chips along the exact 90° screen normal at 30° bearing on lat 0', () => {
    const plane = createSessionPlane({ lon: 0, lat: 0 })
    const testView = createTestView({
      plane,
      camera: { center: { lon: 0, lat: 0 }, zoom: 19, bearingDeg: 30 },
    })
    const view = testView.view()
    const corners = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 15 }, { x: 0, y: 15 }]
    const labels = createPolygonalZoneMeasurements(corners, plane)
    const shapes = measureLabelShapes(
      labels,
      (a, b) => view.screenDistance(a, b),
      { corners, edges: new Set([0, 1, 2, 3]), screenAxes: screenBasisOf(view) },
    )
    const edgeLabels = shapes.filter((shape) => shape.kind === 'label' && shape.tone === 'measure-quiet')
    expect(edgeLabels).toHaveLength(4)

    for (let index = 0; index < corners.length; index += 1) {
      const label = edgeLabels[index]!
      expect(label.kind).toBe('label')
      if (label.kind !== 'label') throw new Error('expected label')
      expect(label.beside, `edge ${index} must carry a beside normal`).toBeDefined()
      const normal = label.beside!.normalPx
      expect(Math.hypot(normal.x, normal.y)).toBeCloseTo(1, 10)

      const start = corners[index]!
      const end = corners[(index + 1) % corners.length]!
      const screenEdge = view.worldDeltaToScreen({ x: end.x - start.x, y: end.y - start.y })
      const edgeLen = Math.hypot(screenEdge.x, screenEdge.y)
      // Dot product between screen edge and chip normal must be 0 (exact 90° perpendicular in screen space).
      const dot = (screenEdge.x * normal.x + screenEdge.y * normal.y) / edgeLen
      expect(dot, `edge ${index} perpendicularity`).toBeCloseTo(0, 10)
      // Outward check: normal must point away from the polygon centroid on screen.
      const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      const outward = view.worldDeltaToScreen({ x: mid.x - 10, y: mid.y - 7.5 })
      expect(outward.x * normal.x + outward.y * normal.y, `edge ${index} outward`).toBeGreaterThan(0)
    }

    testView.dispose()
  })
})
