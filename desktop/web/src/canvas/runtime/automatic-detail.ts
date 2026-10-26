import { getAnnotationFontEpoch, getAnnotationWorldBounds } from './annotation-layout'
import { LabelCollisionIndex, type LabelBounds } from '../label-collision'
import { getPlantWorldBounds } from './plant-presentation'
import { nearestPlantSpacing } from '../plant-spacing'
import {
  createMeasurementGuidePresentation,
  MEASUREMENT_GUIDE_LABEL_FONT_SIZE_PX,
  measurementGuideLabelPoseIn,
} from './measurement-guides'
import type { ScenePersistedState } from './scene'
import { getSceneLayerStyle, isPlantLayerShown } from './scene-visuals'
import { getCanvasTextOpacity } from './text-visibility'
import type { SceneRendererSnapshot } from './renderers/scene-types'
import { projectScenePlantLabels, type PlantNameLabel, type SelectionLabel } from './selection-labels'
import { getCanvasPlantDisplay, PLANT_LABEL_MIN_SCALE } from './plant-display'

/**
 * The plant names admitted at `pixelsPerMetre`: pinned names first, then automatic ones where they fit, around the single
 * selection's label (`projected`, computed at the same scale when not given). Admission never depends on where the plane
 * sits on screen, so collisions are tested in plane pixels: world metres times the scale.
 */
export function getCanvasPlantNameLabels(
  snapshot: SceneRendererSnapshot,
  pixelsPerMetre: number,
  projected: { readonly pinnedPlantNameLabels: readonly PlantNameLabel[]; readonly selectionLabels: readonly SelectionLabel[] }
    = projectScenePlantLabels(snapshot, pixelsPerMetre),
): readonly PlantNameLabel[] {
  const scale = pixelsPerMetre
  const { scene } = snapshot
  // Labels › None keeps only names the user pinned or a single selection shows.
  const mode = snapshot.plantLabels ?? getCanvasPlantDisplay().labels
  const automatic = mode !== 'none'
  const codes = mode === 'codes'
  const minimumScale = PLANT_LABEL_MIN_SCALE[codes ? 'codes' : 'names']
  if (!isPlantLayerShown(scene)) return []
  if ((!automatic || scale < minimumScale) && projected.pinnedPlantNameLabels.length === 0) return []
  const occupied = new LabelCollisionIndex()
  for (const rect of getCanvasDetailLayout(scene, scale).bounds) occupied.add(rect)
  for (const label of projected.selectionLabels) {
    occupied.add(nameBounds(label.text, label.anchor.x * scale + label.offsetPx.x, label.anchor.y * scale + label.offsetPx.y))
  }
  const pinned = new Map(projected.pinnedPlantNameLabels.map((label) => [label.plantId, label]))
  const plants = [...scene.plants].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || a.id.localeCompare(b.id))
  const result: PlantNameLabel[] = []
  const context = { plants: scene.plants, pixelsPerMetre: scale }
  for (const plant of plants) {
    if (snapshot.speciesFocus.canonicalName && plant.canonicalName !== snapshot.speciesFocus.canonicalName) continue
    const existing = pinned.get(plant.id)
    if (snapshot.selectionLabelPlantIds.has(plant.id) && !plant.pinnedName) continue
    const forced = snapshot.selectionLabelPlantIds.has(plant.id)
    if (!existing && !plant.pinnedName && !forced && (!automatic || scale < minimumScale || (!codes && nearestPlantSpacing(scene.plants, plant.position) * scale < 35))) continue
    const opacity = forced ? 1 : existing?.opacity ?? getCanvasTextOpacity(scale)
    if (!opacity) continue
    const commonName = snapshot.localizedCommonNames.get(plant.canonicalName) ?? plant.commonName
    const code = codes ? scene.plantSpeciesCodes[plant.canonicalName] : null
    const text = existing?.text ?? code ?? (commonName || plant.canonicalName)
    const fontStyle = existing?.fontStyle ?? (code || commonName ? 'normal' : 'italic')
    const radius = getPlantWorldBounds(plant, context).width * scale / 2
    const x = plant.position.x * scale, y = plant.position.y * scale
    const candidates = [nameBounds(text, x, y + radius + 4), nameBounds(text, x, y - radius - 20)]
    const rect = candidates.find((candidate) => !occupied.overlaps(candidate)) ?? (forced ? candidates[0] : null)
    if (!rect) continue
    occupied.add(rect)
    result.push({ plantId: plant.id, text, fontStyle, opacity, anchor: { x: plant.position.x, y: plant.position.y },
      offsetPx: { x: 0, y: rect.y + 2 - y } })
  }
  return result
}

function nameBounds(text: string, x: number, y: number): LabelBounds {
  const width = Array.from(text).reduce((sum, character) => sum + (character.codePointAt(0)! > 0x2ff ? 12 : 8.4), 0)
  return { x: x - width / 2 - 2, y: y - 2, width: width + 4, height: 19 }
}

interface CanvasDetailLayout {
  readonly annotationIds: ReadonlySet<string>
  readonly measurementIds: ReadonlySet<string>
  readonly bounds: readonly LabelBounds[]
}

export function isMeasurementLabelVisible(snapshot: SceneRendererSnapshot, pixelsPerMetre: number, id: string): boolean {
  return snapshot.selectedMeasurementGuideIds.has(id)
    || (snapshot.hoverTarget?.kind === 'measurement-guide' && snapshot.hoverTarget.id === id)
    || getCanvasDetailLayout(snapshot.scene, pixelsPerMetre).measurementIds.has(id)
}

// Pan does not affect admission. Keep the main view and an inspection view warm.
// Symbol size changes plant bounds and a loaded web font changes note bounds, so both are part of the key.
const layouts = new WeakMap<ScenePersistedState, Map<string, CanvasDetailLayout>>()

export function getCanvasDetailLayout(scene: ScenePersistedState, scale: number): CanvasDetailLayout {
  let cache = layouts.get(scene)
  const key = `${scale}|${getCanvasPlantDisplay().symbolScale}|${getAnnotationFontEpoch()}`
  const previous = cache?.get(key)
  if (previous) return previous
  const occupied = new LabelCollisionIndex()
  const bounds: LabelBounds[] = []
  function reserve(rect: LabelBounds) { occupied.add(rect); bounds.push(rect) }
  const annotationIds = new Set<string>()
  const measurementIds = new Set<string>()
  const context = { plants: scene.plants, pixelsPerMetre: scale }
  // Plane pixels: admission never depends on where the plane sits on screen.
  const planePixels = { worldToScreen: (point: { readonly x: number; readonly y: number }) => ({ x: point.x * scale, y: point.y * scale }) }
  if (isLayerVisible(scene, 'plants')) {
    for (const plant of scene.plants) {
      const bounds = getPlantWorldBounds(plant, context)
      reserve({ x: bounds.x * scale - 2, y: bounds.y * scale - 2, width: bounds.width * scale + 4, height: bounds.height * scale + 4 })
    }
  }
  if (isLayerVisible(scene, 'annotations') && getCanvasTextOpacity(scale) > 0) {
    for (const annotation of [...scene.annotations].reverse()) {
      const world = getAnnotationWorldBounds(annotation, scale)
      const rect = { x: world.x * scale - 2, y: world.y * scale - 2, width: world.width * scale + 4, height: world.height * scale + 4 }
      if (occupied.overlaps(rect)) continue
      annotationIds.add(annotation.id)
      reserve(rect)
    }
  }
  if (isLayerVisible(scene, 'measurement-guides')) {
    for (const guide of scene.measurementGuides) {
      const presentation = createMeasurementGuidePresentation(guide)
      if (!presentation) continue
      const w = presentation.text.length * MEASUREMENT_GUIDE_LABEL_FONT_SIZE_PX * .7 + 4
      if (presentation.lengthWorld * scale < w + 16) continue
      const h = MEASUREMENT_GUIDE_LABEL_FONT_SIZE_PX + 4
      const label = measurementGuideLabelPoseIn(guide, planePixels)
      const cos = Math.abs(Math.cos(label.rotationRad)), sin = Math.abs(Math.sin(label.rotationRad))
      const width = w * cos + h * sin, height = w * sin + h * cos
      const rect = { x: label.point.x - width / 2, y: label.point.y - height / 2, width, height }
      if (occupied.overlaps(rect)) continue
      measurementIds.add(guide.id)
      reserve(rect)
    }
  }
  const result = { annotationIds, measurementIds, bounds }
  if (!cache) { cache = new Map(); layouts.set(scene, cache) }
  if (cache.size >= 2) cache.delete(cache.keys().next().value!)
  cache.set(key, result)
  return result
}

function isLayerVisible(scene: ScenePersistedState, name: string): boolean {
  const layer = getSceneLayerStyle(scene, name)
  return layer.visible && layer.opacity > 0
}
