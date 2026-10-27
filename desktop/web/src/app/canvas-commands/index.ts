import {
  ariaKeyShortcuts,
  formatShortcut,
  isCharacterKeyShortcut,
} from '../shell-commands/shortcut-text'
import type { ToolId } from '../../canvas/runtime/tool-id'
import { canvasEditAvailable, type CanvasEditSelectionAvailability } from './edit-availability'
import type { LocaleKey } from '../../generated/locale-keys'

/**
 * The tools a command arms: every tool but the saved stamp, which Favorites arms
 * with its payload. Profile is Desktop's, armed from Site data and the palette,
 * not on the rail (canopi-f47t.42).
 */
export type CanvasToolId = Exclude<ToolId, 'saved-object-stamp'>

/** Tool rail groups, top to bottom. Only `zones` carries a heading. */
type CanvasToolGroupId = 'navigate' | 'plant' | 'zones' | 'annotate'

export type CanvasEditAction =
  | 'cut'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'select-all'
  | 'select-same-species'
  | 'deselect'
  | 'group'
  | 'ungroup'
  | 'bring-to-front'
  | 'send-to-back'
  | 'rotate'
  | 'lock'
  | 'unlock'
  | 'unlock-all'
  | 'save-as-stamp'

export type CanvasViewAction =
  | 'zoom-in'
  | 'zoom-out'
  | 'fit-to-design'
  | 'zoom-to-selection'
  | 'reset-north'
  | 'turn-view-left'
  | 'turn-view-right'
  | 'search-place'
  | 'cycle-labels'

export type CanvasCommandId =
  | 'edit.undo'
  | 'edit.redo'
  | 'canvas.tool.select'
  | 'canvas.tool.hand'
  | 'canvas.tool.plantStamp'
  | 'canvas.tool.plantSpacing'
  | 'canvas.tool.objectStamp'
  | 'canvas.tool.polygon'
  | 'canvas.tool.rectangle'
  | 'canvas.tool.ellipse'
  | 'canvas.tool.line'
  | 'canvas.tool.text'
  | 'canvas.tool.measurementGuide'
  | 'canvas.toggleGrid'
  | 'canvas.toggleSnapToGrid'
  | 'canvas.cut'
  | 'canvas.copy'
  | 'canvas.paste'
  | 'canvas.duplicateSelected'
  | 'canvas.deleteSelected'
  | 'canvas.selectAll'
  | 'canvas.selectSameSpecies'
  | 'canvas.clearSelection'
  | 'canvas.groupSelected'
  | 'canvas.ungroupSelected'
  | 'canvas.bringToFront'
  | 'canvas.sendToBack'
  | 'canvas.rotateSelected'
  | 'canvas.lockSelected'
  | 'canvas.unlockSelected'
  | 'canvas.unlockAll'
  | 'canvas.saveSelectionAsStamp'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.fitToDesign'
  | 'view.zoomToSelection'
  | 'view.resetNorth'
  | 'view.turnViewLeft'
  | 'view.turnViewRight'
  | 'view.searchPlace'
  | 'view.cycleLabels'

export type CanvasCommandIntent =
  | { readonly type: 'select-tool', readonly tool: CanvasToolId }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'toggle-grid' }
  | { readonly type: 'toggle-snap-to-grid' }
  | { readonly type: 'edit', readonly action: CanvasEditAction }
  | { readonly type: 'view', readonly action: CanvasViewAction }

export interface CanvasCommandProjectionState {
  readonly activeTool: string
  /** A canvas runtime is mounted. */
  readonly canvasAvailable: boolean
  /** False in overview, where Design objects are hidden and cannot change (the mutating edits); tools stay enabled. */
  readonly spatialEditingAvailable: boolean
  /** What the selection's commands can do; null with nothing selected. */
  readonly selection: CanvasEditSelectionAvailability | null
  /** The re-origin hold (a press, a tool transient or a text entry): Cut and Delete wait (U39). */
  readonly held: boolean
  /** Some Design Object is locked, so Unlock all has something to do. */
  readonly lockedObjectsPresent: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly gridVisible: boolean
  readonly snapToGridEnabled: boolean
}

/** Which surface ran a canvas command: armCanvasTool focuses the map after every one but a shortcut. */
export type CanvasCommandFrom = 'rail' | 'menu' | 'palette' | 'shortcut'

/** Runs one intent; `from` reaches arming for a tool and is unused by the rest. */
type CanvasIntentRunner = (intent: CanvasCommandIntent, from: CanvasCommandFrom) => void

/** A command as chrome shows it: menus, the tool rail, the view chip, the palette. */
export interface CanvasProjectedCommand {
  readonly commandId: CanvasCommandId
  readonly label: string
  /** Display text, e.g. "Ctrl Shift Z". */
  readonly shortcut?: string
  /** `aria-keyshortcuts` value. */
  readonly ariaShortcut?: string
  readonly disabled: boolean
  /** Runs the command for the surface that shows it (a tool arms with this `from`). */
  readonly action: (from: CanvasCommandFrom) => void
}

export interface CanvasToolbarToolCommand extends CanvasProjectedCommand {
  readonly tool: CanvasToolId
  readonly active: boolean
}

export interface CanvasToolbarActionCommand extends CanvasProjectedCommand {
  readonly id: string
  readonly pressed?: boolean
  /** Arms no tool, so it needs no caller. */
  readonly action: () => void
}

interface CanvasToolGroupProjection {
  readonly id: CanvasToolGroupId
  /** Heading shown above the group while tool names are shown. */
  readonly heading?: string
  readonly tools: readonly CanvasToolbarToolCommand[]
}

export interface CanvasCommandProjection {
  readonly toolGroups: readonly CanvasToolGroupProjection[]
  readonly historyActions: readonly CanvasToolbarActionCommand[]
  readonly settingsToggles: readonly CanvasToolbarActionCommand[]
  readonly editActions: readonly CanvasToolbarActionCommand[]
  readonly viewActions: readonly CanvasToolbarActionCommand[]
}

interface CanvasCommandDefinitionBase {
  readonly commandId: CanvasCommandId
  readonly labelKey: LocaleKey
  /** Canonical shortcuts; the first is shown, the rest are accepted aliases. */
  readonly shortcuts?: readonly string[]
  /**
   * Keys shown beside the command but never routed to it, because another
   * owner handles them (Deselect's Esc is the map's own Esc chain; the rotation
   * chords are canvas key rows in app/keyboard/keymap.ts). Menus show the first
   * when no live shortcut is left; `aria-keyshortcuts` lists every one.
   */
  readonly keyHints?: readonly string[]
  readonly intent: CanvasCommandIntent
  /** The shortcut also works while a text field has focus. */
  readonly worksInTextFields?: boolean
}

interface CanvasToolCommandDefinition extends CanvasCommandDefinitionBase {
  readonly kind: 'tool'
  readonly group: CanvasToolGroupId
  readonly tool: CanvasToolId
}

interface CanvasHistoryCommandDefinition extends CanvasCommandDefinitionBase {
  readonly kind: 'history'
  readonly id: 'undo' | 'redo'
}

interface CanvasSettingsCommandDefinition extends CanvasCommandDefinitionBase {
  readonly kind: 'settings'
  readonly id: 'grid' | 'snap'
  readonly stateKey: 'gridVisible' | 'snapToGridEnabled'
}

export interface CanvasEditCommandDefinition extends CanvasCommandDefinitionBase {
  readonly kind: 'edit'
  readonly id: CanvasEditAction
}

interface CanvasViewCommandDefinition extends CanvasCommandDefinitionBase {
  readonly kind: 'view'
  readonly id: CanvasViewAction
}

export type CanvasCommandDefinition =
  | CanvasToolCommandDefinition
  | CanvasHistoryCommandDefinition
  | CanvasSettingsCommandDefinition
  | CanvasEditCommandDefinition
  | CanvasViewCommandDefinition

const CANVAS_TOOL_GROUP_HEADINGS: Partial<Record<CanvasToolGroupId, LocaleKey>> = {
  zones: 'canvas.tools.zones',
}

const CANVAS_TOOL_GROUP_ORDER: readonly CanvasToolGroupId[] = ['navigate', 'plant', 'zones', 'annotate']

function tool(
  group: CanvasToolGroupId,
  toolId: CanvasToolId,
  commandId: CanvasCommandId,
  labelKey: LocaleKey,
  shortcut: string,
): CanvasToolCommandDefinition {
  return {
    kind: 'tool',
    group,
    tool: toolId,
    commandId,
    labelKey,
    shortcuts: [shortcut],
    intent: { type: 'select-tool', tool: toolId },
  }
}

function edit(
  id: CanvasEditAction,
  commandId: CanvasCommandId,
  labelKey: LocaleKey,
  shortcuts?: readonly string[],
  keyHints?: readonly string[],
): CanvasEditCommandDefinition {
  return {
    kind: 'edit',
    id,
    commandId,
    labelKey,
    shortcuts,
    ...(keyHints ? { keyHints } : {}),
    intent: { type: 'edit', action: id },
  }
}

/** The command's live shortcuts, in order; `characterKeys` is Settings › Keyboard's switch (off hides `]`, `[`, …). */
function liveShortcuts(
  definition: CanvasCommandDefinition,
  characterKeys: boolean,
): readonly string[] | undefined {
  if (!definition.shortcuts || characterKeys) return definition.shortcuts
  const live = definition.shortcuts.filter((shortcut) => !isCharacterKeyShortcut(shortcut))
  return live.length > 0 ? live : undefined
}

/** The key a command shows: its first live shortcut, else its first key hint. */
export function canvasCommandDisplayKey(definition: CanvasCommandDefinition, characterKeys: boolean): string | undefined {
  return liveShortcuts(definition, characterKeys)?.[0] ?? definition.keyHints?.[0]
}

/** `aria-keyshortcuts` for a command: every live shortcut, then every key hint. */
export function canvasCommandAriaKeys(definition: CanvasCommandDefinition, characterKeys: boolean): string | undefined {
  const keys = [...liveShortcuts(definition, characterKeys) ?? [], ...definition.keyHints ?? []]
  return keys.length > 0 ? keys.map(ariaKeyShortcuts).join(' ') : undefined
}

function view(
  id: CanvasViewAction,
  commandId: CanvasCommandId,
  labelKey: LocaleKey,
  keys: { readonly shortcuts?: readonly string[], readonly keyHints?: readonly string[], readonly worksInTextFields?: boolean },
): CanvasViewCommandDefinition {
  return {
    kind: 'view',
    id,
    commandId,
    labelKey,
    ...(keys.shortcuts ? { shortcuts: keys.shortcuts } : {}),
    ...(keys.keyHints ? { keyHints: keys.keyHints } : {}),
    intent: { type: 'view', action: id },
    worksInTextFields: keys.worksInTextFields ?? false,
  }
}

export const canvasCommandDefinitions: readonly CanvasCommandDefinition[] = [
  tool('navigate', 'select', 'canvas.tool.select', 'canvas.tools.select', 'V'),
  tool('navigate', 'hand', 'canvas.tool.hand', 'canvas.tools.hand', 'H'),
  tool('plant', 'plant-stamp', 'canvas.tool.plantStamp', 'canvas.tools.plantStamp', 'P'),
  tool('plant', 'plant-spacing', 'canvas.tool.plantSpacing', 'canvas.tools.plantSpacing', 'W'),
  tool('plant', 'object-stamp', 'canvas.tool.objectStamp', 'canvas.tools.objectStamp', 'K'),
  tool('zones', 'polygon', 'canvas.tool.polygon', 'canvas.tools.polygon', 'Z'),
  tool('zones', 'rectangle', 'canvas.tool.rectangle', 'canvas.tools.rectangle', 'R'),
  tool('zones', 'ellipse', 'canvas.tool.ellipse', 'canvas.tools.ellipse', 'E'),
  tool('zones', 'line', 'canvas.tool.line', 'canvas.tools.line', 'L'),
  tool('annotate', 'text', 'canvas.tool.text', 'canvas.tools.text', 'T'),
  tool('annotate', 'measurement-guide', 'canvas.tool.measurementGuide', 'canvas.tools.measurementGuide', 'M'),
  {
    kind: 'history',
    id: 'undo',
    commandId: 'edit.undo',
    labelKey: 'menu.edit.undo',
    shortcuts: ['Ctrl+Z'],
    intent: { type: 'undo' },
  },
  {
    kind: 'history',
    id: 'redo',
    commandId: 'edit.redo',
    labelKey: 'menu.edit.redo',
    shortcuts: ['Ctrl+Shift+Z', 'Ctrl+Y'],
    intent: { type: 'redo' },
  },
  edit('cut', 'canvas.cut', 'menu.edit.cut', ['Ctrl+X']),
  edit('copy', 'canvas.copy', 'menu.edit.copy', ['Ctrl+C']),
  edit('paste', 'canvas.paste', 'menu.edit.paste', ['Ctrl+V']),
  edit('duplicate', 'canvas.duplicateSelected', 'menu.edit.duplicate', ['Ctrl+D']),
  edit('delete', 'canvas.deleteSelected', 'menu.edit.delete', ['Delete', 'Backspace']),
  edit('select-all', 'canvas.selectAll', 'menu.edit.selectAll', ['Ctrl+A']),
  edit('select-same-species', 'canvas.selectSameSpecies', 'menu.edit.selectSameSpecies', ['Ctrl+Shift+A']),
  edit('deselect', 'canvas.clearSelection', 'menu.edit.deselect', undefined, ['Escape']),
  edit('group', 'canvas.groupSelected', 'menu.edit.group', ['Ctrl+G']),
  edit('ungroup', 'canvas.ungroupSelected', 'menu.edit.ungroup', ['Ctrl+Shift+G']),
  edit('bring-to-front', 'canvas.bringToFront', 'menu.edit.bringToFront', [']']),
  edit('send-to-back', 'canvas.sendToBack', 'menu.edit.sendToBack', ['[']),
  edit('rotate', 'canvas.rotateSelected', 'menu.edit.rotate', ['Ctrl+Alt+R']),
  edit('lock', 'canvas.lockSelected', 'menu.edit.lock', ['Ctrl+Shift+L']),
  edit('unlock', 'canvas.unlockSelected', 'menu.edit.unlock'),
  edit('unlock-all', 'canvas.unlockAll', 'menu.edit.unlockAll'),
  edit('save-as-stamp', 'canvas.saveSelectionAsStamp', 'menu.edit.saveAsStamp'),
  view('zoom-in', 'view.zoomIn', 'menu.view.zoomIn', { shortcuts: ['Ctrl+Plus'] }),
  view('zoom-out', 'view.zoomOut', 'menu.view.zoomOut', { shortcuts: ['Ctrl+Minus'] }),
  // Home fits too, with the map focused: a canvas key row (app/keyboard/keymap.ts), shown here only.
  view('fit-to-design', 'view.fitToDesign', 'menu.view.fitToDesign', { shortcuts: ['Shift+F', 'Ctrl+0'], keyHints: ['Home'] }),
  view('zoom-to-selection', 'view.zoomToSelection', 'menu.view.zoomToSelection', { shortcuts: ['Shift+2'] }),
  // The rotation rows sit after Fit to Design, in the View menu's first section. Their routed chords (Shift+N, Shift+←,
  // Shift+→, Shift+↑) are canvas key rows, shown here only (spec §3.6).
  // N follows the single-key switch; Shift+N always resets (with the switch off menus show it).
  view('reset-north', 'view.resetNorth', 'menu.view.resetNorth', { shortcuts: ['N'], keyHints: ['Shift+N', 'Shift+ArrowUp'] }),
  view('turn-view-left', 'view.turnViewLeft', 'menu.view.turnViewLeft', { keyHints: ['Shift+ArrowLeft'] }),
  view('turn-view-right', 'view.turnViewRight', 'menu.view.turnViewRight', { keyHints: ['Shift+ArrowRight'] }),
  view('search-place', 'view.searchPlace', 'menu.view.searchPlace', { shortcuts: ['Ctrl+K'], worksInTextFields: true }),
  // Shift+L cycles View › Labels (None, Codes, Names; it was N before rotation); menus show it on the Labels submenu.
  view('cycle-labels', 'view.cycleLabels', 'menu.view.cycleLabels', { shortcuts: ['Shift+L'] }),
  {
    kind: 'settings',
    id: 'grid',
    commandId: 'canvas.toggleGrid',
    labelKey: 'canvas.grid.grid',
    shortcuts: ['Shift+G'],
    intent: { type: 'toggle-grid' },
    stateKey: 'gridVisible',
  },
  {
    kind: 'settings',
    id: 'snap',
    commandId: 'canvas.toggleSnapToGrid',
    labelKey: 'canvas.grid.snapToGrid',
    shortcuts: ['Shift+S'],
    intent: { type: 'toggle-snap-to-grid' },
    stateKey: 'snapToGridEnabled',
  },
]

export function isCanvasCommandDisabled(
  intent: CanvasCommandIntent,
  state: CanvasCommandProjectionState,
): boolean {
  switch (intent.type) {
    case 'select-tool':
      // Never disabled: before the canvas mounts a tool primes the one it starts with, and in overview arming fits the
      // Design first (app/keyboard/arming.ts).
      return false
    case 'undo':
      return !state.canUndo
    case 'redo':
      return !state.canRedo
    case 'toggle-grid':
    case 'toggle-snap-to-grid':
      return !state.canvasAvailable
    case 'view':
      return !state.canvasAvailable || (intent.action === 'zoom-to-selection' && state.selection === null)
    case 'edit':
      return !canvasEditAvailable(intent.action, {
        canvasAvailable: state.canvasAvailable,
        overview: !state.spatialEditingAvailable,
        selection: state.selection,
        held: state.held,
        lockedObjectsPresent: state.lockedObjectsPresent,
        // The menu bar and the palette keep Paste enabled, a no-op without a clipboard (U54 Q5): the one difference
        // from the canvas menu, which reads the clipboard.
        canPaste: true,
      })
  }
}

interface CreateCanvasCommandProjectionOptions {
  readonly state: CanvasCommandProjectionState
  readonly run: CanvasIntentRunner
  readonly translate: (key: LocaleKey) => string
  /** Settings › Keyboard; false hides character-key shortcuts from every surface. */
  readonly characterKeys: boolean
}

export function createCanvasCommandProjection({
  state,
  run,
  translate,
  characterKeys,
}: CreateCanvasCommandProjectionOptions): CanvasCommandProjection {
  const project = (definition: CanvasCommandDefinition): CanvasProjectedCommand => {
    const disabled = isCanvasCommandDisabled(definition.intent, state)
    const shortcut = canvasCommandDisplayKey(definition, characterKeys)
    const { intent } = definition
    return {
      commandId: definition.commandId,
      label: translate(definition.labelKey),
      shortcut: shortcut ? formatShortcut(shortcut, translate) : undefined,
      ariaShortcut: canvasCommandAriaKeys(definition, characterKeys),
      disabled,
      action: (from) => {
        if (!disabled) run(intent, from)
      },
    }
  }
  const projectAction = (
    definition: CanvasHistoryCommandDefinition
      | CanvasSettingsCommandDefinition
      | CanvasEditCommandDefinition
      | CanvasViewCommandDefinition,
  ): CanvasToolbarActionCommand => {
    const command = project(definition)
    return {
      ...command,
      // Arms no tool, so its surface does not matter.
      action: () => command.action('menu'),
      id: definition.id,
      ...(definition.kind === 'settings' ? { pressed: state[definition.stateKey] } : {}),
    }
  }
  const toolDefinitions = canvasCommandDefinitions.filter(
    (definition): definition is CanvasToolCommandDefinition => definition.kind === 'tool',
  )
  const panTool = project(toolDefinitions.find((definition) => definition.tool === 'hand')!)
  const viewPan: CanvasToolbarActionCommand = { ...panTool, id: 'pan', action: () => panTool.action('menu') }

  return {
    toolGroups: CANVAS_TOOL_GROUP_ORDER.map((group) => {
      const headingKey = CANVAS_TOOL_GROUP_HEADINGS[group]
      return {
        id: group,
        ...(headingKey ? { heading: translate(headingKey) } : {}),
        tools: toolDefinitions
          .filter((definition) => definition.group === group)
          .map((definition) => ({
            ...project(definition),
            tool: definition.tool,
            active: state.activeTool === definition.tool,
          })),
      }
    }),
    historyActions: canvasCommandDefinitions
      .filter((definition): definition is CanvasHistoryCommandDefinition => definition.kind === 'history')
      .map(projectAction),
    settingsToggles: canvasCommandDefinitions
      .filter((definition): definition is CanvasSettingsCommandDefinition => definition.kind === 'settings')
      .map(projectAction),
    editActions: canvasCommandDefinitions
      .filter((definition): definition is CanvasEditCommandDefinition => definition.kind === 'edit')
      .map(projectAction),
    // View › Pan is the Pan tool's own command, after the view turns: Pan is off the main rail, so View and Tools
    // both list it.
    viewActions: canvasCommandDefinitions
      .filter((definition): definition is CanvasViewCommandDefinition => definition.kind === 'view')
      .flatMap((definition) => definition.id === 'turn-view-right'
        ? [projectAction(definition), viewPan]
        : [projectAction(definition)]),
  }
}
