import { currentCanvasQuerySurface } from '../../canvas/session'
import type { CanvasQuerySurface } from '../../canvas/runtime/runtime'
import {
  createViewSnapshotMap,
  type ViewSnapshotCapture,
  type ViewSnapshotImageType,
  type ViewSnapshotMap,
  type ViewSnapshotRequest,
} from '../../maplibre/view-snapshot-map'
import type { SavedView } from '../../generated/contracts'
import { locale } from '../settings/state'
import { readSatelliteConfig } from '../settings/satellite-config'
import { mapLayers, type MapLayersState } from '../map-layers/state'
import { backgroundPresentationOf, mapLayersOfView } from '../map-layers/background-presentation'
import { currentPlantDisplay } from '../plant-display/state'
import type { PlantLabelMode } from '../../canvas/runtime/plant-display'
import { savedViewZoom } from '../../canvas/saved-view-framing'

/** Default wait for tiles before a snapshot is read with a "some tiles missing" flag. */
export const VIEW_SNAPSHOT_DEFAULT_TIMEOUT_MS = 8_000

export const VIEW_SNAPSHOT_THUMBNAIL = Object.freeze({ width: 320, height: 200 })

interface SavedViewSnapshotOptions {
  /** CSS pixels of the image. */
  readonly width: number
  readonly height: number
  readonly pixelRatio?: number
  readonly timeoutMs?: number
  readonly type?: ViewSnapshotImageType
  readonly quality?: number
  readonly signal?: AbortSignal
}

export type SavedViewSnapshot = ViewSnapshotCapture

export interface SavedViewSnapshotContext {
  readonly queries: Pick<CanvasQuerySurface, 'sessionPlane' | 'view' | 'captureViewScene'>
  readonly mapLayers: MapLayersState
  readonly locale: string
  /** The labels the view shows: its recorded choice, else the Design's current one. */
  readonly plantLabels: PlantLabelMode
}

/**
 * The off-screen capture request for a saved view of the open Design, or null
 * when no Design is open on a map. The camera is the view's centre and bearing
 * at the zoom that fits its framed ground into the image, the rule going to the
 * view follows (spec §4.10). Background, Design layers, the
 * focused species and the labels come from the view; opacities and locale from
 * the user's current settings.
 */
export function describeSavedViewSnapshot(
  view: SavedView,
  options: SavedViewSnapshotOptions,
  context: SavedViewSnapshotContext,
): ViewSnapshotRequest | null {
  const plane = context.queries.sessionPlane.peek()
  if (!plane) return null
  const visibleLayerNames = [...view.visible_layers.scene_layers]
  const focusedSpecies = view.highlighted.species[0] ?? null
  return {
    camera: {
      lon: view.camera.lon,
      lat: view.camera.lat,
      zoom: savedViewZoom(view.camera, options),
      bearing: view.camera.bearing,
    },
    width: options.width,
    height: options.height,
    ...(options.pixelRatio === undefined ? {} : { pixelRatio: options.pixelRatio }),
    background: backgroundPresentationOf(mapLayersOfView(view, context.mapLayers), context.locale),
    scene: {
      origin: plane.origin,
      build(view) {
        const snapshot = context.queries.captureViewScene({
          view, visibleLayerNames, focusedSpecies, plantLabels: context.plantLabels,
        })
        if (!snapshot) throw new ViewSnapshotSceneBusyError()
        return snapshot
      },
    },
    timeoutMs: options.timeoutMs ?? VIEW_SNAPSHOT_DEFAULT_TIMEOUT_MS,
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

/** An edit owned the Scene when the snapshot was drawn; try again later. */
export class ViewSnapshotSceneBusyError extends Error {
  constructor() {
    super('The Design was being edited; the view snapshot was not taken.')
    this.name = 'ViewSnapshotSceneBusyError'
  }
}

/** The labels a view is presented with: those stored with it, else the Design's current choice. */
export function savedViewPresentedLabels(view: Pick<SavedView, 'labels'>): PlantLabelMode {
  return view.labels ?? currentPlantDisplay.peek().labels
}

let owner: ViewSnapshotMap | null = null

/**
 * Captures a saved view of the open Design as an image, off-screen: the
 * visible map, the camera and the Design are never touched. Resolves null when
 * no Design is open on a map; rejects with `ViewSnapshotSceneBusyError` while
 * an edit owns the Scene.
 */
export async function captureSavedViewSnapshot(
  view: SavedView,
  options: SavedViewSnapshotOptions,
): Promise<SavedViewSnapshot | null> {
  const queries = currentCanvasQuerySurface.peek()
  if (!queries) return null
  const request = describeSavedViewSnapshot(view, options, {
    queries,
    mapLayers: mapLayers.peek(),
    locale: locale.peek(),
    plantLabels: savedViewPresentedLabels(view),
  })
  if (!request) return null
  owner ??= createViewSnapshotMap({ readSatelliteConfig })
  return owner.capture(request)
}

/** Releases the shared off-screen map now instead of after its idle delay. */
export async function disposeViewSnapshots(): Promise<void> {
  const current = owner
  owner = null
  await current?.dispose()
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disposeViewSnapshots()
  })
}
