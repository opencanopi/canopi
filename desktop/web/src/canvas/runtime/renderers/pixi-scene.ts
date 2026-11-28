// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import type { Container, Text } from 'pixi.js'
import { getAnnotationPresentation } from '../annotation-layout'
import { buildPlantPresentationEntries } from '../plant-presentation'
import { getMapTextColor, resolveZoneVisual } from '../scene-visuals'
import { isZoneClosed } from '../zone-geometry'
import type { DraftPresentation } from '../tools/draft'
import { bandCentreScale, zoomBandOf } from '../../../geo/view/frame-source'
import type { ViewTransform } from '../../../geo/view/types'
import { createBillboardLayer, drawPlantGlyph, noteTextRotation, styleAnnotationText, traceAnnotationMarker } from './billboard-layer'
import { createDraftLayer, type DraftScenePainters } from './draft-layer'
import { cssColorAlpha, resolveCasedStroke, toPixiColor } from './scene-paint'
import type { SceneRendererSnapshot } from './scene-types'
import { createWorldLayers, traceZonePath, ZONE_STROKE_PX } from './world-layers'

/** Plant a row's disc is at least 4 px across, as its 2 px border-box border kept it before v2 (plant-spacing-overlay.ts at a4c86d39). */
const DOT_GHOST_MIN_RADIUS_PX = 2

/**
 * Retained botanical presentation. The MapLibre custom layer owns the stage,
 * the shared WebGL context and frame submission; it presents each frame here
 * once, with the camera's view and any new scene snapshot, and this graph
 * draws the active tool's draft over it (`draft-layer.ts`). The stage holds,
 * in this order (spec §1.5): the world root (`world-layers.ts`), the
 * billboard root (`billboard-layer.ts`), then the two draft roots.
 */
export interface PixiScenePresentation {
  dispose(): void
  resize(width: number, height: number): void
  /**
   * One frame: the camera's view (the world roots' affine, the visible set, the billboards' anchors) and, when data,
   * selection, hover, style or labels changed, the new snapshot drawn under it. A pan brings no snapshot. Names are
   * admitted on a snapshot, a zoom-band change and a `settled` frame at a new scale; omitted, the frame is settled.
   */
  present(view: ViewTransform, snapshot?: SceneRendererSnapshot, settled?: boolean): void
  setDraft(draft: DraftPresentation | null): void
}

export interface PixiScenePresentationOptions {
  readonly stage: Container
  readonly createText: () => Text
  readonly viewSize: { width: number; height: number }
  /** Asks the host for a frame when the presentation changed outside a render (a draft chip's font arrived). */
  readonly requestRepaint?: () => void
}

export function createPixiScenePresentation(options: PixiScenePresentationOptions): PixiScenePresentation {
  const { stage, createText, viewSize } = options
  let snapshot: SceneRendererSnapshot | null = null
  const world = createWorldLayers()
  // Rasterize text and tessellate symbols at their readable CSS-pixel size.
  // Tiny world-unit primitives lose detail before the camera enlarges them.
  const billboards = createBillboardLayer({ createText, viewSize })
  // Drafts draw over plants, notes and labels, as the DOM previews did over the canvas.
  const draftLayer = createDraftLayer({
    createText,
    viewSize,
    requestRepaint: options.requestRepaint,
    painters: createDraftScenePainters(() => snapshot),
    getPaintTokens: () => snapshot?.paintTokens,
  })
  stage.addChild(world.root)
  stage.addChild(billboards.root)
  stage.addChild(draftLayer.worldDraftRoot)
  stage.addChild(draftLayer.billboardDraftRoot)

  return {
    dispose() {
      draftLayer.dispose()
      billboards.dispose()
      snapshot = null
    },
    resize(width, height) {
      viewSize.width = width
      viewSize.height = height
      billboards.resize(width, height)
      draftLayer.resize(width, height)
    },
    present(view, next, settled) {
      if (next) snapshot = next
      world.present(view, next)
      billboards.present(view, next, settled)
      draftLayer.setView(view)
    },
    setDraft(draft) {
      draftLayer.setDraft(draft)
    },
  }
}

/**
 * The scene's own drawing code, lent to the draft layer so a placement ghost
 * looks like the object a click would create: zones in world units, plant
 * marks and note text at the local origin in CSS px. Plants are presented
 * with the last scene snapshot's plant context.
 */
export function createDraftScenePainters(getSnapshot: () => SceneRendererSnapshot | null): DraftScenePainters {
  return {
    drawZoneGhost(fill, outline, zone, scale) {
      // The ghost: the zone's fill at a fifth (a line has none) and the placed zone's outline, its cream stroke over its
      // dark casing, traced at the band's centre scale as the zone it places is.
      const snapshot = getSnapshot()
      const visual = resolveZoneVisual(zone, snapshot?.paintTokens)
      if (!traceZonePath(outline, zone)) return false
      const stroke = resolveCasedStroke(null, { color: visual.stroke, casing: visual.casing }, ZONE_STROKE_PX, bandCentreScale(zoomBandOf(scale)))
      outline.stroke(stroke.casing)
      traceZonePath(outline, zone)
      outline.stroke(stroke.stroke)
      if (isZoneClosed(zone) && traceZonePath(fill, zone)) {
        fill.fill({ color: toPixiColor(visual.fill), alpha: 0.2 * cssColorAlpha(visual.fill) })
      }
      return true
    },
    drawPlantGhost(graphics, plant, mark, scale, sizeFrom) {
      const snapshot = getSnapshot()
      if (!snapshot) return false
      // A dot's radius is the presentation at sizeFrom (Plant a row: the source plant's), so the whole row has one size.
      const presented = mark === 'dot' && sizeFrom ? { ...plant, position: sizeFrom } : plant
      const [entry] = buildPlantPresentationEntries([presented], {
        plants: snapshot.scene.plants,
        pixelsPerMetre: scale,
        speciesCache: snapshot.speciesCache,
        plantSpeciesSymbols: snapshot.scene.plantSpeciesSymbols,
        plantDisplay: snapshot.plantDisplay,
      }, new Set())
      if (!entry) return false
      // Plant a row's look: a disc in the display colour, its 2 px border the same colour, so never under 2 px in radius.
      if (mark === 'dot') graphics.circle(0, 0, Math.max(entry.radiusScreenPx, DOT_GHOST_MIN_RADIUS_PX)).fill({ color: toPixiColor(entry.color) })
      else drawPlantGlyph(graphics.context, entry, snapshot.mapBackdrop, snapshot.plantDisplay)
      return true
    },
    drawNoteGhost(text, marker, annotation, scale) {
      if (annotation.annotationType !== 'text') return null
      const snapshot = getSnapshot()
      const { textFrame, textOpacity, markerOpacity, markerPaths, markerStrokePx } =
        getAnnotationPresentation(annotation, scale)
      styleAnnotationText(text, annotation, textFrame.lineHeightPx, snapshot?.backdropInk)
      // The note's own angle; the draft layer turns it with the map.
      text.rotation = noteTextRotation(annotation, 0)
      // The ghost marker has no halo.
      traceAnnotationMarker(marker.context, markerPaths)
      marker.stroke({ color: toPixiColor(getMapTextColor(snapshot?.backdropInk)), width: markerStrokePx })
      return { textOpacity, markerOpacity }
    },
  }
}
