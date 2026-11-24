/**
 * editions/web/manifest.ts: Web L5 edition-root parity manifest (A33, ADR 0030, 2.1-M211).
 *
 * Commands and panels are derived directly from `BROWSER_SHELL_CAPABILITY_IDS`
 * and `SHELL_COMMAND_DESCRIPTORS`.
 */
import { SHELL_COMMAND_DESCRIPTORS } from '../../app/shell-commands'
import type { EditionCapabilityId } from '../../generated/edition-capabilities'
import type { EditionManifest, EditionManifestEntry } from '../../platform/edition-manifest'
import { BROWSER_SHELL_CAPABILITY_IDS } from './browser-shell-commands'

const webCapabilitySet = new Set<string>(BROWSER_SHELL_CAPABILITY_IDS)
const webDescriptors = SHELL_COMMAND_DESCRIPTORS.filter((d) => webCapabilitySet.has(d.capabilityId))

const WEB_INSTEAD_OF_COMMANDS: Readonly<Record<string, EditionCapabilityId>> = {
  'file.openCanopi': 'file-home',
  'file.downloadCanopi': 'file-home',
  'nav.templates': 'file-home',
}

const WEB_INSTEAD_OF_PANELS: Readonly<Record<string, EditionCapabilityId>> = {
  templates: 'file-home',
}

function webEntry(
  id: string,
  insteadOfMap: Readonly<Record<string, EditionCapabilityId>>,
): EditionManifestEntry {
  const insteadOf = insteadOfMap[id]
  return insteadOf ? { id, insteadOf } : { id }
}

const webCommands: readonly EditionManifestEntry[] = [
  ...webDescriptors.map((cmd) => webEntry(cmd.id, WEB_INSTEAD_OF_COMMANDS)),
]

const webPanels: readonly EditionManifestEntry[] = [
  ...webDescriptors
    .filter((cmd) => cmd.panel !== undefined)
    .map((cmd) => webEntry(cmd.panel!.panel, WEB_INSTEAD_OF_PANELS)),
]

export const WEB_EDITION_MANIFEST: EditionManifest = {
  commands: webCommands,
  fileDelivery: [
    { id: 'file.downloadCanopi', insteadOf: 'file-home' },
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
  ],
  panels: webPanels,
  settingsSlices: [
    { id: 'locale' },
    { id: 'theme' },
    { id: 'map-and-imagery' },
    { id: 'canvas-preferences' },
    { id: 'keyboard-shortcuts' },
  ],
  keymap: [
    { id: 'shared-editing-chords' },
    { id: 'shared-navigation-chords' },
    { id: 'shared-view-chords' },
  ],
}
