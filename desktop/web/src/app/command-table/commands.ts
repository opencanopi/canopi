// app/command-table/commands.ts  (L2 rank 2, pure)
//
// Shell command ids and user-facing `Instead` note lookup for lacking edition
// capabilities (contracts §21, 2.1-M163, 2.1-Q358).

import {
  EDITION_CAPABILITIES,
  type EditionCapabilityId,
} from '../../generated/edition-capabilities'

export type ShellCommandId =
  | 'file.new'
  | 'file.open'
  | 'file.openCanopi'
  | 'file.rename'
  | 'file.save'
  | 'file.saveAs'
  | 'file.downloadCanopi'
  | 'file.revert'
  | 'file.addData'
  | 'file.dataLibrary'
  | 'file.importGeoJson'
  | 'file.exportCanvasPdf'
  | 'file.exportGeoJson'
  | 'file.exportBudgetCsv'
  | 'app.settings'
  | 'edit.findPlants'
  | 'file.close'
  | 'file.exit'
  | 'nav.canvas'
  | 'nav.templates'
  | 'nav.layers'
  | 'nav.siteData'
  | 'nav.speciesKey'
  | 'nav.plantDb'
  | 'nav.favorites'
  | 'nav.calendar'
  | 'nav.budget'
  | 'nav.consortium'
  | 'nav.designNotebook'
  | 'nav.stories'
  | 'siteData.profile'
  | 'view.saveCurrentView'
  | 'view.manageViews'
  | 'view.toggleToolNames'
  | 'view.backgroundSatellite'
  | 'view.backgroundMap'
  | 'view.backgroundNone'
  | 'view.toggleTheme'
  | 'help.commandPalette'
  | 'help.shortcuts'
  | 'help.gettingStarted'
  | 'help.reportProblem'
  | 'help.aboutCanopi'

/** User-facing Instead note for a lacking capability set (2.1-M163, 2.1-Q358). */
export function insteadNoteFor(lacking: readonly EditionCapabilityId[]): string | undefined {
  for (const id of lacking) {
    const instead = EDITION_CAPABILITIES.find((row) => row.id === id)?.instead
    if (instead && instead !== 'none' && instead !== 'none needed') return instead
  }
  return lacking.length > 0 ? 'Needs Canopi Desktop' : undefined
}
