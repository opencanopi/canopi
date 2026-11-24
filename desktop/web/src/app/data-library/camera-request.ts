import {
  currentCanvasQuerySurface,
  getCurrentCanvasViewportCommandSurface,
} from '../../canvas/session'
import type { SessionPlane } from '../../geo/session-plane'

function currentSessionPlane(): SessionPlane | null {
  return currentCanvasQuerySurface.value?.sessionPlane.value ?? null
}

/** Focuses LiDAR coverage through the live renderer-neutral workspace camera. */
export function viewLidarCoverage(bounds: [number, number, number, number]): boolean {
  const plane = currentSessionPlane()
  const localBounds = lidarBoundsToLocalWorld(bounds, plane)
  const viewport = getCurrentCanvasViewportCommandSurface()
  if (!plane || !localBounds || !viewport) return false

  const maximumScale = plane.pixelsPerMetre(18).mean
  if (!Number.isFinite(maximumScale)) return false

  return viewport.focusTemporaryBounds(localBounds, {
    paddingCssPx: 48,
    maximumScale,
  })
}

/**
 * Restores the view before the first coverage focus; with no bookmark left (the user moved the view, or a place search, a story
 * step or a saved view dropped it), frames the Design as "Back to my Design" does. False only without a live canvas.
 */
export function viewDesignLocation(): boolean {
  const viewport = getCurrentCanvasViewportCommandSurface()
  if (!viewport) return false
  if (!viewport.returnFromTemporaryFocus()) viewport.returnToDesign()
  return true
}

export function lidarBoundsToLocalWorld(
  bounds: [number, number, number, number],
  plane: SessionPlane | null,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!plane) return null

  const [west, south, east, north] = bounds
  if (
    ![west, south, east, north].every(Number.isFinite)
    || west < -180
    || east > 180
    || south <= -90
    || north >= 90
    || west >= east
    || south >= north
  ) return null

  const corners = [
    plane.toPlane({ lon: west, lat: north }),
    plane.toPlane({ lon: east, lat: north }),
    plane.toPlane({ lon: east, lat: south }),
    plane.toPlane({ lon: west, lat: south }),
  ]
  if (!corners.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))) return null

  return {
    minX: Math.min(...corners.map(({ x }) => x)),
    minY: Math.min(...corners.map(({ y }) => y)),
    maxX: Math.max(...corners.map(({ x }) => x)),
    maxY: Math.max(...corners.map(({ y }) => y)),
  }
}
