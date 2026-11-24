/**
 * Paint helpers the scene's layers share (world-layers.ts, billboard-layer.ts,
 * draft-layer.ts): CSS colours as Pixi paint, cased interaction strokes,
 * dashes, text styles, the reuse keys that keep retained geometry, and the one
 * write of the view's affine to a world root.
 */

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import { Container, TextStyle, type Graphics, type Text, type TextStyleOptions } from 'pixi.js'
import { isSceneObjectGroupMemberTarget, type ScenePoint } from '../scene'
import {
  getCanvasInteractionStrokeVisual,
  getLabelHalo,
  OVERLAY_CASING_EXTRA_PX,
  type CanvasInteractionStrokeVisual,
  type CanvasInteractionVisualState,
} from '../scene-visuals'
import type { ViewTransform } from '../../../geo/view/types'
import type { SceneRendererHoverState, SceneRendererSnapshot } from './scene-types'

/**
 * Pixi world root (ADR 0016, 2.1-M520): overrides `updateLocalTransform` to write the view's
 * 2×3 general affine directly into `localTransform`, avoiding position/scale/rotation/skew
 * decomposition so anisotropic WGS84 ground-metre affines stay exact on one transform path.
 */
export class WorldRootContainer extends Container {
  private readonly affine: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0]
  private appliedTick = -1

  setAffine(values: readonly [number, number, number, number, number, number]): void {
    this.affine[0] = values[0]
    this.affine[1] = values[1]
    this.affine[2] = values[2]
    this.affine[3] = values[3]
    this.affine[4] = values[4]
    this.affine[5] = values[5]
    this.appliedTick = -1
    // Public ObservablePoint.set triggers Pixi's dirty tick even when tx/ty are unchanged,
    // keeping getGlobalPosition() consistent without touching private Container internals.
    this.position.set(values[4] + 1, values[5])
    this.position.set(values[4], values[5])
  }

  override updateLocalTransform(): void {
    const tick = this._didContainerChangeTick
    if (this.appliedTick === tick) return
    this.appliedTick = tick
    const lt = this.localTransform
    lt.a = this.affine[0]
    lt.b = this.affine[1]
    lt.c = this.affine[2]
    lt.d = this.affine[3]
    lt.tx = this.affine[4]
    lt.ty = this.affine[5]
  }
}

/** A world root's transform: the view's general affine, so world shapes keep their ground metres (ADR 0016, 2.1-M520). */
export function writeWorldAffine(root: WorldRootContainer, view: ViewTransform): void {
  root.setAffine(view.planar.affine)
}

/** CSS px as world units at `pixelsPerMetre`: the scene's one rule for screen-weight strokes in a world root. */
export function screenPxToWorldPx(px: number, pixelsPerMetre: number): number {
  return px / Math.max(pixelsPerMetre, 0.001)
}

export interface CasedStroke {
  readonly casing: { color: number; width: number; alpha: number }
  readonly stroke: { color: number; width: number; alpha: number }
}

/** Resolves the interaction stroke, or the base overlay stroke, and the casing drawn under it. */
export function resolveCasedStroke(
  interactionVisual: CanvasInteractionStrokeVisual | null,
  base: { color: string; casing: string },
  baseWidthPx: number,
  pixelsPerMetre: number,
): CasedStroke {
  return casedStroke(interactionVisual ?? {
    color: base.color,
    widthPx: baseWidthPx,
    alpha: 1,
    casingColor: base.casing,
    casingWidthPx: baseWidthPx + OVERLAY_CASING_EXTRA_PX,
  }, pixelsPerMetre)
}

/** Screen-pixel widths become world units under the view (`pixelsPerMetre` 1 for CSS-pixel layers). */
export function casedStroke(visual: CanvasInteractionStrokeVisual, pixelsPerMetre: number): CasedStroke {
  return {
    casing: {
      color: toPixiColor(visual.casingColor),
      width: screenPxToWorldPx(visual.casingWidthPx, pixelsPerMetre),
      alpha: visual.alpha * cssColorAlpha(visual.casingColor),
    },
    stroke: {
      color: toPixiColor(visual.color),
      width: screenPxToWorldPx(visual.widthPx, pixelsPerMetre),
      alpha: visual.alpha * cssColorAlpha(visual.color),
    },
  }
}

/** The cased outline of an interaction state in CSS px. */
export function interactionOutline(state: CanvasInteractionVisualState): CasedStroke {
  return casedStroke(getCanvasInteractionStrokeVisual(state), 1)
}

export function drawClosedPath(graphics: Graphics, points: readonly ScenePoint[]): Graphics {
  const first = points[0]
  if (!first) return graphics
  graphics.moveTo(first.x, first.y)
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!
    graphics.lineTo(point.x, point.y)
  }
  return graphics.closePath()
}

/**
 * Traces the dashes of a path by hand (Pixi has no dashed stroke). The phase
 * carries across vertices, so a dash that spans a corner stays one sub-path
 * and takes the stroke's join.
 */
export function traceDashedPath(graphics: Graphics, points: readonly ScenePoint[], closed: boolean, pattern: readonly number[]): void {
  const path = closed ? [...points, points[0]!] : points
  let index = 0
  let remaining = pattern[0]!
  let drawing = true
  let penDown = false
  for (let segment = 1; segment < path.length; segment += 1) {
    const from = path[segment - 1]!
    const to = path[segment]!
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    const end = length * (1 - 1e-12)
    let travelled = 0
    while (travelled < end) {
      const step = Math.min(remaining, length - travelled)
      if (drawing) {
        if (!penDown) {
          graphics.moveTo(from.x + ((to.x - from.x) * travelled) / length, from.y + ((to.y - from.y) * travelled) / length)
          penDown = true
        }
        const reached = travelled + step
        graphics.lineTo(from.x + ((to.x - from.x) * reached) / length, from.y + ((to.y - from.y) * reached) / length)
      }
      travelled += step
      remaining -= step
      if (remaining <= 0) {
        index = (index + 1) % pattern.length
        remaining = pattern[index]!
        drawing = !drawing
        penDown = false
      }
    }
  }
}

/** Destroys every entry `keep` does not name; a Design switch behind a hidden layer must not retain the old objects. */
export function destroyEntriesNotIn<T extends { removeFromParent(): void; destroy(): void }>(
  byId: Map<string, T>,
  keep: ReadonlySet<string>,
  destroy: (entry: T) => void = (entry) => entry.destroy(),
): void {
  for (const [id, entry] of byId) {
    if (keep.has(id)) continue
    entry.removeFromParent()
    destroy(entry)
    byId.delete(id)
  }
}

/** Removes and destroys the entry for `id`, if there is one. */
export function destroyEntry<T extends { removeFromParent(): void; destroy(): void }>(
  byId: Map<string, T>,
  id: string,
  destroy: (entry: T) => void = (entry) => entry.destroy(),
): void {
  const entry = byId.get(id)
  if (!entry) return
  entry.removeFromParent()
  destroy(entry)
  byId.delete(id)
}

export function cssColorAlpha(color: string): number {
  const channels = color.match(/^rgba\(([^)]+)\)$/i)?.[1]?.split(',')
  if (channels?.length === 4) return Number.parseFloat(channels[3]!)
  return parseHexColor(color)?.alpha ?? 1
}

/** A CSS colour as Pixi paint: the colour and its own alpha. */
export function pixiPaint(color: string): { readonly color: number; readonly alpha: number } {
  return { color: toPixiColor(color), alpha: cssColorAlpha(color) }
}

/** A CSS `rgb()`, `rgba()` or hex colour as a Pixi colour number; 0 for anything else. */
export function toPixiColor(color: string): number {
  const rgba = color.match(/rgba?\(([^)]+)\)/i)
  if (rgba) {
    const channels = rgba[1]!
      .split(',')
      .slice(0, 3)
      .map((channel) => Number.parseFloat(channel.trim()))
    if (channels.length === 3 && channels.every((channel) => Number.isFinite(channel))) {
      const [r, g, b] = channels.map((channel) => Math.max(0, Math.min(255, Math.round(channel)))) as [number, number, number]
      return (r << 16) + (g << 8) + b
    }
  }

  return parseHexColor(color)?.rgb ?? 0
}

// `#RGB`, `#RGBA`, `#RRGGBB` and `#RRGGBBAA`; anything else (named colours,
// hsl()) is not a colour this renderer knows.
function parseHexColor(color: string): { rgb: number; alpha: number } | null {
  const match = color.trim().match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (!match) return null
  let digits = match[1]!
  if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join('')
  const rgb = Number.parseInt(digits.slice(0, 6), 16)
  const alpha = digits.length === 8 ? Number.parseInt(digits.slice(6), 16) / 255 : 1
  return { rgb, alpha }
}

export function resolveInteractionState(
  selected: boolean,
  highlighted: boolean,
  hoverState: SceneRendererHoverState | null,
): CanvasInteractionVisualState | null {
  if (selected) return 'selected'
  if (hoverState) return hoverState
  return highlighted ? 'hover' : null
}

export function hoverStateForTarget(
  snapshot: SceneRendererSnapshot,
  kind: 'plant' | 'zone' | 'annotation' | 'measurement-guide',
  id: string,
): SceneRendererHoverState | null {
  const hoverTarget = snapshot.hoverTarget
  if (!hoverTarget) return null
  if (hoverTarget.kind === kind && hoverTarget.id === id) return hoverTarget.state
  if (kind === 'measurement-guide') return null
  if (hoverTarget.kind !== 'group') return null
  const group = snapshot.scene.groups.find((entry) => entry.id === hoverTarget.id)
  return group?.members.some((member) => isSceneObjectGroupMemberTarget(member, { kind, id }))
    ? hoverTarget.state
    : null
}

const textStyleKeys = new WeakMap<Text, string>()

/** The halo under map text, so it reads on the backdrop and on busy imagery. */
export function labelHaloStroke(fontSizePx: number): { color: number; width: number; join: 'round' } {
  const halo = getLabelHalo(fontSizePx)
  return { color: toPixiColor(halo.color), width: halo.widthPx, join: 'round' }
}

export function setTextStyle(text: Text, options: TextStyleOptions): void {
  const key = JSON.stringify(options)
  if (textStyleKeys.get(text) === key) return
  text.style = new TextStyle(options)
  textStyleKeys.set(text, key)
}

const graphicsKeys = new WeakMap<Graphics, string>()

/** True when `graphics` already holds the geometry `appearance` describes; otherwise records it for the redraw. */
export function reuseGeometry(graphics: Graphics, appearance: readonly unknown[]): boolean {
  const key = JSON.stringify(appearance)
  if (graphicsKeys.get(graphics) === key) return true
  graphicsKeys.set(graphics, key)
  return false
}
