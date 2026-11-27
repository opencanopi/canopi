// canvas/runtime/keyboard-port.ts
//
// Owns the canvas's key handling behind CanvasKeyboardPort (spec §1.2a, §1.6, ADR 0020): the key router hands it every
// key first (keyState: the nudge commit, the Space hold, the modifiers a live rotate steps by), runs its key commands (the arrow nudge and pan, mod for the large step; Shift+←/→ turning the view and
// Shift+↑ or Shift+N resetting north; plain + and − zooming one step; Enter, Backspace, Delete on a
// focused or selected corner, F2, `[` `]`, the Menu key) and lists and runs its Esc layers, which
// app/keyboard/escape-chain.ts places in the Esc chain. The arrow nudge series is the ToolHost's; the port only reads its
// outcome. It never touches a DOM event: the router acts on its answers.

import type { ToolHost } from './interaction-ports'
import type { Modifiers } from './interaction-types'
import type { CanvasEscapeLayer, CanvasKeyboardPort, CanvasKeyCommand, CanvasKeyState, CanvasKeyVerdict } from './runtime'
import type { ViewNavigation } from '../../geo/view/navigation'
import type { ScreenPoint } from '../../geo/view/types'

/** Arrow-key pan steps with nothing selected, in screen pixels. */
const ARROW_PAN_STEP_PX = 64
const ARROW_PAN_LARGE_STEP_PX = 256
const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
const DIRECTIONS: Readonly<Record<'left' | 'right' | 'up' | 'down', ScreenPoint>> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
}
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'])

export interface CanvasKeyboardPortDeps {
  readonly host: HTMLElement
  readonly toolHost: ToolHost
  /** Today's getSelection().length > 0, read per key: on a 'pass' nudge the arrow pans with nothing selected and is let through
   *  otherwise; the Esc 'selection' layer is live while it holds. */
  hasSelection(): boolean
  /** Arrow pans (64 or 256 px), + / −, Shift+N and Shift+←/→/↑ (N runs View › Reset north through the edition's sink). */
  readonly navigation: Pick<ViewNavigation, 'panByPx' | 'zoomIn' | 'zoomOut' | 'resetNorth' | 'rotateBy'>
  /** The interaction session's side of the keys. */
  readonly session: CanvasKeySession
}

/** What the keys need from the interaction session (its recogniser and the ToolHost). */
interface CanvasKeySession {
  /** A pointer press or pan is live: the arrows and the Menu key wait, Esc cancels it. */
  pointerSessionLive(): boolean
  /** The map is in overview (the session's mode). */
  overview(): boolean
  /** A canvas handle (a corner, a midpoint dot, a guide end) holds keyboard focus: the arrows do nothing (U36). */
  handleFocused(): boolean
  /** Space is held for panning: the recogniser's held.space, the one record (ADR 0017). */
  spaceHeld(): boolean
  /** Space and the modifiers as the keys left them: the recogniser's key state and the navigation cursor. */
  keyState(state: { readonly space: boolean; readonly mods: Modifiers }): void
  /** Esc with a pointer session live: the recogniser's 'escape' cancels it and releases Space. */
  escapeGesture(): void
  /** The Esc layer 'tool' leaves the armed tool for Select, settling any pending map-input request as `'escape'`. */
  escapeTool(): void
  /** The Esc layer 'selection': an empty selection, history-free, redrawn. */
  clearSelection(): void
}

export function createCanvasKeyboardPort(deps: CanvasKeyboardPortDeps): CanvasKeyboardPort {
  const { host, toolHost, session } = deps

  /** The arrow's rule after the host's nudge (spec §3.6): a handled or refused nudge takes the key, and on 'pass' the map
   *  pans with nothing selected; otherwise a plain arrow goes on, and mod+arrow is taken anyway (Web Mac Cmd+← would go
   *  Back). */
  function arrow(direction: ScreenPoint, large: boolean): boolean {
    const outcome = toolHost.nudge(direction, large)
    if (outcome !== 'pass') return true
    if (deps.hasSelection()) return large
    const step = large ? ARROW_PAN_LARGE_STEP_PX : ARROW_PAN_STEP_PX
    deps.navigation.panByPx({ x: -direction.x * step + 0, y: -direction.y * step + 0 })
    return true
  }

  /** Space held for panning: from the map or with nothing focused, and from anywhere but a text field while a pointer
   *  session is live; any other focused widget keeps its Space (spec §1.6, step 3). */
  function holdsSpace(k: CanvasKeyState): boolean {
    if (k.code !== 'Space' || session.spaceHeld() || k.text) return false
    if (!k.onCanvas && !session.pointerSessionLive()) return false
    // An open text entry, focused or not, keeps Space from arming a pan, as today's Text adapter kept the shared keys.
    if (toolHost.textEntryOpen()) return false
    session.keyState({ space: true, mods: k.mods })
    return true
  }

  function verdict(): CanvasKeyVerdict {
    return session.pointerSessionLive() ? 'pass-live' : 'pass'
  }

  /** Esc in overview: today's interrupted-gesture cancel, Space released. */
  function cancelInterrupted(): void {
    session.escapeGesture()
    toolHost.interrupted()
  }

  /**
   * The live layers, by the Esc chain's priority (spec §3.7): a live pointer session, a nudge series, the armed tool's draft
   * or row source, any tool but Select, the selection. The gesture runs above the tool's own Esc, so an Esc mid-drag in
   * Plant a row cancels only the drag (plan §8). In overview only the gesture runs, today's interrupted-gesture cancel,
   * so Esc never leaves the tool or clears the selection there (U36); it is listed only while a pointer session or a
   * nudge series is live, so with nothing to cancel the Esc reaches the raster inspection's layer (spec §3.7).
   */
  function escapeLayers(): readonly CanvasEscapeLayer[] {
    if (session.overview()) return session.pointerSessionLive() || toolHost.hasNudgeSeries() ? ['gesture'] : []
    const layers: CanvasEscapeLayer[] = []
    for (const step of toolHost.activeToolEscSteps()) {
      if (step === 'gesture' && session.pointerSessionLive()) layers.push('gesture')
      else if (step === 'nudge-series' && toolHost.hasNudgeSeries()) layers.push('nudge-series')
      else if (step === 'tool-transient' && toolHost.activeToolHasEscapeTransient()) layers.push('tool-transient')
      else if (step === 'tool' && !toolHost.activeToolIsSelect()) layers.push('tool')
      else if (step === 'selection' && deps.hasSelection()) layers.push('selection')
    }
    return layers
  }

  return {
    host,
    escapeLayers,
    escape(layer) {
      switch (layer) {
        case 'gesture':
          if (session.overview()) cancelInterrupted()
          else session.escapeGesture()
          return
        case 'nudge-series':
          toolHost.endNudgeSeries(false)
          return
        case 'tool-transient':
          toolHost.command({ kind: 'escape' })
          return
        case 'tool':
          session.escapeTool()
          return
        case 'selection':
          session.clearSelection()
          return
      }
    },
    command(c: CanvasKeyCommand): boolean {
      const overview = session.overview()
      switch (c.kind) {
        case 'arrow':
          // A live pointer session leaves the arrows still (fixture H25); mod+arrow is consumed even so. A focused handle
          // takes them and moves nothing (U36).
          if (session.handleFocused()) return true
          if (session.pointerSessionLive()) return c.large
          return arrow(DIRECTIONS[c.dir], c.large)
        case 'rotate-held':
          if (overview) return false
          return toolHost.command({ kind: 'rotate-held', stepDeg: c.stepDeg }) === 'handled'
        case 'confirm':
          if (overview) return false
          if (toolHost.command({ kind: 'confirm' }) === 'handled') return true
          // Enter under Select edits the one selected note, as F2 does; never while a pointer session (a still twist or
          // rotate included) is live, as the editor would take the Esc that cancels the session.
          if (session.pointerSessionLive()) return false
          return toolHost.activeToolIsSelect() && toolHost.command({ kind: 'edit-text' }) === 'handled'
        case 'edit-text':
          // Consumed while a pointer session is live, so its fallback never renames the Design mid-gesture.
          if (session.pointerSessionLive()) return true
          if (overview || !toolHost.activeToolIsSelect()) return false
          return toolHost.command({ kind: 'edit-text' }) === 'handled'
        case 'remove-last':
        case 'delete-handle':
          if (overview) return false
          return toolHost.command({ kind: c.kind }) === 'handled'
        case 'rotate-view':
          deps.navigation.rotateBy(c.direction)
          return true
        case 'reset-north':
          deps.navigation.resetNorth()
          return true
        case 'zoom-step':
          if (c.direction > 0) deps.navigation.zoomIn()
          else deps.navigation.zoomOut()
          return true
        case 'context-menu':
          if (overview || session.pointerSessionLive()) return false
          toolHost.menuAt('selection', 'keyboard')
          return true
      }
    },
    keyState(k) {
      if (k.type === 'keyup') {
        if (k.code === 'Space') session.keyState({ space: false, mods: k.mods })
        else if (MODIFIER_KEYS.has(k.key)) session.keyState({ space: session.spaceHeld(), mods: k.mods })
        return verdict()
      }
      // Any other key ends a nudge series (one undo step); Esc aborts it through its layer.
      if (toolHost.hasNudgeSeries() && !ARROW_KEYS.has(k.key) && !MODIFIER_KEYS.has(k.key) && k.key !== 'Escape') {
        toolHost.endNudgeSeries(true)
      }
      if (holdsSpace(k)) return 'held'
      // A modifier reaches the recogniser's key state, so a live rotate re-steps with the mouse still (spec §2.2, A8).
      if (MODIFIER_KEYS.has(k.key)) session.keyState({ space: session.spaceHeld(), mods: k.mods })
      return verdict()
    },
    holdsSelectionDeletes: () => session.pointerSessionLive() || toolHost.holdsReorigin(),
  }
}

/**
 * The runtime surfaces' keyboard port (spec §1.2a): the surfaces exist before runtime.init creates the interaction session,
 * so this port reaches the live session's port once there is one and consumes nothing before or after. Its host is the
 * live port's, or else the map host the composition holds.
 */
export function createForwardingCanvasKeyboardPort(
  current: () => CanvasKeyboardPort | null,
  host: HTMLElement,
): CanvasKeyboardPort {
  return {
    get host() {
      return current()?.host ?? host
    },
    escapeLayers: () => current()?.escapeLayers() ?? [],
    escape: (layer) => current()?.escape(layer),
    command: (c) => current()?.command(c) ?? false,
    keyState: (state) => current()?.keyState(state) ?? 'pass',
    holdsSelectionDeletes: () => current()?.holdsSelectionDeletes() ?? false,
  }
}
