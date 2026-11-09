import { CANVAS_CHROME_FONT_FAMILY } from '../chrome-fonts'
import { canvasFonts } from './font-loading'
import { getCanvasTextOpacity } from './text-visibility'
import type { SceneAnnotationEntity, SceneDesignObjectSelection, ScenePoint } from './scene'

interface AnnotationTextMetrics {
  widthPx: number
  heightPx: number
  lineHeightPx: number
}

export interface AnnotationWorldBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface AnnotationScreenFrame {
  origin: ScenePoint
  widthPx: number
  heightPx: number
  lineHeightPx: number
  rotationDeg: number
}

/** The drawn outline's margin about a note's text frame, CSS px; a shown note's click target is that outline (Q7). */
const ANNOTATION_OUTLINE_PADDING_PX = { x: 4, y: 2 } as const
const ANNOTATION_MARKER_SIZE_PX = 8
const ANNOTATION_MARKER_STROKE_PX = 1.5
const ANNOTATION_MARKER_PATHS: readonly (readonly ScenePoint[])[] = [
  [{ x: -4, y: -4 }, { x: 4, y: -4 }, { x: 4, y: 4 }, { x: -4, y: 4 }, { x: -4, y: -4 }],
  [{ x: -2, y: -1 }, { x: 2, y: -1 }],
  [{ x: -2, y: 1 }, { x: 1, y: 1 }],
]
const COMPACT_MARKER_PATHS = [ANNOTATION_MARKER_PATHS[0]!.map(({ x, y }) => ({ x: x / 2, y: y / 2 }))]

export function getRevealedAnnotationId(selection: SceneDesignObjectSelection): string | null {
  return selection.length === 1 && selection[0]?.kind === 'annotation' ? selection[0].id : null
}

/** How a note shows at a scale. Its frames are in CSS px about the note's anchor, its position projected through the view. */
export function getAnnotationPresentation(
  annotation: SceneAnnotationEntity,
  pixelsPerMetre: number,
  revealText = false,
  textAllowed = true,
) {
  const textOpacity = revealText ? 1 : textAllowed ? getCanvasTextOpacity(pixelsPerMetre) : 0
  const textFrame = annotationScreenFrameAt(annotation, { x: 0, y: 0 })
  const markerOwnsGeometry = textOpacity < 0.5
  const compact = !textAllowed && getCanvasTextOpacity(pixelsPerMetre) > 0
  const markerSize = compact ? 4 : ANNOTATION_MARKER_SIZE_PX
  return {
    textOpacity,
    markerOpacity: (1 - textOpacity) * (compact ? 0.5 : 1),
    /** The half-size marker of a note whose text the detail layout keeps hidden. */
    compact,
    markerPaths: compact ? COMPACT_MARKER_PATHS : ANNOTATION_MARKER_PATHS,
    markerStrokePx: compact ? 1 : ANNOTATION_MARKER_STROKE_PX,
    markerOwnsGeometry,
    textFrame,
    frame: markerOwnsGeometry ? {
      origin: { x: textFrame.origin.x - markerSize / 2, y: textFrame.origin.y - markerSize / 2 },
      widthPx: markerSize,
      heightPx: markerSize,
      lineHeightPx: 0,
      rotationDeg: 0,
    } : textFrame,
  }
}

export function getAnnotationVisualWorldCorners(
  annotation: SceneAnnotationEntity,
  viewportScale: number,
  revealText = false,
  textAllowed = true,
): ScenePoint[] {
  const { frame } = getAnnotationPresentation(annotation, viewportScale, revealText, textAllowed)
  const safeScale = Math.max(viewportScale, 0.001)
  return rotatedRectCorners(
    { x: annotation.position.x + frame.origin.x / safeScale, y: annotation.position.y + frame.origin.y / safeScale },
    frame.widthPx / safeScale,
    frame.heightPx / safeScale,
    frame.rotationDeg,
  )
}

/** A note's drawn outline in CSS px about its anchor: `frame` padded 4 px across and 2 px down, turned by its angle. */
export function annotationOutlineCorners(frame: AnnotationScreenFrame): ScenePoint[] {
  return rotatedRectCorners(frame.origin, frame.widthPx, frame.heightPx, frame.rotationDeg, ANNOTATION_OUTLINE_PADDING_PX)
}

export function getAnnotationVisualWorldBounds(
  annotation: SceneAnnotationEntity,
  viewportScale: number,
  revealText = false,
  textAllowed = true,
): AnnotationWorldBounds {
  return boundsForPoints(getAnnotationVisualWorldCorners(annotation, viewportScale, revealText, textAllowed))
}

export function isPointInAnnotationPresentation(
  annotation: SceneAnnotationEntity,
  point: ScenePoint,
  viewportScale: number,
  revealText = false,
  textAllowed = true,
): boolean {
  if (revealText || (textAllowed && getCanvasTextOpacity(viewportScale) >= 0.5)) {
    return isPointInAnnotationOutline(annotation, point, viewportScale)
  }
  // Pointer allowance follows the visible marker, including crowded notes.
  const { frame } = getAnnotationPresentation(annotation, viewportScale, false, textAllowed)
  const radius = (frame.widthPx / 2 + 4) / Math.max(viewportScale, 0.001)
  return Math.abs(point.x - annotation.position.x) <= radius + HIT_EPSILON
    && Math.abs(point.y - annotation.position.y) <= radius + HIT_EPSILON
}

const CHARACTER_WIDTH_FACTOR = 0.6
const LINE_HEIGHT_FACTOR = 1.25
const HIT_EPSILON = 0.000001

type MeasureContext = Pick<CanvasRenderingContext2D, 'font' | 'measureText'>

/** The 2D context notes are measured with; null where there is none, and undefined until the first note asks. */
let measureContext: MeasureContext | null | undefined
const textMetricsByKey = new Map<string, AnnotationTextMetrics>()
/** The font epoch the memoised widths were measured at. */
let metricsEpoch = canvasFonts.epoch()

/** Counts the web-font loads that re-measured the notes; memos of anything sized by a note keep it in their key. */
export function getAnnotationFontEpoch(): number {
  return canvasFonts.epoch()
}

/** Calls `listener` after a web font loaded and the notes measure anew; returns the unsubscribe. */
export function onAnnotationFontLoad(listener: () => void): () => void {
  return canvasFonts.subscribe(listener)
}

/**
 * A note's text box: each line measured by the browser in the font the renderer draws it in, as Pixi's
 * CanvasTextMetrics measures it, without the halo Pixi adds to its texture (the glyphs start half a halo in, so the
 * outline's 4 px margin ends about 2 px past the last glyph). Memoised by size and text. Policy P5c keeps Pixi out of
 * this module's importers (the tools), hence the 2D context of its own.
 */
function getAnnotationTextMetrics(annotation: Pick<SceneAnnotationEntity, 'text' | 'fontSize'>): AnnotationTextMetrics {
  // A font load forgets every width measured in the fallback.
  if (metricsEpoch !== canvasFonts.epoch()) {
    metricsEpoch = canvasFonts.epoch()
    textMetricsByKey.clear()
  }
  const key = `${annotation.fontSize}|${annotation.text}`
  const known = textMetricsByKey.get(key)
  if (known) return known
  const lines = annotation.text.split('\n')
  const lineHeightPx = annotation.fontSize * LINE_HEIGHT_FACTOR
  const metrics = {
    widthPx: measureLinesWidth(lines, annotation.fontSize),
    heightPx: Math.max(lines.length * lineHeightPx, annotation.fontSize),
    lineHeightPx,
  }
  if (textMetricsByKey.size >= 512) textMetricsByKey.clear()
  textMetricsByKey.set(key, metrics)
  return metrics
}

function measureLinesWidth(lines: readonly string[], fontSize: number): number {
  const context = getMeasureContext()
  // No 2D context (jsdom): 0.6 em per character.
  if (!context) return Math.max(...lines.map((line) => line.length), 1) * fontSize * CHARACTER_WIDTH_FACTOR
  const font = `${fontSize}px ${CANVAS_CHROME_FONT_FAMILY}`
  context.font = font
  canvasFonts.request(font, lines.join(''))
  return Math.max(...lines.map((line) => {
    const measured = context.measureText(line)
    return Math.max(measured.width, measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight)
  }))
}

/**
 * Probed once. A page without the font loading API cannot say when the web font arrives, so it keeps the estimate
 * rather than a width measured in a fallback font for good.
 */
function getMeasureContext(): MeasureContext | null {
  if (measureContext !== undefined) return measureContext
  try {
    measureContext = !globalThis.document?.fonts ? null
      : typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('2d')
        : document.createElement('canvas').getContext('2d')
  } catch {
    measureContext = null
  }
  return measureContext
}

export function getAnnotationWorldBounds(
  annotation: SceneAnnotationEntity,
  viewportScale: number,
): AnnotationWorldBounds {
  return boundsForPoints(getAnnotationWorldCorners(annotation, viewportScale))
}

/** A note's text frame at an origin already projected. */
function annotationScreenFrameAt(
  annotation: Pick<SceneAnnotationEntity, 'text' | 'fontSize' | 'rotationDeg'>,
  origin: ScenePoint,
): AnnotationScreenFrame {
  const metrics = getAnnotationTextMetrics(annotation)
  return {
    origin,
    widthPx: metrics.widthPx,
    heightPx: metrics.heightPx,
    lineHeightPx: metrics.lineHeightPx,
    rotationDeg: annotation.rotationDeg ?? 0,
  }
}

function getAnnotationWorldCorners(annotation: SceneAnnotationEntity, viewportScale: number): ScenePoint[] {
  const safeScale = Math.max(viewportScale, 0.001)
  const metrics = getAnnotationTextMetrics(annotation)
  return rotatedRectCorners(annotation.position, metrics.widthPx / safeScale, metrics.heightPx / safeScale, annotation.rotationDeg ?? 0)
}

function isPointInAnnotationOutline(
  annotation: SceneAnnotationEntity,
  point: ScenePoint,
  viewportScale: number,
): boolean {
  const safeScale = Math.max(viewportScale, 0.001)
  const metrics = getAnnotationTextMetrics(annotation)
  const local = inverseRotatePoint(point, annotation.position, annotation.rotationDeg ?? 0)
  const padX = ANNOTATION_OUTLINE_PADDING_PX.x / safeScale
  const padY = ANNOTATION_OUTLINE_PADDING_PX.y / safeScale
  return (
    local.x >= -padX - HIT_EPSILON &&
    local.x <= metrics.widthPx / safeScale + padX + HIT_EPSILON &&
    local.y >= -padY - HIT_EPSILON &&
    local.y <= metrics.heightPx / safeScale + padY + HIT_EPSILON
  )
}

/** A `width` by `height` rectangle grown by `padding` on each side, turned by `rotationDeg` about `origin`, its unpadded corner. */
function rotatedRectCorners(
  origin: ScenePoint,
  width: number,
  height: number,
  rotationDeg: number,
  padding: ScenePoint = { x: 0, y: 0 },
): ScenePoint[] {
  const localCorners = [
    { x: -padding.x, y: -padding.y },
    { x: width + padding.x, y: -padding.y },
    { x: width + padding.x, y: height + padding.y },
    { x: -padding.x, y: height + padding.y },
  ]
  return localCorners.map((point) => rotateLocalPoint(point, origin, rotationDeg))
}

function rotateLocalPoint(point: ScenePoint, origin: ScenePoint, rotationDeg: number): ScenePoint {
  const radians = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: origin.x + point.x * cos - point.y * sin,
    y: origin.y + point.x * sin + point.y * cos,
  }
}

function inverseRotatePoint(point: ScenePoint, origin: ScenePoint, rotationDeg: number): ScenePoint {
  const radians = (-rotationDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point.x - origin.x
  const dy = point.y - origin.y
  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos,
  }
}

function boundsForPoints(points: readonly ScenePoint[]): AnnotationWorldBounds {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  }
}
