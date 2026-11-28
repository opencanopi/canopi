import { getCanvasTextOpacity } from './text-visibility'
import { DEFAULT_PLANT_DISPLAY } from './plant-display'
import { getPlantWorldBounds } from './plant-presentation'
import type { ScenePlantEntity, ScenePoint } from './scene'
import type { SceneRendererSnapshot } from './renderers/scene-types'

/**
 * A plant's name label: drawn upright at `offsetPx` (CSS px) from its plant's projected `anchor` (world metres), so a pan
 * moves it with its plant. Where it lands is the frame's: `view.worldToScreen(anchor)` plus `offsetPx`.
 */
interface AnchoredLabel {
  anchor: ScenePoint
  offsetPx: ScenePoint
}

export interface SelectionLabel extends AnchoredLabel {
  canonicalName: string
  text: string
  fontStyle: 'normal' | 'italic'
}

export interface PlantNameLabel extends AnchoredLabel {
  plantId: string
  opacity: number
  text: string
  fontStyle: 'normal' | 'italic'
}

/** A single selection's label and the pinned names, at `pixelsPerMetre`. */
export function projectScenePlantLabels(
  snapshot: Pick<SceneRendererSnapshot, 'scene' | 'localizedCommonNames' | 'selectionLabelPlantIds' | 'plantLabels'>,
  pixelsPerMetre: number,
): { readonly pinnedPlantNameLabels: PlantNameLabel[]; readonly selectionLabels: SelectionLabel[] } {
  const { scene, localizedCommonNames, selectionLabelPlantIds } = snapshot
  const codes = (snapshot.plantLabels ?? DEFAULT_PLANT_DISPLAY.labels) === 'codes'
    ? scene.plantSpeciesCodes
    : undefined
  return {
    pinnedPlantNameLabels: computePinnedPlantNameLabels(scene.plants, pixelsPerMetre, localizedCommonNames, selectionLabelPlantIds, codes),
    selectionLabels: computeSelectionLabels(scene.plants, selectionLabelPlantIds, pixelsPerMetre, localizedCommonNames, codes),
  }
}

const PLANT_LABEL_GAP_PX = 2
const PLANT_LABEL_MIN_OFFSET_PX = 5

export function computeSelectionLabels(
  plants: readonly ScenePlantEntity[],
  selectedIds: ReadonlySet<string>,
  pixelsPerMetre: number,
  localizedCommonNames: ReadonlyMap<string, string | null>,
  plantSpeciesCodes?: Readonly<Record<string, string>>,
): SelectionLabel[] {
  if (selectedIds.size !== 1) return []

  const selectedId = selectedIds.values().next().value
  const plant = plants.find((candidate) => candidate.id === selectedId)
  if (!plant || plant.pinnedName) return []

  const offsetYPx = plantLabelOffsetPx(plant, plants, pixelsPerMetre)
  const { text, fontStyle } = formatPlantNameLabel(plant, localizedCommonNames, plantSpeciesCodes)

  return [{ canonicalName: plant.canonicalName, text, fontStyle, ...below(plant.position, offsetYPx) }]
}

export function computePinnedPlantNameLabels(
  plants: readonly ScenePlantEntity[],
  pixelsPerMetre: number,
  localizedCommonNames: ReadonlyMap<string, string | null>,
  selectionLabelPlantIds: ReadonlySet<string>,
  plantSpeciesCodes?: Readonly<Record<string, string>>,
): PlantNameLabel[] {
  const labels: PlantNameLabel[] = []
  const overviewOpacity = getCanvasTextOpacity(pixelsPerMetre)
  const revealedId = selectionLabelPlantIds.size === 1 ? selectionLabelPlantIds.values().next().value : null
  for (const plant of plants) {
    if (!plant.pinnedName) continue
    const opacity = plant.id === revealedId ? 1 : overviewOpacity
    if (opacity === 0) continue
    const offsetYPx = plantLabelOffsetPx(plant, plants, pixelsPerMetre)

    const { text, fontStyle } = formatPlantNameLabel(plant, localizedCommonNames, plantSpeciesCodes)
    labels.push({ plantId: plant.id, text, fontStyle, opacity, ...below(plant.position, offsetYPx) })
  }

  return labels
}

function formatPlantNameLabel(
  plant: ScenePlantEntity,
  localizedCommonNames: ReadonlyMap<string, string | null>,
  plantSpeciesCodes?: Readonly<Record<string, string>>,
): { text: string; fontStyle: 'normal' | 'italic' } {
  const localizedName = localizedCommonNames.get(plant.canonicalName) || plant.commonName
  const baseText = localizedName || plant.canonicalName
  const code = plantSpeciesCodes?.[plant.canonicalName]
  const text = code ? `${code} · ${baseText}` : baseText
  const fontStyle = localizedName ? 'normal' as const : 'italic' as const
  return { text, fontStyle }
}

/** A label `offsetYPx` below `anchor`. */
function below(anchor: ScenePoint, offsetYPx: number): AnchoredLabel {
  return { anchor: { x: anchor.x, y: anchor.y }, offsetPx: { x: 0, y: offsetYPx } }
}

/** The gap below a plant's footprint at `pixelsPerMetre`: 2 px under the symbol, at least 5 px from its centre. */
function plantLabelOffsetPx(
  plant: ScenePlantEntity,
  plants: readonly ScenePlantEntity[],
  pixelsPerMetre: number,
): number {
  const bounds = getPlantWorldBounds(plant, { plants, pixelsPerMetre })
  const radiusPx = (Math.max(bounds.width, bounds.height) * pixelsPerMetre) / 2
  return Math.max(radiusPx + PLANT_LABEL_GAP_PX, PLANT_LABEL_MIN_OFFSET_PX)
}
