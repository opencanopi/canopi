import type { CanvasQuerySurface } from '../../canvas/runtime/runtime'
import { createPanelTargetMapOverlayContract } from '../../maplibre/panel-target-overlays'
import {
  clearMapOverlay,
  clearPanelTargetMapOverlay,
  syncMapOverlay,
  type MapLibreOverlayMap,
} from '../../maplibre/panel-target-overlay-sync'
import {
  siteHoverOverlayContract,
  siteMapOverlayContract,
  siteMapOverlayIds,
  type SiteMapOverlay,
} from '../../maplibre/site-overlay'
import { projectTargetsToMapFeatures } from '../../target'
import type { PanelTarget } from '../../types/design'

/** The panel Targets the map highlights, and the Scene and plane origin they are projected from; the Site data pin and line. */
export interface CanvasMapSurfaceOverlaySnapshot {
  readonly runtime: Pick<CanvasQuerySurface, 'getSceneSnapshot'>
  readonly location: { readonly lat: number; readonly lon: number }
  readonly hoveredTargets: readonly PanelTarget[]
  readonly selectedTargets: readonly PanelTarget[]
  /**
   * Desktop's pin and profile line, as [lon, lat], read from app/lidar/site-transients.ts; null on Web, in overview and with
   * neither. The chart hover never rides the snapshot: `readSiteHover?()` feeds `WorkspaceMapContributions.setSiteHover`.
   */
  readonly site: SiteMapOverlay | null
}

export function clearCanvasMapSurfaceOverlays(map: MapLibreOverlayMap): void {
  clearPanelTargetMapOverlay(map, 'hover')
  clearPanelTargetMapOverlay(map, 'selection')
}

/** Paints the hover and selection overlays; with no Targets it clears them without reading the Scene. */
export function syncCanvasMapSurfaceOverlays(map: MapLibreOverlayMap, snapshot: CanvasMapSurfaceOverlaySnapshot): void {
  const { hoveredTargets, selectedTargets, location } = snapshot
  if (hoveredTargets.length === 0 && selectedTargets.length === 0) {
    clearCanvasMapSurfaceOverlays(map)
    return
  }
  const scene = snapshot.runtime.getSceneSnapshot()
  syncMapOverlay(map, createPanelTargetMapOverlayContract(
    'selection',
    projectTargetsToMapFeatures(selectedTargets, scene, location),
  ))
  syncMapOverlay(map, createPanelTargetMapOverlayContract(
    'hover',
    projectTargetsToMapFeatures(hoveredTargets, scene, location),
  ))
}

/** Clears the Site data pin and line, and the hover ring drawn over them. */
export function clearCanvasMapSurfaceSiteOverlay(map: MapLibreOverlayMap): void {
  const ids = siteMapOverlayIds()
  clearMapOverlay(map, ids.hover)
  clearMapOverlay(map, ids)
}

/** Paints the Site data pin and profile line; with neither it clears them, hover ring included. */
export function syncCanvasMapSurfaceSiteOverlay(map: MapLibreOverlayMap, site: SiteMapOverlay | null): void {
  const contract = siteMapOverlayContract(site)
  if (!contract.hasRenderableFeatures) {
    clearCanvasMapSurfaceSiteOverlay(map)
    return
  }
  syncMapOverlay(map, contract)
}

/** Clears the profile chart's hover ring. */
export function clearCanvasMapSurfaceSiteHover(map: MapLibreOverlayMap): void {
  clearMapOverlay(map, siteMapOverlayIds().hover)
}

/** Moves the profile chart's hover ring ([lon, lat]) with one setData on its own source; null clears it. */
export function syncCanvasMapSurfaceSiteHover(map: MapLibreOverlayMap, hover: readonly [number, number] | null): void {
  const contract = siteHoverOverlayContract(hover)
  if (!contract.hasRenderableFeatures) {
    clearCanvasMapSurfaceSiteHover(map)
    return
  }
  syncMapOverlay(map, contract)
}
