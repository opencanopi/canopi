import type { MapLibreMapInstance } from '../../maplibre/loader'
import { clearUserLocationOverlay, syncUserLocationOverlay, type UserLocationReading } from '../../maplibre/user-location-overlay'

export interface UserLocationOverlayPort {
  sync(map: MapLibreMapInstance, reading: UserLocationReading | null): void
  clear(map: MapLibreMapInstance): void
}

/**
 * Map overlay port for Show my location, supplied through WorkspaceMapContributionAdapter.
 */
export const USER_LOCATION_OVERLAY_PORT: UserLocationOverlayPort = {
  sync: syncUserLocationOverlay,
  clear: clearUserLocationOverlay,
}
