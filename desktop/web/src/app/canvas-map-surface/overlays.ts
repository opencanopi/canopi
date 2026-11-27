import type { CanvasMapBackdrop, CanvasPaintTokens } from '../../canvas/runtime/scene-visuals'
import {
  clearMapOverlay,
  syncMapOverlay,
  type MapLibreOverlayMap,
} from '../../maplibre/panel-target-overlay-sync'
import {
  siteHoverOverlayContract,
  siteMapOverlayContract,
  siteMapOverlayIds,
  type SiteMapOverlay,
} from '../../maplibre/site-overlay'

/** Map overlay snapshot: the Site data pin and line (panel highlights draw on the canvas only, canopi-1ecd). */
export interface CanvasMapSurfaceOverlaySnapshot {
  /**
   * Desktop's pin and profile line, as [lon, lat], read from app/lidar/site-transients.ts; null on Web, in overview and with
   * neither. The chart hover never rides the snapshot: `readSiteHover?()` feeds `WorkspaceMapContributions.setSiteHover`.
   */
  readonly site: SiteMapOverlay | null
  /** Active map backdrop for hover-ring ink contrast (defaults to 'basemap' when omitted in unit stubs). */
  readonly mapBackdrop?: CanvasMapBackdrop
  /** Snapshot paint tokens for profile line / vertex guide colours (defaults to current theme tokens when omitted). */
  readonly paintTokens?: CanvasPaintTokens
}

/** Clears the Site data pin and line, and the hover ring drawn over them. */
export function clearCanvasMapSurfaceSiteOverlay(map: MapLibreOverlayMap): void {
  const ids = siteMapOverlayIds()
  clearMapOverlay(map, ids.hover)
  clearMapOverlay(map, ids)
}

/** Paints the Site data pin and profile line; with neither it clears them, hover ring included. */
export function syncCanvasMapSurfaceSiteOverlay(
  map: MapLibreOverlayMap,
  site: SiteMapOverlay | null,
  paintTokens?: CanvasPaintTokens,
): void {
  const contract = siteMapOverlayContract(site, paintTokens)
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
export function syncCanvasMapSurfaceSiteHover(
  map: MapLibreOverlayMap,
  hover: readonly [number, number] | null,
  backdrop?: CanvasMapBackdrop,
): void {
  const contract = siteHoverOverlayContract(hover, backdrop)
  if (!contract.hasRenderableFeatures) {
    clearCanvasMapSurfaceSiteHover(map)
    return
  }
  syncMapOverlay(map, contract)
}
