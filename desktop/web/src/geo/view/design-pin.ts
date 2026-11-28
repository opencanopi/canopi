// canvas/runtime/view/design-pin.ts  (pure)
//
// Owns where the overview's Design pin is on screen (canopi-n2cg): its point, the plane origin's screen point in overview
// (none within 24 px of an edge), and its box, the extent the pin element measures about that point
// (ViewCommandSurface.setDesignPinExtent). The ToolHost hit-tests a tap and a hover in overview against the box, so the
// pin's tap, cursor and tooltip come from the map's own input; the pin element is transparent to the pointer.

import type { DesignPinExtent, ScreenPoint, ViewFrame } from './types'

/** The overview pin shows only this many CSS px or more inside every screen edge. */
const DESIGN_PIN_EDGE_MARGIN_PX = 24

/** The plane origin's screen point in overview, rounded after the edge test, or null. */
export function designPinPoint(frame: ViewFrame): ScreenPoint | null {
  if (frame.mode !== 'overview') return null
  const origin = frame.view.worldToScreen({ x: 0, y: 0 })
  const { screen } = frame.view
  const inside = origin.x >= DESIGN_PIN_EDGE_MARGIN_PX
    && origin.x <= screen.width - DESIGN_PIN_EDGE_MARGIN_PX
    && origin.y >= DESIGN_PIN_EDGE_MARGIN_PX
    && origin.y <= screen.height - DESIGN_PIN_EDGE_MARGIN_PX
  return inside ? { x: Math.round(origin.x), y: Math.round(origin.y) } : null
}

/** Whether a screen point is on the pin: false while no pin shows or before it measured its box. */
export function designPinContains(frame: ViewFrame, extent: DesignPinExtent | null, at: ScreenPoint): boolean {
  const point = extent ? designPinPoint(frame) : null
  if (!point || !extent) return false
  return at.x >= point.x + extent.left && at.x <= point.x + extent.right
    && at.y >= point.y + extent.top && at.y <= point.y + extent.bottom
}

/** A measured extent the pin may register: finite, and about its point; anything else registers none. */
export function validDesignPinExtent(extent: DesignPinExtent | null): DesignPinExtent | null {
  if (!extent) return null
  const finite = [extent.left, extent.top, extent.right, extent.bottom].every(Number.isFinite)
  return finite && extent.left <= 0 && extent.top <= 0 && extent.right >= 0 && extent.bottom >= 0 ? extent : null
}
