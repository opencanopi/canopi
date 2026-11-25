/**
 * app/canvas-map-surface/desktop-workspace-runtime.ts: Desktop (and Gallery) CanvasHostCore
 * binding directly onto the unified SessionCore via ScenePort (C3, ADR 0024, contracts §4).
 */
import { getLiveSessionCore, requireLiveSessionCore } from '../document-session/live-core'
import { createDesktopCanvasRuntimeAppAdapter } from '../canvas-runtime/desktop-adapter'
import type { CanvasHostCore } from './canvas-host'
import {
  createDesktopWorkspaceMapContributionAdapter,
  type DesktopWorkspaceMapContributionOptions,
} from './desktop-workspace-map-contribution-adapter'
import { scenePortOf } from './scene-port'
import type { CanvasHostRuntimeBinding } from './use-canvas-host'

export function createDesktopCanvasHostCore(): CanvasHostCore {
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

export function createDesktopCanvasHostRuntime(
  contributions: DesktopWorkspaceMapContributionOptions,
): CanvasHostRuntimeBinding {
  return {
    core: createDesktopCanvasHostCore(),
    adapters: {
      appAdapter: createDesktopCanvasRuntimeAppAdapter(),
      mapContributions: createDesktopWorkspaceMapContributionAdapter(contributions),
    },
  }
}
