import { computed } from '@preact/signals'
import type { CanvasCommandProjection } from '../../app/canvas-commands'
import {
  projectShellCommandCatalog,
  type ProjectedShellCommand,
} from '../../app/shell-commands'
import {
  composeWorkspaceMenus,
  type MenuAction,
  type MenuDefinition,
} from '../../app/shell-commands/menus'
import type { Panel } from '../../app/shell/state'
import { designNotebookWorkbench } from '../../app/design-notebook'
import { savedViewMenuActions } from '../../app/saved-views'
import { plantLabelMenuActions } from '../../app/plant-display/menu'
import { t } from '../../i18n'
import {
  APP_COMMANDS,
  createDesktopCanvasCommandProjection,
  DESKTOP_SHELL_COMMAND_CATALOG,
  isCatalogCommandDisabled,
  readAppCommandState,
  runCatalogCommand,
  type AppCommandDefinition,
  type AppCommandId,
  type DesktopShellCommandId,
} from './catalog'

export type {
  MenuAction,
  MenuDefinition,
  MenuEntry,
} from '../../app/shell-commands/menus'

interface Command {
  id: AppCommandId
  label: () => string
  shortcut?: string
  note?: string
  disabled: () => boolean
  action: () => void
}

/** A title-bar button's command: label, shortcut and action from the graph. */
interface AppCommandGraphTitleBarCommand {
  readonly label: string
  readonly shortcut?: string
  readonly ariaShortcut?: string
  readonly disabled: boolean
  action(): void
}

export interface AppCommandGraphChromeProjection {
  readonly menus: MenuDefinition[]
  readonly paletteCommands: Command[]
  readonly titleBar: {
    readonly help: AppCommandGraphTitleBarCommand
    readonly settings: AppCommandGraphTitleBarCommand
  }
}

interface AppCommandGraphPanelCommand {
  readonly panel: Panel
  readonly commandId: AppCommandId
  readonly label: string
  readonly shortcut?: string
  readonly ariaShortcut?: string
  readonly disabled: boolean
  readonly active: boolean
  readonly action: () => void
}

export interface AppCommandGraphPanelProjection {
  readonly primary: AppCommandGraphPanelCommand[]
  readonly design: AppCommandGraphPanelCommand[]
  readonly planning: AppCommandGraphPanelCommand[]
}

export type AppCommandGraphToolbarProjection = CanvasCommandProjection

function commandProjection(command: AppCommandDefinition): Command {
  return {
    id: command.id,
    label: command.label,
    // Read when the palette shows it: Settings › Keyboard can drop it.
    get shortcut() { return command.shortcut },
    disabled: () => isCatalogCommandDisabled(command.id),
    action: () => {
      runCatalogCommand(command.id, 'palette')
    },
  }
}

const paletteCommands: Command[] = APP_COMMANDS
  .filter((command) => command.palette)
  .map(commandProjection)

function desktopShellProjection() {
  return projectShellCommandCatalog(DESKTOP_SHELL_COMMAND_CATALOG, readAppCommandState(), t)
}

export const appCommandGraphToolbarProjection = computed<AppCommandGraphToolbarProjection>(() =>
  createDesktopCanvasCommandProjection(),
)

export const appCommandGraphChromeProjection = computed<AppCommandGraphChromeProjection>(() => {
  const recentEntries = designNotebookWorkbench.view.value.recentEntries
  const openRecent = {
    type: 'submenu' as const,
    id: 'file.openRecent',
    label: t('designNotebook.openRecent'),
    disabled: recentEntries.length === 0,
    items: recentEntries.slice(0, 5).map((entry): MenuAction => ({
      type: 'action',
      id: `recent:${entry.path}`,
      label: entry.name,
      disabled: false,
      action: () => {
        void designNotebookWorkbench.openEntry(entry.path)
      },
    })),
  }

  const shell = desktopShellProjection()
  const titleBarCommand = (id: DesktopShellCommandId): AppCommandGraphTitleBarCommand => {
    const command = shell.commands.get(id)
    if (!command) throw new Error(`Missing title bar command '${id}'`)
    return command
  }
  return {
    titleBar: {
      help: titleBarCommand('help.shortcuts'),
      settings: titleBarCommand('app.settings'),
    },
    menus: composeWorkspaceMenus<DesktopShellCommandId>({
      shell,
      canvas: appCommandGraphToolbarProjection.value,
      translate: t,
      savedViews: savedViewMenuActions(),
      plantLabels: plantLabelMenuActions(),
      openRecent,
    }),
    paletteCommands,
  }
})

function panelCommandProjection(
  command: ProjectedShellCommand<DesktopShellCommandId>,
): AppCommandGraphPanelCommand {
  if (!command.panel) {
    throw new Error(`Missing panel identity for navigation command '${command.id}'`)
  }
  return {
    panel: command.panel,
    commandId: command.id,
    label: command.label,
    shortcut: command.shortcut,
    ariaShortcut: command.ariaShortcut,
    disabled: command.disabled,
    active: command.active ?? false,
    // The panel rail runs navigation commands only.
    action: () => {
      runCatalogCommand(command.id, 'rail')
    },
  }
}

export const appCommandGraphPanelProjection = computed<AppCommandGraphPanelProjection>(() => {
  const shell = desktopShellProjection()
  return {
    primary: shell.panelBar.primary.map(panelCommandProjection),
    design: shell.panelBar.design.map(panelCommandProjection),
    planning: shell.panelBar.planning.map(panelCommandProjection),
  }
})
