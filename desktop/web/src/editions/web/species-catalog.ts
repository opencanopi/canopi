import type { SpeciesCatalogWorkbench } from '../../app/plant-browser'
import { createBrowserSpeciesCatalogRuntime } from './species-catalog-runtime'

const liveSpeciesCatalog = createBrowserSpeciesCatalogRuntime()

export const speciesCatalogWorkbench: SpeciesCatalogWorkbench = liveSpeciesCatalog.workbench

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    try {
      await liveSpeciesCatalog.dispose()
    } catch (error) {
      console.error('Failed to dispose Web Species Catalog:', error)
    }
  })
}
