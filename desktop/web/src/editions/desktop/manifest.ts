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

const e = (id: string, gatedBy?: EditionCapabilityId): EditionManifestEntry =>
  gatedBy ? { id, gatedBy } : { id }

export const DESKTOP_EDITION_MANIFEST: EditionManifest = {
  commands: DESKTOP_SHELL_COMMAND_CATALOG.map((cmd) => e(cmd.id, DESKTOP_ONLY_COMMAND_GATES[cmd.id])),
  fileDelivery: [
    e('file.save', 'file-home'),
    e('file.saveAs', 'save-as-path'),
    e('file.exportCanvasPdf'),
    e('file.exportBudgetCsv'),
    e('file.exportGeoJson'),
    e('help.reportProblem'),
  ],
  mapContributions: [
    e('basemap'),
    e('satellite'),
    e('contours'),
    e('hillshade'),
    e('scene'),
    e('my-location'),
    e('site-data-rasters', 'site-data-below-limit'),
  ],
  panels: DESKTOP_SHELL_COMMAND_CATALOG
    .filter((cmd) => cmd.panel !== undefined)
    .map((cmd) => e(cmd.panel!.panel, DESKTOP_ONLY_PANEL_GATES[cmd.panel!.panel])),
  settingsSlices: [
    e('locale'),
    e('theme'),
    e('map-and-imagery'),
    e('canvas-preferences'),
    e('keyboard-shortcuts'),
    e('files-and-data', 'file-home'),
    e('updates', 'app-updater'),
  ],
  keymap: [
    e('shared-editing-chords'),
    e('shared-navigation-chords'),
    e('shared-view-chords'),
    e('desktop-browser-reserved-chords', 'desktop-browser-reserved-chords'),
  ],
}
