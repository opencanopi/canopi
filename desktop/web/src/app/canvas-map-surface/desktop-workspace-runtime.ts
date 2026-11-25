import { failureLogger } from '../../failures/report'
import { createDesktopCanvasRuntimeAppAdapter } from '../canvas-runtime/desktop-adapter'
import { createAppSceneRuntimePanelTargetAdapter } from '../canvas-runtime/panel-target-adapter'
import {
  abortFailedAttachedDesignSessionStart,
  consumeQueuedDocumentLoad,
  startAttachedDesignSession,
  teardownAttachedDesignSession,
} from '../document-session/transition'
import type { CanvasDocumentSurface } from '../../canvas/runtime/runtime'
import type { CanvasHostCore } from './canvas-host'
import { createDesktopWorkspaceMapContributionAdapter } from './desktop-workspace-map-contribution-adapter'
import { persistLastView } from './last-view'
import type { CanvasHostRuntimeBinding } from './use-canvas-host'
import {
  createWorkspaceRuntimeComposition,
  type WorkspaceRuntimeComposition,
  type WorkspaceRuntimeMountOptions,
} from './workspace-runtime-composition'

/** Desktop's complete shared-workspace assembly. */
function createDesktopWorkspaceRuntimeComposition(
  options: WorkspaceRuntimeMountOptions,
): WorkspaceRuntimeComposition {
  return createWorkspaceRuntimeComposition({
    ...options,
    appAdapter: createDesktopCanvasRuntimeAppAdapter(),
    targetPresentation: createAppSceneRuntimePanelTargetAdapter(),
    mapContributions: createDesktopWorkspaceMapContributionAdapter(),
    onViewSettled: persistLastView,
  })
}

/**
 * Desktop's interim CanvasHostCore bridge until 2b-3 (canopi-f47t.52.48) replaces transition.ts,
 * consumeQueuedDocumentLoad, and per-edition createComposition with SessionCore.
 */
export function createDesktopCanvasHostCore(): CanvasHostCore {
  const logError = failureLogger('document-session')
  let activeDocuments: CanvasDocumentSurface | null = null
  let cancelQueuedLoad: (() => void) | null = null

  return {
    async attachScene(documents) {
      activeDocuments = documents
      const failAttach = (error: unknown) => {
        abortFailedAttachedDesignSessionStart(documents, logError)
        activeDocuments = null
        return { kind: 'failed' as const, error }
      }
      const result = await startAttachedDesignSession(documents)
      if (result?.status === 'failed') return failAttach(result.error)
      try {
        cancelQueuedLoad = consumeQueuedDocumentLoad(documents)
      } catch (error) {
        return failAttach(error)
      }
      return 'attached'
    },
    detachScene() {
      const documents = activeDocuments
      if (documents) {
        teardownAttachedDesignSession({
          session: documents,
          runtimeInitialized: true,
          logError,
        })
      }
      activeDocuments = null
      const cancel = cancelQueuedLoad
      cancelQueuedLoad = null
      try {
        cancel?.()
      } catch (error) {
        logError('Failed to cancel a pending document load:', error)
      }
    },
  }
}

export function createDesktopCanvasHostRuntime(): CanvasHostRuntimeBinding {
  return {
    core: createDesktopCanvasHostCore(),
    createComposition: createDesktopWorkspaceRuntimeComposition,
  }
}
