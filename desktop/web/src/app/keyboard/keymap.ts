// app/keyboard/keymap.ts
//
// Owns the keymap the key router matches (spec §1.6, §3.6): which chord runs which command, in which focus scope, and
// whether Settings › Keyboard's single-key switch turns it off. Canvas rows come from each catalogue definition's
// `shortcuts` (never its key hint, so no row has Escape) and from the canvas key commands the keyboard port runs; each
// edition composes its shell rows from its own catalogue and runs them through its own CommandSink (Desktop:
// commands/registry.ts; Web: web/browser-shell-commands.ts), so this module names no edition (P14). Also the stack of
// pushed key scopes: non-modal surfaces that own a key while open.

import type { CanvasCommandId } from '../canvas-commands'
import { canvasCommandDefinitions } from '../canvas-commands'
import type { ShellCommandCatalogEntry, ShellCommandId } from '../shell-commands'
import { isCharacterKeyShortcut } from '../shell-commands/shortcut-text'
import type { CanvasKeyCommand } from '../../canvas/runtime/runtime'
import { chordMatches, chordsOfShortcut, type KeyChord } from './key-chord'

export type KeyScope =
  | 'global'          // every focus class except modal; in text only with worksInTextFields (every shell chord, Ctrl+K)
  | 'command'         // anywhere except text fields and dialogs: tool letters, [ ], N, Shift+N, Shift+L, Ctrl+V, Ctrl+Z…
  | 'view-arrows'     // like 'command', but not inside an arrow-owning widget: Shift+←/→ turn the view, Shift+↑ resets north
  | 'outside-dock'    // like 'command', but not from the dock or phone sheet (focus there, or <body> after a press there):
                      // the edits of the map's selection (Ctrl+C, Ctrl+A, Delete…)
  | 'canvas-focus'    // the map host (not text or a control in it), or <body> after a press or focus on the map: plain
                      // and mod arrows, Enter, F2…

/** A shell command, a canvas catalogue command or a canvas key command ('canvas.<CanvasKeyCommand kind>'). */
type KeyCommandId = ShellCommandId | CanvasCommandId | `canvas.${CanvasKeyCommand['kind']}`

export interface KeymapRow {
  readonly command: KeyCommandId
  /** The port command a canvas key row sends; absent on rows the edition's CommandSink runs. */
  readonly canvas?: CanvasKeyCommand
  readonly chords: readonly KeyChord[]
  readonly scope: KeyScope
  /** The single-key shortcut switch: 'follows-switch' rows stop when it is off; a canvas key row that follows it still runs
   *  its port command, without its fallback, while the map host has focus (a held stamp's `[` `]`, spec §3.6). */
  readonly singleKey: 'follows-switch' | 'always-on' | 'n/a'
  /** Also runs while a text field has focus: every shell row but a single key (F2 too), and Ctrl+K. */
  readonly worksInTextFields?: boolean
  readonly worksInModal?: boolean             // Desktop's help.commandPalette only: its sink closes the open palette
  /** A canvas row whose port command() returns false runs this instead (F2 → file.rename; Backspace → delete). */
  readonly fallback?: ShellCommandId | CanvasCommandId
  /** Runs nothing: the router only keeps the chord from the browser (Web Mac Cmd+← and Cmd+→ go Back). */
  readonly keepsFromBrowser?: true
}

/** Where a keymap row runs. Injected, so this module stays neutral (P14). */
export interface CommandSink {
  /** False when the key is not consumed; the router prevents and stops a consumed key. */
  run(command: ShellCommandId | CanvasCommandId): boolean
}

/**
 * The canvas key commands, ahead of the catalogue rows they share a chord with (Backspace, Delete, F2, `[` `]`). The
 * rotation chords live only here, never on a catalogue definition, whose rows are not in the `view-arrows` scope and
 * would turn the map from an arrow-owning widget (spec §3.6): the menus show them through the definitions' display-only
 * keyHints.
 */
const CANVAS_KEY_ROWS: readonly KeymapRow[] = [
  keyRow({ kind: 'confirm' }, ['Enter']),
  // Both remove a focused or selected zone corner in Select (Backspace is the Mac's delete key); with none the selection goes.
  keyRow({ kind: 'remove-last' }, ['Backspace'], { fallback: 'canvas.deleteSelected' }),
  keyRow({ kind: 'delete-handle' }, ['Delete'], { fallback: 'canvas.deleteSelected' }),
  keyRow({ kind: 'edit-text' }, ['F2'], { fallback: 'file.rename' }),
  keyRow({ kind: 'context-menu' }, ['ContextMenu', 'Shift+F10']),
  keyRow({ kind: 'rotate-held', stepDeg: -15 }, ['['], { scope: 'command', singleKey: 'follows-switch', fallback: 'canvas.sendToBack' }),
  keyRow({ kind: 'rotate-held', stepDeg: 15 }, [']'], { scope: 'command', singleKey: 'follows-switch', fallback: 'canvas.bringToFront' }),
  ...(['left', 'right', 'up', 'down'] as const).flatMap((dir) => {
    const key = `Arrow${dir[0]!.toUpperCase()}${dir.slice(1)}`
    return [
      keyRow({ kind: 'arrow', dir, large: false }, [key]),
      // mod is the large step (Cmd on a Mac, where Ctrl+arrow is Mission Control's).
      keyRow({ kind: 'arrow', dir, large: true }, [`Ctrl+${key}`]),
    ]
  }),
  // Away from the map mod+←/→ runs nothing but stays in the app: Chrome and Firefox on a Mac go Back on Cmd+←/→, and the
  // map teaches it as the large step. Cmd+↑/↓ only scroll, so they keep it.
  {
    command: 'canvas.arrow',
    chords: ['Ctrl+ArrowLeft', 'Ctrl+ArrowRight'].flatMap(chordsOfShortcut),
    scope: 'command',
    singleKey: 'n/a',
    keepsFromBrowser: true,
  },
  keyRow({ kind: 'rotate-view', direction: -1 }, ['Shift+ArrowLeft'], { scope: 'view-arrows' }),
  keyRow({ kind: 'rotate-view', direction: 1 }, ['Shift+ArrowRight'], { scope: 'view-arrows' }),
  keyRow({ kind: 'reset-north' }, ['Shift+ArrowUp'], { scope: 'view-arrows' }),
  // N follows the switch through its catalogue row (View › Reset north); Shift+N always resets.
  keyRow({ kind: 'reset-north' }, ['Shift+N'], { scope: 'command', singleKey: 'always-on' }),
  // Plain + and − act only while the map has focus, so they stay on with the switch off (WCAG 2.1.4); `+` matches
  // whatever Shift typed it (US Shift+=).
  keyRow({ kind: 'zoom-step', direction: 1 }, ['Plus']),
  keyRow({ kind: 'zoom-step', direction: -1 }, ['Minus']),
  // Home fits only with the map focused: elsewhere it moves to a list's first item or a field's start.
  { command: 'view.fitToDesign', chords: chordsOfShortcut('Home'), scope: 'canvas-focus', singleKey: 'n/a' },
]

/**
 * The edits of the map's selection run from any focus but a text field, a dialog and the dock or phone sheet: from the
 * map, its floating chrome, the rail and the title bar as before phase F, while a press on a dock panel's text or a dock
 * control leaves the browser's copy and select all to the page. `[` `]` stay with their `command` key rows (a held stamp
 * turns); paste, undo and redo run from the dock too, as before phase F.
 */
const MAP_SELECTION_EDITS: ReadonlySet<CanvasCommandId> = new Set<CanvasCommandId>([
  'canvas.cut',
  'canvas.copy',
  'canvas.duplicateSelected',
  'canvas.deleteSelected',
  'canvas.selectAll',
  'canvas.selectSameSpecies',
  'canvas.groupSelected',
  'canvas.ungroupSelected',
  'canvas.rotateSelected',
  'canvas.lockSelected',
])

/** Both editions' canvas rows: the key commands, then each catalogue definition's shortcuts through the switch. */
export const CANVAS_KEYMAP_ROWS: readonly KeymapRow[] = [
  ...CANVAS_KEY_ROWS,
  ...canvasCommandDefinitions.flatMap((definition) => (definition.shortcuts ?? []).flatMap((shortcut): KeymapRow[] => {
    const scope: KeyScope = definition.worksInTextFields
      ? 'global'
      : MAP_SELECTION_EDITS.has(definition.commandId) ? 'outside-dock' : 'command'
    // A chord a key row of the same scope falls back to the catalogue command with is that row's: `[` `]`, Backspace.
    const chords = chordsOfShortcut(shortcut).filter((chord) => !CANVAS_KEY_ROWS.some((row) =>
      row.scope === scope && row.fallback === definition.commandId
      && row.chords.some((rowChord) => chordMatches(rowChord, chord))))
    if (chords.length === 0) return []
    return [{
      command: definition.commandId,
      chords,
      scope,
      singleKey: isCharacterKeyShortcut(shortcut) ? 'follows-switch' : 'n/a',
      ...(definition.worksInTextFields ? { worksInTextFields: true } : {}),
    }]
  })),
]

/** F2 asks the map first (edit the selected note), so its shell row waits for the command step. */
const SHELL_COMMAND_SCOPE_ROWS: ReadonlySet<ShellCommandId> = new Set(['file.rename'])

/**
 * One edition's shell rows from its own catalogue (capability-filtered; Web omits the shortcuts a browser keeps). Each
 * edition composes [...shellKeymapRows(…), ...CANVAS_KEYMAP_ROWS]. Shell shortcuts work everywhere but a modal, text
 * fields included (a single key there types, so it would not).
 */
export function shellKeymapRows(
  catalog: readonly ShellCommandCatalogEntry[],
  options: { readonly omit?: ReadonlySet<string> } = {},
): readonly KeymapRow[] {
  return catalog.flatMap((command): KeymapRow[] => {
    const raw = command.shortcuts ?? (command.shortcut ? [command.shortcut] : [])
    const live = raw.filter((shortcut) => !options.omit?.has(shortcut))
    if (live.length === 0) return []
    const singleKey = live.every(isCharacterKeyShortcut)
    return [{
      command: command.id,
      chords: live.flatMap(chordsOfShortcut),
      scope: SHELL_COMMAND_SCOPE_ROWS.has(command.id) ? 'command' : 'global',
      singleKey: singleKey ? 'follows-switch' : 'n/a',
      ...(singleKey ? {} : { worksInTextFields: true }),
      ...(command.id === 'help.commandPalette' ? { worksInModal: true } : {}),
    }]
  })
}

/** A pushed scope takes a chord by answering true. */
type PushedKeyScope = (chord: KeyChord) => boolean

/** Pushed scopes, the latest last: non-modal surfaces that own keys while open (spec §1.6, step 7). Modal surfaces push none. */
const pushedScopes: PushedKeyScope[] = []

/** Pushes a scope until the returned function removes it. */
export function pushKeyScope(handle: PushedKeyScope): () => void {
  pushedScopes.push(handle)
  return () => {
    const index = pushedScopes.lastIndexOf(handle)
    if (index >= 0) pushedScopes.splice(index, 1)
  }
}

/** The pushed scopes, the latest last; the key router tries them latest first. */
export function pushedKeyScopes(): readonly PushedKeyScope[] {
  return pushedScopes
}

function keyRow(
  canvas: CanvasKeyCommand,
  shortcuts: readonly string[],
  options: Partial<Pick<KeymapRow, 'scope' | 'singleKey' | 'fallback'>> = {},
): KeymapRow {
  return {
    command: `canvas.${canvas.kind}`,
    canvas,
    chords: shortcuts.flatMap(chordsOfShortcut),
    scope: options.scope ?? 'canvas-focus',
    singleKey: options.singleKey ?? 'n/a',
    ...(options.fallback ? { fallback: options.fallback } : {}),
  }
}
