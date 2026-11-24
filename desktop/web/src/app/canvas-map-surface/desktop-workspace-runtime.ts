import { createDesktopCanvasRuntimeAppAdapter } from '../canvas-runtime/desktop-adapter'
import { createAppSceneRuntimePanelTargetAdapter } from '../canvas-runtime/panel-target-adapter'
import { createDesktopWorkspaceMapContributionAdapter } from './desktop-workspace-map-contribution-adapter'
import { persistLastView } from './last-view'
import {
  createWorkspaceRuntimeComposition,
  type WorkspaceRuntimeComposition,
  type WorkspaceRuntimeMountOptions,
} from './workspace-runtime-composition'

type DesktopWorkspaceRuntimeFactory = (
  options: WorkspaceRuntimeMountOptions,
) => WorkspaceRuntimeComposition

const overrideSlot: { current: DesktopWorkspaceRuntimeFactory | null } = { current: null }

/** Installs an alternate Desktop workspace runtime factory (used by the offline UI gallery). */
export function installDesktopWorkspaceRuntimeComposition(
  factory: DesktopWorkspaceRuntimeFactory | null,
): () => void {
  const previous = overrideSlot.current
  overrideSlot.current = factory
  return () => {
    if (overrideSlot.current === factory) overrideSlot.current = previous
  }
}

/** Desktop's complete shared-workspace assembly. */
export function createDesktopWorkspaceRuntimeComposition(
  options: WorkspaceRuntimeMountOptions,
): WorkspaceRuntimeComposition {
  if (overrideSlot.current) return overrideSlot.current(options)
  return createWorkspaceRuntimeComposition({
    ...options,
    appAdapter: createDesktopCanvasRuntimeAppAdapter(),
    targetPresentation: createAppSceneRuntimePanelTargetAdapter(),
    mapContributions: createDesktopWorkspaceMapContributionAdapter(),
    onViewSettled: persistLastView,
  })
}
