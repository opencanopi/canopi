import { designSessionStore, type DesignSessionStore } from '../../app/document-session/store'
import {
  createSharedContributionCapabilities,
  readWorkspaceMapContributions,
  type WorkspaceMapContributionAdapter,
} from '../../app/canvas-map-surface/workspace-map-contribution-adapter'

/**
 * Web Edition map contributions (2.1-Q25, 2.1-Q45): shares terrain (Contours +
 * Relief) and My location with Desktop; adds no local LiDAR or Site data overlays.
 */
export function createBrowserWorkspaceMapContributionAdapter(
  store: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'> = designSessionStore,
): WorkspaceMapContributionAdapter {
  return {
    ...createSharedContributionCapabilities({ locationEnabled: true }),
    read: (runtime) => readWorkspaceMapContributions(runtime, store),
  }
}
