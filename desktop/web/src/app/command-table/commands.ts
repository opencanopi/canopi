// app/command-table/commands.ts  (L2 rank 2, pure)
//
// Shell command ids and localised `Instead` note key lookup for lacking
// edition capabilities (contracts §21, 2.1-M163, 2.1-Q358).

import type { EditionCapabilityId } from '../../generated/edition-capabilities'
import type { LocaleKey } from '../../generated/locale-keys'

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

/** Single source of truth for non-panel shell command capability gates (contracts §21, 2.1-M164). */
export const SHELL_COMMAND_REQUIRES: Readonly<Partial<Record<ShellCommandId, readonly EditionCapabilityId[]>>> = {
  'file.open': ['file-home'],
  'file.save': ['file-home'],
  'file.saveAs': ['save-as-path'],
  'file.exit': ['quit-app'],
  'file.addData': ['site-data-below-limit'],
  'file.dataLibrary': ['site-data-below-limit'],
  'siteData.profile': ['site-data-below-limit'],
}

/** Localised Instead note key for a lacking capability set (2.1-M163, 2.1-Q358). */
export function insteadNoteKeyFor(lacking: readonly EditionCapabilityId[]): LocaleKey | undefined {
  return lacking.length > 0 ? 'editionCapability.needsDesktop' : undefined
}
