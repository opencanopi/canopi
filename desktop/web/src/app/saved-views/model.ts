import type { SceneDesignObjectTarget } from '../../canvas/runtime/scene'
import type { GeographicView } from '../../geo/session-plane'
import { savedViewCameraOf } from '../../canvas/saved-view-framing'
import type { CanopiFile, SavedView, SavedViewObject } from '../../types/design'
import type { PlantLabelMode } from '../../canvas/runtime/plant-display'
import type { MapLayersState } from '../map-layers/state'
import { viewMapLayersOf } from '../map-layers/background-presentation'

export interface SavedViewCaptureInput {
  readonly id: string
  readonly name: string
  readonly title: string | null
  readonly view: GeographicView
  /** The whole map's size in CSS pixels: the ground it shows is the view's frame. A map with no size frames none and gives no view. */
  readonly screen: { readonly width: number; readonly height: number }
  readonly mapLayers: MapLayersState
  readonly sceneLayers: readonly { readonly name: string; readonly visible: boolean }[]
  readonly siteData: readonly { readonly id: string; readonly visible: boolean }[]
  readonly focusedSpecies: string | null
  readonly selection: readonly SceneDesignObjectTarget[]
  /** The plant labels the map shows, stored with the view. */
  readonly labels: PlantLabelMode
}

/**
 * What the current view shows, as a saved view: its camera as stored, with the ground the whole map shows (savedViewCameraOf);
 * null on a map with no size.
 */
export function composeSavedView(input: SavedViewCaptureInput): SavedView | null {
  const camera = savedViewCameraOf(input.view, input.screen)
  if (!camera) return null
  return {
    id: input.id,
    name: input.name,
    camera,
    visible_layers: {
      ...viewMapLayersOf(input.mapLayers),
      scene_layers: input.sceneLayers.filter((layer) => layer.visible).map((layer) => layer.name),
      site_data: input.siteData.filter((entry) => entry.visible).map((entry) => entry.id),
    },
    highlighted: {
      species: input.focusedSpecies ? [input.focusedSpecies] : [],
      objects: input.selection.map(savedViewObjectOf),
    },
    title: input.title,
    text: [],
    labels: input.labels,
  }
}

/** The stories with a step that shows this view, by name, in story order. */
export function storiesShowingView(design: CanopiFile | null, viewId: string): string[] {
  return (design?.stories ?? [])
    .filter((story) => story.steps.some((step) => step.view_id === viewId))
    .map((story) => story.name)
}

function savedViewObjectOf(target: SceneDesignObjectTarget): SavedViewObject {
  return target.kind === 'measurement-guide'
    ? { kind: 'measurement_guide', id: target.id }
    : { kind: target.kind, id: target.id }
}
