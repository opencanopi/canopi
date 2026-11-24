// canvas/runtime/tools/constraints.ts  (pure)
//
// Owns the angle constraints the ToolHost applies to a tool's point while Shift is held (CanvasTool.constraint, spec §1.4):
// a direction from an origin turned to the nearest step against the screen axes, its length kept; and a point turned about
// a pivot so that the angle since the press is a step multiple (relative steps, bearing-independent). At bearing 0 the
// screen axes are the world axes.

import type { WorldPoint, WorldVector } from '../../../geo/view/types'
import type { ToolConstraint } from './tool'

/** Unit world vectors of screen-right and screen-down (ToolView.screenAxesInWorld). */
export interface ScreenAxes {
  readonly right: WorldVector
  readonly down: WorldVector
}

/** The point under `constraint`, against the screen axes the host passes (world axes at bearing 0). */
export function applyToolConstraint(constraint: ToolConstraint, point: WorldPoint, axes: ScreenAxes): WorldPoint {
  if (constraint.kind === 'direction') return constrainDirection(constraint.origin, point, constraint.stepDeg, axes)
  return constrainRotation(constraint.pivot, constraint.startDeg, point, constraint.stepDeg)
}

function constrainDirection(origin: WorldPoint, point: WorldPoint, stepDeg: number, axes: ScreenAxes): WorldPoint {
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  const worldLength = Math.hypot(dx, dy)
  if (worldLength <= 0.000001) return { ...origin }
  // Dual basis of (right, down): exact screen-axis coordinates even when non-orthogonal under anisotropic affine.
  const det = axes.right.x * axes.down.y - axes.right.y * axes.down.x
  const across = Math.abs(det) > 1e-12
    ? (dx * axes.down.y - dy * axes.down.x) / det
    : dx * axes.right.x + dy * axes.right.y
  const down = Math.abs(det) > 1e-12
    ? (axes.right.x * dy - axes.right.y * dx) / det
    : dx * axes.down.x + dy * axes.down.y
  if (Math.hypot(across, down) <= 0.000001) return { ...origin }

  const step = Math.PI / (180 / stepDeg)
  const angle = Math.round(Math.atan2(down, across) / step) * step
  const rayX = Math.cos(angle) * axes.right.x + Math.sin(angle) * axes.down.x
  const rayY = Math.cos(angle) * axes.right.y + Math.sin(angle) * axes.down.y
  const rayLen = Math.hypot(rayX, rayY)
  if (!(rayLen > 0)) return { ...origin }
  return {
    x: origin.x + (rayX / rayLen) * worldLength,
    y: origin.y + (rayY / rayLen) * worldLength,
  }
}

/** The rotate handle's step: the signed angle turned since the press, rounded to the step. */
function constrainRotation(pivot: WorldPoint, startDeg: number, point: WorldPoint, stepDeg: number): WorldPoint {
  const radius = Math.hypot(point.x - pivot.x, point.y - pivot.y)
  if (radius <= 0.000001) return { ...point }
  const currentDeg = (Math.atan2(point.y - pivot.y, point.x - pivot.x) * 180) / Math.PI
  const steppedDeg = Math.round(signedAngleDeltaDeg(startDeg, currentDeg) / stepDeg) * stepDeg
  const radians = ((startDeg + steppedDeg) * Math.PI) / 180
  return { x: pivot.x + Math.cos(radians) * radius, y: pivot.y + Math.sin(radians) * radius }
}

function signedAngleDeltaDeg(startDeg: number, currentDeg: number): number {
  let delta = (currentDeg - startDeg) % 360
  if (delta > 180) delta -= 360
  if (delta <= -180) delta += 360
  return delta
}
