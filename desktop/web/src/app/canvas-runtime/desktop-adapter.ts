import type { CanvasRuntimeAppAdapter } from '../../canvas/runtime/app-adapter'
import { CanvasPlantLabelResolver } from '../../canvas/runtime/plant-labels'
import { CanvasSpeciesCache } from './species-cache'
import { speciesCatalogWorkbench } from '../plant-browser'
import { getLiveSessionCore } from '../document-session/live-core'
import { designSessionStore } from '../document-session/store'
import { placeStampThroughCore, savedObjectStampWorkbench } from '../saved-object-stamps'
import { createAppCanvasRuntimeAppAdapter } from './app-adapter'

export function createDesktopCanvasRuntimeAppAdapter(): CanvasRuntimeAppAdapter {
  return createAppCanvasRuntimeAppAdapter({
    presentationData: {
      // Labels read the catalog's one display-name projection, batched and cached there.
      plantLabels: new CanvasPlantLabelResolver((names, locale) => speciesCatalogWorkbench.resolveDisplayNames(names, locale)),
      speciesCache: new CanvasSpeciesCache(),
    },
    savedObjectStamps: {
      saveCurrentSelection: (capture) => savedObjectStampWorkbench.saveSelection({
        ...capture,
        design: capture.design !== undefined ? capture.design : designSessionStore.currentDesign.peek(),
      }),
    },
    placeSavedStamp: (stamp, applyScene) => {
      const core = getLiveSessionCore()
      if (!core) return false
      return placeStampThroughCore(core, stamp, () => applyScene()) !== null
    },
  })
}
