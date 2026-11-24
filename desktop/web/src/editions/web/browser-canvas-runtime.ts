import type { CanvasRuntimeAppAdapter } from '../../canvas/runtime/app-adapter'
import { createDetachedCanvasPlantLabelSource, createDetachedCanvasSpeciesPresentationCache } from '../../canvas/runtime/presentation-data'
import { createAppCanvasRuntimeAppAdapter } from '../../app/canvas-runtime/app-adapter'

export function createBrowserCanvasRuntimeAppAdapter(): CanvasRuntimeAppAdapter {
  return createAppCanvasRuntimeAppAdapter({
    presentationData: {
      plantLabels: createDetachedCanvasPlantLabelSource(),
      speciesCache: createDetachedCanvasSpeciesPresentationCache(),
    },
  })
}
