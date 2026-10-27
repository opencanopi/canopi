// app/keyboard/key-router.ts
//
// Owns the only window key listeners (spec §1.6, ADR 0020; policy P8): keydown in capture and bubble, keyup in capture.
// A key that is part of an IME composition runs nothing (WebKit sends the composition's Enter with keyCode 229).
// Capture hands every other key to the canvas keyboard port first (keyState: the nudge commit, the Space hold), cycles the F6 regions and, while a drag or nudge series is live, runs the Esc chain before
// any element handler (app/keyboard/escape-chain.ts). It also keeps the keys held down and lets every one go (a keyup to
// the port) when Meta comes up, on a window blur and on a visibility change: macOS drops the keyup of any key released
// while Cmd is down, so Meta's keyup releases every held key. Bubble skips a key an element handler already took, then
// runs, by focus class, the modal rows, the global rows, the pushed scopes, the Esc chain and the keymap's canvas-focus,
// view-arrows, outside-dock and command rows, each chord's one row per scope, through the canvas port or the edition's
// CommandSink.
// The router registers the canvas port's Esc layers for as long as it is installed, and records at document capture
// (app/keyboard/input-modality.ts) whether the last input was a key or a pointer press and which primary press is held
// (pointerdown to pointerup or pointercancel, or leaving the window or page), and
// whether the last pointer press or focus move landed in the map host (with nothing focused, only then are the map-focus
// keys the map's) or in the dock or phone sheet (then the map's selection edits leave the key to the page;
// app/keyboard/target-class.ts). The focus move counts so a dock control that F6 or Tab reached and that then
// unmounts leaves <body> off the map. Installed once per edition:
// Desktop's platform/desktop.ts passes installKeyRouter to commands/registry.ts installDesktopKeyRouter; Web's
// main.web.tsx calls web/browser-shell-commands.ts installWebKeyRouter.

import type { ReadonlySignal } from '@preact/signals'
import type { CanvasCommandId } from '../canvas-commands'
import type { ShellCommandId } from '../shell-commands'
import type { InputPlatform } from '../../canvas/runtime/input/platform'
import type { CanvasKeyboardPort, CanvasKeyState, CanvasKeyVerdict } from '../../canvas/runtime/runtime'
import { registerCanvasEscapeLayers, runEscape } from './escape-chain'
import type { FocusOwner } from './focus-owner'
import { chordMatches, chordOf, digitChordOf, type KeyboardEventLike, type KeyChord } from './key-chord'
import { pushedKeyScopes, type CommandSink, type KeymapRow, type KeyScope } from './keymap'
import { noteKeyPress, notePointerPress, notePrimaryPressDown, notePrimaryPressEnd } from './input-modality'
import { classifyKeyTarget, isInDock, ownsArrows, type KeyTarget, type LastPress } from './target-class'

/** F6 and Shift+F6 move between the workspace regions through the focus owner. */
type KeyRouterFocus = Pick<FocusOwner, 'cycleRegion'>

export interface KeyRouterDeps {
  readonly target: Pick<Window, 'addEventListener' | 'removeEventListener'>   // window in production
  readonly keymap: readonly KeymapRow[]            // composed per edition: its shellKeymapRows(…), then CANVAS_KEYMAP_ROWS
  readonly commands: CommandSink
  readonly canvas: () => CanvasKeyboardPort | null // canvas/session.ts currentCanvasKeyboardPort
  readonly singleKeys: ReadonlySignal<boolean>     // Settings › Keyboard
  readonly focus: KeyRouterFocus                  // app/keyboard/focus-owner.ts focusOwner
  readonly isModalOpen: () => boolean              // modalLayerOpen, saveProblem, savedViewDialogOpen
  readonly platform: InputPlatform                 // the Mac chord rule; detectPlatform runs in the platforms
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener'>   // visibilitychange, pointer presses, focusin
}

export interface KeyRouterHandle { dispose(): void }

/** Step 9 tries the narrowest scope first: a canvas-focus row before the command row of the same chord. */
const KEYMAP_SCOPES: readonly Exclude<KeyScope, 'global'>[] = ['canvas-focus', 'view-arrows', 'outside-dock', 'command']

export function installKeyRouter(deps: KeyRouterDeps): KeyRouterHandle {
  /** Where the last pointer press or focus move in the document landed; none yet is one outside the map and the dock. */
  let last: LastPress = { onMap: false, inDock: false }
  const at = (port: CanvasKeyboardPort | null, event: KeyboardEventLike): KeyTarget =>
    classifyKeyTarget(event.target, port?.host ?? null, deps.isModalOpen(), last)
  /** The keys down now, by code: what a lost keyup would leave held in the port. */
  const held = new Map<string, string>()
  const letGo = (): void => {
    const keys = [...held]
    held.clear()
    const port = deps.canvas()
    if (!port) return
    for (const [code, key] of keys) port.keyState(releasedKey(key, code))
  }
  // The listeners are registered for keydown and keyup only, so a KeyboardEvent here is a KeyboardEventLike.
  const onKeyDownCapture = (event: KeyboardEvent): void => {
    noteKeyPress()
    // Step 1: a key that is part of a composition is the IME's.
    if (isComposing(event)) return
    held.set(event.code || event.key, event.key)
    keyDownCapture(deps, at, event as KeyboardEventLike)
  }
  const onKeyDownBubble = (event: KeyboardEvent): void => keyDownBubble(deps, at, event as KeyboardEventLike)
  const onKeyUpCapture = (event: KeyboardEvent): void => {
    held.delete(event.code || event.key)
    const port = deps.canvas()
    if (port) port.keyState(keyState(event as KeyboardEventLike, 'keyup', at(port, event as KeyboardEventLike)))
    if (event.key === 'Meta') letGo()
  }
  // A window left behind takes the keys held and the key flag with it: a key the page heard on the way out (Alt of
  // Alt+Tab) is no keyboard focus when the window comes back.
  const onLeave = (): void => {
    letGo()
    notePointerPress()
    notePrimaryPressEnd()
  }
  const onPressOrFocus = (event: Event): void => {
    if (event.type === 'pointerdown') {
      notePointerPress()
      if (isPrimaryPress(event)) notePrimaryPressDown(event.pointerId)
    }
    const host = deps.canvas()?.host
    last = {
      onMap: !!host && event.target instanceof Node && host.contains(event.target),
      inDock: isInDock(event.target),
    }
  }
  const onPressEnd = (event: Event): void => {
    if (isPointerEvent(event)) notePrimaryPressEnd(event.pointerId)
  }
  const disposeEscapeLayers = registerCanvasEscapeLayers(deps.canvas)
  deps.target.addEventListener('keydown', onKeyDownCapture as EventListener, true)
  deps.target.addEventListener('keydown', onKeyDownBubble as EventListener)
  deps.target.addEventListener('keyup', onKeyUpCapture as EventListener, true)
  deps.target.addEventListener('blur', onLeave)
  deps.document.addEventListener('visibilitychange', onLeave)
  deps.document.addEventListener('pointerdown', onPressOrFocus, true)
  deps.document.addEventListener('pointerup', onPressEnd, true)
  deps.document.addEventListener('pointercancel', onPressEnd, true)
  deps.document.addEventListener('focusin', onPressOrFocus, true)
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      disposeEscapeLayers()
      deps.target.removeEventListener('keydown', onKeyDownCapture as EventListener, true)
      deps.target.removeEventListener('keydown', onKeyDownBubble as EventListener)
      deps.target.removeEventListener('keyup', onKeyUpCapture as EventListener, true)
      deps.target.removeEventListener('blur', onLeave)
      deps.document.removeEventListener('visibilitychange', onLeave)
      deps.document.removeEventListener('pointerdown', onPressOrFocus, true)
      deps.document.removeEventListener('pointerup', onPressEnd, true)
      deps.document.removeEventListener('pointercancel', onPressEnd, true)
      deps.document.removeEventListener('focusin', onPressOrFocus, true)
      // No router is left to see the press end; work waiting for it runs.
      notePrimaryPressEnd()
    },
  }
}

/** A primary pointer's primary button going down: the press that layout waits for (a key router test's plain Event is none). */
function isPrimaryPress(event: Event): event is PointerEvent {
  return isPointerEvent(event) && event.isPrimary && event.button === 0
}

function isPointerEvent(event: Event): event is PointerEvent {
  return typeof PointerEvent !== 'undefined' && event instanceof PointerEvent
}

/** Classifies a key's target for the canvas port's host, with the last press or focus move. */
type Where = (port: CanvasKeyboardPort | null, event: KeyboardEventLike) => KeyTarget

function keyDownCapture(deps: KeyRouterDeps, where: Where, event: KeyboardEventLike): void {
  const port = deps.canvas()
  const at = where(port, event)
  const verdict: CanvasKeyVerdict = port ? port.keyState(keyState(event, 'keydown', at)) : 'pass'
  if (verdict === 'held') {
    if (event.cancelable) event.preventDefault()
    return
  }
  if (event.key === 'F6') {
    // Capture, so a widget that stops propagation cannot keep focus in its region (fixture I11).
    if (event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented || at.focus === 'modal') return
    if (deps.focus.cycleRegion(event.shiftKey ? -1 : 1) && event.cancelable) event.preventDefault()
    return
  }
  // Step 4: a live drag or nudge series takes Esc before any element handler, from any focus but a text field or a
  // modal (the layers' own rule), so a widget's own Esc (the inspection lens closing) does not also run (fixture I10).
  const liveOnCanvas = verdict === 'pass-live' || (port?.escapeLayers().includes('nudge-series') ?? false)
  if (event.key === 'Escape' && liveOnCanvas && at.focus !== 'modal') escape(event, at)
}

/** Step 8: the Esc chain; a layer that takes the key prevents and stops it. */
function escape(event: KeyboardEventLike, at: KeyTarget): void {
  if (runEscape({ event, focus: at.focus })) consume(event)
}

function keyDownBubble(deps: KeyRouterDeps, where: Where, event: KeyboardEventLike): void {
  // An element handler of a focused widget took the key.
  if (event.defaultPrevented) return
  const named = chordOf(event, deps.platform)
  if (!named) return
  const port = deps.canvas()
  const at = where(port, event)
  // A layout's digit row names its digits when no row takes its label (AZERTY Ctrl+& is Ctrl+1).
  let chord: KeyChord = named
  let rows = rowsFor(deps.keymap, named)
  const digit = rows.length === 0 ? digitChordOf(named, event) : null
  if (digit) {
    chord = digit
    rows = rowsFor(deps.keymap, digit)
  }
  const singleKeys = deps.singleKeys.peek()

  // Step 5: a modal dialog's own element handlers have run; only its rows remain.
  if (at.focus === 'modal') {
    const row = rows.find((candidate) => candidate.worksInModal)
    if (row) dispatch(deps, port, event, row, true)
    return
  }
  // Step 6: in a text field only the rows that work there (the shell's, F2 included); elsewhere the global rows.
  if (at.focus === 'text') {
    const row = rows.find((candidate) => candidate.worksInTextFields)
    if (row) dispatch(deps, port, event, row, true)
    else if (event.key === 'Escape') escape(event, at)
    return
  }
  const global = rows.find((row) => row.scope === 'global')
  if (global) {
    dispatch(deps, port, event, global, true)
    return
  }
  // Step 7: the pushed scopes, the latest first.
  const scopes = pushedKeyScopes()
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (!scopes[index]!(chord)) continue
    consume(event)
    return
  }
  // Step 8: no keymap row has Escape.
  if (event.key === 'Escape') {
    escape(event, at)
    return
  }
  // Step 9: one row per chord and scope, never tried in turn.
  for (const scope of KEYMAP_SCOPES) {
    if (!scopeAdmits(scope, at, event)) continue
    for (const row of rows) {
      if (row.scope !== scope) continue
      const switchOn = row.singleKey !== 'follows-switch' || singleKeys
      // A canvas key that follows the switch still runs on the focused map with it off (a held stamp's `[` `]`).
      if (!switchOn && !(row.canvas && at.focus === 'map' && !at.unfocused)) continue
      dispatch(deps, port, event, row, switchOn)
      return
    }
  }
}

function isComposing(event: Pick<KeyboardEventLike, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229
}

function rowsFor(keymap: readonly KeymapRow[], chord: KeyChord): readonly KeymapRow[] {
  return keymap.filter((row) => row.chords.some((rowChord) => chordMatches(rowChord, chord)))
}

function scopeAdmits(scope: Exclude<KeyScope, 'global'>, at: KeyTarget, event: KeyboardEventLike): boolean {
  switch (scope) {
    case 'canvas-focus':
      return at.focus === 'map'
    case 'view-arrows':
      return !ownsArrows(event.target)
    case 'outside-dock':
      return !at.dock
    case 'command':
      return true
  }
}

/** Step 10: canvas commands through the port, a refused one through its fallback, the rest through the sink; a row kept
 *  from the browser runs nothing. */
function dispatch(
  deps: KeyRouterDeps,
  port: CanvasKeyboardPort | null,
  event: KeyboardEventLike,
  row: KeymapRow,
  fallbackAllowed: boolean,
): void {
  let consumed: boolean
  if (row.keepsFromBrowser) {
    consumed = true
  } else if (row.canvas) {
    consumed = port?.command(row.canvas) ?? false
    if (!consumed && row.fallback && fallbackAllowed) consumed = runSink(deps, port, row.fallback)
  } else {
    consumed = runSink(deps, port, row.command as ShellCommandId | CanvasCommandId)
  }
  if (consumed) consume(event)
}

/** The sink commands that delete the selection: Delete and Backspace's deletion, and Ctrl+X's cut. */
const DELETES_SELECTION: ReadonlySet<ShellCommandId | CanvasCommandId> = new Set<ShellCommandId | CanvasCommandId>([
  'canvas.deleteSelected',
  'canvas.cut',
])

/** A sink command from a key. A command that deletes the selection is consumed and runs nothing while the canvas holds
 *  it (U33, canopi-f47t.21): a live pointer session (a still drag, twist or rotate included), whose deletion would wait
 *  for it to settle and land after the release, or a tool transient (a draft, a row source, Place plants' waiting point,
 *  a held stamp pick). From any focus, since a canvas row's fallback passes here too. */
function runSink(deps: KeyRouterDeps, port: CanvasKeyboardPort | null, command: ShellCommandId | CanvasCommandId): boolean {
  if (DELETES_SELECTION.has(command) && (port?.holdsSelectionDeletes() ?? false)) return true
  return deps.commands.run(command)
}

function consume(event: KeyboardEventLike): void {
  if (event.cancelable) event.preventDefault()
  event.stopPropagation()
}

/** A keyup the browser never sent, for a key held when Meta came up or the window lost the keys. */
function releasedKey(key: string, code: string): CanvasKeyState {
  return {
    type: 'keyup',
    key,
    code,
    mods: { shift: false, ctrl: false, alt: false, meta: false },
    text: false,
    onCanvas: false,
  }
}

function keyState(event: KeyboardEventLike, type: CanvasKeyState['type'], at: KeyTarget): CanvasKeyState {
  return {
    type,
    key: event.key,
    code: event.code,
    mods: { shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey },
    text: at.text,
    // Space holds from the map and with nothing focused, wherever the last press landed (spec §1.6, step 3).
    onCanvas: at.focus === 'map' || at.unfocused,
  }
}
