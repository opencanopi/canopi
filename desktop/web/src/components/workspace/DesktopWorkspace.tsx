import { Suspense } from 'preact/compat'
import { retryableLazy } from '../../failures/lazy'
import { closeDataDialog, closeDataLibrary, dataDialog, libraryView } from '../../app/lidar/library-navigation'
import { SurfaceBoundary } from '../shared/SurfaceBoundary'
import { appCommandGraphPanelProjection } from '../../commands/registry'
import { CanvasPanel } from '../panels/CanvasPanel'
import {
  WorkspaceComposition,
  type WorkspaceSurfaces,
} from './WorkspaceComposition'

const PlantDbPanel = retryableLazy(async () => {
  const module = await import('../panels/PlantDbPanel')
  return { default: module.PlantDbPanel }
})

const FavoritesPanel = retryableLazy(async () => {
  const module = await import('../panels/FavoritesPanel')
  return { default: module.FavoritesPanel }
})

const DesignNotebookPanel = retryableLazy(async () => {
  const module = await import('../panels/DesignNotebookPanel')
  return { default: module.DesignNotebookPanel }
})

const SpeciesKeyPanel = retryableLazy(async () => {
  const module = await import('../panels/DesktopSpeciesKeyPanel')
  return { default: module.DesktopSpeciesKeyPanel }
})

const LayersPanel = retryableLazy(async () => {
  const module = await import('../panels/LayersPanel')
  return { default: module.LayersPanel }
})

const SiteDataPanel = retryableLazy(async () => {
  const module = await import('../panels/lidar/SiteDataPanel')
  return { default: module.SiteDataPanel }
})

const DataDialogs = retryableLazy(async () => {
  const module = await import('../panels/lidar/DataDialogs')
  return { default: module.DataDialogs }
})

const BudgetPanel = retryableLazy(async () => {
  const module = await import('../panels/BudgetPanel')
  return { default: module.BudgetPanel }
})

const CalendarPanel = retryableLazy(async () => {
  const module = await import('../panels/CalendarPanel')
  return { default: module.CalendarPanel }
})

const ConsortiumPanel = retryableLazy(async () => {
  const module = await import('../panels/ConsortiumPanel')
  return { default: module.ConsortiumPanel }
})

const StoriesPanel = retryableLazy(async () => {
  const module = await import('../panels/StoriesPanel')
  return { default: module.StoriesPanel }
})

function DesignNotebookSurface() {
  return <DesignNotebookPanel />
}

function SiteDataSurface() {
  return <SiteDataPanel />
}

const DESKTOP_WORKSPACE_SURFACES: WorkspaceSurfaces = {
  primary: {
    canvas: CanvasPanel,
  },
  side: {
    'plant-db': PlantDbPanel,
    favorites: FavoritesPanel,
    'design-notebook': DesignNotebookSurface,
    'species-key': SpeciesKeyPanel,
    layers: LayersPanel,
    'site-data': SiteDataSurface,
    calendar: CalendarPanel,
    budget: BudgetPanel,
    consortium: ConsortiumPanel,
    stories: StoriesPanel,
  },
}

/** The Data dialogs host's fallback closes both the open dialog and the library under it. */
function closeDataSurfaces(): void {
  closeDataDialog()
  closeDataLibrary()
}

export function DesktopWorkspace() {
  return (
    <>
      <WorkspaceComposition
        panelProjection={appCommandGraphPanelProjection.value}
        surfaces={DESKTOP_WORKSPACE_SURFACES}
      />
      {/* The Data library and the data dialogs sit outside the composition, which turns inert under them. */}
      {(libraryView.value || dataDialog.value) && (
        <SurfaceBoundary surface="data-dialogs" onClose={closeDataSurfaces}>
          <Suspense fallback={null}>
            <DataDialogs />
          </Suspense>
        </SurfaceBoundary>
      )}
    </>
  )
}
