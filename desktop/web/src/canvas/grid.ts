// ---------------------------------------------------------------------------
// Grid interval computation + snap-to-grid
// ---------------------------------------------------------------------------

import { scaleReaches } from '../geo/projection'

/** Sorted ascending: the grid intervals (snapping and the world layers' grid). */
export const NICE_DISTANCES = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]

/** Minimum screen-pixel gap between grid lines before the interval steps up. */
const MIN_SCREEN_GAP = 20

/**
 * Compute the minor grid interval for a given viewport scale.
 * Returns the smallest NICE_DISTANCES entry whose screen-space gap >= MIN_SCREEN_GAP,
 * plus its index (used by the renderer for deriving the major-line interval).
 */
export function gridInterval(viewportScale: number): { interval: number; index: number } {
  for (let i = 0; i < NICE_DISTANCES.length; i++) {
    if (scaleReaches(NICE_DISTANCES[i]! * viewportScale, MIN_SCREEN_GAP)) {
      return { interval: NICE_DISTANCES[i]!, index: i }
    }
  }
  return { interval: NICE_DISTANCES[NICE_DISTANCES.length - 1]!, index: NICE_DISTANCES.length - 1 }
}

export function snapToGrid(
  x: number,
  y: number,
  size: number,
): { x: number; y: number } {
  return {
    x: Math.round(x / size) * size,
    y: Math.round(y / size) * size,
  }
}
