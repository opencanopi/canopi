/**
 * The scene's billboard root (spec §1.5): plants, their rings and stack
 * badges, notes, measurement-guide labels and plant names, drawn upright in CSS
 * px under an identity transform. Each sits at its world anchor projected
 * through `view.projectAnchors`, plus a CSS-px offset, so a pan moves them all
 * and a turned view keeps them upright; a note's text turns by its own angle
 * less the bearing. A scene sync builds what the snapshot decides (entries,
 * order, stack counts, rings, text and styles); every frame then places it
 * (projection, the cull, positions, and sizes when the scale changed). Glyphs,
 * rings, badges and note markers bind shared drawing contexts keyed by their
 * look, glyph radii rounded to 0.25 px, so a pan or a warm zoom draws nothing.
 * Labels are admitted by `label-admission.ts`, mid-zoom only on a band change.
 */

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import { CANVAS_CHROME_FONT_FAMILY } from '../../chrome-fonts'
import { SPECIES_FOCUS_DIM_OPACITY, speciesFocusOpacity } from '../species-key'
import { AlphaFilter, CanvasTextMetrics, Container, Graphics, GraphicsContext, Rectangle, type Text } from 'pixi.js'
import { annotationOutlineCorners, getAnnotationFontEpoch, getAnnotationPresentation } from '../annotation-layout'
import { getCanvasDetailLayout, isMeasurementLabelVisible } from '../automatic-detail'
import {
  createMeasurementGuidePresentation,
  MEASUREMENT_GUIDE_LABEL_FONT_SIZE_PX,
  measurementGuideLabelPoseIn,
} from '../measurement-guides'
import {
  buildPlantPresentationEntries,
  getStackBadgeOffsetPx,
  getStackBadgeSizePx,
  plantStackCounts,
  rescalePlantEntry,
  STACK_BADGE_FONT_SIZE_PX,
  type PlantPresentationEntry,
} from '../plant-presentation'
import { getPlantSymbolArt, ROUND_PLANT_SYMBOL_RADIUS, tracePlantSymbolContours } from '../plant-symbol-recipes'
import type { PlantSymbolId, SceneAnnotationEntity, SceneMeasurementGuideEntity, ScenePoint } from '../scene'
import {
  getCanvasInteractionStrokeVisual,
  getMapBackdropInk,
  getMapTextColor,
  getPlantSymbolEdgeColor,
  getPlantSymbolEdgeWidth,
  getSceneLayerStyle,
  getStackBadgeBackgroundColor,
  getStackBadgeTextColor,
  MIN_PLANT_RING_RADIUS_PX,
  OVERLAY_CASING_EXTRA_PX,
  type CanvasInteractionVisualState,
} from '../scene-visuals'
import type { PlantNameLabel } from '../selection-labels'
import type { ViewTransform } from '../view/types'
import { LabelAdmission, type AdmittedLabels } from './label-admission'
import {
  casedStroke,
  destroyEntriesNotIn,
  destroyEntry,
  drawClosedPath,
  hoverStateForTarget,
  interactionOutline,
  labelHaloStroke,
  resolveInteractionState,
  reuseGeometry,
  setTextStyle,
  toPixiColor,
  type CasedStroke,
} from './scene-paint'
import type { SceneRendererHoverState, SceneRendererSnapshot } from './scene-types'

type PixiSceneWorkName =
  | 'plantObjects' | 'plantCull' | 'plantEntries' | 'plantLayout' | 'plantDraw' | 'plantGlyph' | 'labelAdmission'

declare global {
  interface Window {
    __CANOPI_PIXI_SCENE_WORK__?: (name: PixiSceneWorkName, durationMs: number) => void
  }
}

function measurePixiSceneWork<T>(name: PixiSceneWorkName, operation: () => T): T {
  const observer = import.meta.env.DEV ? window.__CANOPI_PIXI_SCENE_WORK__ : undefined
  if (!observer) return operation()
  const startedAt = performance.now()
  try {
    return operation()
  } finally {
    observer(name, performance.now() - startedAt)
  }
}

export interface BillboardLayer {
  /** Plants, rings, badges, notes and labels, in CSS px; stays untransformed. */
  readonly root: Container
  /**
   * One frame: every billboard placed under the view, after a build from the new snapshot when data, selection, hover or
   * style changed. `settled` is false on a frame of a camera still moving: names are then admitted only on a band change.
   */
  present(view: ViewTransform, snapshot?: SceneRendererSnapshot, settled?: boolean): void
  resize(width: number, height: number): void
  dispose(): void
}

export interface BillboardLayerOptions {
  readonly createText: () => Text
  readonly viewSize: { width: number; height: number }
}

/** Bulk projection through `view.projectAnchors`, with buffers kept between frames. */
class AnchorProjection {
  private world = new Float64Array(0)
  private screen = new Float32Array(0)

  /** CSS px of each point, as [x0, y0, x1, y1, …]; valid until the next call. */
  project(view: ViewTransform, points: readonly ScenePoint[]): Float32Array {
    const count = points.length
    if (this.world.length < count * 2) {
      this.world = new Float64Array(count * 2)
      this.screen = new Float32Array(count * 2)
    }
    for (let index = 0; index < count; index++) {
      this.world[index * 2] = points[index]!.x
      this.world[index * 2 + 1] = points[index]!.y
    }
    view.projectAnchors(this.world, this.screen, count)
    return this.screen
  }
}

export function createBillboardLayer(options: BillboardLayerOptions): BillboardLayer {
  const { createText, viewSize } = options
  const root = new Container()
  const plantLayers = createPlantLayers(viewSize)
  const plantsOverlayLayer = new Container()
  const annotationTextLayer = new Container()
  const annotationHighlightLayer = new Container()
  const measurementGuideLabelLayer = new Container()
  const plantNameLabelLayer = new Container()
  const selectionLabelLayer = new Container()
  root.addChild(plantLayers.root)
  root.addChild(plantsOverlayLayer)
  root.addChild(annotationTextLayer)
  root.addChild(annotationHighlightLayer)
  root.addChild(measurementGuideLabelLayer)
  root.addChild(plantNameLabelLayer)
  root.addChild(selectionLabelLayer)

  const labels = new LabelAdmission((admit) => measurePixiSceneWork('labelAdmission', admit))
  const shared: SharedContexts = {
    // Passing one external empty context avoids the unused owned context that
    // `new Graphics()` would otherwise allocate for every Graphics before its
    // shared geometry is assigned; anything hidden binds it.
    empty: new GraphicsContext(),
    cache: new SharedGraphicsContextCache(),
  }
  const plants: PlantGraphics = {
    layers: plantLayers,
    overlay: plantsOverlayLayer,
    shared,
    graphicsById: new Map(),
    ringById: new Map(),
    badgeById: new Map(),
    badgeTextById: new Map(),
    visibleIds: new Set(),
    projection: new AnchorProjection(),
    built: null,
  }
  const notes: NoteGraphics = {
    textLayer: annotationTextLayer,
    highlightLayer: annotationHighlightLayer,
    shared,
    textById: new Map(),
    fontEpoch: getAnnotationFontEpoch(),
    markerById: new Map(),
    outlineById: new Map(),
    built: null,
  }
  const measurementLabels: MeasurementLabelGraphics = { layer: measurementGuideLabelLayer, labelById: new Map(), built: [] }
  const plantNameLabelById = new Map<string, Text>()
  const selectionLabelBySpecies = new Map<string, Text>()
  const labelProjection = new AnchorProjection()
  let snapshot: SceneRendererSnapshot | null = null
  /** The admission the name labels hold; a new one restyles them, the same one only moves them. */
  let drawnLabels: AdmittedLabels | null = null

  return {
    root,
    present(view, next, settled = true) {
      if (next) {
        snapshot = next
        labels.setScene(next)
        shared.cache.beginGeneration()
        buildPlants(createText, plants, next, view.pixelsPerMetre)
        buildNotes(createText, notes, next, view.pixelsPerMetre)
        buildMeasurementLabels(createText, measurementLabels, next)
      }
      if (!snapshot) return
      placePlants(plants, viewSize, view)
      placeNotes(notes, view)
      placeMeasurementLabels(measurementLabels, snapshot, view)
      const admitted = labels.admit(view.pixelsPerMetre, settled)!
      const restyle = admitted !== drawnLabels
      drawnLabels = admitted
      // Admission is empty while the Plants layer shows nothing; its opacity fades every name, a selection's included.
      if (restyle) {
        const opacity = getSceneLayerStyle(snapshot.scene, 'plants').opacity
        plantNameLabelLayer.alpha = opacity
        selectionLabelLayer.alpha = opacity
      }
      syncNameLabels(createText, plantNameLabelLayer, plantNameLabelById, (label) => label.plantId, view, labelProjection,
        admitted.plantNameLabels, restyle)
      syncNameLabels(createText, selectionLabelLayer, selectionLabelBySpecies, (label) => label.canonicalName, view, labelProjection,
        admitted.selectionLabels, restyle)
    },
    resize(width, height) {
      viewSize.width = width
      viewSize.height = height
      plantLayers.resize(width, height)
    },
    dispose() {
      snapshot = null
      drawnLabels = null
      for (const byId of [plants.graphicsById, plants.ringById, plants.badgeById, notes.markerById]) {
        for (const graphics of byId.values()) {
          graphics.removeFromParent()
          destroySharedGraphics(graphics)
        }
        byId.clear()
      }
      for (const outline of notes.outlineById.values()) outline.destroy()
      notes.outlineById.clear()
      plantLayers.dispose()
      plants.visibleIds.clear()
      plants.built = null
      notes.built = null
      shared.empty.destroy()
      shared.cache.dispose()
    },
  }
}

/**
 * Drawing contexts shared by every glyph, ring, badge and note marker of one look. A generation begins on each scene
 * sync, and every frame binds what it shows, so a context is destroyed only after two syncs in which nothing showed
 * it; a Graphics that hides binds the empty context first (Pixi still validates hidden renderables, and a destroyed
 * context has no instructions to read).
 */
class SharedGraphicsContextCache {
  private current = new Map<string, GraphicsContext>()
  private recent = new Map<string, GraphicsContext>()
  private older = new Map<string, GraphicsContext>()

  beginGeneration(): void {
    this.destroyContexts(this.older)
    this.older = this.recent
    this.recent = this.current
    this.current = new Map()
  }

  acquire(key: string): { context: GraphicsContext; created: boolean } {
    const current = this.current.get(key)
    if (current) return { context: current, created: false }
    const recent = this.recent.get(key)
    if (recent) {
      this.recent.delete(key)
      this.current.set(key, recent)
      return { context: recent, created: false }
    }
    const older = this.older.get(key)
    if (older) {
      this.older.delete(key)
      this.current.set(key, older)
      return { context: older, created: false }
    }
    const context = new GraphicsContext()
    this.current.set(key, context)
    return { context, created: true }
  }

  dispose(): void {
    this.destroyContexts(this.current)
    this.destroyContexts(this.recent)
    this.destroyContexts(this.older)
  }

  private destroyContexts(contexts: ReadonlyMap<string, GraphicsContext>): void {
    for (const context of contexts.values()) context.destroy()
  }
}

interface SharedContexts {
  readonly empty: GraphicsContext
  readonly cache: SharedGraphicsContextCache
}

/** Binds `graphics` to the shared context for `key`, drawing it first when no context holds that look yet. */
function bindShared(shared: SharedContexts, graphics: Graphics, key: string, draw: (context: GraphicsContext) => void): void {
  const { context, created } = shared.cache.acquire(key)
  graphics.context = context
  if (created) draw(context)
}

/** Hides a Graphics that binds shared contexts. */
function hideShared(shared: SharedContexts, graphics: Graphics | undefined): void {
  if (!graphics) return
  graphics.visible = false
  graphics.context = shared.empty
}

/** Pixi does not detach a destroyed Graphics from an externally owned context. */
function destroySharedGraphics(graphics: Graphics): void {
  // Rebinding uses Pixi's public context setter to detach both listeners from
  // the shared cache entry. The temporary context is then destroyed with the
  // Graphics, so neither side retains the other.
  graphics.context = new GraphicsContext()
  graphics.destroy({ context: true })
}

/**
 * Plant symbols draw opaque into containers that apply opacity once, as a
 * composite: Pixi multiplies a container's alpha into every triangle, so the
 * overlapping contours of one symbol (and its halo under the fill) would show
 * darker. Species Focus dims the other plants through `dimmed`; the Plants
 * layer opacity applies to `root`. Interaction rings sit above both, so a
 * dimmed plant's selection ring stays at full strength. The filters run only
 * while something is dimmed or the layer is translucent.
 */
interface PlantLayers {
  readonly root: Container
  readonly dimmed: Container
  readonly symbols: Container
  readonly rings: Container
  setLayerOpacity(opacity: number): void
  setDimmed(active: boolean): void
  resize(width: number, height: number): void
  dispose(): void
}

function createPlantLayers(viewSize: { width: number; height: number }): PlantLayers {
  const root = new Container()
  const dimmed = new Container()
  const symbols = new Container()
  const rings = new Container()
  // Children keep scene order through zIndex, whichever container holds them.
  dimmed.sortableChildren = true
  symbols.sortableChildren = true
  root.addChild(dimmed)
  root.addChild(symbols)
  root.addChild(rings)
  // Plants draw in CSS pixels in the untransformed billboard root, so the view is the filter area.
  const area = new Rectangle(0, 0, viewSize.width, viewSize.height)
  const filterOptions = { resolution: 'inherit', antialias: 'inherit' } as const
  const layerFilter = new AlphaFilter({ alpha: 1, ...filterOptions })
  const dimFilter = new AlphaFilter({ alpha: SPECIES_FOCUS_DIM_OPACITY, ...filterOptions })
  root.filterArea = area
  dimmed.filterArea = area
  let layerFiltered = false
  let dimFiltered = false
  return {
    root,
    dimmed,
    symbols,
    rings,
    setLayerOpacity(opacity) {
      layerFilter.alpha = opacity
      const filtered = opacity < 1
      if (filtered !== layerFiltered) root.filters = filtered ? [layerFilter] : null
      layerFiltered = filtered
    },
    setDimmed(active) {
      if (active !== dimFiltered) dimmed.filters = active ? [dimFilter] : null
      dimFiltered = active
    },
    resize(width, height) {
      area.width = width
      area.height = height
    },
    dispose() {
      root.filters = null
      dimmed.filters = null
      layerFilter.destroy()
      dimFilter.destroy()
    },
  }
}

interface PlantGraphics {
  readonly layers: PlantLayers
  readonly overlay: Container
  readonly shared: SharedContexts
  readonly graphicsById: Map<string, Graphics>
  readonly ringById: Map<string, Graphics>
  readonly badgeById: Map<string, Graphics>
  readonly badgeTextById: Map<string, Text>
  readonly visibleIds: Set<string>
  readonly projection: AnchorProjection
  /** What the last scene sync decided; null while the Plants layer is hidden. */
  built: BuiltPlants | null
}

interface BuiltPlants {
  readonly positions: readonly ScenePoint[]
  /** Every plant's entry, in scene order, at `scale`; a zoom frame rescales them from their spacing. */
  entries: readonly PlantPresentationEntry[]
  scale: number
  readonly ringById: ReadonlyMap<string, PlantRing>
  readonly stackCounts: ReadonlyMap<string, number>
  readonly badgeColor: number
}

/** A ring's state and cased stroke; `look` keys its shared context with the radius. */
interface PlantRing {
  readonly outline: CasedStroke
  readonly look: string
}

/** Builds the plants of a new snapshot: their Graphics, order, entries at `pixelsPerMetre`, stack counts and rings. */
function buildPlants(
  createText: () => Text,
  plants: PlantGraphics,
  snapshot: SceneRendererSnapshot,
  pixelsPerMetre: number,
): void {
  const { layers, overlay, shared, graphicsById, ringById, badgeById, badgeTextById, visibleIds } = plants
  const scenePlants = snapshot.scene.plants
  const keep = new Set(scenePlants.map((plant) => plant.id))
  destroyEntriesNotIn(graphicsById, keep, destroySharedGraphics)
  destroyEntriesNotIn(ringById, keep, destroySharedGraphics)
  destroyEntriesNotIn(badgeById, keep, destroySharedGraphics)
  destroyEntriesNotIn(badgeTextById, keep)
  const layer = getSceneLayerStyle(snapshot.scene, 'plants')
  layers.root.visible = layer.visible
  layers.setLayerOpacity(layer.opacity)
  overlay.visible = layer.visible
  overlay.alpha = layer.opacity
  if (!layer.visible) {
    for (const plantId of visibleIds) hidePlant(plants, plantId)
    visibleIds.clear()
    plants.built = null
    return
  }

  // Keep display order stable even when a previously unseen Plant enters the view.
  let anyDimmed = false
  measurePixiSceneWork('plantObjects', () => {
    scenePlants.forEach((plant, index) => {
      let graphic = graphicsById.get(plant.id)
      if (!graphic) {
        graphic = new Graphics(shared.empty)
        graphic.visible = false
        graphicsById.set(plant.id, graphic)
      }
      graphic.zIndex = index
      const dimmed = speciesFocusOpacity(snapshot.speciesFocus, plant.canonicalName) < 1
      anyDimmed ||= dimmed
      const target = dimmed ? layers.dimmed : layers.symbols
      if (graphic.parent !== target) target.addChild(graphic)
    })
  })
  layers.setDimmed(anyDimmed)
  const entries = measurePixiSceneWork('plantEntries', () => buildPlantPresentationEntries(scenePlants, {
    pixelsPerMetre,
    speciesCache: snapshot.speciesCache,
    plantSpeciesSymbols: snapshot.scene.plantSpeciesSymbols,
  }, snapshot.selectedPlantIds))
  const stackCounts = measurePixiSceneWork('plantLayout', () => plantStackCounts(entries))

  const rings = new Map<string, PlantRing>()
  const ringLooks = new Map<CanvasInteractionVisualState, PlantRing>()
  for (const entry of entries) {
    const id = entry.plant.id
    const state = resolvePlantInteractionState(
      entry,
      snapshot.hoveredCanonicalName,
      snapshot.highlightedPlantIds.has(id),
      hoverStateForTarget(snapshot, 'plant', id),
    )
    if (state) {
      let ring = ringLooks.get(state)
      if (!ring) {
        const outline = interactionOutline(state)
        ring = { outline, look: `${state}|${JSON.stringify(outline)}` }
        ringLooks.set(state, ring)
      }
      rings.set(id, ring)
      if (!ringById.has(id)) {
        const graphic = new Graphics(shared.empty)
        graphic.visible = false
        ringById.set(id, graphic)
        layers.rings.addChild(graphic)
      }
    } else {
      destroyEntry(ringById, id, destroySharedGraphics)
    }

    const stackCount = stackCounts.get(id)
    if (stackCount) {
      if (!badgeById.has(id)) {
        const badge = new Graphics(shared.empty)
        badge.visible = false
        badgeById.set(id, badge)
        overlay.addChild(badge)
        const badgeText = createText()
        badgeText.visible = false
        badgeText.anchor.set(0.5, 0.5)
        badgeTextById.set(id, badgeText)
        overlay.addChild(badgeText)
      }
      const badgeText = badgeTextById.get(id)!
      badgeText.text = String(stackCount)
      setTextStyle(badgeText, {
        fontFamily: CANVAS_CHROME_FONT_FAMILY,
        fontSize: STACK_BADGE_FONT_SIZE_PX,
        fill: toPixiColor(getStackBadgeTextColor()),
      })
    } else {
      destroyEntry(badgeById, id, destroySharedGraphics)
      destroyEntry(badgeTextById, id)
    }
  }

  plants.built = {
    positions: scenePlants.map((plant) => plant.position),
    entries,
    scale: pixelsPerMetre,
    ringById: rings,
    stackCounts,
    badgeColor: toPixiColor(getStackBadgeBackgroundColor()),
  }
}

/** Places the built plants under the view: the cull, positions, and sizes when the scale changed. */
function placePlants(plants: PlantGraphics, viewSize: { width: number; height: number }, view: ViewTransform): void {
  const { built, visibleIds } = plants
  if (!built) return
  if (built.scale !== view.pixelsPerMetre) {
    const scale = view.pixelsPerMetre
    built.entries = measurePixiSceneWork('plantEntries', () => built.entries.map((entry) => rescalePlantEntry(entry, scale)))
    built.scale = scale
  }
  // Includes the largest symbolic footprint, interaction ring and stack badge.
  const margin = 32
  const projected = plants.projection.project(view, built.positions)
  const nextVisibleIds = measurePixiSceneWork('plantCull', () => {
    const inView = new Set<string>()
    built.entries.forEach((entry, index) => {
      const x = projected[index * 2]!
      const y = projected[index * 2 + 1]!
      if (viewSize.width <= 0 || viewSize.height <= 0
        || (x >= -margin && y >= -margin && x <= viewSize.width + margin && y <= viewSize.height + margin)) inView.add(entry.plant.id)
    })
    return inView
  })
  for (const plantId of visibleIds) {
    if (!nextVisibleIds.has(plantId)) hidePlant(plants, plantId)
  }
  measurePixiSceneWork('plantDraw', () => {
    built.entries.forEach((entry, index) => {
      if (nextVisibleIds.has(entry.plant.id)) showPlant(plants, built, entry, projected[index * 2]!, projected[index * 2 + 1]!)
    })
  })
  visibleIds.clear()
  for (const plantId of nextVisibleIds) visibleIds.add(plantId)
}

/** Binds and places a plant's glyph, ring and badge; only a look no context holds yet is drawn. */
function showPlant(plants: PlantGraphics, built: BuiltPlants, entry: PlantPresentationEntry, x: number, y: number): void {
  const id = entry.plant.id
  const { shared } = plants
  const keys = plantContextKeys(entry, built)
  const graphic = plants.graphicsById.get(id)!
  bindShared(shared, graphic, keys.glyph, (context) => measurePixiSceneWork('plantGlyph', () => drawPlantGlyph(context, entry)))
  graphic.position.set(x, y)
  graphic.visible = true

  const ring = built.ringById.get(id)
  if (ring) {
    const graphics = plants.ringById.get(id)!
    bindShared(shared, graphics, keys.ring!, (context) => drawPlantRing(context, plantRingRadius(entry), ring.outline))
    graphics.position.set(x, y)
    graphics.visible = true
  }

  const stackCount = built.stackCounts.get(id)
  if (stackCount) {
    // The badge sits off the exact radius; its pill is shared by every badge of its count.
    const offset = getStackBadgeOffsetPx(entry.radiusScreenPx)
    const badge = plants.badgeById.get(id)!
    bindShared(shared, badge, keys.badge!, (context) => drawStackBadge(context, String(stackCount), built.badgeColor))
    badge.position.set(x + offset.x, y + offset.y)
    badge.visible = true
    const badgeText = plants.badgeTextById.get(id)!
    badgeText.position.set(x + offset.x, y + offset.y)
    badgeText.visible = true
  }
}

function hidePlant(plants: PlantGraphics, plantId: string): void {
  hideShared(plants.shared, plants.graphicsById.get(plantId))
  hideShared(plants.shared, plants.ringById.get(plantId))
  hideShared(plants.shared, plants.badgeById.get(plantId))
  const badgeText = plants.badgeTextById.get(plantId)
  if (badgeText) badgeText.visible = false
}

interface PlantContextKeys {
  readonly glyph: string
  readonly ring: string | null
  readonly badge: string | null
}

/** Each entry's shared-context keys, made once per entry (a scene sync or a zoom frame), so a pan builds no key. */
const plantContextKeysByEntry = new WeakMap<PlantPresentationEntry, PlantContextKeys>()

function plantContextKeys(entry: PlantPresentationEntry, built: BuiltPlants): PlantContextKeys {
  let keys = plantContextKeysByEntry.get(entry)
  if (keys) return keys
  const ring = built.ringById.get(entry.plant.id)
  const stackCount = built.stackCounts.get(entry.plant.id)
  keys = {
    glyph: plantGeometryKey(entry),
    ring: ring ? `ring|${plantRingRadius(entry)}|${ring.look}` : null,
    badge: stackCount ? `badge|${stackCount}|${built.badgeColor}` : null,
  }
  plantContextKeysByEntry.set(entry, keys)
  return keys
}

function plantGeometryKey(entry: PlantPresentationEntry): string {
  const renderedSymbol = resolveRenderedPlantSymbol(entry)
  const edgeColor = getPlantSymbolEdgeColor(entry.color)
  const edgeWidth = getPlantSymbolEdgeWidth(entry.glyphRadiusPx * 2)
  return `glyph|${entry.glyphRadiusPx}|${renderedSymbol}|${entry.dot}|${entry.color}|${edgeColor}|${edgeWidth}`
}

/** The symbol alone at the local origin, opaque, at its drawn radius; its container applies any dimming or layer opacity once. */
export function drawPlantGlyph(graphics: GraphicsContext, entry: PlantPresentationEntry): void {
  const symbol = resolveRenderedPlantSymbol(entry)
  const r = entry.glyphRadiusPx
  const color = toPixiColor(entry.color)
  if (entry.dot || symbol === 'round') {
    graphics.circle(0, 0, entry.dot ? r : r * ROUND_PLANT_SYMBOL_RADIUS).fill({ color })
    const width = getPlantSymbolEdgeWidth(r * 2)
    if (!entry.dot && width > 0) graphics.stroke({ color: toPixiColor(getPlantSymbolEdgeColor(entry.color)), width })
    return
  }
  const edge = toPixiColor(getPlantSymbolEdgeColor(entry.color))
  const width = getPlantSymbolEdgeWidth(r * 2)
  const art = getPlantSymbolArt(symbol, r * 2)
  // Halo under the whole silhouette (unless Outline is off), then the body, then cut-outs in the outline colour.
  if (width > 0) {
    tracePlantSymbolContours(graphics, art.body, 0, 0, r)
    graphics.stroke({ color: edge, width, join: 'round', cap: 'round' })
  }
  tracePlantSymbolContours(graphics, art.body, 0, 0, r)
  graphics.fill({ color })
  if (art.cutouts.length === 0) return
  tracePlantSymbolContours(graphics, art.cutouts, 0, 0, r)
  graphics.fill({ color: edge })
}

/** A selected plant is ringed at its drawn radius; any other ring stands off it and stays readable at dot sizes. */
function plantRingRadius(entry: PlantPresentationEntry): number {
  const r = entry.glyphRadiusPx
  return entry.selected ? r : Math.max(r * 1.4, MIN_PLANT_RING_RADIUS_PX)
}

/** The ring at the local origin; plants draw in the CSS-pixel root, so ring widths need no scaling. */
function drawPlantRing(context: GraphicsContext, radius: number, outline: CasedStroke): void {
  context.circle(0, 0, radius).stroke(outline.casing)
  context.circle(0, 0, radius).stroke(outline.stroke)
}

function resolveRenderedPlantSymbol(entry: PlantPresentationEntry): PlantSymbolId {
  return entry.dot ? 'round' : entry.symbol
}

/** The badge's pill centred on the local origin, sized for its count. */
function drawStackBadge(context: GraphicsContext, text: string, color: number): void {
  const size = getStackBadgeSizePx(text)
  context.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, size.height / 2).fill({ color, alpha: 1 })
}

/**
 * A plant's ring state: selection first, then the map hover, then a panel's
 * highlight, then the species under the pointer.
 */
function resolvePlantInteractionState(
  entry: PlantPresentationEntry,
  hoveredCanonicalName: string | null,
  highlighted: boolean,
  hoverState: SceneRendererHoverState | null,
): CanvasInteractionVisualState | null {
  if (entry.selected) return 'selected'
  if (hoverState) return hoverState
  if (highlighted) return 'highlight'
  return hoveredCanonicalName && entry.plant.canonicalName === hoveredCanonicalName ? 'hover' : null
}

interface NoteGraphics {
  readonly textLayer: Container
  readonly highlightLayer: Container
  readonly shared: SharedContexts
  readonly textById: Map<string, Text>
  /** The web-font loads the note texts were drawn after (`getAnnotationFontEpoch`). */
  fontEpoch: number
  /** Each note's marker, bound to the shared normal or compact marker. */
  readonly markerById: Map<string, Graphics>
  /** Each outlined note's frame, in CSS px about its anchor on the ground; a frame turns it by the bearing. */
  readonly outlineById: Map<string, Graphics>
  /** What the last scene sync decided; null while the Notes layer is hidden. */
  built: BuiltNotes | null
}

interface BuiltNotes {
  readonly snapshot: SceneRendererSnapshot
  readonly notes: readonly BuiltNote[]
  readonly markerInk: { readonly halo: number; readonly ink: number }
  /** The scale the notes were presented at; null until the first frame after the sync. */
  scale: number | null
}

interface BuiltNote {
  readonly annotation: SceneAnnotationEntity
  readonly text: Text
  /** Shows its text at every scale: the single selected note or the hovered one. */
  readonly revealText: boolean
  /** The selection or hover outline; null when the note has none. */
  readonly outline: CasedStroke | null
}

function buildNotes(createText: () => Text, notes: NoteGraphics, snapshot: SceneRendererSnapshot, pixelsPerMetre: number): void {
  const { textLayer, highlightLayer, shared, textById, markerById, outlineById } = notes
  const keep = new Set(snapshot.scene.annotations.filter((annotation) => annotation.annotationType === 'text').map((annotation) => annotation.id))
  // Pixi keeps a text's raster while its text and style stay the same, and a font's ascent and descent by its CSS font
  // string, and nothing in Pixi listens for fonts: a note drawn before its web font loaded would keep the fallback's
  // glyphs and baseline inside an outline measured in the web font. So a font load forgets the ascents and lets every
  // note text go, which frees the raster, and draws them anew.
  const fontEpoch = getAnnotationFontEpoch()
  if (notes.fontEpoch !== fontEpoch) CanvasTextMetrics.clearMetrics()
  destroyEntriesNotIn(textById, notes.fontEpoch === fontEpoch ? keep : new Set())
  notes.fontEpoch = fontEpoch
  destroyEntriesNotIn(markerById, keep, destroySharedGraphics)
  destroyEntriesNotIn(outlineById, keep)
  const layer = getSceneLayerStyle(snapshot.scene, 'annotations')
  textLayer.visible = layer.visible
  textLayer.alpha = layer.opacity
  highlightLayer.visible = layer.visible
  highlightLayer.alpha = layer.opacity
  if (!layer.visible) {
    for (const marker of markerById.values()) hideShared(shared, marker)
    notes.built = null
    return
  }

  const built: BuiltNote[] = []
  for (const annotation of snapshot.scene.annotations) {
    if (annotation.annotationType !== 'text') continue
    let text = textById.get(annotation.id)
    if (!text) {
      text = createText()
      textById.set(annotation.id, text)
      textLayer.addChild(text)
    }
    styleAnnotationText(text, annotation, getAnnotationPresentation(annotation, pixelsPerMetre).textFrame.lineHeightPx)
    if (!markerById.has(annotation.id)) {
      const marker = new Graphics(shared.empty)
      marker.visible = false
      markerById.set(annotation.id, marker)
      highlightLayer.addChild(marker)
    }
    const interactionState = resolveInteractionState(
      snapshot.selectedAnnotationIds.has(annotation.id),
      false,
      hoverStateForTarget(snapshot, 'annotation', annotation.id),
    )
    if (interactionState && !outlineById.has(annotation.id)) {
      const outline = new Graphics()
      outlineById.set(annotation.id, outline)
      highlightLayer.addChild(outline)
    } else if (!interactionState) {
      destroyEntry(outlineById, annotation.id)
    }
    built.push({
      annotation,
      text,
      revealText: annotation.id === snapshot.revealedAnnotationId
        || (snapshot.hoverTarget?.kind === 'annotation' && snapshot.hoverTarget.id === annotation.id),
      outline: interactionState ? casedStroke(getCanvasInteractionStrokeVisual(interactionState), 1) : null,
    })
  }
  const ink = getMapBackdropInk()
  notes.built = { snapshot, notes: built, markerInk: { halo: toPixiColor(ink.halo), ink: toPixiColor(getMapTextColor()) }, scale: null }
}

/** Places the notes: their anchors and angles every frame; text, marker and outline when the scale changed. */
function placeNotes(notes: NoteGraphics, view: ViewTransform): void {
  const { built } = notes
  if (!built || built.notes.length === 0) return
  const pixelsPerMetre = view.pixelsPerMetre
  if (built.scale !== pixelsPerMetre) {
    built.scale = pixelsPerMetre
    const detail = getCanvasDetailLayout(built.snapshot.scene, pixelsPerMetre)
    for (const note of built.notes) presentNote(notes, built, note, pixelsPerMetre, detail.annotationIds.has(note.annotation.id))
  }
  const bearingRad = (view.camera.bearingDeg * Math.PI) / 180
  for (const { annotation, text } of built.notes) {
    const origin = view.worldToScreen(annotation.position)
    text.position.set(origin.x, origin.y)
    text.rotation = noteTextRotation(annotation, view.camera.bearingDeg)
    notes.markerById.get(annotation.id)!.position.set(origin.x, origin.y)
    const outline = notes.outlineById.get(annotation.id)
    if (outline) {
      outline.position.set(origin.x, origin.y)
      outline.rotation = -bearingRad
    }
  }
}

/** A note's text opacity, its marker and its outline at a scale. */
function presentNote(notes: NoteGraphics, built: BuiltNotes, note: BuiltNote, pixelsPerMetre: number, textAllowed: boolean): void {
  const { annotation, text, revealText, outline } = note
  const presentation = getAnnotationPresentation(annotation, pixelsPerMetre, revealText, textAllowed)
  text.alpha = presentation.textOpacity
  text.visible = presentation.textOpacity > 0

  const marker = notes.markerById.get(annotation.id)!
  if (presentation.markerOpacity > 0) {
    const { halo, ink } = built.markerInk
    bindShared(notes.shared, marker, `marker|${presentation.compact}|${halo}|${ink}`, (context) => {
      traceAnnotationMarker(context, presentation.markerPaths)
      context.stroke({ color: halo, width: presentation.markerStrokePx + OVERLAY_CASING_EXTRA_PX, cap: 'round', join: 'round' })
      traceAnnotationMarker(context, presentation.markerPaths)
      context.stroke({ color: ink, width: presentation.markerStrokePx })
    })
    marker.alpha = presentation.markerOpacity
    marker.visible = true
  } else {
    hideShared(notes.shared, marker)
  }

  const outlineGraphics = notes.outlineById.get(annotation.id)
  if (!outline || !outlineGraphics) return
  // The text frame (or the marker's square) as outlined: also the shown note's click target (annotation-layout.ts).
  const corners = annotationOutlineCorners(presentation.frame)
  if (!reuseGeometry(outlineGraphics, [corners, outline])) {
    outlineGraphics.clear()
    drawClosedPath(outlineGraphics, corners).stroke(outline.casing)
    drawClosedPath(outlineGraphics, corners).stroke(outline.stroke)
  }
  outlineGraphics.visible = true
}

/** A note's text and style; the caller places it at the note's screen point and turns it (`noteTextRotation`). */
export function styleAnnotationText(text: Text, annotation: SceneAnnotationEntity, lineHeightPx: number): void {
  text.text = annotation.text
  setTextStyle(text, {
    fontFamily: CANVAS_CHROME_FONT_FAMILY,
    fontSize: annotation.fontSize,
    lineHeight: lineHeightPx,
    fill: getMapTextColor(),
    stroke: labelHaloStroke(annotation.fontSize),
  })
  text.anchor.set(0, 0)
}

/** A note's text angle on screen: its own angle less the bearing, in radians. */
export function noteTextRotation(annotation: SceneAnnotationEntity, bearingDeg: number): number {
  return (((annotation.rotationDeg ?? 0) - bearingDeg) * Math.PI) / 180
}

/** A note's marker paths, CSS px from the note's screen point. */
export function traceAnnotationMarker(context: GraphicsContext, markerPaths: readonly (readonly ScenePoint[])[]): void {
  for (const path of markerPaths) {
    path.forEach(({ x, y }, index) => {
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
  }
}

interface MeasurementLabelGraphics {
  readonly layer: Container
  readonly labelById: Map<string, Text>
  /** The guides with a label, from the last scene sync; empty while the layer is hidden. */
  built: ReadonlyArray<{ readonly guide: SceneMeasurementGuideEntity; readonly text: Text }>
}

function buildMeasurementLabels(createText: () => Text, labels: MeasurementLabelGraphics, snapshot: SceneRendererSnapshot): void {
  const { layer, labelById } = labels
  const style = getSceneLayerStyle(snapshot.scene, 'measurement-guides')
  layer.visible = style.visible
  layer.alpha = style.opacity
  const built: Array<{ readonly guide: SceneMeasurementGuideEntity; readonly text: Text }> = []
  if (style.visible) {
    for (const guide of snapshot.scene.measurementGuides) {
      const presentation = createMeasurementGuidePresentation(guide)
      if (!presentation) continue
      let text = labelById.get(guide.id)
      if (!text) {
        text = createText()
        labelById.set(guide.id, text)
        layer.addChild(text)
      }
      text.text = presentation.text
      setTextStyle(text, {
        fontFamily: CANVAS_CHROME_FONT_FAMILY,
        fontSize: MEASUREMENT_GUIDE_LABEL_FONT_SIZE_PX,
        // Map text follows the backdrop; the guide's own stroke carries the interaction state.
        fill: toPixiColor(getMapTextColor()),
        stroke: labelHaloStroke(MEASUREMENT_GUIDE_LABEL_FONT_SIZE_PX),
      })
      text.anchor.set(0.5, 0.5)
      built.push({ guide, text })
    }
  }
  labels.built = built
  destroyEntriesNotIn(labelById, new Set(built.map(({ guide }) => guide.id)))
}

function placeMeasurementLabels(labels: MeasurementLabelGraphics, snapshot: SceneRendererSnapshot, view: ViewTransform): void {
  for (const { guide, text } of labels.built) {
    const pose = measurementGuideLabelPoseIn(guide, view)
    text.position.set(pose.point.x, pose.point.y)
    text.rotation = pose.rotationRad
    text.visible = isMeasurementLabelVisible(snapshot, view.pixelsPerMetre, guide.id)
  }
}

/** A name the layer draws below its anchor; `opacity` fades a plant's name, a selection's name is opaque. */
type NameLabel = Omit<PlantNameLabel, 'plantId' | 'opacity'> & { readonly opacity?: number }

/** Name labels: text, style and fade when admission ran again, positions on every frame. */
function syncNameLabels<L extends NameLabel>(
  createText: () => Text,
  layer: Container,
  textByKey: Map<string, Text>,
  keyOf: (label: L) => string,
  view: ViewTransform,
  projection: AnchorProjection,
  labels: readonly L[],
  restyle: boolean,
): void {
  if (restyle) {
    for (const label of labels) {
      let text = textByKey.get(keyOf(label))
      if (!text) {
        text = createText()
        textByKey.set(keyOf(label), text)
        layer.addChild(text)
      }
      text.text = label.text
      setTextStyle(text, {
        fontFamily: CANVAS_CHROME_FONT_FAMILY,
        fontSize: 12,
        fontWeight: '600',
        fontStyle: label.fontStyle,
        fill: toPixiColor(getMapTextColor()),
        stroke: labelHaloStroke(12),
      })
      text.anchor.set(0.5, 0)
      text.alpha = label.opacity ?? 1
    }
    destroyEntriesNotIn(textByKey, new Set(labels.map(keyOf)))
  }
  const projected = projection.project(view, labels.map((label) => label.anchor))
  labels.forEach((label, index) => {
    textByKey.get(keyOf(label))!
      .position.set(projected[index * 2]! + label.offsetPx.x, projected[index * 2 + 1]! + label.offsetPx.y)
  })
}
