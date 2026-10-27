import type { Panel, SidePanel } from '../shell/state'
import {
  ariaKeyShortcuts,
  formatShortcut,
} from './shortcut-text'
import type { LocaleKey } from '../../generated/locale-keys'

type ShellCommandIdByCapability = {
  readonly newDesign: 'file.new'
  readonly openDesign: 'file.open'
  readonly openCanopi: 'file.openCanopi'
  readonly renameDesign: 'file.rename'
  readonly saveDesign: 'file.save'
  readonly saveDesignAs: 'file.saveAs'
  readonly downloadCanopi: 'file.downloadCanopi'
  readonly revertDesign: 'file.revert'
  readonly addData: 'file.addData'
  readonly openDataLibrary: 'file.dataLibrary'
  readonly importGeoJson: 'file.importGeoJson'
  readonly exportCanvasPdf: 'file.exportCanvasPdf'
  readonly exportGeoJson: 'file.exportGeoJson'
  readonly exportBudgetCsv: 'file.exportBudgetCsv'
  readonly openSettings: 'app.settings'
  readonly findPlants: 'edit.findPlants'
  readonly closeDesign: 'file.close'
  readonly exitApp: 'file.exit'
  readonly navigateCanvas: 'nav.canvas'
  readonly navigateTemplates: 'nav.templates'
  readonly navigateLayers: 'nav.layers'
  readonly navigateSiteData: 'nav.siteData'
  readonly navigateSpeciesKey: 'nav.speciesKey'
  readonly navigatePlantDatabase: 'nav.plantDb'
  readonly navigateFavorites: 'nav.favorites'
  readonly navigateCalendar: 'nav.calendar'
  readonly navigateBudget: 'nav.budget'
  readonly navigateConsortium: 'nav.consortium'
  readonly navigateDesignNotebook: 'nav.designNotebook'
  readonly navigateStories: 'nav.stories'
  readonly startProfile: 'siteData.profile'
  readonly saveCurrentView: 'view.saveCurrentView'
  readonly manageViews: 'view.manageViews'
  readonly toggleToolNames: 'view.toggleToolNames'
  readonly showSatellite: 'view.backgroundSatellite'
  readonly showMap: 'view.backgroundMap'
  readonly showNoBackground: 'view.backgroundNone'
  readonly toggleTheme: 'view.toggleTheme'
  readonly showCommandPalette: 'help.commandPalette'
  readonly showShortcuts: 'help.shortcuts'
  readonly gettingStarted: 'help.gettingStarted'
  readonly reportProblem: 'help.reportProblem'
  readonly aboutCanopi: 'help.aboutCanopi'
}

export type ShellCommandCapabilityId = keyof ShellCommandIdByCapability
export type ShellCommandId = ShellCommandIdByCapability[ShellCommandCapabilityId]
export type ShellCommandIdForCapability<
  Capability extends ShellCommandCapabilityId,
> = ShellCommandIdByCapability[Capability]

type ShellMenuId = 'file' | 'edit' | 'view' | 'help'
export type ShellSubmenuId = 'export' | 'background'
type ShellPanelGroup = 'primary' | 'design' | 'planning'

export interface ShellCommandState {
  readonly hasDesign: boolean
  /** The current Design changed since it was opened or created. */
  readonly revertAvailable: boolean
  readonly activePanel: Panel
  readonly sidePanel: SidePanel | null
}

interface ShellCommandCapability {
  execute(): void
  isExecutionDisabled?(state: ShellCommandState): boolean
  isProjectionDisabled?(state: ShellCommandState): boolean
  /** Current value of a checkable command (theme, tool names, background). */
  isChecked?(): boolean
}

export type ShellCommandCapabilities = Partial<
  Record<ShellCommandCapabilityId, ShellCommandCapability>
>

interface ShellCommandMenuPlacement {
  readonly id: ShellMenuId
  readonly section: number
  readonly submenu?: ShellSubmenuId
}

export interface ShellCommandCatalogEntry<
  Id extends ShellCommandId = ShellCommandId,
> {
  readonly capabilityId: ShellCommandCapabilityId
  readonly id: Id
  readonly labelKey: LocaleKey
  /** Canonical shortcut (`Ctrl+Shift+S`); see `shortcut-text.ts`. */
  readonly shortcut?: string
  readonly palette: boolean
  readonly check?: 'checkbox' | 'radio'
  readonly menu?: ShellCommandMenuPlacement
  readonly panel?: {
    readonly panel: Panel
    readonly group: ShellPanelGroup
    readonly order: number
  }
  execute(): void
  isExecutionDisabled(state: ShellCommandState): boolean
  isProjectionDisabled(state: ShellCommandState): boolean
  isChecked(): boolean | undefined
}

export interface ProjectedShellCommand<
  Id extends ShellCommandId = ShellCommandId,
> {
  readonly id: Id
  readonly label: string
  /** Display text, e.g. "Ctrl Shift S". */
  readonly shortcut?: string
  readonly ariaShortcut?: string
  readonly disabled: boolean
  readonly active?: boolean
  readonly checked?: boolean
  readonly check?: 'checkbox' | 'radio'
  readonly submenu?: ShellSubmenuId
  readonly panel?: Panel
  action(): void
}

export interface ShellMenuProjection<
  Id extends ShellCommandId = ShellCommandId,
> {
  readonly id: ShellMenuId
  readonly label: string
  readonly sections: readonly (readonly ProjectedShellCommand<Id>[])[]
}

export interface ShellPanelBarProjection<
  Id extends ShellCommandId = ShellCommandId,
> {
  readonly primary: readonly ProjectedShellCommand<Id>[]
  readonly design: readonly ProjectedShellCommand<Id>[]
  readonly planning: readonly ProjectedShellCommand<Id>[]
}

export interface ShellChromeProjection<
  Id extends ShellCommandId = ShellCommandId,
> {
  readonly commands: ReadonlyMap<Id, ProjectedShellCommand<Id>>
  readonly menus: readonly ShellMenuProjection<Id>[]
  readonly panelBar: ShellPanelBarProjection<Id>
}

export interface ShellProjectionOptions {
  /** Shortcuts the edition cannot receive (a browser keeps Ctrl N or Ctrl 1 for itself). */
  readonly unavailableShortcuts?: ReadonlySet<string>
}

type ShellCommandDescriptor = {
  [Capability in ShellCommandCapabilityId]: Omit<
    ShellCommandCatalogEntry,
    | 'capabilityId'
    | 'id'
    | 'execute'
    | 'isExecutionDisabled'
    | 'isProjectionDisabled'
    | 'isChecked'
  > & {
    readonly capabilityId: Capability
    readonly id: ShellCommandIdByCapability[Capability]
  }
}[ShellCommandCapabilityId]

const file = (section: number, submenu?: ShellSubmenuId): ShellCommandMenuPlacement => ({ id: 'file', section, submenu })
const panel = (panelId: Panel, group: ShellPanelGroup, order: number) => ({ panel: panelId, group, order })

const SHELL_COMMAND_DESCRIPTORS: readonly ShellCommandDescriptor[] = [
  { capabilityId: 'newDesign', id: 'file.new', labelKey: 'menu.file.new', shortcut: 'Ctrl+N', palette: true, menu: file(0) },
  { capabilityId: 'openDesign', id: 'file.open', labelKey: 'menu.file.open', shortcut: 'Ctrl+O', palette: true, menu: file(0) },
  { capabilityId: 'openCanopi', id: 'file.openCanopi', labelKey: 'webShell.openCanopi', shortcut: 'Ctrl+O', palette: true, menu: file(0) },
  { capabilityId: 'renameDesign', id: 'file.rename', labelKey: 'menu.file.rename', shortcut: 'F2', palette: true, menu: file(1) },
  { capabilityId: 'saveDesign', id: 'file.save', labelKey: 'menu.file.save', shortcut: 'Ctrl+S', palette: true, menu: file(1) },
  { capabilityId: 'saveDesignAs', id: 'file.saveAs', labelKey: 'menu.file.saveAs', shortcut: 'Ctrl+Shift+S', palette: true, menu: file(1) },
  { capabilityId: 'downloadCanopi', id: 'file.downloadCanopi', labelKey: 'webShell.downloadCanopi', shortcut: 'Ctrl+S', palette: true, menu: file(1) },
  { capabilityId: 'revertDesign', id: 'file.revert', labelKey: 'menu.file.revert', palette: true, menu: file(1) },
  // File's imports, flat (U49 Q8): terrain or height data, GeoJSON, then the Data library.
  { capabilityId: 'addData', id: 'file.addData', labelKey: 'menu.file.addData', palette: true, menu: file(2) },
  { capabilityId: 'importGeoJson', id: 'file.importGeoJson', labelKey: 'geojson.import', palette: true, menu: file(2) },
  { capabilityId: 'openDataLibrary', id: 'file.dataLibrary', labelKey: 'canvas.lidar.layers.openLibrary', palette: true, menu: file(2) },
  { capabilityId: 'exportCanvasPdf', id: 'file.exportCanvasPdf', labelKey: 'menu.file.exportPlantingPlan', shortcut: 'Ctrl+P', palette: true, menu: file(2, 'export') },
  { capabilityId: 'exportGeoJson', id: 'file.exportGeoJson', labelKey: 'menu.file.exportGeoJson', palette: true, menu: file(2, 'export') },
  { capabilityId: 'exportBudgetCsv', id: 'file.exportBudgetCsv', labelKey: 'menu.file.exportBudgetCsv', palette: true, menu: file(2, 'export') },
  { capabilityId: 'openSettings', id: 'app.settings', labelKey: 'menu.file.settings', shortcut: 'Ctrl+,', palette: true, menu: file(3) },
  { capabilityId: 'findPlants', id: 'edit.findPlants', labelKey: 'menu.edit.findPlants', shortcut: 'Ctrl+F', palette: true, menu: { id: 'edit', section: 0 } },
  { capabilityId: 'closeDesign', id: 'file.close', labelKey: 'menu.file.close', shortcut: 'Ctrl+W', palette: true, menu: file(4) },
  { capabilityId: 'exitApp', id: 'file.exit', labelKey: 'menu.file.exit', shortcut: 'Ctrl+Q', palette: false, menu: file(4) },
  { capabilityId: 'navigateCanvas', id: 'nav.canvas', labelKey: 'panelRail.canvas', palette: false, panel: panel('canvas', 'primary', 0) },
  { capabilityId: 'navigateTemplates', id: 'nav.templates', labelKey: 'worldMap.title', palette: false, panel: panel('templates', 'primary', 1) },
  // Ctrl 1–9 in rail order; Site data (Desktop) takes Ctrl 2 under Layers and Stories has no digit (U49 Q1).
  { capabilityId: 'navigateLayers', id: 'nav.layers', labelKey: 'panelRail.layers', shortcut: 'Ctrl+1', palette: true, panel: panel('layers', 'design', 0) },
  { capabilityId: 'navigateSiteData', id: 'nav.siteData', labelKey: 'canvas.layers.siteData', shortcut: 'Ctrl+2', palette: true, panel: panel('site-data', 'design', 1) },
  { capabilityId: 'navigateSpeciesKey', id: 'nav.speciesKey', labelKey: 'panelRail.plants', shortcut: 'Ctrl+3', palette: true, panel: panel('species-key', 'design', 2) },
  { capabilityId: 'navigatePlantDatabase', id: 'nav.plantDb', labelKey: 'panelRail.catalog', shortcut: 'Ctrl+4', palette: true, panel: panel('plant-db', 'design', 3) },
  { capabilityId: 'navigateFavorites', id: 'nav.favorites', labelKey: 'panelRail.favorites', shortcut: 'Ctrl+5', palette: true, panel: panel('favorites', 'design', 4) },
  { capabilityId: 'navigateCalendar', id: 'nav.calendar', labelKey: 'panelRail.calendar', shortcut: 'Ctrl+6', palette: true, panel: panel('calendar', 'planning', 0) },
  { capabilityId: 'navigateBudget', id: 'nav.budget', labelKey: 'panelRail.budget', shortcut: 'Ctrl+7', palette: true, panel: panel('budget', 'planning', 1) },
  { capabilityId: 'navigateConsortium', id: 'nav.consortium', labelKey: 'panelRail.consortium', shortcut: 'Ctrl+8', palette: true, panel: panel('consortium', 'planning', 2) },
  { capabilityId: 'navigateDesignNotebook', id: 'nav.designNotebook', labelKey: 'panelRail.notebook', shortcut: 'Ctrl+9', palette: true, panel: panel('design-notebook', 'planning', 3) },
  { capabilityId: 'navigateStories', id: 'nav.stories', labelKey: 'panelRail.stories', palette: true, panel: panel('stories', 'planning', 4) },
  // Desktop's palette arms Profile; it has no shortcut and no menu or rail place (spec §1.10).
  { capabilityId: 'startProfile', id: 'siteData.profile', labelKey: 'siteData.profile', palette: true },
  { capabilityId: 'saveCurrentView', id: 'view.saveCurrentView', labelKey: 'menu.view.saveCurrentView', palette: true, menu: { id: 'view', section: 2 } },
  { capabilityId: 'manageViews', id: 'view.manageViews', labelKey: 'menu.view.manageViews', palette: true, menu: { id: 'view', section: 2 } },
  { capabilityId: 'toggleToolNames', id: 'view.toggleToolNames', labelKey: 'menu.view.toolNames', palette: true, check: 'checkbox', menu: { id: 'view', section: 0 } },
  { capabilityId: 'showSatellite', id: 'view.backgroundSatellite', labelKey: 'menu.view.backgroundSatellite', palette: true, check: 'radio', menu: { id: 'view', section: 1, submenu: 'background' } },
  { capabilityId: 'showMap', id: 'view.backgroundMap', labelKey: 'menu.view.backgroundMap', palette: true, check: 'radio', menu: { id: 'view', section: 1, submenu: 'background' } },
  { capabilityId: 'showNoBackground', id: 'view.backgroundNone', labelKey: 'menu.view.backgroundNone', palette: true, check: 'radio', menu: { id: 'view', section: 1, submenu: 'background' } },
  { capabilityId: 'toggleTheme', id: 'view.toggleTheme', labelKey: 'menu.view.darkTheme', palette: true, check: 'checkbox', menu: { id: 'view', section: 1 } },
  // Not listed in the palette it opens; its shortcut is discoverable in Help and the F1 list.
  { capabilityId: 'showCommandPalette', id: 'help.commandPalette', labelKey: 'menu.help.commandPalette', shortcut: 'Ctrl+Shift+P', palette: false, menu: { id: 'help', section: 0 } },
  { capabilityId: 'showShortcuts', id: 'help.shortcuts', labelKey: 'menu.help.shortcuts', shortcut: 'F1', palette: true, menu: { id: 'help', section: 0 } },
  { capabilityId: 'gettingStarted', id: 'help.gettingStarted', labelKey: 'menu.help.gettingStarted', palette: true, menu: { id: 'help', section: 0 } },
  { capabilityId: 'reportProblem', id: 'help.reportProblem', labelKey: 'menu.help.reportProblem', palette: true, menu: { id: 'help', section: 1 } },
  { capabilityId: 'aboutCanopi', id: 'help.aboutCanopi', labelKey: 'menu.help.aboutCanopi', palette: true, menu: { id: 'help', section: 1 } },
]

const MENU_LABEL_KEYS: Record<ShellMenuId, LocaleKey> = {
  file: 'menu.file',
  edit: 'menu.edit',
  view: 'menu.view',
  help: 'menu.help',
}

export function composeShellCommandCatalog<
  const Capabilities extends ShellCommandCapabilities,
>(
  capabilities: Capabilities,
): readonly ShellCommandCatalogEntry<
  ShellCommandIdForCapability<Extract<keyof Capabilities, ShellCommandCapabilityId>>
>[] {
  const entries: ShellCommandCatalogEntry[] = SHELL_COMMAND_DESCRIPTORS.flatMap((descriptor) => {
    const capability = capabilities[descriptor.capabilityId]
    if (!capability) return []
    return [{
      ...descriptor,
      execute: () => capability.execute(),
      isExecutionDisabled: (state: ShellCommandState) =>
        capability.isExecutionDisabled?.(state) ?? false,
      isProjectionDisabled: (state: ShellCommandState) =>
        capability.isProjectionDisabled?.(state)
          ?? capability.isExecutionDisabled?.(state)
          ?? false,
      isChecked: () => descriptor.check ? capability.isChecked?.() ?? false : undefined,
    }]
  })
  // Entries are emitted only when their descriptor's capability key exists.
  return entries as unknown as readonly ShellCommandCatalogEntry<
    ShellCommandIdForCapability<Extract<keyof Capabilities, ShellCommandCapabilityId>>
  >[]
}

export function projectShellCommandCatalog<Id extends ShellCommandId>(
  catalog: readonly ShellCommandCatalogEntry<Id>[],
  state: ShellCommandState,
  translate: (key: LocaleKey) => string,
  options: ShellProjectionOptions = {},
): ShellChromeProjection<Id> {
  const commands = new Map<Id, ProjectedShellCommand<Id>>()
  for (const command of catalog) {
    const disabled = command.isProjectionDisabled(state)
    const shortcut = command.shortcut && !options.unavailableShortcuts?.has(command.shortcut)
      ? command.shortcut
      : undefined
    commands.set(command.id, {
      id: command.id,
      label: translate(command.labelKey),
      shortcut: shortcut ? formatShortcut(shortcut, translate) : undefined,
      ariaShortcut: shortcut ? ariaKeyShortcuts(shortcut) : undefined,
      disabled,
      active: command.panel ? isPanelCommandActive(command.panel, state) : undefined,
      checked: command.isChecked(),
      check: command.check,
      submenu: command.menu?.submenu,
      panel: command.panel?.panel,
      action: () => {
        if (!disabled) command.execute()
      },
    })
  }

  const menus: ShellMenuProjection<Id>[] = []
  for (const menuId of ['file', 'edit', 'view', 'help'] as const) {
    const sections = new Map<number, ProjectedShellCommand<Id>[]>()
    for (const command of catalog) {
      if (command.menu?.id !== menuId) continue
      const section = sections.get(command.menu.section) ?? []
      section.push(requireProjectedCommand(commands, command.id))
      sections.set(command.menu.section, section)
    }
    if (sections.size === 0) continue
    menus.push({
      id: menuId,
      label: translate(MENU_LABEL_KEYS[menuId]),
      sections: [...sections.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, section]) => section),
    })
  }

  const panelCommands = (group: ShellPanelGroup) => catalog
    .flatMap((command) => command.panel?.group === group
      ? [{ command, panel: command.panel }]
      : [])
    .sort((left, right) => left.panel.order - right.panel.order)
    .map(({ command }) => requireProjectedCommand(commands, command.id))

  return {
    commands,
    menus,
    panelBar: {
      primary: panelCommands('primary'),
      design: panelCommands('design'),
      planning: panelCommands('planning'),
    },
  }
}

function requireProjectedCommand<Id extends ShellCommandId>(
  commands: ReadonlyMap<Id, ProjectedShellCommand<Id>>,
  id: Id,
): ProjectedShellCommand<Id> {
  const command = commands.get(id)
  if (!command) throw new Error(`Missing projected shell command '${id}'`)
  return command
}

function isPanelCommandActive(
  panelPlacement: NonNullable<ShellCommandCatalogEntry['panel']>,
  state: ShellCommandState,
): boolean {
  if (panelPlacement.group !== 'primary') {
    return state.activePanel === 'canvas' && state.sidePanel === panelPlacement.panel
  }
  if (panelPlacement.panel === 'canvas') {
    return state.activePanel === 'canvas' && state.sidePanel === null
  }
  return state.activePanel === panelPlacement.panel
}
