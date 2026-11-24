// canvas/runtime/view/fit.ts  (pure)
//
// Owns framing: the screen rectangle the chrome leaves, and the oriented fits that place a PlanarCamera inside it (Fit to Design
// over a scale-dependent point set, temporary focus on a box). A fit projects its points onto the screen axes at the target bearing
// and fits that extent, never a world-axis box; at bearing 0 the projection is the identity, so the fit is the plain planar fit
// (fit.test.ts holds the numbers).

import { bearingCosSin, normaliseBearing } from './navigation-policy'
import type { PlanarCamera, SceneBounds, SceneExtent, ScreenInsets, TemporaryBoundsFocusOptions, WorldPoint } from './types'

const FIT_PADDING = 0.1
const FIT_MAX_ROUNDS = 20
const FIT_CONVERGENCE_THRESHOLD = 0.0001
/** The least width and height framing keeps: a shorter free band grows to it around its centre. */
const MIN_FRAMING_EXTENT_CSS_PX = 120
/** Rounding room when checking that a framed box lands inside the free band. */
const FREE_BAND_TOLERANCE_CSS_PX = 1e-6
const NO_INSETS: ScreenInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 })

/** The screen rectangle fitting frames into, in CSS pixels. */
export interface FramingRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** What a fit frames into and starts from. */
export interface FitFrame {
  readonly screen: { readonly width: number; readonly height: number }
  /** Screen edges covered by floating chrome (the visible-map-area seam). */
  readonly insets?: ScreenInsets
  /** The effective scale bounds at the target bearing (ViewFrame.scaleBounds). */
  readonly scaleBounds: { readonly min: number; readonly max: number }
  /** The live placement: its scale seeds the extent loop, and it is kept when there is nothing to fit. */
  readonly current: PlanarCamera
}

/** Extent of a point set along the screen axes at a bearing: across = right, down = down. */
interface OrientedExtent {
  readonly minAcross: number
  readonly minDown: number
  readonly maxAcross: number
  readonly maxDown: number
}

/**
 * The part of the screen not covered by floating chrome. An axis the insets leave under 120 px grows to 120 px around the
 * centre of its free band, clamped to the screen, and the other axis keeps its insets (answer 17: a short window's chrome
 * can leave a thin band, and the Design is framed there, not under the chrome). Invalid insets frame the whole screen.
 */
export function framingRect(screen: { readonly width: number; readonly height: number }, insets: ScreenInsets = NO_INSETS): FramingRect {
  const across = framingSpan(screen.width, insets.left, insets.right)
  const down = framingSpan(screen.height, insets.top, insets.bottom)
  if (!across || !down) return { x: 0, y: 0, width: screen.width, height: screen.height }
  return { x: across.start, y: down.start, width: across.size, height: down.size }
}

/** One axis of the framing rectangle; null for invalid numbers. */
function framingSpan(extent: number, before: number, after: number): { start: number; size: number } | null {
  if (![extent, before, after].every(Number.isFinite)) return null
  const size = extent - before - after
  if (size >= MIN_FRAMING_EXTENT_CSS_PX) return { start: before, size }
  const grown = Math.min(MIN_FRAMING_EXTENT_CSS_PX, extent)
  const start = before + size / 2 - grown / 2
  return { start: Math.min(Math.max(start, 0), extent - grown), size: grown }
}

/**
 * Fit to Design at a bearing. Notes and default-mode plants are screen-sized, so the extent depends on the scale: the fit
 * recomputes it at each candidate scale until the scale changes by less than 0.01 % (at most 20 rounds; typically 2–3).
 */
export function fitScene(frame: FitFrame, extent: SceneExtent, bearingDeg: number): PlanarCamera {
  if (frame.screen.width <= 0 || frame.screen.height <= 0) return frame.current
  const rect = framingRect(frame.screen, frame.insets)
  const bearing = normaliseBearing(bearingDeg)

  let currentScale = frame.current.scale
  let bounds: OrientedExtent | null = null
  let scale = currentScale
  for (let round = 0; round < FIT_MAX_ROUNDS; round++) {
    bounds = orientedExtent(extent.extentPoints(currentScale), bearing)
    if (!bounds) return emptyScenePlacement(frame, extent.emptySceneScale, bearing)

    const contentWidth = Math.max(bounds.maxAcross - bounds.minAcross, 1)
    const contentHeight = Math.max(bounds.maxDown - bounds.minDown, 1)
    scale = clampScale(Math.min(
      (rect.width * (1 - FIT_PADDING * 2)) / contentWidth,
      (rect.height * (1 - FIT_PADDING * 2)) / contentHeight,
    ), frame.scaleBounds)

    if (Math.abs(scale - currentScale) / Math.max(scale, currentScale) < FIT_CONVERGENCE_THRESHOLD) break
    currentScale = scale
  }

  const finalBounds = bounds!
  const contentWidth = Math.max(finalBounds.maxAcross - finalBounds.minAcross, 1)
  const contentHeight = Math.max(finalBounds.maxDown - finalBounds.minDown, 1)
  return {
    x: rect.x + (rect.width - contentWidth * scale) / 2 - finalBounds.minAcross * scale,
    y: rect.y + (rect.height - contentHeight * scale) / 2 - finalBounds.minDown * scale,
    scale,
    bearingDeg: bearing,
  }
}

/**
 * Temporary focus (plant finder, LiDAR) at a bearing: the box's four corners are fitted, with symmetric CSS-pixel padding and
 * an optional scale ceiling. On the framing rectangle the padding takes at most a quarter of an axis from each side, so a
 * thin chrome band still frames the box in half of it. Null when the box, ceiling or screen cannot frame it, the screen
 * itself cannot hold the padding, or the framed box would not land inside the band the chrome leaves free (it would be
 * hidden, so the view is left alone).
 */
export function fitTemporaryBounds(
  frame: FitFrame,
  bounds: SceneBounds,
  options: TemporaryBoundsFocusOptions,
  bearingDeg: number,
): PlanarCamera | null {
  const { width: screenWidth, height: screenHeight } = frame.screen
  if (!Number.isFinite(screenWidth) || !Number.isFinite(screenHeight) || screenWidth <= 0 || screenHeight <= 0) return null
  const rect = framingRect(frame.screen, frame.insets)
  const { width, height } = rect
  const { minX, minY, maxX, maxY } = bounds
  const padding = options.paddingCssPx
  const maximumScale = options.maximumScale ?? frame.scaleBounds.max
  if (
    ![width, height, minX, minY, maxX, maxY, padding, maximumScale].every(Number.isFinite)
    || width <= 0
    || height <= 0
    || minX >= maxX
    || minY >= maxY
    || padding < 0
    || padding * 2 >= Math.min(screenWidth, screenHeight)
    || maximumScale < frame.scaleBounds.min
  ) return null

  const availableWidth = width - Math.min(padding, width / 4) * 2
  const availableHeight = height - Math.min(padding, height / 4) * 2

  const bearing = normaliseBearing(bearingDeg)
  const box = orientedExtent([
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ], bearing)!
  const scale = clampScale(Math.min(
    availableWidth / (box.maxAcross - box.minAcross),
    availableHeight / (box.maxDown - box.minDown),
    maximumScale,
  ), frame.scaleBounds)
  if (!Number.isFinite(scale) || scale > maximumScale) return null

  const centreX = rect.x + width / 2
  const centreY = rect.y + height / 2
  const halfWidth = ((box.maxAcross - box.minAcross) * scale) / 2
  const halfHeight = ((box.maxDown - box.minDown) * scale) / 2
  const free = freeBand(frame.screen, frame.insets)
  if (
    centreX - halfWidth < free.left - FREE_BAND_TOLERANCE_CSS_PX
    || centreX + halfWidth > free.right + FREE_BAND_TOLERANCE_CSS_PX
    || centreY - halfHeight < free.top - FREE_BAND_TOLERANCE_CSS_PX
    || centreY + halfHeight > free.bottom + FREE_BAND_TOLERANCE_CSS_PX
  ) return null

  return {
    x: centreX - ((box.minAcross + box.maxAcross) / 2) * scale,
    y: centreY - ((box.minDown + box.maxDown) / 2) * scale,
    scale,
    bearingDeg: bearing,
  }
}

/** The screen edges of the band floating chrome leaves free, before framingRect grows it; the whole screen for invalid insets. */
function freeBand(screen: { readonly width: number; readonly height: number }, insets: ScreenInsets = NO_INSETS) {
  const { top, right, bottom, left } = insets
  if (![top, right, bottom, left].every(Number.isFinite)) return { left: 0, top: 0, right: screen.width, bottom: screen.height }
  return { left, top, right: screen.width - right, bottom: screen.height - bottom }
}

/** Whether a scene has nothing to frame at a scale: the empty-scene branch of fitScene. */
export function isEmptyExtent(extent: SceneExtent, pixelsPerMetre: number): boolean {
  return orientedExtent(extent.extentPoints(pixelsPerMetre), 0) === null
}

/** Null for an empty or non-finite point set. */
function orientedExtent(points: readonly WorldPoint[], bearingDeg: number): OrientedExtent | null {
  const [cos, sin] = bearingCosSin(bearingDeg)
  const level = cos === 1 && sin === 0
  let minAcross = Number.POSITIVE_INFINITY
  let minDown = Number.POSITIVE_INFINITY
  let maxAcross = Number.NEGATIVE_INFINITY
  let maxDown = Number.NEGATIVE_INFINITY
  for (const point of points) {
    // The point's screen-axis components: turned counter-clockwise on screen by the bearing (the identity at bearing 0).
    const across = level ? point.x : cos * point.x + sin * point.y
    const down = level ? point.y : cos * point.y - sin * point.x
    minAcross = Math.min(minAcross, across)
    minDown = Math.min(minDown, down)
    maxAcross = Math.max(maxAcross, across)
    maxDown = Math.max(maxDown, down)
  }
  if (![minAcross, minDown, maxAcross, maxDown].every(Number.isFinite)) return null
  return { minAcross, minDown, maxAcross, maxDown }
}

/** An empty Design frames the session plane origin at the centre of the whole screen, or keeps the placement. */
function emptyScenePlacement(frame: FitFrame, emptySceneScale: number, bearingDeg: number): PlanarCamera {
  if (!(emptySceneScale > 0)) return frame.current
  const scale = clampScale(emptySceneScale, frame.scaleBounds)
  return { x: frame.screen.width / 2, y: frame.screen.height / 2, scale, bearingDeg }
}

function clampScale(scale: number, bounds: { readonly min: number; readonly max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, scale))
}
