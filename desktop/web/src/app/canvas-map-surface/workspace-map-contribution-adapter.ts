import type { CanvasQuerySurface } from '../../canvas/runtime/runtime'
import { canvasPaintRevision, readCanvasPaintTokens } from '../../canvas/theme-refresh'
import type { DesignSessionStore } from '../document-session/store'
import { isDarkMapBackdrop, mapBackdropOf, mapTerrainStateOf } from '../settings/state'
import { myLocation } from '../my-location/session'
import { presentedMapLayers, storyPresentationHidesEditingAids } from '../story-presentation/overrides'
import type { MapLibreApi } from '../../maplibre/loader'
import type { TerrainLayerState, TerrainProtocolSupport } from '../../maplibre/terrain'
import { loadMapLibreTerrainSupport } from '../../maplibre/terrain-loader'
import type { RasterDisplay, RasterDisplayLayer, RasterDisplayMap, RasterDisplayOptions } from '../../maplibre/raster-display/adapter'
import type { CanvasMapSurfaceOverlaySnapshot } from './overlays'
import { USER_LOCATION_OVERLAY_PORT, type UserLocationOverlayPort } from './user-location-overlay-port'
import type { SiteMapOverlay } from '../../maplibre/site-overlay'
import type { UserLocationReading } from '../../maplibre/user-location-overlay'

export type { UserLocationOverlayPort }

export interface WorkspaceMapContributionSnapshot {
  readonly sessionIdentity: object
  readonly lidar: readonly Readonly<RasterDisplayLayer>[]
  readonly terrain: TerrainLayerState
  readonly overlays: CanvasMapSurfaceOverlaySnapshot
}

export interface WorkspaceMapContributionAdapter {
  read(runtime: CanvasQuerySurface): WorkspaceMapContributionSnapshot | null
  readonly loadTerrainSupport?: (maplibre: MapLibreApi) => Promise<TerrainProtocolSupport>
  /**
   * Create the map-lifetime raster display for this edition. Desktop renders
   * library data through MapLibre `addProtocol` over the cog-tiler worker pool;
   * an edition without local data leaves the hook undefined and never loads it.
   */
  readonly createRasterDisplay?: (
    map: RasterDisplayMap,
    options: Pick<RasterDisplayOptions, 'maplibre' | 'onLayersChanged' | 'onLayerStatus'>,
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

/** What an edition adds to the shared contributions: Desktop's LiDAR band and Site data pin/line. */
interface WorkspaceMapEditionAdditions {
  readonly lidar: readonly Readonly<RasterDisplayLayer>[]
  readonly site: SiteMapOverlay | null
}

const NO_EDITION_ADDITIONS: WorkspaceMapEditionAdditions = Object.freeze({
  lidar: [],
  site: null,
})

/**
 * Shared Q45 contribution reader: null without a Design or a plane, else the
 * shared terrain (following the map backdrop, not UI theme; contracts §6,
 * 2.1-Q25) and panel Targets (none in overview) over the edition's capability
 * rows (`lidar`, `site`). Coarse view signals only: re-reads on Scene change,
 * settled camera, mode change or canvas paint change, never on a camera frame.
 */
export function readWorkspaceMapContributions(
  runtime: CanvasQuerySurface,
  store: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'>,
  edition: () => WorkspaceMapEditionAdditions = () => NO_EDITION_ADDITIONS,
): WorkspaceMapContributionSnapshot | null {
  const sessionIdentity = store.sessionIdentity.value
  if (!store.hasCurrentDesign()) return null
  const plane = runtime.sessionPlane.value
  if (!plane) return null
  void runtime.revision.scene.value
  void runtime.view.settledCamera.value
  void canvasPaintRevision.value
  const overview = runtime.view.mode.value === 'overview'
  const presented = presentedMapLayers()
  const terrain: TerrainLayerState = {
    ...mapTerrainStateOf(presented),
    isDark: isDarkMapBackdrop(presented),
  }
  const { site, lidar } = edition()
  return {
    sessionIdentity,
    lidar,
    terrain,
    overlays: {
      site: overview || storyPresentationHidesEditingAids.value ? null : site,
      mapBackdrop: mapBackdropOf(presented),
      paintTokens: readCanvasPaintTokens(),
    },
  }
}

/** Shared adapter fields owned once for both editions: terrain support and optional My location wiring (2.1-Q25, 2.1-Q45, 2.1-Q146). */
export function createSharedContributionCapabilities(options: { readonly locationEnabled: boolean }): Pick<
  WorkspaceMapContributionAdapter,
  'loadTerrainSupport' | 'readUserLocation' | 'userLocationOverlay'
> {
  return {
    loadTerrainSupport: loadMapLibreTerrainSupport,
    ...(options.locationEnabled
      ? {
          readUserLocation: () => myLocation.reading.value,
          userLocationOverlay: USER_LOCATION_OVERLAY_PORT,
        }
      : {}),
  }
}
