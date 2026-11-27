import { CANVAS_CHROME_FONT_FAMILY } from '../chrome-fonts'
import {
  buildPlantPresentationEntries,
  getStackBadgeOffsetPx,
  plantStackCounts,
  STACK_BADGE_FONT_SIZE_PX,
  getStackBadgeSizePx,
  type PlantPresentationEntry,
} from './plant-presentation'
import {
  getPlantSymbolArt,
  ROUND_PLANT_SYMBOL_RADIUS,
  tracePlantSymbolContours,
} from './plant-symbol-recipes'
import type { SpeciesCacheEntry } from './presentation-data'
import type { ScenePersistedState, SceneZoneEntity } from './scene'
import {
  getCanvasInteractionStrokeVisual,
  getPlantSymbolEdgeColor,
  getPlantSymbolEdgeWidth,
  getSceneLayerStyle,
  getStackBadgeBackgroundColor,
  getStackBadgeTextColor,
  OVERLAY_CASING_EXTRA_PX,
  resolveZoneVisual,
} from './scene-visuals'
import type { ViewTransform } from '../../geo/view/types'
import { pixelsPerMetreAt } from '../../geo/view/view-transform'
import { isZoneClosed, traceZoneOutline } from './zone-geometry'
import { getCanvasColor } from '../theme-refresh'

const ZONE_STROKE_PX = 2

/** The lens preview sits on the themed paper (`--canvas-bg`), not on the map. */
function lensPaper(): string {
  return getCanvasColor('background')
}

/** What the lens paints: the scene's zones and plants with their layers, and the plant the lens has highlighted. */
interface InspectionLensScene {
  readonly scene: ScenePersistedState
  readonly speciesCache: ReadonlyMap<string, SpeciesCacheEntry>
  readonly hoveredPlantId: string | null
}

export interface InspectionLensDrawOptions {
  readonly widthPx: number
  readonly heightPx: number
  readonly dpr: number
  /**
   * An offscreen context of the given backing size, for a translucent Plants layer: its symbols and hover ring are
   * drawn opaque there and composited once, so overlaps are no darker than one plant. Null when none can be made: the
   * layer is then drawn opaque, which keeps the preview.
   */
  scratch(widthPx: number, heightPx: number): CanvasRenderingContext2D | null
}

/**
 * Paints the inspection lens preview: Zones and Plant Symbols on a Canvas2D
 * context, through the lens's own view. This is
 * renderer-neutral preview output (ADR 0004), not a scene renderer; it never
 * mounts on the workspace.
 */
export function drawInspectionLensScene(
  ctx: CanvasRenderingContext2D,
  lens: InspectionLensScene,
  view: ViewTransform,
  options: InspectionLensDrawOptions,
): void {
  const dpr = options.dpr
  const widthPx = Math.max(1, options.widthPx)
  const heightPx = Math.max(1, options.heightPx)

  applyScreenSpaceTransform(ctx, dpr)
  ctx.clearRect(0, 0, widthPx, heightPx)
  applyView(ctx, view)
  drawZones(ctx, lens.scene, view.pixelsPerMetre)
  drawPlants(ctx, lens, view, dpr, widthPx, heightPx, options.scratch)
}

function drawZones(ctx: CanvasRenderingContext2D, scene: ScenePersistedState, pixelsPerMetre: number): void {
  const layer = getSceneLayerStyle(scene, 'zones')
  if (!layer.visible) return

  for (const zone of scene.zones) {
    const visual = resolveZoneVisual(zone)
    ctx.beginPath()
    traceZonePath(ctx, zone)
    ctx.fillStyle = visual.fill
    ctx.globalAlpha = 0.2 * layer.opacity
    if (isZoneClosed(zone)) ctx.fill()
    ctx.globalAlpha = layer.opacity
    ctx.strokeStyle = visual.casing
    ctx.lineWidth = (ZONE_STROKE_PX + OVERLAY_CASING_EXTRA_PX) / pixelsPerMetre
    ctx.stroke()
    ctx.strokeStyle = visual.stroke
    ctx.lineWidth = ZONE_STROKE_PX / pixelsPerMetre
    ctx.stroke()
  }

  ctx.globalAlpha = 1
}

function traceZonePath(ctx: CanvasRenderingContext2D, zone: SceneZoneEntity): void {
  traceZoneOutline(zone, {
    rect: (x, y, width, height) => { ctx.rect(x, y, width, height) },
    ellipse: (cx, cy, rx, ry, rotationDeg) => {
      ctx.ellipse(cx, cy, rx, ry, (rotationDeg * Math.PI) / 180, 0, Math.PI * 2)
    },
    polyline: (points, closed) => {
      const first = points[0]
      if (!first) return
      ctx.moveTo(first.x, first.y)
      for (let i = 1; i < points.length; i += 1) {
        const point = points[i]!
        ctx.lineTo(point.x, point.y)
      }
      if (closed) ctx.closePath()
    },
  })
}

function drawPlants(
  ctx: CanvasRenderingContext2D,
  { scene, speciesCache, hoveredPlantId }: InspectionLensScene,
  view: ViewTransform,
  dpr: number,
  widthPx: number,
  heightPx: number,
  createScratch: InspectionLensDrawOptions['scratch'],
): void {
  const layer = getSceneLayerStyle(scene, 'plants')
  if (!layer.visible || layer.opacity <= 0) return
  // The Plants opacity applies once to the layer, as on the map: opaque symbols on a scratch, one drawImage at it.
  const backingWidth = Math.round(widthPx * dpr), backingHeight = Math.round(heightPx * dpr)
  const scratch = layer.opacity < 1 ? createScratch(backingWidth, backingHeight) : null
  const target = scratch ?? ctx
  if (scratch) {
    // The scratch is reused: clear its whole backing in device pixels, which a CSS-pixel clear misses at a fractional dpr.
    scratch.setTransform(1, 0, 0, 1, 0, 0)
    scratch.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height)
    applyScreenSpaceTransform(scratch, dpr)
    applyView(scratch, view)
  }

  // The one cull: symbolic footprints are bounded in CSS pixels, rings and stack badges included. Spacing reads every
  // plant, so a neighbour just outside the lens still sizes an edge plant.
  const margin = 32
  const scale = view.pixelsPerMetre
  const visiblePlants = scene.plants.filter((plant) => {
    const { x, y } = view.worldToScreen(plant.position)
    return x >= -margin && y >= -margin && x <= widthPx + margin && y <= heightPx + margin
  })
  const entries = buildPlantPresentationEntries(visiblePlants, {
    plants: scene.plants,
    pixelsPerMetre: scale,
    pixelsPerMetreAt: (point) => pixelsPerMetreAt(view, point),
    speciesCache,
    plantSpeciesSymbols: scene.plantSpeciesSymbols,
  }, new Set())
  const stackCounts = plantStackCounts(entries)
  // Plant glyphs and hover rings are screen-upright isotropic marks (2.1-M520, spec §4.8, §4.13):
  // draw them in screen-upright pixel space at worldToScreen(position) so neither bearing nor
  // anisotropic WGS84 plane stretch distorts the pictogram or circle.
  const upright = (position: { readonly x: number; readonly y: number }) => {
    const screen = view.worldToScreen(position)
    target.save()
    target.setTransform(dpr, 0, 0, dpr, 0, 0)
    target.translate(screen.x, screen.y)
    target.scale(scale, scale)
    target.translate(-position.x, -position.y)
  }
  for (const entry of entries) {
    upright(entry.plant.position)
    drawPlantSymbolGlyph(target, entry, scale)
    target.restore()
  }

  // The hover ring sits above every symbol, as on the map.
  const hovered = hoveredPlantId === null ? undefined : entries.find((entry) => entry.plant.id === hoveredPlantId)
  if (hovered) {
    upright(hovered.plant.position)
    const ring = getCanvasInteractionStrokeVisual('hover')
    target.beginPath()
    target.arc(hovered.plant.position.x, hovered.plant.position.y, hovered.radiusWorld * 1.4, 0, Math.PI * 2)
    target.globalAlpha = ring.alpha
    target.strokeStyle = ring.casingColor
    target.lineWidth = ring.casingWidthPx / scale
    target.stroke()
    target.strokeStyle = ring.color
    target.lineWidth = ring.widthPx / scale
    target.stroke()
    target.restore()
  }

  if (scratch) {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = layer.opacity
    ctx.drawImage(scratch.canvas, 0, 0)
    ctx.restore()
  }
  // Stack badges stay per shape, above every symbol.
  for (const entry of entries) {
    const stackCount = stackCounts.get(entry.plant.id)
    if (stackCount) drawStackBadge(ctx, entry, view.worldToScreen(entry.plant.position), stackCount, layer.opacity, dpr)
  }

  target.globalAlpha = 1
  ctx.globalAlpha = 1
}

function drawPlantSymbolGlyph(
  ctx: CanvasRenderingContext2D,
  entry: PlantPresentationEntry,
  viewportScale: number,
): void {
  const symbol = entry.dot ? 'round' : entry.symbol
  const { x, y } = entry.plant.position
  const r = entry.radiusWorld
  ctx.globalAlpha = 1
  ctx.fillStyle = entry.color
  if (entry.dot || symbol === 'round') {
    ctx.beginPath()
    ctx.arc(x, y, entry.dot ? r : r * ROUND_PLANT_SYMBOL_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    const edgeWidth = getPlantSymbolEdgeWidth(entry.radiusScreenPx * 2)
    if (!entry.dot && edgeWidth > 0) {
      ctx.strokeStyle = getPlantSymbolEdgeColor(entry.color, lensPaper())
      ctx.lineWidth = edgeWidth / viewportScale
      ctx.stroke()
    }
    return
  }
  const edge = getPlantSymbolEdgeColor(entry.color, lensPaper())
  const art = getPlantSymbolArt(symbol, entry.radiusScreenPx * 2)
  const edgeWidth = getPlantSymbolEdgeWidth(entry.radiusScreenPx * 2)
  ctx.strokeStyle = edge
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  tracePlantSymbolContours(ctx, art.body, x, y, r)
  // A zero line width is ignored by Canvas2D, so Outline off skips the stroke.
  if (edgeWidth > 0) {
    ctx.lineWidth = edgeWidth / viewportScale
    ctx.stroke()
  }
  ctx.fill('nonzero')
  if (art.cutouts.length === 0) return
  ctx.fillStyle = edge
  ctx.beginPath()
  tracePlantSymbolContours(ctx, art.cutouts, x, y, r)
  ctx.fill('nonzero')
}

function drawStackBadge(
  ctx: CanvasRenderingContext2D,
  entry: PlantPresentationEntry,
  at: { readonly x: number; readonly y: number },
  count: number,
  opacity: number,
  dpr: number,
): void {
  ctx.save()
  applyScreenSpaceTransform(ctx, dpr)
  const offset = getStackBadgeOffsetPx(entry.radiusScreenPx)
  const x = at.x + offset.x
  const y = at.y + offset.y
  ctx.globalAlpha = opacity
  ctx.fillStyle = getStackBadgeBackgroundColor(lensPaper())
  const size = getStackBadgeSizePx(String(count))
  ctx.beginPath()
  ctx.roundRect(x - size.width / 2, y - size.height / 2, size.width, size.height, size.height / 2)
  ctx.fill()
  ctx.fillStyle = getStackBadgeTextColor(lensPaper())
  ctx.font = `${STACK_BADGE_FONT_SIZE_PX}px ${CANVAS_CHROME_FONT_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(count), x, y)
  ctx.restore()
}

/** World metres to the backing store: the device-pixel scale already set, then the view's affine. */
function applyView(ctx: CanvasRenderingContext2D, view: ViewTransform): void {
  const { affine } = view.planar
  const current = ctx.getTransform()
  ctx.setTransform(current.a, current.b, current.c, current.d, 0, 0)
  ctx.transform(affine[0], affine[1], affine[2], affine[3], affine[4], affine[5])
}

function applyScreenSpaceTransform(ctx: CanvasRenderingContext2D, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}
