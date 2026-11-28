import { effect } from '@preact/signals'
import type { CanvasRuntimePlantDisplayAdapter, CanvasRuntimeSettingsAdapter } from '../app-adapter'
import type { PlantDisplay } from '../plant-display'
import type { ViewFrameSource } from '../../../geo/view/types'
import type { CanvasMapBackdrop } from '../scene-visuals'
import {
  runCanvasRuntimeCleanups,
  throwCanvasRuntimeCleanupErrors,
} from '../cleanup'

interface SceneRuntimeEffectsDeps {
  onTheme: () => void
  onLocale: () => void
  onUnitSystem?: () => void
  onChromeOverlay: () => void
  onMapBackdrop: (backdrop: CanvasMapBackdrop) => void
  onPlantDisplay: (display: PlantDisplay) => void
  plantDisplay?: CanvasRuntimePlantDisplayAdapter
  onPanelTargetHover: () => void
  /** The runtime camera's frames: each frame after the first invalidates (render invalidation coalesces per animation frame). */
  frames: Pick<ViewFrameSource, 'viewFrame'>
  onCameraFrame: () => void
  settings: Pick<
    CanvasRuntimeSettingsAdapter,
    'subscribeTheme' | 'subscribeLocale' | 'subscribeUnitSystem' | 'subscribeChromeOverlay' | 'subscribeMapBackdrop'
  >
  subscribePanelOriginTargetChanges(onChange: () => void): () => void
}

export function installSceneRuntimeEffects(deps: SceneRuntimeEffectsDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  try {
    let initialCameraFrame = true
    disposers.push(effect(() => {
      void deps.frames.viewFrame.value
      if (initialCameraFrame) {
        initialCameraFrame = false
        return
      }
      deps.onCameraFrame()
    }))
    disposers.push(deps.settings.subscribeTheme(deps.onTheme))
    disposers.push(deps.settings.subscribeLocale(deps.onLocale))
    if (deps.settings.subscribeUnitSystem && deps.onUnitSystem) {
      disposers.push(deps.settings.subscribeUnitSystem(deps.onUnitSystem))
    }
    disposers.push(deps.settings.subscribeChromeOverlay(deps.onChromeOverlay))
    disposers.push(deps.settings.subscribeMapBackdrop(deps.onMapBackdrop))
    if (deps.plantDisplay) disposers.push(deps.plantDisplay.subscribe(deps.onPlantDisplay))
    disposers.push(deps.subscribePanelOriginTargetChanges(deps.onPanelTargetHover))
    return disposers
  } catch (error) {
    const errors: unknown[] = [error]
    try {
      runCanvasRuntimeCleanups(
        [...disposers].reverse(),
        'Scene Canvas runtime effect installation rollback failed',
      )
    } catch (cleanupError) {
      errors.push(cleanupError)
    }
    throwCanvasRuntimeCleanupErrors(errors, 'Scene Canvas runtime effect installation failed')
    return []
  }
}
