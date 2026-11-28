// canvas/runtime/tools/screen-basis.ts  (pure)
//
// Shared world<->screen linear delta projection for tool geometry (2m-2, #333 N1, #344 N4): uses the view's exact
// affine linear part (`worldDeltaToScreen` / `screenDeltaToWorld`) so constraints, outward edge normals, bands and
// selection hulls stay exact at every bearing (including 30°) and latitude under anisotropic WGS84 planes.

import type { ScreenPoint, WorldVector } from '../../../geo/view/types'

/** Unit world vectors of screen-right and screen-down, paired with the view's exact linear affine maps. */
export interface ScreenBasis {
  readonly right: WorldVector
  readonly down: WorldVector
  worldDeltaToScreen(delta: WorldVector): ScreenPoint
  screenDeltaToWorld(delta: ScreenPoint): WorldVector
}

/** Maps a world-metre delta to screen-axis coordinates (exact CSS px via the view's linear affine). */
export function worldDeltaToScreenCoords(basis: ScreenBasis, delta: WorldVector): ScreenPoint {
  return basis.worldDeltaToScreen(delta)
}

/** Inverse of `worldDeltaToScreenCoords`: maps screen-axis coordinates back to a world-metre delta. */
export function screenCoordsToWorldDelta(basis: ScreenBasis, screen: ScreenPoint): WorldVector {
  return basis.screenDeltaToWorld(screen)
}

/** Builds a `ScreenBasis` from a `ToolView` or `ViewTransform`. */
export function screenBasisOf(view: {
  screenAxesInWorld(): { readonly right: WorldVector; readonly down: WorldVector }
  worldDeltaToScreen(delta: WorldVector): ScreenPoint
  screenDeltaToWorld(delta: ScreenPoint): WorldVector
}): ScreenBasis {
  const { right, down } = view.screenAxesInWorld()
  return {
    right,
    down,
    worldDeltaToScreen: (delta) => view.worldDeltaToScreen(delta),
    screenDeltaToWorld: (delta) => view.screenDeltaToWorld(delta),
  }
}
