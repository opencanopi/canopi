import { signal } from '@preact/signals'
import {
  currentCanvasQuerySurface,
  currentCanvasSceneEditCommandSurface,
  currentCanvasViewportCommandSurface,
} from '../../canvas/session'
import type { SceneBounds } from '../../geo/view/types'
import type { ScenePersistedState } from '../../canvas/runtime/scene'
import { speciesTarget } from '../../target'
import { clearSelectedPanelTargetsForOrigin, setMatchedPanelTargets, setSelectedPanelTargets } from '../panel-targets/presentation'
import { readPlanningViewState } from '../planning-view/state'

/**
 * The finder of "Plants in this Design" rings its matches on the map. This module owns
 * that highlight (through the panel-target channel, so it never selects, edits or
 * dirties the Design) and the chip's actions: Zoom to them moves only the camera,
 * Select all runs the runtime selection command.
 */
export interface PlantFinderMapMatches {
  readonly query: string
  readonly canonicalNames: readonly string[]
}

export const plantFinderMapMatches = signal<PlantFinderMapMatches | null>(null)

const ZOOM_PADDING_CSS_PX = 72
/** Half the side of the smallest area Zoom to them frames, in metres. */
const MIN_HALF_EXTENT_M = 2

export function showPlantFinderMatchesOnMap(query: string, canonicalNames: readonly string[]): void {
  const current = plantFinderMapMatches.peek()
  if (canonicalNames.length === 0) {
    clearPlantFinderMatchesOnMap()
    return
  }
  if (
    !current
    || current.query !== query
    || current.canonicalNames.length !== canonicalNames.length
    || current.canonicalNames.some((name, index) => name !== canonicalNames[index])
  ) {
    plantFinderMapMatches.value = { query, canonicalNames: [...canonicalNames] }
  }
  setMatchedPanelTargets(canonicalNames.map(speciesTarget))
}

export function clearPlantFinderMatchesOnMap(): void {
  if (plantFinderMapMatches.peek() !== null) plantFinderMapMatches.value = null
  setMatchedPanelTargets([])
}

/** The chip's Clear: forget the search that produced the highlight. */
export function clearPlantFinderSearch(): void {
  readPlanningViewState().plantsSearch.value = ''
  clearPlantFinderMatchesOnMap()
}

export function countPlantsOfSpecies(scene: ScenePersistedState, canonicalNames: readonly string[]): number {
  const names = new Set(canonicalNames)
  return scene.plants.reduce((count, plant) => count + (names.has(plant.canonicalName) ? 1 : 0), 0)
}

/** Frames the matching plants; objects never move. */
export function zoomToPlantFinderMatches(): boolean {
  const matches = plantFinderMapMatches.peek()
  return matches ? zoomToSpeciesPlants(matches.canonicalNames) : false
}

export function selectPlantFinderMatches(): void {
  const matches = plantFinderMapMatches.peek()
  if (matches) selectSpeciesPlants(matches.canonicalNames)
}

/** Frames every plant of these species (Species detail's "Zoom to them"); objects never move. */
export function zoomToSpeciesPlants(canonicalNames: readonly string[]): boolean {
  const queries = currentCanvasQuerySurface.peek()
  const viewport = currentCanvasViewportCommandSurface.peek()
  if (!queries || !viewport) return false
  const bounds = speciesPlantBounds(queries.getSceneSnapshot(), canonicalNames)
  // A framing, not a temporary focus: Return to Design keeps LiDAR's bookmark, and Zoom to them leaves none.
  return bounds ? viewport.frameBounds(bounds, { paddingCssPx: ZOOM_PADDING_CSS_PX }) : false
}

/** Species detail rings its species' plants on the map while it is open; never selects or edits. */
export function showSpeciesDetailOnMap(canonicalName: string): void {
  setSelectedPanelTargets('species-detail', [speciesTarget(canonicalName)])
}

export function clearSpeciesDetailOnMap(): void {
  clearSelectedPanelTargetsForOrigin('species-detail')
}

/** Selects every plant of these species through the runtime selection command. */
export function selectSpeciesPlants(canonicalNames: readonly string[]): void {
  currentCanvasSceneEditCommandSurface.peek()?.selectSpecies(canonicalNames)
}

function speciesPlantBounds(
  scene: ScenePersistedState,
  canonicalNames: readonly string[],
): SceneBounds | null {
  const names = new Set(canonicalNames)
  let bounds: SceneBounds | null = null
  for (const plant of scene.plants) {
    if (!names.has(plant.canonicalName)) continue
    const radius = Math.max((plant.canopySpreadM ?? 0) / 2, MIN_HALF_EXTENT_M)
    const { x, y } = plant.position
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, x - radius),
          minY: Math.min(bounds.minY, y - radius),
          maxX: Math.max(bounds.maxX, x + radius),
          maxY: Math.max(bounds.maxY, y + radius),
        }
      : { minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius }
  }
  return bounds
}
