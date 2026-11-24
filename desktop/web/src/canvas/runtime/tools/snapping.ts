// canvas/runtime/tools/snapping.ts  (pure)
//
// Owns the ToolHost's grid snapping, on true east and north (world axes, user), whatever the bearing: on a turned map
// the lattice turns with the map (spec §4.6). The interval comes from the frame's pixelsPerMetre (the plane origin's
// scale, which the bearing does not change). The host feeds ToolPoint.free, ToolPoint.snapped and ToolContext.snap from
// here, and the length a Shift constraint keeps along its ray (snapAlongRay; spec §2.3: constrain, then snap).
// canvas/grid.ts keeps the arithmetic, which the drawn grid reads too, so the grid lines are the snap lattice.

import { gridInterval, snapToGrid } from '../../grid'
import type { WorldPoint } from '../../../geo/view/types'

/** Which snapping the settings turn on (Snap to grid). */
export interface SnapSettings {
  readonly grid: boolean
}

/** `point` snapped to the grid; the point itself when snapping is off. */
export function snapWorldPoint(point: WorldPoint, settings: SnapSettings, pixelsPerMetre: number): WorldPoint {
  if (!settings.grid) return point
  return snapToGrid(point.x, point.y, gridInterval(pixelsPerMetre).interval)
}

/** `point` on the ray from `origin`, its distance rounded to a whole number of grid intervals; `point` when snapping is
 *  off. A constrained point keeps its direction this way, where a lattice snap would turn it off its step. */
export function snapAlongRay(origin: WorldPoint, point: WorldPoint, settings: SnapSettings, pixelsPerMetre: number): WorldPoint {
  if (!settings.grid) return point
  const interval = gridInterval(pixelsPerMetre).interval
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  const length = Math.hypot(dx, dy)
  if (length <= 0 || !(interval > 0)) return point
  const scale = (Math.round(length / interval) * interval) / length
  return { x: origin.x + dx * scale, y: origin.y + dy * scale }
}
