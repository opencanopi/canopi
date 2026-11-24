/**
 * editions/desktop/manifest.ts: Desktop L5 edition-root parity manifest (A33, ADR 0030, 2.1-M211).
 *
 * Commands and panels are derived directly from `DESKTOP_SHELL_COMMAND_CATALOG`
 * so any unregistered or drifting command/panel breaks A33 parity.
 */
import { DESKTOP_SHELL_COMMAND_CATALOG } from '../../commands/registry'
import type { EditionCapabilityId } from '../../generated/edition-capabilities'
import type { EditionManifest, EditionManifestEntry } from '../../platform/edition-manifest'

const DESKTOP_ONLY_COMMAND_GATES: Readonly<Record<string, EditionCapabilityId>> = {
  'file.open': 'file-home',
  'file.save': 'file-home',
  'file.saveAs': 'save-as-path',
  'file.addData': 'site-data-below-limit',
  'file.dataLibrary': 'site-data-below-limit',
  'file.exit': 'quit-app',
  'nav.siteData': 'site-data-below-limit',
  'nav.designNotebook': 'design-notebook',
  'siteData.profile': 'site-data-below-limit',
  'help.commandPalette': 'desktop-browser-reserved-chords',
}

const DESKTOP_ONLY_PANEL_GATES: Readonly<Record<string, EditionCapabilityId>> = {
  'site-data': 'site-data-below-limit',
  'design-notebook': 'design-notebook',
}

function gateEntry(
  id: string,
  gates: Readonly<Record<string, EditionCapabilityId>>,
): EditionManifestEntry {
  const gatedBy = gates[id]
  return gatedBy ? { id, gatedBy } : { id }
}

const desktopCommands: readonly EditionManifestEntry[] = [
  ...DESKTOP_SHELL_COMMAND_CATALOG.map((cmd) => gateEntry(cmd.id, DESKTOP_ONLY_COMMAND_GATES)),
]

const desktopPanels: readonly EditionManifestEntry[] = [
  ...DESKTOP_SHELL_COMMAND_CATALOG
    .filter((cmd) => cmd.panel !== undefined)
    .map((cmd) => gateEntry(cmd.panel!.panel, DESKTOP_ONLY_PANEL_GATES)),
]

export const DESKTOP_EDITION_MANIFEST: EditionManifest = {
  commands: desktopCommands,
  fileDelivery: [
    { id: 'file.save', gatedBy: 'file-home' },
    { id: 'file.saveAs', gatedBy: 'save-as-path' },
    { id: 'file.exportCanvasPdf' },
    { id: 'file.exportBudgetCsv' },
    { id: 'file.exportGeoJson' },
    { id: 'help.reportProblem' },
  ],
  mapContributions: [
    { id: 'basemap' },
    { id: 'satellite' },
    { id: 'contours' },
    { id: 'hillshade' },
    { id: 'scene' },
    { id: 'my-location' },
    { id: 'site-data-rasters', gatedBy: 'site-data-below-limit' },
  ],
  panels: desktopPanels,
  settingsSlices: [
    { id: 'locale' },
    { id: 'theme' },
    { id: 'map-and-imagery' },
    { id: 'canvas-preferences' },
    { id: 'keyboard-shortcuts' },
    { id: 'files-and-data', gatedBy: 'file-home' },
    { id: 'updates', gatedBy: 'app-updater' },
  ],
  keymap: [
    { id: 'shared-editing-chords' },
    { id: 'shared-navigation-chords' },
    { id: 'shared-view-chords' },
    { id: 'desktop-browser-reserved-chords', gatedBy: 'desktop-browser-reserved-chords' },
  ],
}
