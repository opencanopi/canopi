import {
  clearPanelOriginTargets,
  readPanelOriginTargets,
  subscribePanelOriginTargetChanges,
} from '../panel-targets/presentation'
import type { SceneRuntimePanelTargetAdapter } from '../../canvas/runtime/scene-runtime/panel-target-adapter'

export function createAppSceneRuntimePanelTargetAdapter(): SceneRuntimePanelTargetAdapter {
  return {
    readPanelOriginTargets,
    clearPanelOriginTargets,
    subscribePanelOriginTargetChanges,
  }
}
