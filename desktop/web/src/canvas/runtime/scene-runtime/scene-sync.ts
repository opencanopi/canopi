import { setCanvasSelection } from '../../session-state'
import type { ToolId } from '../interaction-types'
import type { SceneStateReader } from '../scene'

export function resetTransientRuntimeState(
  setTool: (id: ToolId) => void,
  closePlantAppearance?: () => void,
): void {
  setTool('select')
  closePlantAppearance?.()
}

/** The Scene's selection reaches the app's selection signal after each commit, undo and redo. */
export function syncCanvasSignalsFromScene(sceneStore: SceneStateReader): void {
  setCanvasSelection(sceneStore.session.selectedTargets.map((target) => target.id))
}
