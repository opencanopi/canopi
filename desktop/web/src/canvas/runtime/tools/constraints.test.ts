import { describe, expect, it } from 'vitest'
import type { WorldPoint } from '../../../geo/view/types'
import { applyToolConstraint } from './constraints'
import type { ScreenBasis } from './screen-basis'

/** Screen axes of a view turned so that `bearingDeg` points up (screen-right is world east turned by the bearing). */
function screenAxesAt(bearingDeg: number): ScreenBasis {
  const radians = (bearingDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    right: { x: cos, y: sin },
    down: { x: -sin, y: cos },
    worldDeltaToScreen: (d) => ({ x: d.x * cos + d.y * sin, y: -d.x * sin + d.y * cos }),
    screenDeltaToWorld: (s) => ({ x: s.x * cos - s.y * sin, y: s.x * sin + s.y * cos }),
  }
}

const WORLD_AXES = screenAxesAt(0)

const SAMPLE_POINTS: readonly WorldPoint[] = [
  { x: 3.25, y: 1.1 },
  { x: -7.5, y: 2.2 },
  { x: 0.4, y: -9.75 },
  { x: -1.3, y: -1.2 },
  { x: 12, y: 11.9 },
  { x: 0, y: 5 },
]

describe('tool constraints', () => {
  it('puts a point on the nearest 45 degree direction from the origin and keeps its length', () => {
    const origin = { x: 1.5, y: -2.25 }
    const constrainPointTo45Degrees = (from: WorldPoint, point: WorldPoint) =>
      applyToolConstraint({ kind: 'direction', origin: from, stepDeg: 45 }, point, WORLD_AXES)
    for (const point of SAMPLE_POINTS) {
      const constrained = constrainPointTo45Degrees(origin, point)
      const length = Math.hypot(point.x - origin.x, point.y - origin.y)
      const angle = Math.atan2(constrained.y - origin.y, constrained.x - origin.x)
      expect(Math.hypot(constrained.x - origin.x, constrained.y - origin.y)).toBeCloseTo(length, 9)
      expect(Math.abs(Math.round(angle / (Math.PI / 4)) * (Math.PI / 4) - angle)).toBeLessThan(1e-9)
    }
    expect(constrainPointTo45Degrees(origin, { x: 11.5, y: -1.25 })).toEqual({ x: origin.x + Math.hypot(10, 1), y: origin.y })
    expect(constrainPointTo45Degrees(origin, origin)).toEqual(origin)
  })

  it('turns a direction to the step against the screen axes and keeps its length', () => {
    const origin = { x: 2, y: 3 }
    const axes = screenAxesAt(30)
    // 10 m along screen-right, nudged 5 degrees off it on screen.
    const nudge = (5 * Math.PI) / 180
    const point = {
      x: origin.x + 10 * (Math.cos(nudge) * axes.right.x + Math.sin(nudge) * axes.down.x),
      y: origin.y + 10 * (Math.cos(nudge) * axes.right.y + Math.sin(nudge) * axes.down.y),
    }

    const constrained = applyToolConstraint({ kind: 'direction', origin, stepDeg: 45 }, point, axes)

    expect(constrained.x).toBeCloseTo(origin.x + 10 * axes.right.x, 9)
    expect(constrained.y).toBeCloseTo(origin.y + 10 * axes.right.y, 9)
  })

  it('turns a point about the pivot so the angle since the press is a step multiple', () => {
    const pivot = { x: 5, y: 5 }
    const startDeg = 10
    const radius = 4
    const at = (deg: number) => ({
      x: pivot.x + radius * Math.cos((deg * Math.PI) / 180),
      y: pivot.y + radius * Math.sin((deg * Math.PI) / 180),
    })

    const constrained = applyToolConstraint(
      { kind: 'rotation-delta', pivot, startDeg, stepDeg: 15 },
      at(startDeg + 22),
      WORLD_AXES,
    )

    const expected = at(startDeg + 15)
    expect(constrained.x).toBeCloseTo(expected.x, 9)
    expect(constrained.y).toBeCloseTo(expected.y, 9)
  })

  it('steps a rotation across the half turn by the signed delta, as today', () => {
    const pivot = { x: 0, y: 0 }
    // Pressed at 170 degrees; the pointer at -172 degrees has turned +18 degrees, which steps to +15.
    const constrained = applyToolConstraint(
      { kind: 'rotation-delta', pivot, startDeg: 170, stepDeg: 15 },
      { x: Math.cos((-172 * Math.PI) / 180), y: Math.sin((-172 * Math.PI) / 180) },
      WORLD_AXES,
    )

    expect(Math.atan2(constrained.y, constrained.x) * 180 / Math.PI).toBeCloseTo(-175, 9)
  })
})
