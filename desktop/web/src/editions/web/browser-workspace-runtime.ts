import { createAppSceneRuntimePanelTargetAdapter } from '../../app/canvas-runtime/panel-target-adapter'
import type { DesignSessionStore } from '../../app/document-session/store'
import {
  createWorkspaceRuntimeComposition,
  type WorkspaceRuntimeComposition,
  type WorkspaceRuntimeMountOptions,
} from '../../app/canvas-map-surface/workspace-runtime-composition'
import { readWorkspaceActivationSnapshot } from '../../app/canvas-map-surface/workspace-activation-snapshot'
import { createBrowserCanvasRuntimeAppAdapter } from './browser-canvas-runtime'
import { createBrowserWorkspaceMapContributionAdapter } from './browser-workspace-map-contribution-adapter'
import { persistLastView } from '../../app/canvas-map-surface/last-view'

export interface BrowserWorkspaceRuntimeMountOptions extends WorkspaceRuntimeMountOptions {
  readonly store?: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'>
}

/** Browser's complete shared-workspace assembly, with browser-only map policy. */
export function createBrowserWorkspaceRuntimeComposition(
  options: BrowserWorkspaceRuntimeMountOptions,
): WorkspaceRuntimeComposition {
  const { store, ...mount } = options
  return createWorkspaceRuntimeComposition({
    ...mount,
    appAdapter: createBrowserCanvasRuntimeAppAdapter(),
    targetPresentation: createAppSceneRuntimePanelTargetAdapter(),
    mapContributions: createBrowserWorkspaceMapContributionAdapter(store),
    readSnapshot: (readInitialCenter) => readWorkspaceActivationSnapshot({ store, readInitialCenter }),
    onViewSettled: persistLastView,
  })
}
