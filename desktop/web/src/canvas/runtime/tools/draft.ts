// canvas/runtime/tools/draft.ts  (world-space presentations)

import type { ToolHandleId } from '../interaction-types'
import type { ScreenPoint, WorldPoint, WorldQuad } from '../../../geo/view/types'
import type { GhostEntity } from './tool'

export type DraftShape =
  | { readonly kind: 'polyline'; readonly points: readonly WorldPoint[]; readonly style: DraftStroke }
  | { readonly kind: 'polygon'; readonly points: readonly WorldPoint[]; readonly style: DraftStroke; readonly fill?: DraftFill }
  | { readonly kind: 'quad'; readonly corners: WorldQuad; readonly style: DraftStroke; readonly fill?: DraftFill }   // band select
  | { readonly kind: 'ellipse'; readonly center: WorldPoint; readonly radiusX: number; readonly radiusY: number; readonly rotationDeg: number; readonly style: DraftStroke; readonly fill?: DraftFill }
  | { readonly kind: 'circle-px'; readonly center: WorldPoint; readonly radiusPx: number; readonly style: DraftStroke }
  | { readonly kind: 'ghost'; readonly entity: GhostEntity; readonly opacity: number }
  | { readonly kind: 'label'; readonly anchor: WorldPoint; readonly offsetPx: ScreenPoint; readonly text: string; readonly tone: 'measure' | 'measure-quiet' | 'hint' | 'hint-primary'
      readonly beside?: LabelBeside }  // upright chip
// A label is today's UI chip, drawn upright in Pixi in Source Sans 3; its tone carries the whole chip style (spec §1.4):
// 'measure' centred at weight 600, 'measure-quiet' the same at 400, 'hint' bottom-centre, 'hint-primary' the same in the
// primary colour.
/** A chip drawn beside its point rather than on it: moved along the unit screen `normalPx` until its nearest side is
 *  `gapPx` past anchor + offset, whatever the chip's size (an edge chip beside its midpoint dot, U38). */
interface LabelBeside { readonly normalPx: ScreenPoint; readonly gapPx: number }
/** widthPx and dash (dash, gap, … lengths: an even-length list of positive numbers) are CSS px at every scale; the casing is widthPx + OVERLAY_CASING_EXTRA_PX. The renderer converts them
 *  to world units at the scale it draws with and re-traces when that scale changes (plan 0D1 "Transform until 0D2"). */
export type DraftStroke = { readonly token: 'draft' | 'selection'; readonly widthPx: number; readonly dash?: readonly number[] }
export type DraftFill = { readonly token: 'draft-fill' | 'selection-fill' }
// Draft tokens resolve to canvas colours in canvas/runtime/scene-visuals.ts (getDraftVisual, beside the overlay visuals; plan 0D1).
export interface DraftPresentation { readonly shapes: readonly DraftShape[] }

export interface ToolHandle {
  readonly id: ToolHandleId              // unique across objects: 'rotate', 'vertex:<zone id>:<index>', 'rect-corner:<id>:ne', 'guide-end:<id>:a', 'edge-mid:<zone id>:<edge index>'
  readonly anchor: WorldPoint
  readonly offsetPx?: ScreenPoint        // rotate handle: centred 28 px above the selection's projected hull, 48 px while dots show
  readonly hitRadiusPx: number           // a point 10, a midpoint dot 8, the rotate handle 14; 22 after a touch (44 px, ADR 0010; select/handle-size.ts)
  readonly glyph: 'vertex' | 'corner' | 'rotate' | 'midpoint'
  readonly label: string                 // aria-label, translated through ctx.translate (i18n-completeness scans for literals)
  readonly readout?: string              // live chip beside the handle (the rotate handle's '+15°'); the host marks the dragged handle active
}
