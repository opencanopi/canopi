import { mutateSettingsProjection } from '../settings/projection'
import { currentCanvasSceneEditCommandSurface } from '../../canvas/session'

export function saveCanvasSelectionAsObjectStamp(): void {
  currentCanvasSceneEditCommandSurface.value?.saveSelectionAsObjectStamp?.()
}

export function commitSavedStampsFrameHeight(height: number): void {
  if (!Number.isFinite(height)) return
  mutateSettingsProjection((settings) => {
    settings.savedStamps.frameHeight = height
  }, { persist: 'immediate' })
}
