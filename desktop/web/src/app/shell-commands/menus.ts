import type {
  CanvasCommandProjection,
  CanvasProjectedCommand,
  CanvasToolbarActionCommand,
} from '../canvas-commands'
import type {
  ProjectedShellCommand,
  ShellChromeProjection,
  ShellMenuProjection,
  ShellCommandId,
  ShellSubmenuId,
} from './index'
import type { LocaleKey } from '../../generated/locale-keys'

/**
 * The menu bar model both editions render: File, Edit, View, Tools and Help,
 * composed from the shell and canvas command projections so every command
 * appears once, with its shortcut, and nothing duplicates an action.
 */
type WorkspaceMenuId = 'file' | 'edit' | 'view' | 'tools' | 'help'

export interface MenuAction {
  readonly type: 'action'
  readonly id: string
  readonly label: string
  /** Display text, e.g. "Ctrl Shift Z". */
  readonly shortcut?: string
  readonly ariaShortcut?: string
  readonly disabled: boolean
  /** Set on checkable items; they render as `menuitemcheckbox` or `menuitemradio`. */
  readonly checked?: boolean
  readonly check?: 'checkbox' | 'radio'
  /** A small decorative picture before the label (a saved view's snapshot). */
  readonly thumbnail?: MenuItemThumbnail
  action(): void
}

/** A picture drawn on demand: `load` runs when the item is shown, `source` reads the current image. */
export interface MenuItemThumbnail {
  source(): { readonly url: string | null; readonly loading: boolean }
  load(): void
}

interface MenuSubmenu {
  readonly type: 'submenu'
  readonly id: string
  readonly label: string
  /** A key that acts on the whole submenu (View › Labels: Shift+L cycles its items). */
  readonly shortcut?: string
  readonly ariaShortcut?: string
  readonly disabled: boolean
  readonly items: readonly MenuAction[]
}

interface MenuSeparator {
  readonly type: 'separator'
}

export type MenuEntry = MenuAction | MenuSeparator | MenuSubmenu

export interface MenuDefinition {
  readonly id: WorkspaceMenuId
  readonly label: string
  readonly items: readonly MenuEntry[]
}

export interface WorkspaceMenuInput<Id extends ShellCommandId> {
  readonly shell: ShellChromeProjection<Id>
  /** With no canvas runtime mounted, Edit and Tools still list its commands, disabled. */
  readonly canvas: CanvasCommandProjection
  readonly translate: (key: LocaleKey) => string
  /** View › Saved views ▸: one entry per saved view of the open Design. */
  readonly savedViews?: readonly MenuAction[]
  /** View › Labels ▸: None, Codes, Names; the canvas `cycle-labels` command gives its key. */
  readonly plantLabels?: readonly MenuAction[]
  /** File › Open recent ▸ (Desktop), placed right after Open (`file.open`). */
  readonly openRecent?: MenuEntry
}

const SEPARATOR: MenuSeparator = { type: 'separator' }

const SUBMENU_LABEL_KEYS: Record<ShellSubmenuId, LocaleKey> = {
  export: 'menu.file.export',
  background: 'menu.view.background',
}

const EDIT_SECTIONS = [
  ['cut', 'copy', 'paste', 'duplicate', 'delete'],
  ['select-all', 'select-same-species', 'deselect'],
  ['group', 'ungroup', 'arrange', 'rotate'],
  ['lock', 'unlock', 'unlock-all'],
  ['save-as-stamp'],
] as const

const ARRANGE_ACTIONS = ['bring-to-front', 'send-to-back'] as const

export function composeWorkspaceMenus<Id extends ShellCommandId>({
  shell,
  canvas,
  translate,
  savedViews = [],
  plantLabels = [],
  openRecent,
}: WorkspaceMenuInput<Id>): MenuDefinition[] {
  const shellMenu = (id: 'file' | 'edit' | 'view' | 'help') => shell.menus.find((menu) => menu.id === id)
  // Both editions' catalogues fill File, View and Help, and View's three sections.
  const requireMenu = (id: 'file' | 'view' | 'help') => {
    const menu = shellMenu(id)
    if (!menu) throw new Error(`Missing shell menu '${id}'`)
    return menu
  }
  const requireSection = (menu: ShellMenuProjection<Id>, index: number) => {
    const section = menu.sections[index]
    if (!section) throw new Error(`Missing section ${index} of shell menu '${menu.id}'`)
    return section
  }
  const menus: MenuDefinition[] = []

  const fileMenu = requireMenu('file')
  menus.push({
    id: 'file',
    label: fileMenu.label,
    items: joinSections(fileMenu.sections.map((section) =>
      shellSectionEntries(section, translate).flatMap((entry) =>
        openRecent && entry.type === 'action' && entry.id === 'file.open' ? [entry, openRecent] : [entry],
      ),
    )),
  })

  const editById = new Map(canvas.editActions.map((command) => [command.id, command]))
  const requireEdit = (id: string): CanvasToolbarActionCommand => {
    const command = editById.get(id)
    if (!command) throw new Error(`Missing canvas edit command '${id}'`)
    return command
  }
  // Shell Edit commands (Find plants) join the selection section.
  const shellEdit = shellMenu('edit')?.sections.flat() ?? []
  menus.push({
    id: 'edit',
    label: translate('menu.edit'),
    items: joinSections([
      canvas.historyActions.map((command) => canvasAction(command)),
      ...EDIT_SECTIONS.map((section) => [
        ...section.map((id): MenuEntry => id === 'arrange'
          ? submenu('edit.arrange', translate('menu.edit.arrange'), ARRANGE_ACTIONS.map((action) => canvasAction(requireEdit(action))))
          : canvasAction(requireEdit(id))),
        ...((section as readonly string[]).includes('select-all') ? shellEdit.map(shellAction) : []),
      ]),
    ]),
  })

  const viewMenu = requireMenu('view')
  const panels = [...shell.panelBar.design, ...shell.panelBar.planning]
  const cycleLabels = canvas.viewActions.find((command) => command.id === 'cycle-labels')
  if (!cycleLabels) throw new Error("Missing canvas view command 'cycle-labels'")
  const labelsSubmenu: MenuEntry[] = plantLabels.length > 0
    ? [{
      ...submenu(cycleLabels.commandId, translate('menu.view.labels'), plantLabels),
      shortcut: cycleLabels.shortcut,
      ariaShortcut: cycleLabels.ariaShortcut,
    }]
    : []
  menus.push({
    id: 'view',
    label: viewMenu.label,
    items: joinSections([
      canvas.viewActions.filter((command) => command.id !== 'cycle-labels').map((command) => canvasAction(command)),
      // Saved views, then the commands that save and manage them (shell section 2).
      [
        submenu('view.savedViews', translate('menu.view.savedViews'), savedViews),
        ...shellSectionEntries(requireSection(viewMenu, 2), translate),
      ],
      [
        ...canvas.settingsToggles.map((command) => canvasAction(command, command.pressed ?? false)),
        ...labelsSubmenu,
        ...shellSectionEntries(requireSection(viewMenu, 0), translate),
      ],
      panels.map((command) => shellAction(command)),
      shellSectionEntries(requireSection(viewMenu, 1), translate),
    ]),
  })

  menus.push({
    id: 'tools',
    label: translate('menu.tools'),
    items: joinSections(canvas.toolGroups.map((group) => group.tools.map((command) => canvasAction(command)))),
  })

  const helpMenu = requireMenu('help')
  menus.push({
    id: 'help',
    label: helpMenu.label,
    items: joinSections(helpMenu.sections.map((section) => shellSectionEntries(section, translate))),
  })
  return menus
}

/** Every menu action, submenus included, in menu order. */
export function flattenMenuActions(menus: readonly MenuDefinition[]): MenuAction[] {
  return menus.flatMap((menu) => menu.items.flatMap((entry) => {
    if (entry.type === 'action') return [entry]
    if (entry.type === 'submenu') return [...entry.items]
    return []
  }))
}

function joinSections(sections: readonly (readonly MenuEntry[])[]): MenuEntry[] {
  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, index) => index === 0 ? [...section] : [SEPARATOR, ...section])
}

function shellSectionEntries<Id extends ShellCommandId>(
  section: readonly ProjectedShellCommand<Id>[],
  translate: (key: LocaleKey) => string,
): MenuEntry[] {
  // A submenu takes the place of its first command; its availability follows all of them.
  const grouped = new Map<ShellSubmenuId, MenuAction[]>()
  const order: (MenuAction | ShellSubmenuId)[] = []
  for (const command of section) {
    if (!command.submenu) {
      order.push(shellAction(command))
      continue
    }
    let items = grouped.get(command.submenu)
    if (!items) {
      items = []
      grouped.set(command.submenu, items)
      order.push(command.submenu)
    }
    items.push(shellAction(command))
  }
  return order.map((entry) => typeof entry === 'string'
    ? submenu(`submenu.${entry}`, translate(SUBMENU_LABEL_KEYS[entry]), grouped.get(entry)!)
    : entry)
}

function submenu(id: string, label: string, items: readonly MenuAction[]): MenuSubmenu {
  return { type: 'submenu', id, label, disabled: items.every((item) => item.disabled), items }
}

function shellAction(command: ProjectedShellCommand): MenuAction {
  return {
    type: 'action',
    id: command.id,
    label: command.label,
    shortcut: command.shortcut,
    ariaShortcut: command.ariaShortcut,
    disabled: command.disabled,
    ...(command.check ? { check: command.check, checked: command.checked ?? false } : {}),
    action: () => command.action(),
  }
}

function canvasAction(command: CanvasProjectedCommand, checked?: boolean): MenuAction {
  return {
    type: 'action',
    id: command.commandId,
    label: command.label,
    shortcut: command.shortcut,
    ariaShortcut: command.ariaShortcut,
    disabled: command.disabled,
    ...(checked === undefined ? {} : { check: 'checkbox' as const, checked }),
    action: () => command.action('menu'),
  }
}
