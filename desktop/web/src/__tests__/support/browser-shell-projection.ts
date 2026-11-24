import type { Panel, SidePanel } from '../../app/shell/state'
import { workspaceCanvasCommandProjection } from '../../app/workspace-commands/canvas-actions'
import {
  createBrowserShellCatalog,
  createBrowserShellCommandProjection,
  type BrowserShellCapabilities,
  type BrowserShellChromeProjection,
} from '../../editions/web/browser-shell-commands'

/** A Web Edition shell projection from plain test inputs. */
export function projectBrowserShellForTest({
  currentPanel = 'canvas',
  currentSidePanel = null,
  downloadCanopiEnabled = true,
  revertAvailable = false,
  geoJsonEnabled = true,
  templatesEnabled = false,
  capabilities,
}: {
  readonly currentPanel?: Panel
  readonly currentSidePanel?: SidePanel | null
  readonly downloadCanopiEnabled?: boolean
  readonly revertAvailable?: boolean
  readonly geoJsonEnabled?: boolean
  readonly templatesEnabled?: boolean
  readonly capabilities: BrowserShellCapabilities
}): BrowserShellChromeProjection {
  return createBrowserShellCommandProjection({
    catalog: createBrowserShellCatalog(capabilities, { templatesEnabled, canvasReady: () => geoJsonEnabled }),
    state: {
      hasDesign: downloadCanopiEnabled,
      revertAvailable,
      activePanel: currentPanel,
      sidePanel: currentSidePanel,
    },
    canvas: workspaceCanvasCommandProjection.value,
  })
}
