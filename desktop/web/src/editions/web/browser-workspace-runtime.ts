import type { DesignSessionStore } from '../../app/document-session/store'
import type { CanvasHostCore } from '../../app/canvas-map-surface/canvas-host'
import { scenePortOf } from '../../app/canvas-map-surface/scene-port'
import type { CanvasHostRuntimeBinding } from '../../app/canvas-map-surface/use-canvas-host'
import { readWorkspaceActivationSnapshot } from '../../app/canvas-map-surface/workspace-activation-snapshot'
import { getLiveSessionCore, requireLiveSessionCore } from '../../app/document-session/live-core'
import { createBrowserCanvasRuntimeAppAdapter } from './browser-canvas-runtime'
import { createBrowserWorkspaceMapContributionAdapter } from './browser-workspace-map-contribution-adapter'

function createBrowserCanvasHostCore(): CanvasHostCore {
  return {
    attachScene(documents) {
      const core = requireLiveSessionCore()
      try {
        return core.attachScene(scenePortOf(documents))
      } catch (error) {
        return { kind: 'failed' as const, error }
      }
    },
    detachScene() {
      getLiveSessionCore()?.detachScene()
    },
  }
}

export function createBrowserCanvasHostRuntime(
  store?: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'>,
): CanvasHostRuntimeBinding {
  return {
    core: createBrowserCanvasHostCore(),
    adapters: {
      appAdapter: createBrowserCanvasRuntimeAppAdapter(),
      mapContributions: createBrowserWorkspaceMapContributionAdapter(store),
      readSnapshot: (readInitialCenter) => readWorkspaceActivationSnapshot({ store, readInitialCenter }),
    },
  }
}
