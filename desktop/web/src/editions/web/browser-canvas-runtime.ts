import type { CanvasRuntimeAppAdapter } from '../../canvas/runtime/app-adapter'
import { CanvasPlantLabelResolver } from '../../canvas/runtime/plant-labels'
import { createDetachedCanvasSpeciesPresentationCache } from '../../canvas/runtime/presentation-data'
import { createAppCanvasRuntimeAppAdapter } from '../../app/canvas-runtime/app-adapter'
import { speciesCatalogWorkbench } from '../../app/plant-browser'

export function createBrowserCanvasRuntimeAppAdapter(): CanvasRuntimeAppAdapter {
  return createAppCanvasRuntimeAppAdapter({
    presentationData: {
      plantLabels: new CanvasPlantLabelResolver((names, locale) =>
        speciesCatalogWorkbench.resolveDisplayNames(names, locale),
      ),
      speciesCache: createDetachedCanvasSpeciesPresentationCache(),
    },
  })
}
