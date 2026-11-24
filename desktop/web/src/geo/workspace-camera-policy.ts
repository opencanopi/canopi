// canvas/workspace-camera-policy.ts  (pure)
//
// The workspace camera's limits: the map's zoom range and the overview threshold. The navigation policy
// (canvas/runtime/view/navigation-policy.ts) carries them to both camera drivers, with the world floor it computes from the screen.

import { scaleReaches } from './projection'

export const WORKSPACE_MAP_MIN_ZOOM = 0
export const WORKSPACE_MAP_MAX_ZOOM = 27
/** Overview starts below this many pixels per metre, the same at every latitude. */
export const WORKSPACE_OVERVIEW_SCALE_THRESHOLD = 0.1

export function isWorkspaceOverviewScale(scale: number): boolean {
  return !scaleReaches(scale, WORKSPACE_OVERVIEW_SCALE_THRESHOLD)
}
