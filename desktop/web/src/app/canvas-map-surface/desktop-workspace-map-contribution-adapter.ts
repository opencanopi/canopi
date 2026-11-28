import { designSessionStore } from '../document-session/store'
import { storyPresentationOverrides } from '../story-presentation/overrides'
import { readCurrentLidarPresentation } from '../data-library/library-store'
import { lidarDisplayDescriptors, lidarDisplayLayers } from '../data-library/display'
import { pin, profileLine } from '../data-library/site-transients'
import { profileHover } from '../data-library/profile'
import type { SiteMapOverlay } from '../../maplibre/site-overlay'
import { createRasterDisplay } from '../../maplibre/raster-display/adapter'
import {
  createSharedContributionCapabilities,
  readWorkspaceMapContributions,
  type WorkspaceMapContributionAdapter,
} from './workspace-map-contribution-adapter'

export interface DesktopWorkspaceMapContributionOptions {
  /** Whether the host desktop OS provides My location (`capabilities.has('my-location')`). */
  readonly locationEnabled: boolean
}

export function createDesktopWorkspaceMapContributionAdapter(
  options: DesktopWorkspaceMapContributionOptions,
): WorkspaceMapContributionAdapter {
  return {
    ...createSharedContributionCapabilities({ locationEnabled: options.locationEnabled }),
    createRasterDisplay: (map, options) => createRasterDisplay(map, options),
    readSiteHover,
    read: (runtime) => readWorkspaceMapContributions(runtime, designSessionStore, () => ({
      lidar: lidarDisplayLayers(
        readCurrentLidarPresentation(),
        lidarDisplayDescriptors.value,
        storyPresentationOverrides.value?.siteDataIds ?? null,
      ),
      site: readSiteMapOverlay(),
    })),
  }
}

/** The profile chart's hover point in [lon, lat], or null. */
function readSiteHover(): readonly [number, number] | null {
  const hover = profileHover.value
  return hover ? [hover.lon, hover.lat] : null
}

/** The Site data pin and profile line in [lon, lat], or null with neither. */
function readSiteMapOverlay(): SiteMapOverlay | null {
  const point = pin.value
  const line = profileLine.value
  if (!point && !line) return null
  return {
    pin: point ? [point.lon, point.lat] : null,
    profileLine: line ? line.map((vertex) => [vertex.lon, vertex.lat] as const) : null,
  }
}
