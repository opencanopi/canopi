/**
 * The scene's world root (spec §1.5): the workspace's editing aid (the grid),
 * then zones and measurement guides, in world metres
 * under the view's affine. A frame writes the affine and nothing else; the
 * strokes and dashes, sized in CSS px, are traced at the zoom band's centre
 * scale (within 12 % of their size anywhere in the band) and again only when
 * the band changes (policy P12's behavioural half, `world-layers.test.ts`).
 * The grid is endless lines, traced over a box around the visible quad with a
 * margin, and again only when the view leaves that box, the band changes or
 * the snap interval steps.
 */

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import { Container, Graphics } from 'pixi.js'
import { gridInterval, NICE_DISTANCES } from '../../grid'
import {
  createMeasurementGuidePresentation,
  MEASUREMENT_GUIDE_DASH_PX,
  MEASUREMENT_GUIDE_GAP_PX,
  MEASUREMENT_GUIDE_TICK_HALF_PX,
} from '../measurement-guides'
import type { SceneMeasurementGuideEntity, ScenePoint, SceneZoneEntity } from '../scene'
import {
  getCanvasInteractionStrokeVisual,
  getGuideLineVisual,
  getSceneLayerStyle,
  resolveZoneVisual,
} from '../scene-visuals'
import { bandCentreScale, zoomBandOf } from '../../../geo/view/frame-source'
import type { SceneBounds, ViewTransform } from '../../../geo/view/types'
import { getEllipticalZonePolygon, getRectangularZoneCorners } from '../zone-geometry'
import {
  cssColorAlpha,
  destroyEntriesNotIn,
  drawClosedPath,
  hoverStateForTarget,
  pixiPaint,
  resolveCasedStroke,
  resolveInteractionState,
  reuseGeometry,
  screenPxToWorldPx,
  toPixiColor,
  traceDashedPath,
  writeWorldAffine,
} from './scene-paint'
import type { SceneEditingAids, SceneRendererHoverState, SceneRendererSnapshot } from './scene-types'

export const ZONE_STROKE_PX = 2
const MEASUREMENT_GUIDE_STROKE_PX = 1.5
/** The grid is traced this far past the visible box, as a share of its width and height. */
const EDITING_AIDS_MARGIN = 0.5
/** A major grid line every this many steps up `NICE_DISTANCES` from the minor interval. */
const GRID_MAJOR_STEP = 2
/** Past this many lines across the traced box the grid is not drawn (a jump to the overview before its scene arrives). */
const GRID_MAX_LINES = 1000
const GRID_LINE_PX = 1

export interface WorldLayers {
  /** The editing aids, zones, then measurement guides; its transform is the view's affine. */
  readonly root: Container
  /** One frame: the view's affine, and the strokes traced again for a new snapshot or a new scale. */
  present(view: ViewTransform, snapshot?: SceneRendererSnapshot): void
}

export function createWorldLayers(): WorldLayers {
  const root = new Container()
  const editingAidsLayer = new Container()
  const zonesLayer = new Container()
  const measurementGuideLayer = new Container()
  root.addChild(editingAidsLayer)
  root.addChild(zonesLayer)
  root.addChild(measurementGuideLayer)
  const zoneGraphicsById = new Map<string, Graphics>()
  const measurementGuideGraphicsById = new Map<string, Graphics>()
  const editingAids = createEditingAidsLayer(editingAidsLayer)
  let snapshot: SceneRendererSnapshot | null = null
  /** The latest view's zoom band; null before the first view. */
  let viewBand: number | null = null
  /** The band the strokes were traced in; null until a scene and a view have both arrived. */
  let tracedBand: number | null = null

  function trace(): void {
    if (!snapshot || viewBand === null) return
    const strokeScale = bandCentreScale(viewBand)
    syncZones(zonesLayer, zoneGraphicsById, snapshot, strokeScale)
    syncMeasurementGuides(measurementGuideLayer, measurementGuideGraphicsById, snapshot, strokeScale)
    tracedBand = viewBand
  }

  return {
    root,
    present(view, next) {
      writeWorldAffine(root, view)
      viewBand = zoomBandOf(view.pixelsPerMetre)
      if (next) snapshot = next
      editingAids.sync(snapshot?.editingAids ?? null, view)
      if (next || viewBand !== tracedBand) trace()
    },
  }
}

/**
 * The grid (spec §1.5, §4.6): world east-west and north-south lines that turn with the map, the lattice snapping uses
 * (`gridInterval` at the view's scale). It is traced over the visible box with a margin, again when the view leaves it,
 * the band changes or the snap interval steps; the ink is part of the reuse key.
 */
function createEditingAidsLayer(layer: Container) {
  let grid: Graphics | null = null
  /** The traced box, the snap interval's step and the band its lines were traced in. */
  let traced: GridTrace | null = null

  function traceFor(view: ViewTransform): GridTrace {
    const visible = boundsOf(view.visibleWorldQuad())
    const { index } = gridInterval(view.pixelsPerMetre)
    const band = zoomBandOf(view.pixelsPerMetre)
    if (traced && traced.index === index && traced.band === band && containsBounds(traced.box, visible)) return traced
    const marginX = (visible.maxX - visible.minX) * EDITING_AIDS_MARGIN
    const marginY = (visible.maxY - visible.minY) * EDITING_AIDS_MARGIN
    const box = { minX: visible.minX - marginX, minY: visible.minY - marginY, maxX: visible.maxX + marginX, maxY: visible.maxY + marginY }
    traced = { box, index, band }
    return traced
  }

  return {
    sync(aids: SceneEditingAids | null, view: ViewTransform): void {
      if (!aids) {
        grid?.removeFromParent()
        grid?.destroy()
        grid = null
        traced = null
        return
      }
      if (!grid) {
        grid = new Graphics({ label: 'grid' })
        layer.addChild(grid)
      }
      drawGrid(grid, aids.grid, traceFor(view))
    },
  }
}

interface GridTrace {
  readonly box: SceneBounds
  /** The snap interval's step in `NICE_DISTANCES`, at the view's exact scale. */
  readonly index: number
  readonly band: number
}

function boundsOf(points: readonly ScenePoint[]): SceneBounds {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

function containsBounds(outer: SceneBounds, inner: SceneBounds): boolean {
  return inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY
}

function drawGrid(graphics: Graphics, grid: SceneEditingAids['grid'], { box, index, band }: GridTrace): void {
  if (reuseGeometry(graphics, [grid, box, index, band])) return
  graphics.clear()
  const interval = NICE_DISTANCES[index]!
  if (Math.max(box.maxX - box.minX, box.maxY - box.minY) > interval * GRID_MAX_LINES) return
  const majorInterval = NICE_DISTANCES[Math.min(index + GRID_MAJOR_STEP, NICE_DISTANCES.length - 1)]!
  const width = screenPxToWorldPx(GRID_LINE_PX, bandCentreScale(band))
  traceLattice(graphics, box, interval)
  graphics.stroke({ ...pixiPaint(grid.ink), width })
  if (majorInterval <= interval) return
  traceLattice(graphics, box, majorInterval)
  graphics.stroke({ ...pixiPaint(grid.majorInk), width })
}

/** Lines at every whole multiple of `step` across the box, the values `snapToGrid` rounds to. */
function traceLattice(graphics: Graphics, box: SceneBounds, step: number): void {
  for (let index = Math.ceil(box.minX / step); index * step <= box.maxX; index += 1) {
    graphics.moveTo(index * step, box.minY).lineTo(index * step, box.maxY)
  }
  for (let index = Math.ceil(box.minY / step); index * step <= box.maxY; index += 1) {
    graphics.moveTo(box.minX, index * step).lineTo(box.maxX, index * step)
  }
}

/** `strokeScale`: the band's centre scale, which sizes every stroke traced in this band. */
function syncZones(layer: Container, graphicsById: Map<string, Graphics>, snapshot: SceneRendererSnapshot, strokeScale: number): void {
  const style = getSceneLayerStyle(snapshot.scene, 'zones')
  layer.visible = style.visible
  layer.alpha = style.opacity
  if (!style.visible) {
    destroyEntriesNotIn(graphicsById, new Set(snapshot.scene.zones.map((zone) => zone.id)))
    return
  }

  const nextZoneIds = new Set<string>()
  for (const zone of snapshot.scene.zones) {
    nextZoneIds.add(zone.id)
    const graphics = graphicsById.get(zone.id) ?? new Graphics()
    if (!graphicsById.has(zone.id)) {
      graphicsById.set(zone.id, graphics)
      layer.addChild(graphics)
    }
    drawZone(
      graphics,
      zone,
      snapshot.selectedZoneIds.has(zone.id),
      snapshot.highlightedZoneIds.has(zone.id),
      hoverStateForTarget(snapshot, 'zone', zone.id),
      strokeScale,
    )
  }
  destroyEntriesNotIn(graphicsById, nextZoneIds)
}

function drawZone(
  graphics: Graphics,
  zone: SceneZoneEntity,
  selected: boolean,
  highlighted: boolean,
  hoverState: SceneRendererHoverState | null,
  strokeScale: number,
): void {
  const visual = resolveZoneVisual(zone)
  const fillColor = toPixiColor(visual.fill)
  const fillAlpha = 0.2 * cssColorAlpha(visual.fill)
  const interactionState = resolveInteractionState(selected, highlighted, hoverState)
  const interactionVisual = interactionState ? getCanvasInteractionStrokeVisual(interactionState) : null
  const stroke = resolveCasedStroke(interactionVisual, { color: visual.stroke, casing: visual.casing }, ZONE_STROKE_PX, strokeScale)

  if (reuseGeometry(graphics, [zone.zoneType, zone.points, zone.rotationDeg, fillColor, fillAlpha, stroke])) return
  graphics.clear()

  if (!traceZonePath(graphics, zone)) return
  if (zone.zoneType !== 'line') graphics.fill({ color: fillColor, alpha: fillAlpha })
  graphics.stroke(stroke.casing)
  traceZonePath(graphics, zone)
  graphics.stroke(stroke.stroke)
}

/** Traces the zone outline in world metres; the caller fills and strokes it. Returns false when nothing is drawable. */
export function traceZonePath(graphics: Graphics, zone: SceneZoneEntity): boolean {
  if (zone.zoneType === 'rect' && zone.points.length >= 4) {
    if (Math.abs(zone.rotationDeg) > 0.000001) {
      const corners = getRectangularZoneCorners(zone)
      if (!corners) return false
      drawClosedPath(graphics, corners)
      return true
    }

    const start = zone.points[0]!
    const end = zone.points[2]!
    graphics.rect(start.x, start.y, end.x - start.x, end.y - start.y)
    return true
  }

  if (zone.zoneType === 'ellipse' && zone.points.length >= 2) {
    if (Math.abs(zone.rotationDeg) > 0.000001) {
      const polygon = getEllipticalZonePolygon(zone)
      if (!polygon) return false
      drawClosedPath(graphics, polygon)
      return true
    }

    const center = zone.points[0]!
    const radii = zone.points[1]!
    graphics.ellipse(center.x, center.y, radii.x, radii.y)
    return true
  }

  if (zone.points.length < 2) return false

  const first = zone.points[0]!
  graphics.moveTo(first.x, first.y)
  for (let i = 1; i < zone.points.length; i += 1) {
    const point = zone.points[i]!
    graphics.lineTo(point.x, point.y)
  }
  if (zone.zoneType !== 'line') graphics.closePath()
  return true
}

function syncMeasurementGuides(
  layer: Container,
  graphicsById: Map<string, Graphics>,
  snapshot: SceneRendererSnapshot,
  strokeScale: number,
): void {
  const style = getSceneLayerStyle(snapshot.scene, 'measurement-guides')
  layer.visible = style.visible
  layer.alpha = style.opacity
  if (!style.visible) {
    destroyEntriesNotIn(graphicsById, new Set(snapshot.scene.measurementGuides.map((guide) => guide.id)))
    return
  }

  const nextIds = new Set<string>()
  for (const guide of snapshot.scene.measurementGuides) {
    if (!drawMeasurementGuide(graphicsById, layer, guide, snapshot, strokeScale)) continue
    nextIds.add(guide.id)
  }
  destroyEntriesNotIn(graphicsById, nextIds)
}

/** Draws a guide too short to measure as nothing and returns false. */
function drawMeasurementGuide(
  graphicsById: Map<string, Graphics>,
  layer: Container,
  guide: SceneMeasurementGuideEntity,
  snapshot: SceneRendererSnapshot,
  strokeScale: number,
): boolean {
  const presentation = createMeasurementGuidePresentation(guide)
  if (!presentation) return false
  let graphics = graphicsById.get(guide.id)
  if (!graphics) {
    graphics = new Graphics()
    graphicsById.set(guide.id, graphics)
    layer.addChild(graphics)
  }

  const interactionState = resolveInteractionState(
    snapshot.selectedMeasurementGuideIds.has(guide.id),
    false,
    hoverStateForTarget(snapshot, 'measurement-guide', guide.id),
  )
  const interactionVisual = interactionState ? getCanvasInteractionStrokeVisual(interactionState) : null
  const stroke = resolveCasedStroke(interactionVisual, getGuideLineVisual(), MEASUREMENT_GUIDE_STROKE_PX, strokeScale)
  if (reuseGeometry(graphics, [guide.start, guide.end, stroke, strokeScale])) return true
  graphics.clear()
  const units = (px: number) => screenPxToWorldPx(px, strokeScale)
  const trace = () => {
    traceDashedPath(graphics, [guide.start, guide.end], false, [units(MEASUREMENT_GUIDE_DASH_PX), units(MEASUREMENT_GUIDE_GAP_PX)])
    drawTick(graphics, guide.start, presentation.normalWorld, units(MEASUREMENT_GUIDE_TICK_HALF_PX))
    drawTick(graphics, guide.end, presentation.normalWorld, units(MEASUREMENT_GUIDE_TICK_HALF_PX))
  }
  trace()
  graphics.stroke(stroke.casing)
  trace()
  graphics.stroke(stroke.stroke)
  return true
}

function drawTick(graphics: Graphics, point: ScenePoint, normal: ScenePoint, halfLength: number): void {
  graphics.moveTo(point.x - normal.x * halfLength, point.y - normal.y * halfLength)
    .lineTo(point.x + normal.x * halfLength, point.y + normal.y * halfLength)
}
