/**
 * The active tool's draft in the Pixi scene (ADR 0019, spec §1.5), mounted as
 * the last two stage children so it draws over plants, notes and labels.
 * `worldDraftRoot` holds the world shapes and a ghost's zones under the view's
 * affine, written in the same scene `present` as the scene's world root;
 * `billboardDraftRoot` holds the upright parts in CSS px (a `circle-px`, a
 * label's chip, a ghost's plants and note text), each at its world anchor
 * projected through `view.projectAnchors`. Stroke widths, casings and dashes
 * are CSS px at every scale: they are traced in world units at the view's scale
 * and traced again when it changes, while a view that only moves repositions
 * the upright parts. Colours come from scene-visuals.ts and ghosts from the
 * scene's own painters. Convention: open polylines have round caps and joins,
 * closed shapes mitred corners and butt dash ends, as today's SVG and CSS
 * previews.
 */

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import { AlphaFilter, Container, Graphics, Rectangle, TextStyle, type Text } from 'pixi.js'
import { canvasFonts } from '../font-loading'
import type { SceneAnnotationEntity, ScenePlantEntity, SceneZoneEntity } from '../scene'
import {
  getDraftLabelVisual,
  getDraftVisual,
  OVERLAY_CASING_EXTRA_PX,
  type CanvasShadowVisual,
} from '../scene-visuals'
import type { DraftFill, DraftPresentation, DraftShape, DraftStroke } from '../tools/draft'
import type { GhostEntity } from '../tools/tool'
import type { ScreenPoint, ViewTransform, WorldPoint } from '../view/types'
import { pixiPaint, screenPxToWorldPx, traceDashedPath, writeWorldAffine } from './scene-paint'

/** Where the scene draws the active tool's draft; mounted by pixi-scene.ts. */
export interface DraftLayer {
  /** World shapes and a ghost's zones, under the view's affine like the scene's world root. */
  readonly worldDraftRoot: Container
  /** Upright parts in CSS px; stays untransformed. */
  readonly billboardDraftRoot: Container
  setView(view: ViewTransform): void
  setDraft(draft: DraftPresentation | null): void
  resize(width: number, height: number): void
  /** Releases the draft; the stage destroys the two containers. */
  dispose(): void
}

/** The scene's own drawing code (pixi-scene.ts), lent so a ghost looks like the object a click would create. */
export interface DraftScenePainters {
  /**
   * A zone as the stamp ghost draws it, in world units: its fill into `fill` (none for a line), its outline as the placed
   * zone's into `outline`; false when nothing is drawable.
   */
  drawZoneGhost(fill: Graphics, outline: Graphics, zone: SceneZoneEntity, scale: number): boolean
  /**
   * A plant's mark at the local origin in CSS px; false before the scene has a snapshot. A 'dot' takes its radius from the
   * plant's presentation at `sizeFrom` when given, else at the plant's own position.
   */
  drawPlantGhost(graphics: Graphics, plant: ScenePlantEntity, mark: 'symbol' | 'dot', scale: number, sizeFrom?: WorldPoint): boolean
  /** A note's text and marker at the local origin, and the opacities the scene gives them at `scale`; null for a note without text. */
  drawNoteGhost(
    text: Text,
    marker: Graphics,
    annotation: SceneAnnotationEntity,
    scale: number,
  ): { readonly textOpacity: number; readonly markerOpacity: number } | null
}

export interface DraftLayerOptions {
  readonly createText: () => Text
  readonly viewSize: { readonly width: number; readonly height: number }
  readonly painters: DraftScenePainters
  /** Asks for a frame after the layer redrew its draft on its own (a chip's font arrived). */
  readonly requestRepaint?: () => void
}

interface UprightPart {
  readonly node: Container
  readonly anchor: WorldPoint
  /** CSS px from the anchor's global point to the node's origin. */
  readonly offset: ScreenPoint
  /** Chips land on whole pixels so their text stays sharp. */
  readonly snap: boolean
  /** A note's text turns with the map: its drawn angle, less the bearing. Null for parts that stay upright. */
  readonly turn: number | null
}

interface StrokeEnds {
  readonly cap: 'round' | 'butt'
  readonly join: 'round' | 'miter'
}

const OPEN_ENDS: StrokeEnds = { cap: 'round', join: 'round' }
const CLOSED_ENDS: StrokeEnds = { cap: 'butt', join: 'miter' }
/** Ellipses and dashed markers are traced as polygons, so they can be dashed, with chords about this long on screen. */
const OUTLINE_CHORD_PX = 3
const MIN_OUTLINE_SEGMENTS = 48
const MAX_OUTLINE_SEGMENTS = 720
/** Rings that stand in for the chip shadow's blur. */
const CHIP_SHADOW_STEPS = 4
/** How far a shadow ring reaches past a side its step does not pass, so the chip stays a hole strictly inside it. */
const CHIP_SHADOW_HAIRLINE_PX = 0.25

export function createDraftLayer(options: DraftLayerOptions): DraftLayer {
  const { createText, painters } = options
  const world = new Container()
  const screen = new Container()
  let viewWidth = options.viewSize.width
  let viewHeight = options.viewSize.height
  let ghostFilterArea: Rectangle | null = null
  let draft: DraftPresentation | null = null
  let view: ViewTransform | null = null
  let tracedScale: number | null = null
  let anchors = new Float64Array(0)
  let anchorsOnScreen = new Float32Array(0)
  const drawn: Container[] = []
  const filters: AlphaFilter[] = []
  const upright: UprightPart[] = []
  // A chip drawn while its web font loads keeps the fallback (font-loading.ts): a load redraws the live draft.
  const unsubscribeFonts = canvasFonts.subscribe(() => {
    if (!draft || !view) return
    trace(draft, view)
    options.requestRepaint?.()
  })

  function clear(): void {
    for (const node of drawn.splice(0)) {
      node.removeFromParent()
      node.destroy({ children: true, context: true })
    }
    for (const filter of filters.splice(0)) filter.destroy()
    upright.length = 0
    tracedScale = null
  }

  function trace(next: DraftPresentation, at: ViewTransform): void {
    clear()
    const scale = at.pixelsPerMetre
    for (const shape of next.shapes) drawShape(shape, scale)
    tracedScale = scale
    if (anchors.length < upright.length * 2) {
      anchors = new Float64Array(upright.length * 2)
      anchorsOnScreen = new Float32Array(upright.length * 2)
    }
    upright.forEach((part, index) => {
      anchors[index * 2] = part.anchor.x
      anchors[index * 2 + 1] = part.anchor.y
    })
    positionUpright(at)
  }

  function positionUpright(at: ViewTransform): void {
    at.projectAnchors(anchors, anchorsOnScreen, upright.length)
    const bearingRad = (at.camera.bearingDeg * Math.PI) / 180
    upright.forEach((part, index) => {
      const x = anchorsOnScreen[index * 2]! + part.offset.x
      const y = anchorsOnScreen[index * 2 + 1]! + part.offset.y
      part.node.position.set(part.snap ? Math.round(x) : x, part.snap ? Math.round(y) : y)
      if (part.turn !== null) part.node.rotation = part.turn - bearingRad
    })
  }

  function add<T extends Container>(parent: Container, node: T): T {
    parent.addChild(node)
    drawn.push(node)
    return node
  }

  function addUpright(node: Container, anchor: WorldPoint, offset: ScreenPoint = { x: 0, y: 0 }, snap = false, turns = false): void {
    upright.push({ node, anchor, offset, snap, turn: turns ? node.rotation : null })
  }

  function drawShape(shape: DraftShape, scale: number): void {
    const worldUnits = (px: number) => screenPxToWorldPx(px, scale)
    switch (shape.kind) {
      case 'polyline':
        paintOutline(add(world, new Graphics()), shape.points, false, shape.style, undefined, worldUnits)
        return
      case 'polygon':
        paintOutline(add(world, new Graphics()), shape.points, true, shape.style, shape.fill, worldUnits)
        return
      case 'quad':
        paintOutline(add(world, new Graphics()), shape.corners, true, shape.style, shape.fill, worldUnits)
        return
      case 'ellipse':
        paintOutline(add(world, new Graphics()), ellipseOutline(shape, scale), true, shape.style, shape.fill, worldUnits)
        return
      case 'circle-px':
        drawMarker(shape)
        return
      case 'label':
        drawLabel(shape)
        return
      case 'ghost':
        drawGhost(shape.entity, shape.opacity, scale)
    }
  }

  function ellipseOutline(shape: Extract<DraftShape, { kind: 'ellipse' }>, scale: number): WorldPoint[] {
    const radiusX = Math.abs(shape.radiusX)
    const radiusY = Math.abs(shape.radiusY)
    const chord = screenPxToWorldPx(OUTLINE_CHORD_PX, scale)
    const segments = outlineSegments((2 * Math.PI * Math.max(radiusX, radiusY)) / chord)
    const turn = (shape.rotationDeg * Math.PI) / 180
    const cos = Math.cos(turn)
    const sin = Math.sin(turn)
    return Array.from({ length: segments }, (_, index) => {
      const angle = (index / segments) * Math.PI * 2
      const x = Math.cos(angle) * radiusX
      const y = Math.sin(angle) * radiusY
      return { x: shape.center.x + x * cos - y * sin, y: shape.center.y + x * sin + y * cos }
    })
  }

  /** Fills a closed outline, then strokes it over its casing, both following the dash. */
  function paintOutline(
    graphics: Graphics,
    points: readonly WorldPoint[],
    closed: boolean,
    style: DraftStroke,
    fill: DraftFill | undefined,
    units: (px: number) => number,
  ): void {
    if (fill && closed && points.length >= 3) {
      tracePath(graphics, points, true)
      graphics.fill(pixiPaint(getDraftVisual(fill.token).color))
    }
    if (points.length < 2) return
    strokeOutline(graphics, style, closed, units, (dash) => {
      if (dash) traceDashedPath(graphics, points, closed, dash)
      else tracePath(graphics, points, closed)
    })
  }

  /** The casing (`widthPx + OVERLAY_CASING_EXTRA_PX`), then the stroke; a width of 0 draws neither. */
  function strokeOutline(
    graphics: Graphics,
    style: DraftStroke,
    closed: boolean,
    units: (px: number) => number,
    traceOutline: (dash: readonly number[] | null) => void,
  ): void {
    if (!(style.widthPx > 0)) return
    const visual = getDraftVisual(style.token)
    // A dash list is an even-length list of positive (dash, gap) CSS px lengths, frozen by the tool that draws it.
    const dash = style.dash ? style.dash.map(units) : null
    const ends = closed ? CLOSED_ENDS : OPEN_ENDS
    traceOutline(dash)
    graphics.stroke({ ...pixiPaint(visual.casing), width: units(style.widthPx + OVERLAY_CASING_EXTRA_PX), ...ends })
    traceOutline(dash)
    graphics.stroke({ ...pixiPaint(visual.color), width: units(style.widthPx), ...ends })
  }

  function drawMarker(shape: Extract<DraftShape, { kind: 'circle-px' }>): void {
    const graphics = add(screen, new Graphics())
    const radius = Math.max(0, shape.radiusPx)
    strokeOutline(graphics, shape.style, true, (px) => px, (dash) => {
      if (!dash) {
        graphics.circle(0, 0, radius)
        return
      }
      const segments = outlineSegments((2 * Math.PI * radius) / OUTLINE_CHORD_PX)
      traceDashedPath(graphics, Array.from({ length: segments }, (_, index) => {
        const angle = (index / segments) * Math.PI * 2
        return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
      }), true, dash)
    })
    addUpright(graphics, shape.center)
  }

  function drawLabel(shape: Extract<DraftShape, { kind: 'label' }>): void {
    const visual = getDraftLabelVisual(shape.tone)
    canvasFonts.request(`${visual.fontWeight} ${visual.fontSizePx}px ${visual.fontFamily}`)
    const text = createText()
    text.text = shape.text
    text.style = new TextStyle({
      fontFamily: visual.fontFamily,
      fontSize: visual.fontSizePx,
      fontWeight: visual.fontWeight,
      fill: pixiPaint(visual.color),
      lineHeight: visual.lineHeightPx,
    })
    const inset = { x: visual.borderWidthPx + visual.paddingPx.x, y: visual.borderWidthPx + visual.paddingPx.y }
    const width = text.width + 2 * inset.x
    const height = text.height + 2 * inset.y
    text.position.set(inset.x, inset.y)

    // The DOM chip: --shadow-sm outside, the background under the border, the 1 px border inside the box.
    const box = new Graphics()
    drawChipShadow(box, visual.shadow, width, height, visual.radiusPx)
    box.roundRect(0, 0, width, height, visual.radiusPx).fill(pixiPaint(visual.background))
    const half = visual.borderWidthPx / 2
    box.roundRect(half, half, width - visual.borderWidthPx, height - visual.borderWidthPx, Math.max(0, visual.radiusPx - half))
      .stroke({ ...pixiPaint(visual.border), width: visual.borderWidthPx })

    const chip = add(screen, new Container())
    chip.addChild(box, text)
    // Beside a point, the chip's centre goes out along the normal by its own half-extent that way plus the gap.
    const beside = shape.beside
    const reach = beside ? Math.abs(beside.normalPx.x) * width / 2 + Math.abs(beside.normalPx.y) * height / 2 + beside.gapPx : 0
    addUpright(chip, shape.anchor, beside
      ? {
        x: shape.offsetPx.x + beside.normalPx.x * reach - width / 2,
        y: shape.offsetPx.y + beside.normalPx.y * reach - height / 2,
      }
      : {
        x: shape.offsetPx.x - width / 2,
        y: shape.offsetPx.y - (visual.placement === 'centre' ? height / 2 : visual.gapPx + height),
      }, true)
  }

  /**
   * A stepped stand-in for the CSS blur: the offset box grown by spreads from
   * inside to outside, whose alphas add up to the shadow's where every step
   * reaches. CSS clips an outer shadow to outside the border box, so each step
   * is a ring around the chip, and a step that stays inside the chip draws
   * nothing.
   */
  function drawChipShadow(
    graphics: Graphics,
    shadow: CanvasShadowVisual | null,
    width: number,
    height: number,
    radius: number,
  ): void {
    if (!shadow) return
    const paint = pixiPaint(shadow.color)
    for (let step = 0; step < CHIP_SHADOW_STEPS; step += 1) {
      const spread = shadow.blurPx * 1.5 * ((step + 0.5) / CHIP_SHADOW_STEPS - 0.5)
      // How far the step passes each side of the chip.
      const reach = [spread - shadow.offsetXPx, spread - shadow.offsetYPx, spread + shadow.offsetXPx, spread + shadow.offsetYPx]
      if (!reach.some((px) => px > 0)) continue
      const [left, top, right, bottom] = reach.map((px) => Math.max(px, CHIP_SHADOW_HAIRLINE_PX)) as [number, number, number, number]
      // No wider a corner than the chip's grown by the ring's narrowest side, so the ring holds the chip's corners.
      graphics.roundRect(-left, -top, width + left + right, height + top + bottom, radius + Math.min(left, top, right, bottom))
        .fill({ color: paint.color, alpha: paint.alpha / CHIP_SHADOW_STEPS })
      graphics.roundRect(0, 0, width, height, radius).cut()
    }
  }

  /** The ghost's entities are already where a click would put them; the layer only places them. */
  function drawGhost(entity: GhostEntity, opacity: number, scale: number): void {
    if (entity.kind === 'plant') {
      drawPlantGhosts([entity.plant], entity.mark, opacity, scale, entity.sizeFrom)
      return
    }
    const { template } = entity
    if (template.zones.length > 0) {
      // The fill fades with the ghost; the outline is the placed zone's at full opacity, so it previews what lands (Q10).
      const fill = new Graphics()
      const outline = new Graphics()
      let drewZone = false
      for (const { entity: zone } of template.zones) drewZone = painters.drawZoneGhost(fill, outline, zone, scale) || drewZone
      if (drewZone) {
        const zones = add(world, new Container())
        fill.alpha = opacity
        if (fill.context.instructions.length > 0) zones.addChild(fill)
        else fill.destroy()
        zones.addChild(outline)
      } else {
        fill.destroy()
        outline.destroy()
      }
    }
    drawPlantGhosts(template.plants.map(({ entity: plant }) => plant), 'symbol', opacity, scale)
    for (const { entity: note } of template.annotations) drawNoteGhost(note, opacity, scale)
  }

  function drawPlantGhosts(
    plants: readonly ScenePlantEntity[],
    mark: 'symbol' | 'dot',
    opacity: number,
    scale: number,
    sizeFrom?: WorldPoint,
  ): void {
    // Symbols composite once, as the scene's plant layers do: their contours
    // overlap. A dot is one flat disc, so its own alpha is exact.
    let composite: Container | null = null
    for (const plant of plants) {
      const graphics = new Graphics()
      if (!painters.drawPlantGhost(graphics, plant, mark, scale, sizeFrom)) {
        graphics.destroy()
        continue
      }
      if (mark === 'dot') {
        graphics.alpha = opacity
        add(screen, graphics)
      } else {
        composite ??= createComposite(opacity)
        composite.addChild(graphics)
      }
      addUpright(graphics, plant.position)
    }
  }

  function createComposite(opacity: number): Container {
    const filter = new AlphaFilter({ alpha: opacity, resolution: 'inherit', antialias: 'inherit' })
    filters.push(filter)
    const composite = add(screen, new Container())
    composite.filters = [filter]
    // Ghosts draw in CSS px in the untransformed screen container, so the view is the filter area.
    composite.filterArea = ghostFilterArea ??= new Rectangle(0, 0, viewWidth, viewHeight)
    return composite
  }

  function drawNoteGhost(note: SceneAnnotationEntity, opacity: number, scale: number): void {
    const text = createText()
    const marker = new Graphics()
    const presentation = painters.drawNoteGhost(text, marker, note, scale)
    for (const [node, nodeOpacity] of [
      [marker, presentation?.markerOpacity ?? 0],
      [text, presentation?.textOpacity ?? 0],
    ] as const) {
      if (nodeOpacity <= 0) {
        node.destroy()
        continue
      }
      node.alpha = opacity * nodeOpacity
      add(screen, node)
      addUpright(node, note.position, undefined, false, node === text)
    }
  }

  return {
    worldDraftRoot: world,
    billboardDraftRoot: screen,
    setView(next) {
      writeWorldAffine(world, next)
      view = next
      if (!draft) return
      if (next.pixelsPerMetre === tracedScale) positionUpright(next)
      else trace(draft, next)
    },
    setDraft(next) {
      draft = next
      clear()
      if (next && view) trace(next, view)
    },
    resize(width, height) {
      viewWidth = width
      viewHeight = height
      if (ghostFilterArea) {
        ghostFilterArea.width = width
        ghostFilterArea.height = height
      }
    },
    dispose() {
      unsubscribeFonts()
      draft = null
      clear()
    },
  }
}

function outlineSegments(chords: number): number {
  return Math.min(MAX_OUTLINE_SEGMENTS, Math.max(MIN_OUTLINE_SEGMENTS, Math.ceil(chords)))
}

function tracePath(graphics: Graphics, points: readonly WorldPoint[], closed: boolean): void {
  const [first, ...rest] = points
  if (!first) return
  graphics.moveTo(first.x, first.y)
  for (const point of rest) graphics.lineTo(point.x, point.y)
  if (closed) graphics.closePath()
}
