import { SceneCanvasRuntime, type SceneCanvasRuntimeOptions } from '../../canvas/runtime/scene-runtime'
import type { CanvasRuntimeSurfaces } from '../../canvas/runtime/runtime'
import { createForwardingCanvasKeyboardPort } from '../../canvas/runtime/keyboard-port'
import type { CameraDriverHost } from '../../geo/view/camera-driver'
import { createDetachedCanvasRuntimeAppAdapter } from './detached-canvas-app-adapter'

export interface TestCanvasRuntimeHostOptions extends Partial<SceneCanvasRuntimeOptions> {
  /** The map's size in CSS px: the runtime is resized to it before init, as the map container reports its size. */
  readonly screen?: { readonly width: number; readonly height: number }
}

/**
 * A live scene runtime without the map workspace, for scene-level tests.
 * Production and the UI gallery mount the shared workspace composition
 * (app/canvas-map-surface/workspace-runtime-composition.ts) instead.
 */
export interface CanvasRuntimeHost {
  readonly surfaces: CanvasRuntimeSurfaces
  /** The runtime's camera, for tests that read where the view puts a point. */
  readonly cameraHost: CameraDriverHost
  init(container: HTMLElement): Promise<void>
  destroy(): Promise<void>
}

export function createLiveTestCanvasRuntimeHost(
  { screen, ...options }: TestCanvasRuntimeHostOptions = {},
): CanvasRuntimeHost {
  const runtime = new SceneCanvasRuntime({
    ...options,
    appAdapter: options.appAdapter ?? createDetachedCanvasRuntimeAppAdapter(),
  })
  if (screen) runtime.documentSurface.resize(screen.width, screen.height)
  return {
    cameraHost: runtime.cameraHost,
    surfaces: {
      commands: runtime.commandSurface,
      queries: runtime.querySurface,
      documents: runtime.documentSurface,
      // Before init there is no map host yet: the port answers with a detached one and consumes nothing.
      keyboard: createForwardingCanvasKeyboardPort(() => runtime.keyboardPort, document.createElement('div')),
    },
    init: (container) => runtime.init(container),
    destroy: async () => {
      runtime.destroy()
    },
  }
}
