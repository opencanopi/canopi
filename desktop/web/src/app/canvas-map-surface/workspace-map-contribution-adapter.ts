import type { CanvasQuerySurface } from '../../canvas/runtime/runtime'
import { canvasPaintRevision } from '../../canvas/theme-refresh'
import type { DesignSessionStore } from '../document-session/store'
import { readPanelTargetOverlaySnapshot } from '../panel-targets/presentation'
import type { MapLibreApi, MapLibreMapInstance } from '../../maplibre/loader'
import type { TerrainLayerState, TerrainProtocolSupport } from '../../maplibre/terrain'
import type { RasterDisplay, RasterDisplayLayer, RasterDisplayMap, RasterDisplayOptions } from '../../maplibre/raster-display/adapter'
import type { CanvasMapSurfaceOverlaySnapshot } from './overlays'
import type { SiteMapOverlay } from '../../maplibre/site-overlay'
import type { UserLocationReading } from '../../maplibre/user-location-overlay'

export interface WorkspaceMapContributionSnapshot {
  readonly sessionIdentity: object
  readonly lidar: readonly Readonly<RasterDisplayLayer>[]
  readonly terrain: TerrainLayerState
  readonly overlays: CanvasMapSurfaceOverlaySnapshot
}

export interface UserLocationOverlayPort {
  sync(map: MapLibreMapInstance, reading: UserLocationReading | null): void
  clear(map: MapLibreMapInstance): void
}

export interface WorkspaceMapContributionAdapter {
  read(runtime: CanvasQuerySurface): WorkspaceMapContributionSnapshot | null
  readonly loadTerrainSupport?: (maplibre: MapLibreApi) => Promise<TerrainProtocolSupport>
  /**
   * Create the map-lifetime raster display for this edition. Desktop renders
   * library data through the upstream renderer; an edition without local data
   * leaves the hook undefined and never loads the renderer.
   */
  readonly createRasterDisplay?: (
    map: RasterDisplayMap,
    options: Pick<RasterDisplayOptions, 'onLayersChanged' | 'onLayerStatus'>,
  ) => RasterDisplay
  /**
   * Desktop only: the profile chart's hover point in [lon, lat]. It changes at scrub rate, so it is the one exception to
   * the coarse rule below: it never rides `read`, and the composition feeds it straight to the map's hover source.
   */
  readonly readSiteHover?: () => readonly [number, number] | null
  /**
   * Web only: Show my location's device reading (app/my-location/session.ts). Like the chart hover it changes at its own
   * rate and never rides `read`: the composition feeds it to the map's dot, hidden during a story presentation. Optional,
   * so the adapter factories keep their signatures and an edition without location (Desktop in 2.0) leaves it undefined.
   */
  readonly readUserLocation?: () => UserLocationReading | null
  /** Web only: draws/clears the device location overlay so Desktop does not bundle geolocation drawing code. */
  readonly userLocationOverlay?: UserLocationOverlayPort
}

/** What an edition adds to the shared contributions: its LiDAR band and terrain, and Desktop's Site data pin and line. */
interface WorkspaceMapEditionContributions extends Pick<WorkspaceMapContributionSnapshot, 'lidar' | 'terrain'> {
  readonly site: SiteMapOverlay | null
}

/**
 * The contributions both editions read: null without a Design or a plane, else the panel Targets (none in overview) over the
 * edition's LiDAR layers and terrain. Coarse view signals only: the contributions re-read when the Scene changes, the camera
 * settles, the mode changes or the canvas paint changes (theme, backdrop: overlays already on the map repaint in its colours),
 * never on a camera frame alone. The one high-rate exception, the profile chart's hover, goes through `readSiteHover`.
 */
export function readWorkspaceMapContributions(
  runtime: CanvasQuerySurface,
  store: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'>,
  edition: () => WorkspaceMapEditionContributions,
): WorkspaceMapContributionSnapshot | null {
  const sessionIdentity = store.sessionIdentity.value
  if (!store.hasCurrentDesign()) return null
  const plane = runtime.sessionPlane.value
  if (!plane) return null
  void runtime.revision.scene.value
  void runtime.view.settledCamera.value
  void canvasPaintRevision.value
  const overview = runtime.view.mode.value === 'overview'
  const panelTargets = readPanelTargetOverlaySnapshot()
  const { site, ...contributions } = edition()
  return {
    sessionIdentity,
    ...contributions,
    overlays: {
      runtime,
      location: { lat: plane.origin.lat, lon: plane.origin.lon },
      hoveredTargets: overview ? [] : panelTargets.hoveredTargets,
      selectedTargets: overview ? [] : panelTargets.selectedTargets,
      site: overview ? null : site,
    },
  }
}
