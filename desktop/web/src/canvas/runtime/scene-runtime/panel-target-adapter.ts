import type { PanelTarget } from '../../../generated/contracts'

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
