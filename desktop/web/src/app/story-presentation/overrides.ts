import { computed, signal, type ReadonlySignal } from '@preact/signals'
import type { PlantLabelMode } from '../../canvas/runtime/plant-display'
import type { PanelTarget } from '../../types/design'
import { mapLayers, type MapLayersState } from '../map-layers/state'
export { mapLayers, type MapLayersState }

// What the map shows while a story is presented, laid over the user's own
// state for the session only: the map layer store, the Design's site data, its
// label choice, its layers and the grid setting stay as they are, so nothing is
// saved, dirtied or undone, and clearing the overrides shows the user's state
// exactly. The presentation controller (controller.ts) is the
// only writer; the map, the runtime adapter and the panel target overlays read
// them.

export interface StoryPresentationOverrides {
  /** Background band and terrain as the step's view shows them. */
  readonly mapLayers: MapLayersState
  /** Library ids of the site-data entries shown; the others are hidden. */
  readonly siteDataIds: ReadonlySet<string>
  readonly plantLabels: PlantLabelMode
  /** Species and objects the view highlights: the canvas rings plants, the map overlay outlines zones. */
  readonly targets: readonly PanelTarget[]
}

const overrides = signal<StoryPresentationOverrides | null>(null)

/** The overrides of the step being presented, or null when no story is presented. */
export const storyPresentationOverrides: ReadonlySignal<StoryPresentationOverrides | null> = computed(() => overrides.value)

/** Written only by the presentation controller. */
export function setStoryPresentationOverrides(next: StoryPresentationOverrides | null): void {
  overrides.value = next
}

const editingAidsHidden = signal(false)

/**
 * The map's editing aid (the grid) is hidden for the whole
 * presentation, whatever step shows; the user's own settings are untouched.
 */
export const storyPresentationHidesEditingAids: ReadonlySignal<boolean> = computed(() => editingAidsHidden.value)

/** Written only by the presentation controller. */
export function setStoryPresentationHidesEditingAids(hidden: boolean): void {
  editingAidsHidden.value = hidden
}

/** The map layers the workspace map draws: a presented step's, else the user's own. */
export function presentedMapLayers(): MapLayersState {
  return overrides.value?.mapLayers ?? mapLayers.value
}
