import { getRevealedAnnotationId } from '../../canvas/runtime/annotation-layout'
import type { SceneRendererSnapshot } from '../../canvas/runtime/renderers/scene-types'
import type {
  SceneDesignObjectSelection,
  ScenePersistedState,
} from '../../canvas/runtime/scene'
import { projectSceneSelectionEntityIds } from '../../canvas/runtime/scene-runtime/selection'
import type { ViewScreen, ViewTransform } from '../../geo/view/types'
import { planarToViewCamera } from '../../geo/view/camera-math'
import { buildViewTransform } from '../../geo/view/view-transform'
import { conformalFixturePlaneForTests } from '../../geo/session-plane'

export interface TestSceneRendererSnapshotOptions {
  readonly speciesFocus?: SceneRendererSnapshot['speciesFocus']
  readonly scene?: Partial<ScenePersistedState>
  readonly selectedTargets?: SceneDesignObjectSelection
  readonly highlightedPlantIds?: SceneRendererSnapshot['highlightedPlantIds']
  readonly highlightedZoneIds?: SceneRendererSnapshot['highlightedZoneIds']
  readonly speciesCache?: SceneRendererSnapshot['speciesCache']
  readonly localizedCommonNames?: SceneRendererSnapshot['localizedCommonNames']
  readonly hoveredCanonicalName?: SceneRendererSnapshot['hoveredCanonicalName']
  readonly hoverTarget?: SceneRendererSnapshot['hoverTarget']
}

export function createTestSceneRendererSnapshot(
  options: TestSceneRendererSnapshotOptions = {},
): SceneRendererSnapshot {
  const scene: ScenePersistedState = {
    plantSpeciesColors: options.scene?.plantSpeciesColors ?? {},
    plantSpeciesCodes: options.scene?.plantSpeciesCodes ?? {},
    plantSpeciesSymbols: options.scene?.plantSpeciesSymbols ?? {},
    layers: options.scene?.layers ?? [],
    plants: options.scene?.plants ?? [],
    zones: options.scene?.zones ?? [],
    annotations: options.scene?.annotations ?? [],
    measurementGuides: options.scene?.measurementGuides ?? [],
    groups: options.scene?.groups ?? [],
  }
  const selectedTargets = options.selectedTargets ?? []
  const singleSelectedPlant = selectedTargets.length === 1 && selectedTargets[0]?.kind === 'plant'
    ? selectedTargets[0]
    : null
  const selectionProjection = projectSceneSelectionEntityIds(scene, selectedTargets)

  return {
    scene,
    selectionLabelPlantIds: new Set(singleSelectedPlant ? [singleSelectedPlant.id] : []),
    revealedAnnotationId: getRevealedAnnotationId(selectedTargets),
    ...selectionProjection,
    speciesFocus: options.speciesFocus ?? { canonicalName: null },
    highlightedPlantIds: new Set(options.highlightedPlantIds ?? []),
    highlightedZoneIds: new Set(options.highlightedZoneIds ?? []),
    speciesCache: new Map(options.speciesCache ?? []),
    localizedCommonNames: new Map(options.localizedCommonNames ?? []),
    hoveredCanonicalName: options.hoveredCanonicalName ?? null,
    hoverTarget: options.hoverTarget ?? null,
  }
}

/**
 * A renderer test's view: the plane placed as today's viewport places it (screen = world × scale + { x, y } at bearing 0),
 * turned by `bearingDeg` about the screen origin, on a 400 × 300 screen unless given.
 */
export function createTestRendererView(
  viewport: { readonly x: number; readonly y: number; readonly scale: number },
  options: { readonly bearingDeg?: number; readonly screen?: Partial<ViewScreen> } = {},
): ViewTransform {
  const screen = { width: 400, height: 300, devicePixelRatio: 1, ...options.screen }
  const basePlane = conformalFixturePlaneForTests({ lon: 0, lat: 0 })
  const camera = planarToViewCamera({ ...viewport, bearingDeg: options.bearingDeg ?? 0 }, screen, basePlane)
  // Avoid 1-ULP log2/pow2 drift on exact scale thresholds (e.g. 8, 100) in renderer unit tests.
  const plane = {
    ...basePlane,
    pixelsPerMetre(zoom: number) {
      return zoom === camera.zoom
        ? { x: viewport.scale, y: viewport.scale, mean: viewport.scale }
        : basePlane.pixelsPerMetre(zoom)
    },
  }
  return buildViewTransform({
    camera,
    screen,
    plane,
    planeRevision: 0,
  })
}
