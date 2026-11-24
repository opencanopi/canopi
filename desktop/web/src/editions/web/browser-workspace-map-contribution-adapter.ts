import { designSessionStore, type DesignSessionStore } from '../../app/document-session/store'
import { myLocation } from '../../app/my-location/session'
import {
  readWorkspaceMapContributions,
  type WorkspaceMapContributionAdapter,
} from '../../app/canvas-map-surface/workspace-map-contribution-adapter'

/**
 * The Web Edition holds no local data: no LiDAR layers, no terrain and no Site data pin or line. It alone shows the
 * device location (U54 Q9).
 */
const WEB_CONTRIBUTIONS = Object.freeze({
  site: null,
  lidar: [],
  terrain: {
    contoursVisible: false, contoursOpacity: 0, contourIntervalMeters: 1,
    hillshadeVisible: false, hillshadeOpacity: 0, isDark: false,
  },
})

export function createBrowserWorkspaceMapContributionAdapter(
  store: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'> = designSessionStore,
): WorkspaceMapContributionAdapter {
  return {
    read: (runtime) => readWorkspaceMapContributions(runtime, store, () => WEB_CONTRIBUTIONS),
    readUserLocation: () => myLocation.reading.value,
  }
}
