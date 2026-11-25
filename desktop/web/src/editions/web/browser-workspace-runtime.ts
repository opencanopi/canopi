import { createAppSceneRuntimePanelTargetAdapter } from '../../app/canvas-runtime/panel-target-adapter'
import type { DesignSessionStore } from '../../app/document-session/store'
import type { CanvasHostCore } from '../../app/canvas-map-surface/canvas-host'
import type { CanvasHostRuntimeBinding } from '../../app/canvas-map-surface/use-canvas-host'
import {
  createWorkspaceRuntimeComposition,
  type WorkspaceRuntimeComposition,
  type WorkspaceRuntimeMountOptions,
} from '../../app/canvas-map-surface/workspace-runtime-composition'
import { readWorkspaceActivationSnapshot } from '../../app/canvas-map-surface/workspace-activation-snapshot'
import { persistLastView } from '../../app/canvas-map-surface/last-view'
import type { BrowserDesignSessionController } from '../../web/browser-design-session'
import { createBrowserCanvasRuntimeAppAdapter } from './browser-canvas-runtime'
import { createBrowserWorkspaceMapContributionAdapter } from './browser-workspace-map-contribution-adapter'

interface BrowserWorkspaceRuntimeMountOptions extends WorkspaceRuntimeMountOptions {
  readonly store?: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'>
}

/** Browser's complete shared-workspace assembly, with browser-only map policy. */
function createBrowserWorkspaceRuntimeComposition(
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

/** Interim Web CanvasHostCore bridge until 2b-3 (canopi-f47t.52.48) replaces per-edition createComposition with SessionCore. */
function createBrowserCanvasHostCore(
  controller: Pick<BrowserDesignSessionController, 'attachCanvasSession'>,
): CanvasHostCore {
  let detach: (() => void) | null = null
  return {
    attachScene(documents) {
      detach = controller.attachCanvasSession(documents)
      return 'attached'
    },
    detachScene() {
      const fn = detach
      if (!fn) return
      fn()
      detach = null
    },
  }
}

export function createBrowserCanvasHostRuntime(
  controller: Pick<BrowserDesignSessionController, 'attachCanvasSession'>,
  store?: Pick<DesignSessionStore, 'sessionIdentity' | 'hasCurrentDesign'>,
): CanvasHostRuntimeBinding {
  return {
    core: createBrowserCanvasHostCore(controller),
    createComposition: (options) => createBrowserWorkspaceRuntimeComposition({
      ...options,
      ...(store ? { store } : {}),
    }),
  }
}
