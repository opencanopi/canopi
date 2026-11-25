import {
  PANEL_DESCRIPTORS,
  resolveDisplayedShortcut,
  SHELL_COMMAND_REQUIRES,
  type Panel,
  type PanelDescriptor,
  type PanelGroup,
  type ShellCommandId,
  type SidePanel,
} from '../command-table'
import type { EditionCapabilityId } from '../../generated/edition-capabilities'
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
export type { ShellCommandId }
export type ShellCommandIdForCapability<
  Capability extends ShellCommandCapabilityId,
> = ShellCommandIdByCapability[Capability]

type ShellMenuId = 'file' | 'edit' | 'view' | 'help'
export type ShellSubmenuId = 'export' | 'background'
type ShellPanelGroup = PanelGroup

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
  /** Edition capabilities missing for this command (2.1-M163, 2.1-Q358). */
  readonly lacking?: readonly EditionCapabilityId[]
  /** Localised Instead note key shown on greyed lacking commands in menus and the palette. */
  readonly noteKey?: LocaleKey
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
  /** Canonical primary shortcut (`Ctrl+Shift+S`); see `shortcut-text.ts`. */
  readonly shortcut?: string
  /** All canonical shortcuts (primary + browser-safe shared chord, 2.1-Q343). */
  readonly shortcuts?: readonly string[]
  /** Edition capabilities required by this command (ADR 0030). */
  readonly requires?: readonly EditionCapabilityId[]
  /** Capabilities lacked by the active edition, if any (2.1-Q358). */
  readonly lacking?: readonly EditionCapabilityId[]
  /** Localised note key shown when the command is greyed for a lacking capability. */
  readonly noteKey?: LocaleKey
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
  /** User-facing note for a command disabled because the edition lacks a capability (2.1-Q358). */
  readonly note?: string
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
    | 'lacking'
    | 'note'
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
const PANEL_CAP_ID: Record<Panel, ShellCommandCapabilityId> = {
  canvas: 'navigateCanvas',
  templates: 'navigateTemplates',
  layers: 'navigateLayers',
  'site-data': 'navigateSiteData',
  'species-key': 'navigateSpeciesKey',
  'plant-db': 'navigatePlantDatabase',
  favorites: 'navigateFavorites',
  calendar: 'navigateCalendar',
  budget: 'navigateBudget',
  consortium: 'navigateConsortium',
  'design-notebook': 'navigateDesignNotebook',
  stories: 'navigateStories',
}

const PANEL_SHELL_DESCRIPTORS: readonly ShellCommandDescriptor[] = PANEL_DESCRIPTORS.map(
  (d: PanelDescriptor) => ({
    capabilityId: PANEL_CAP_ID[d.panel],
    id: d.commandId,
    labelKey: d.labelKey,
    ...(d.shortcuts ? { shortcut: d.shortcuts[0], shortcuts: d.shortcuts } : {}),
    ...(d.requires ? { requires: d.requires } : {}),
    palette: d.group !== 'primary',
    panel: { panel: d.panel, group: d.group, order: d.order },
  }) as ShellCommandDescriptor,
)

const RAW_SHELL_COMMAND_DESCRIPTORS: readonly ShellCommandDescriptor[] = [
  { capabilityId: 'newDesign', id: 'file.new', labelKey: 'menu.file.new', shortcuts: ['Alt+Shift+N', 'Ctrl+N'], palette: true, menu: file(0) },
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
  { capabilityId: 'closeDesign', id: 'file.close', labelKey: 'menu.file.close', shortcuts: ['Alt+Shift+W', 'Ctrl+W'], palette: true, menu: file(4) },
  { capabilityId: 'exitApp', id: 'file.exit', labelKey: 'menu.file.exit', shortcut: 'Ctrl+Q', palette: false, menu: file(4) },
  ...PANEL_SHELL_DESCRIPTORS,
  // Desktop's palette arms Profile; it has no shortcut and no menu or rail place (spec §1.10).
  { capabilityId: 'startProfile', id: 'siteData.profile', labelKey: 'siteData.profile', palette: true },
  { capabilityId: 'saveCurrentView', id: 'view.saveCurrentView', labelKey: 'menu.view.saveCurrentView', palette: true, menu: { id: 'view', section: 2 } },
  { capabilityId: 'manageViews', id: 'view.manageViews', labelKey: 'menu.view.manageViews', palette: true, menu: { id: 'view', section: 2 } },
  { capabilityId: 'toggleToolNames', id: 'view.toggleToolNames', labelKey: 'menu.view.toolNames', palette: true, check: 'checkbox', menu: { id: 'view', section: 0 } },
  { capabilityId: 'showSatellite', id: 'view.backgroundSatellite', labelKey: 'menu.view.backgroundSatellite', palette: true, check: 'radio', menu: { id: 'view', section: 1, submenu: 'background' } },
  { capabilityId: 'showMap', id: 'view.backgroundMap', labelKey: 'menu.view.backgroundMap', palette: true, check: 'radio', menu: { id: 'view', section: 1, submenu: 'background' } },
  { capabilityId: 'showNoBackground', id: 'view.backgroundNone', labelKey: 'menu.view.backgroundNone', palette: true, check: 'radio', menu: { id: 'view', section: 1, submenu: 'background' } },
  { capabilityId: 'toggleTheme', id: 'view.toggleTheme', labelKey: 'menu.view.darkTheme', palette: true, check: 'checkbox', menu: { id: 'view', section: 1 } },
  // Not listed in the palette it opens; its shortcut is discoverable in Help and the F1 list (2.1-Q132, Q343).
  { capabilityId: 'showCommandPalette', id: 'help.commandPalette', labelKey: 'menu.help.commandPalette', shortcuts: ['Alt+Shift+P', 'Ctrl+Shift+P'], palette: false, menu: { id: 'help', section: 0 } },
  { capabilityId: 'showShortcuts', id: 'help.shortcuts', labelKey: 'menu.help.shortcuts', shortcut: 'F1', palette: true, menu: { id: 'help', section: 0 } },
  { capabilityId: 'gettingStarted', id: 'help.gettingStarted', labelKey: 'menu.help.gettingStarted', palette: true, menu: { id: 'help', section: 0 } },
  { capabilityId: 'reportProblem', id: 'help.reportProblem', labelKey: 'menu.help.reportProblem', palette: true, menu: { id: 'help', section: 1 } },
  { capabilityId: 'aboutCanopi', id: 'help.aboutCanopi', labelKey: 'menu.help.aboutCanopi', palette: true, menu: { id: 'help', section: 1 } },
]

export const SHELL_COMMAND_DESCRIPTORS: readonly ShellCommandDescriptor[] = RAW_SHELL_COMMAND_DESCRIPTORS.map((d) => {
  const req = d.requires ?? SHELL_COMMAND_REQUIRES[d.id]
  return req ? { ...d, requires: req } : d
})

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
    const lacking = capability.lacking
    const noteKey = capability.noteKey
    return [{
      ...descriptor,
      ...(descriptor.shortcut === undefined && descriptor.shortcuts?.[0]
        ? { shortcut: descriptor.shortcuts[0] }
        : {}),
      ...(lacking && lacking.length > 0 ? { lacking } : {}),
      ...(noteKey ? { noteKey } : {}),
      execute: () => capability.execute(),
      isExecutionDisabled: (state: ShellCommandState) =>
        (lacking && lacking.length > 0) || (capability.isExecutionDisabled?.(state) ?? false),
      isProjectionDisabled: (state: ShellCommandState) =>
        (lacking && lacking.length > 0)
        || (capability.isProjectionDisabled?.(state)
          ?? capability.isExecutionDisabled?.(state)
          ?? false),
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
    const candidates = command.shortcuts ?? (command.shortcut ? [command.shortcut] : undefined)
    const shortcut = resolveDisplayedShortcut(candidates, options.unavailableShortcuts)
    commands.set(command.id, {
      id: command.id,
      label: translate(command.labelKey),
      shortcut: shortcut ? formatShortcut(shortcut, translate) : undefined,
      ariaShortcut: shortcut ? ariaKeyShortcuts(shortcut) : undefined,
      disabled,
      ...(command.noteKey ? { note: translate(command.noteKey) } : {}),
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
    .flatMap((command) => command.panel?.group === group && !(command.lacking && command.lacking.length > 0)
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
