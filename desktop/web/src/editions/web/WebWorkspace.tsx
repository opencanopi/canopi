import { useMemo } from 'preact/hooks'
export { WebCanvasWorkspace } from './WebCanvasWorkspace'
import { WebCanvasWorkspace } from './WebCanvasWorkspace'
import { WebLayersPanel } from './WebLayersPanel'
import { WebSpeciesCatalogPanel, WebSpeciesKeyPanel } from './WebSpeciesCatalogPanel'
import { BudgetPanel } from '../../components/panels/BudgetPanel'
import { CalendarPanel } from '../../components/panels/CalendarPanel'
import { ConsortiumPanel } from '../../components/panels/ConsortiumPanel'
import { StoriesPanel } from '../../components/panels/StoriesPanel'
import {
  WorkspaceComposition,
  type WorkspacePanelProjection,
  type WorkspaceSurfaces,
} from '../../components/workspace/WorkspaceComposition'
import type { PanelRailCommand } from '../../components/shared/PanelRail'
import { PhoneContextBar } from '../../components/canvas/PhoneContextBar'
import { ToolOptions } from '../../components/canvas/ToolCard'
import { designSessionStore } from '../../app/document-session/store'

export function WebWorkspace({
  panelProjection,
  phoneTabs,
}: {
  readonly panelProjection: WorkspacePanelProjection
  /** The side panel commands, as the phone sheet's tabs. */
  readonly phoneTabs: readonly PanelRailCommand[]
}) {
  const surfaces = useMemo<WorkspaceSurfaces>(() => {
    const Canvas = () => <WebCanvasWorkspace />
    return {
      primary: {
        canvas: Canvas,
      },
      side: {
        'species-key': WebSpeciesKeyPanel,
        layers: WebLayersPanel,
        calendar: CalendarPanel,
        budget: BudgetPanel,
        consortium: ConsortiumPanel,
        stories: StoriesPanel,
        'plant-db': WebCatalog,
        favorites: WebFavorites,
      },
    }
  }, [])

  return (
    <WorkspaceComposition
      panelProjection={panelProjection}
      surfaces={surfaces}
      responsive
      phoneTabs={phoneTabs}
      phoneBar={<WebPhoneBar />}
      phoneOptions={<ToolOptions />}
    />
  )
}

/** The phone's context bar while a Design is open; the start screen has none. The UI gallery's Web workspace mounts it too. */
export function WebPhoneBar() {
  return designSessionStore.currentDesign.value === null ? null : <PhoneContextBar />
}

function WebCatalog() {
  return <WebSpeciesCatalogPanel mode="catalog" />
}

function WebFavorites() {
  return <WebSpeciesCatalogPanel mode="favorites" />
}
