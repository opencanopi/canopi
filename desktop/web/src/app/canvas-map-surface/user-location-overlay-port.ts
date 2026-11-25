import { clearUserLocationOverlay, syncUserLocationOverlay } from '../../maplibre/user-location-overlay'
import type { UserLocationOverlayPort } from './workspace-map-contribution-adapter'

/**
 * Web-only map overlay port for Show my location, supplied through WorkspaceMapContributionAdapter so
 * Desktop does not bundle Web-only geolocation overlay rendering code.
 */
export const USER_LOCATION_OVERLAY_PORT: UserLocationOverlayPort = {
  sync: syncUserLocationOverlay,
  clear: clearUserLocationOverlay,
}
