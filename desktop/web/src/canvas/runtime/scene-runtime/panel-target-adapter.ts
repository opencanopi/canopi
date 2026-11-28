import type { PanelTarget } from '../../../types/design'

export interface SceneRuntimePanelTargetAdapter {
  readPanelOriginTargets(): readonly PanelTarget[]
  clearPanelOriginTargets(): void
  subscribePanelOriginTargetChanges(onChange: () => void): () => void
}

export function createDetachedSceneRuntimePanelTargetAdapter(): SceneRuntimePanelTargetAdapter {
  return {
    readPanelOriginTargets: () => [],
    clearPanelOriginTargets: () => {},
    subscribePanelOriginTargetChanges: () => () => {},
  }
}
