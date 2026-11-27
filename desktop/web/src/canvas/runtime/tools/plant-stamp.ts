// canvas/runtime/tools/plant-stamp.ts
//
// Owns Place plants ('plant-stamp', key P; spec §1.4, §3.2) and the plant placement the host's species drop calls (0B-4):
// each press places one plant of the chosen species at the snapped point, selected, as one Scene Edit; with no species the
// card asks for one, and "Place plants here" waits at its point for the pick (the species arrives through activate and
// sourceChanged, which the session bridges from the plant read model); Esc leaves the tool at once, a waiting point with
// it. Its hover draws the read-only preview: the plant's symbol where a click would place it, a dashed ring for the
// species' mature width when the catalog gives one (never invented) and the distance to the nearest plant within 320 px
// on screen. The preview hides when the pointer leaves the map and when the map enters overview.

import type { PlantStampSourceInput } from '../../stamp-drag-data'
import { speciesPlacementAppearance } from '../species-key'
import { formatMetricDistance } from '../zone-measurements'
import type { SceneEditCoordinator } from '../scene-runtime/transactions'
import type { WorldPoint } from '../../../geo/view/types'
import { distanceGuideShapes } from './distance-guides'
import type { DraftShape } from './draft'
import { appendPlantStampSourceToDraft, plantEntityFromStampSource } from './tool-actions'
import type { CanvasTool, ToolContext, ToolScene, ToolSource } from './tool'

/** Previews draw the real symbol size at 85% opacity. */
const PREVIEW_OPACITY = 0.85
/** A neighbour further than this on screen is not worth a line across the map. */
const NEAREST_PLANT_MAX_SCREEN_PX = 320
const PREVIEW_PLANT_ID = 'plant-placement-preview'
const SPREAD_RING_STROKE = Object.freeze({ token: 'draft', widthPx: 1.5, dash: Object.freeze([6, 5]) } as const)

/**
 * Places one plant of `species` at `world` (already snapped) as one Scene Edit of `type`, the plant selected, then calls
 * `onCommitted`. Nothing is placed while the plants layer is closed for creation. Place plants' press uses it, and so
 * does the host's species drop (spec §1.4, "Drops"; today's _dropWhenSettled) with 'interaction-drop'.
 */
export function placePlantFromSpecies(
  target: { readonly edits: SceneEditCoordinator; readonly scene: Pick<ToolScene, 'isLayerOpenForCreation'> },
  species: PlantStampSourceInput,
  world: WorldPoint,
  type: 'interaction-stamp-plant' | 'interaction-drop',
  onCommitted: () => void,
): void {
  if (!target.scene.isLayerOpenForCreation('plants')) return
  target.edits.run(type, (tx) => {
    let placedPlantId = ''
    tx.mutate((draft) => {
      placedPlantId = appendPlantStampSourceToDraft(draft, species, world)
    })
    tx.setSelection([{ kind: 'plant', id: placedPlantId }])
  }, { onCommitted })
}

export function createPlantStampTool(): CanvasTool {
  let ctx: ToolContext | null = null
  let species: PlantStampSourceInput | null = null
  /** The clicks that found no species chosen since one was. */
  let speciesPrompts = 0
  /** Where "Place plants here" waits for a species to be chosen. */
  let pendingWorld: WorldPoint | null = null
  /** The snapped point under the pointer while the preview shows. */
  let previewWorld: WorldPoint | null = null

  function context(): ToolContext {
    if (!ctx) throw new Error('Place plants is not active.')
    return ctx
  }

  function publishGuidance(): void {
    context().effects.setGuidance({ speciesPrompts })
  }

  function place(chosen: PlantStampSourceInput, world: WorldPoint): void {
    const { effects, scene } = context()
    // The preview follows the placement: its nearest plant may now be the one just placed.
    placePlantFromSpecies({ edits: effects.edits, scene }, chosen, world, 'interaction-stamp-plant', showPreview)
  }

  /** Read-only: draws from the settled scene and never opens a Scene Edit. */
  function showPreview(): void {
    const tool = ctx
    if (!tool) return
    if (!species || !previewWorld || tool.view.mode === 'overview' || !tool.scene.isLayerOpenForCreation('plants')) {
      tool.effects.setDraft(null)
      return
    }
    tool.effects.setDraft({ shapes: previewShapes(tool, species, previewWorld) })
  }

  function hidePreview(): void {
    previewWorld = null
    ctx?.effects.setDraft(null)
  }

  function setSource(source: ToolSource | null): void {
    species = source?.kind === 'species' ? source.species : null
    if (species) speciesPrompts = 0
  }

  return {
    id: 'plant-stamp',
    activate(next, source) {
      ctx = next
      setSource(source)
      publishGuidance()
    },
    sourceChanged(source) {
      setSource(source)
      // The pick that answers "Place plants here" lands where the user right-clicked, once.
      const world = pendingWorld
      if (species && world) {
        pendingWorld = null
        place(species, world)
      }
      publishGuidance()
      showPreview()
    },
    gesture(g) {
      switch (g.kind) {
        case 'press':
          pendingWorld = null
          if (species) place(species, g.point.snapped)
          else speciesPrompts += 1
          publishGuidance()
          return 'handled'
        case 'hover':
          previewWorld = g.point.snapped
          showPreview()
          // With a species chosen the preview replaces the hover restyle and the plant tooltip (today's suppression).
          return species ? 'handled' : 'pass'
        case 'hover-end':
          hidePreview()
          return 'pass'
        case 'drag-start':
        case 'drag-move':
          // Today's press kept its pointer gesture: no passive hover over the held moves.
          return 'handled'
        default:
          return 'pass'
      }
    },
    command(c) {
      if (c.kind !== 'place-at') return 'pass'
      // The host snapped the point and drops the command in overview.
      if (species) {
        pendingWorld = null
        place(species, c.world)
      } else {
        pendingWorld = c.world
        speciesPrompts += 1
      }
      publishGuidance()
      return 'handled'
    },
    sceneChanged: showPreview,
    viewChanged: showPreview,
    // A waiting point is the tool's transient: it holds re-origin (spec §4.19), so it keeps its plane, and Delete and Ctrl+X
    // delete nothing while it waits. It is no Esc layer: the tool layer's Esc leaves, and deactivate drops it (U35).
    hasTransient: () => pendingWorld !== null,
    escapeLeaves: true,
    cancelTransient(reason) {
      // Only an overview entry hides the preview, as today's overview reset did. A pan, a blur and a re-arm of Place plants
      // keep it under the pointer; a real tool change and a document replacement deactivate.
      if (reason === 'overview') hidePreview()
    },
    deactivate() {
      speciesPrompts = 0
      pendingWorld = null
      hidePreview()
      ctx = null
    },
  }
}

/** The preview at `world`: the mature-width ring, the nearest-plant guide, the symbol, then their labels. */
function previewShapes(ctx: ToolContext, species: PlantStampSourceInput, world: WorldPoint): DraftShape[] {
  const { scene, view } = ctx
  const shapes: DraftShape[] = []
  const labels: DraftShape[] = []
  const width = species.width_max_m
  if (width !== null && Number.isFinite(width) && width > 0) {
    const radius = width / 2
    shapes.push({ kind: 'ellipse', center: world, radiusX: radius, radiusY: radius, rotationDeg: 0, style: SPREAD_RING_STROKE })
    // Upright, above the ring's top on screen.
    const { down } = view.screenAxesInWorld()
    labels.push({
      kind: 'label',
      anchor: { x: world.x - down.x * radius, y: world.y - down.y * radius },
      offsetPx: { x: 0, y: 0 },
      text: ctx.translate('canvas.placePreview.matureWidth', {
        width: formatMetricDistance(width, ctx.settings.unitSystem?.() ?? 'metric', ctx.settings.locale?.() ?? 'en'),
      }),
      tone: 'hint',
    })
  }

  const entity = plantEntityFromStampSource(scene.persisted, species, world, PREVIEW_PLANT_ID)
  const plant = { ...entity, color: speciesPlacementAppearance(scene.persisted, species.canonical_name).color }
  const nearest = scene.nearestPlant(world)
  if (nearest && view.screenDistance(world, nearest.plant.position) <= NEAREST_PLANT_MAX_SCREEN_PX) {
    const name = scene.plantPresentation(nearest.plant).commonName
    // Below the symbol, so a close neighbour's label never hides it: the symbol's radius among the scene's plants (crowded).
    const symbolRadiusPx = scene.plantPresentation(plant).radiusPx
    const [line, label] = distanceGuideShapes(
      world,
      nearest.plant.position,
      ctx.translate('canvas.placePreview.nearest', {
        distance: formatMetricDistance(nearest.distanceM, ctx.settings.unitSystem?.() ?? 'metric', ctx.settings.locale?.() ?? 'en'),
        name,
      }),
      { anchor: world, offsetPx: { x: 0, y: Math.max(symbolRadiusPx, 6) + 16 } },
    )
    shapes.push(line!)
    labels.push(label!)
  }

  // After the guide, so the symbol draws over the distance line.
  shapes.push({
    kind: 'ghost',
    entity: { kind: 'plant', plant, mark: 'symbol' },
    opacity: PREVIEW_OPACITY,
  })
  return [...shapes, ...labels]
}
