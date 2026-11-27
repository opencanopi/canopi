// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GestureOutcome, ToolHost } from './interaction-ports'
import type { ToolId } from './interaction-types'
import { TOOL_ROWS } from '../../app/command-table'
import {
  createCanvasKeyboardPort,
  createForwardingCanvasKeyboardPort,
} from './keyboard-port'
import type { CanvasKeyState } from './runtime'
import type { ToolCommand, ToolReply } from './tools/tool'

/** What the port needs from the interaction session. */
type KeySession = Parameters<typeof createCanvasKeyboardPort>[0]['session']

let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  host.tabIndex = 0
  document.body.appendChild(host)
})

afterEach(() => {
  host.remove()
  document.body.innerHTML = ''
})

interface Fixture {
  readonly tool: ReturnType<typeof signal<ToolId>>
  readonly toolHost: {
    nudge: ReturnType<typeof vi.fn>
    command: ReturnType<typeof vi.fn>
    menuAt: ReturnType<typeof vi.fn>
    endNudgeSeries: ReturnType<typeof vi.fn>
    interrupted: ReturnType<typeof vi.fn>
  }
  readonly session: KeySession & { -readonly [K in keyof KeySession]: KeySession[K] }
  readonly navigation: { panByPx: ReturnType<typeof vi.fn>; zoomIn: ReturnType<typeof vi.fn>; zoomOut: ReturnType<typeof vi.fn>; resetNorth: ReturnType<typeof vi.fn>; rotateBy: ReturnType<typeof vi.fn> }
  selected: boolean
  nudging: boolean
  live: boolean
  space: boolean
  transient: boolean
  /** A tool transient that is no Esc layer (Place plants' waiting point): it holds re-origin only. */
  waiting: boolean
  port: ReturnType<typeof createCanvasKeyboardPort>
}

function fixture(options: { readonly tool?: ToolId; readonly reply?: (c: ToolCommand) => ToolReply } = {}): Fixture {
  const tool = signal<ToolId>(options.tool ?? 'select')
  const state = { selected: false, nudging: false, live: false, space: false, transient: false, waiting: false }
  const toolHost = {
    nudge: vi.fn((): 'handled' | 'refused' | 'pass' => 'pass'),
    command: vi.fn(options.reply ?? ((): ToolReply => 'pass')),
    menuAt: vi.fn((): GestureOutcome => ({})),
    endNudgeSeries: vi.fn(() => {
      state.nudging = false
    }),
    interrupted: vi.fn(),
  }
  const hostFake = {
    ...toolHost,
    hasNudgeSeries: () => state.nudging,
    activeToolIsSelect: () => tool.peek() === 'select',
    activeToolHasEscapeTransient: () => state.transient,
    activeToolEscSteps: () => TOOL_ROWS[tool.peek()].escSteps,
    holdsReorigin: () => state.transient || state.waiting,
    textEntryOpen: () => false,
  } as unknown as ToolHost
  const session = {
    pointerSessionLive: () => state.live,
    overview: vi.fn(() => false),
    handleFocused: () => false,
    spaceHeld: () => state.space,
    keyState: vi.fn((next: { readonly space: boolean }) => {
      state.space = next.space
    }),
    escapeGesture: vi.fn(),
    escapeTool: vi.fn(() => {
      tool.value = 'select'
    }),
    clearSelection: vi.fn(() => {
      state.selected = false
    }),
  }
  const navigation = { panByPx: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), resetNorth: vi.fn(), rotateBy: vi.fn() }
  const result = {
    tool,
    toolHost,
    session,
    navigation,
    get selected() { return state.selected },
    set selected(value: boolean) { state.selected = value },
    get nudging() { return state.nudging },
    set nudging(value: boolean) { state.nudging = value },
    get live() { return state.live },
    set live(value: boolean) { state.live = value },
    get space() { return state.space },
    set space(value: boolean) { state.space = value },
    get transient() { return state.transient },
    set transient(value: boolean) { state.transient = value },
    get waiting() { return state.waiting },
    set waiting(value: boolean) { state.waiting = value },
    port: undefined as unknown as ReturnType<typeof createCanvasKeyboardPort>,
  }
  result.port = createCanvasKeyboardPort({
    host,
    toolHost: hostFake,
    hasSelection: () => state.selected,
    navigation,
    session,
  })
  return result as unknown as Fixture
}

const NO_MODS = { shift: false, ctrl: false, alt: false, meta: false }

/** A key as the router reports it: from the map unless the test says otherwise. */
function keyState(
  port: Fixture['port'],
  init: Partial<Omit<CanvasKeyState, 'mods'>> & { readonly mods?: Partial<CanvasKeyState['mods']> },
): ReturnType<Fixture['port']['keyState']> {
  return port.keyState({
    type: 'keydown',
    key: '',
    code: '',
    text: false,
    onCanvas: true,
    ...init,
    mods: { ...NO_MODS, ...init.mods },
  })
}

describe('createCanvasKeyboardPort', () => {
  it('an arrow asks the host to nudge, and a handled or refused nudge takes the key', () => {
    const f = fixture()
    f.selected = true
    f.toolHost.nudge.mockReturnValueOnce('handled').mockReturnValueOnce('refused')

    expect(f.port.command({ kind: 'arrow', dir: 'right', large: false })).toBe(true)
    expect(f.port.command({ kind: 'arrow', dir: 'up', large: true })).toBe(true)

    expect(f.toolHost.nudge.mock.calls).toEqual([[{ x: 1, y: 0 }, false], [{ x: 0, y: -1 }, true]])
    expect(f.navigation.panByPx).not.toHaveBeenCalled()
  })

  it('on a pass the arrow pans 64 px, 256 px large, with nothing selected, and is let through otherwise', () => {
    const f = fixture({ tool: 'polygon' })

    expect(f.port.command({ kind: 'arrow', dir: 'right', large: false })).toBe(true)
    expect(f.port.command({ kind: 'arrow', dir: 'down', large: true })).toBe(true)
    expect(f.navigation.panByPx.mock.calls).toEqual([[{ x: -64, y: 0 }], [{ x: 0, y: -256 }]])

    f.selected = true
    expect(f.port.command({ kind: 'arrow', dir: 'left', large: false })).toBe(false)
    expect(f.navigation.panByPx).toHaveBeenCalledTimes(2)
  })

  it('an arrow waits for a live pointer session', () => {
    const f = fixture()
    f.live = true
    expect(f.port.command({ kind: 'arrow', dir: 'right', large: false })).toBe(false)
    expect(f.toolHost.nudge).not.toHaveBeenCalled()
    expect(f.navigation.panByPx).not.toHaveBeenCalled()
  })

  it('mod+arrow on the focused map is always consumed', () => {
    // Even when nothing moves: Web Mac Cmd+← would go Back (A18).
    const f = fixture({ tool: 'polygon' })
    f.selected = true
    expect(f.port.command({ kind: 'arrow', dir: 'left', large: true })).toBe(true)
    f.live = true
    expect(f.port.command({ kind: 'arrow', dir: 'left', large: true })).toBe(true)
    expect(f.toolHost.nudge).toHaveBeenCalledOnce()
    expect(f.navigation.panByPx).not.toHaveBeenCalled()
    // The plain arrow still leaves the key to the page.
    expect(f.port.command({ kind: 'arrow', dir: 'left', large: false })).toBe(false)
    f.live = false
    expect(f.port.command({ kind: 'arrow', dir: 'left', large: false })).toBe(false)
  })

  it('another key commits the nudge series; arrows, modifiers and Esc keep it, and its Esc layer aborts it', () => {
    const f = fixture()
    f.selected = true
    f.nudging = true
    keyState(f.port, { key: 'Shift', mods: { shift: true } })
    keyState(f.port, { key: 'ArrowLeft' })
    keyState(f.port, { key: 'Escape' })
    expect(f.toolHost.endNudgeSeries).not.toHaveBeenCalled()
    keyState(f.port, { key: 'z', mods: { ctrl: true } })
    expect(f.toolHost.endNudgeSeries).toHaveBeenLastCalledWith(true)

    f.nudging = true
    expect(f.port.escapeLayers()[0]).toBe('nudge-series')
    f.port.escape('nudge-series')
    expect(f.toolHost.endNudgeSeries).toHaveBeenLastCalledWith(false)
    expect(f.session.clearSelection).not.toHaveBeenCalled()
  })

  it('[ and ] turn a held stamp only on a handled reply, and never in overview', () => {
    const f = fixture({ tool: 'object-stamp', reply: (c) => c.kind === 'rotate-held' ? 'handled' : 'pass' })
    expect(f.port.command({ kind: 'rotate-held', stepDeg: 15 })).toBe(true)
    expect(f.toolHost.command).toHaveBeenLastCalledWith({ kind: 'rotate-held', stepDeg: 15 })
    expect(f.port.command({ kind: 'rotate-held', stepDeg: -15 })).toBe(true)
    expect(f.toolHost.command).toHaveBeenLastCalledWith({ kind: 'rotate-held', stepDeg: -15 })
    f.session.overview = vi.fn(() => true)
    expect(f.port.command({ kind: 'rotate-held', stepDeg: 15 })).toBe(false)
    expect(f.toolHost.command).toHaveBeenCalledTimes(2)

    const refused = fixture({ tool: 'object-stamp' })
    expect(refused.port.command({ kind: 'rotate-held', stepDeg: 15 })).toBe(false)
  })

  it('Esc layers run by priority from TOOL_ROWS.escSteps: gesture, tool-transient, tool on drawing tools; nudge-series and selection on Select', () => {
    const f = fixture({ tool: 'polygon', reply: (c) => c.kind === 'escape' ? 'handled' : 'pass' })
    f.selected = true
    f.live = true
    f.nudging = true
    f.transient = true

    expect(f.port.escapeLayers()).toEqual(['gesture', 'tool-transient', 'tool'])
    f.port.escape('gesture')
    expect(f.session.escapeGesture).toHaveBeenCalledTimes(1)
    f.port.escape('tool-transient')
    expect(f.toolHost.command).toHaveBeenLastCalledWith({ kind: 'escape' })
    f.port.escape('tool')
    expect(f.session.escapeTool).toHaveBeenCalledTimes(1)
    f.live = false
    f.transient = false
    expect(f.port.escapeLayers()).toEqual(['nudge-series', 'selection'])
    f.port.escape('nudge-series')
    expect(f.toolHost.endNudgeSeries).toHaveBeenLastCalledWith(false)
    expect(f.port.escapeLayers()).toEqual(['selection'])
    f.port.escape('selection')
    expect(f.session.clearSelection).toHaveBeenCalledTimes(1)
    expect(f.port.escapeLayers()).toEqual([])
  })

  it('the tool\'s own Esc is a layer only while it holds a draft or a source; any other tool leaves for Select', () => {
    const f = fixture({ tool: 'plant-stamp', reply: () => 'handled' })
    expect(f.port.escapeLayers()).toEqual(['tool'])
    f.port.escape('tool')
    expect(f.session.escapeTool).toHaveBeenCalledTimes(1)
    expect(f.toolHost.command).not.toHaveBeenCalled()
  })

  it('Plant a row: Esc mid-drag cancels the drag and keeps the source', () => {
    const f = fixture({ tool: 'plant-spacing', reply: (c) => c.kind === 'escape' ? 'handled' : 'pass' })
    f.transient = true
    f.live = true

    expect(f.port.escapeLayers()[0]).toBe('gesture')
    f.port.escape('gesture')
    expect(f.session.escapeGesture).toHaveBeenCalledTimes(1)
    expect(f.toolHost.command).not.toHaveBeenCalled()
    // The next Esc drops the source.
    f.live = false
    expect(f.port.escapeLayers()[0]).toBe('tool-transient')
    f.port.escape('tool-transient')
    expect(f.toolHost.command).toHaveBeenCalledExactlyOnceWith({ kind: 'escape' })
  })

  it('Space holds for panning once, from the map or nothing focused, and keyup releases it', () => {
    const f = fixture()
    expect(keyState(f.port, { key: ' ', code: 'Space' })).toBe('held')
    expect(keyState(f.port, { key: ' ', code: 'Space' })).toBe('pass')
    expect(f.session.keyState).toHaveBeenCalledTimes(1)
    expect(f.session.keyState).toHaveBeenLastCalledWith({ space: true, mods: NO_MODS })

    keyState(f.port, { type: 'keyup', key: ' ', code: 'Space' })
    expect(f.space).toBe(false)
    expect(keyState(f.port, { key: ' ', code: 'Space', text: true })).toBe('pass')
    // A control or another focused widget keeps its Space.
    expect(keyState(f.port, { key: ' ', code: 'Space', onCanvas: false })).toBe('pass')
    expect(f.session.keyState).toHaveBeenCalledTimes(2)
    // A live pointer session holds Space from outside the map too, never from a text field.
    f.live = true
    expect(keyState(f.port, { key: ' ', code: 'Space', text: true, onCanvas: false })).toBe('pass-live')
    expect(keyState(f.port, { key: ' ', code: 'Space', onCanvas: false })).toBe('held')
  })

  it('answers pass-live while a pointer session is live', () => {
    const f = fixture()
    expect(keyState(f.port, { key: 'a' })).toBe('pass')
    f.live = true
    expect(keyState(f.port, { key: 'a' })).toBe('pass-live')
    expect(keyState(f.port, { type: 'keyup', key: 'a' })).toBe('pass-live')
  })

  it('holds the selection\'s deletes while a pointer session or a tool transient lives, Place plants\' waiting point included (canopi-f47t.21)', () => {
    const f = fixture({ tool: 'polygon' })
    expect(f.port.holdsSelectionDeletes()).toBe(false)
    f.transient = true
    expect(f.port.holdsSelectionDeletes()).toBe(true)
    f.transient = false
    // A waiting point is no Esc layer, and still holds them.
    f.waiting = true
    expect(f.port.escapeLayers()).not.toContain('tool-transient')
    expect(f.port.holdsSelectionDeletes()).toBe(true)
    f.waiting = false
    f.live = true
    expect(f.port.holdsSelectionDeletes()).toBe(true)
  })

  it('in overview only a live or interrupted gesture is an Esc layer, and Space still holds', () => {
    const f = fixture({ tool: 'polygon' })
    f.transient = true
    f.session.overview = vi.fn(() => true)
    // Nothing to cancel: no canvas layer, so the Esc falls through to the raster inspection's; a selection is kept (U36).
    expect(f.port.escapeLayers()).toEqual([])
    f.selected = true
    expect(f.port.escapeLayers()).toEqual([])
    f.nudging = true
    expect(f.port.escapeLayers()).toEqual(['gesture'])
    f.nudging = false
    f.live = true
    expect(f.port.escapeLayers()).toEqual(['gesture'])
    f.port.escape('gesture')
    expect(f.session.escapeGesture).toHaveBeenCalledTimes(1)
    expect(f.toolHost.interrupted).toHaveBeenCalledTimes(1)
    expect(f.session.escapeTool).not.toHaveBeenCalled()
    expect(keyState(f.port, { key: ' ', code: 'Space' })).toBe('held')
  })

  it('the Menu key and Shift F10 open the selection\'s menu through the host, never during a pointer session', () => {
    const f = fixture()
    expect(f.port.command({ kind: 'context-menu' })).toBe(true)
    expect(f.toolHost.menuAt).toHaveBeenCalledExactlyOnceWith('selection', 'keyboard')
    f.live = true
    expect(f.port.command({ kind: 'context-menu' })).toBe(false)
    expect(f.toolHost.menuAt).toHaveBeenCalledOnce()
  })

  it('Enter confirms, then edits the selected note under Select; F2 only edits it', () => {
    const f = fixture({ reply: (c) => c.kind === 'edit-text' ? 'handled' : 'pass' })
    expect(f.port.command({ kind: 'confirm' })).toBe(true)
    expect(f.toolHost.command.mock.calls.map(([c]) => c.kind)).toEqual(['confirm', 'edit-text'])
    expect(f.port.command({ kind: 'edit-text' })).toBe(true)
    expect(f.toolHost.command).toHaveBeenLastCalledWith({ kind: 'edit-text' })

    const polygon = fixture({ tool: 'polygon', reply: () => 'pass' })
    expect(polygon.port.command({ kind: 'confirm' })).toBe(false)
    expect(polygon.port.command({ kind: 'edit-text' })).toBe(false)
    expect(polygon.toolHost.command.mock.calls.map(([c]) => c.kind)).toEqual(['confirm'])
  })

  it('Enter and F2 never open the note editor while a pointer session is live; F2 is kept from renaming the Design', () => {
    // A still twist or rotate is live with no events: the editor would take Esc, which then never cancels it.
    const f = fixture({ reply: (c) => c.kind === 'edit-text' ? 'handled' : 'pass' })
    f.live = true
    expect(f.port.command({ kind: 'confirm' })).toBe(false)
    expect(f.port.command({ kind: 'edit-text' })).toBe(true)
    // The tool's own Enter still runs (a Polygon finished with a corner's press held).
    expect(f.toolHost.command.mock.calls.map(([c]) => c.kind)).toEqual(['confirm'])
    f.live = false
    expect(f.port.command({ kind: 'edit-text' })).toBe(true)
    expect(f.toolHost.command).toHaveBeenLastCalledWith({ kind: 'edit-text' })

    const polygon = fixture({ tool: 'polygon', reply: (c) => c.kind === 'confirm' ? 'handled' : 'pass' })
    polygon.live = true
    expect(polygon.port.command({ kind: 'confirm' })).toBe(true)
  })

  it('in overview Enter, Backspace, F2 and the Menu key do nothing', () => {
    const f = fixture({ reply: () => 'handled' })
    f.session.overview = vi.fn(() => true)
    expect(f.port.command({ kind: 'confirm' })).toBe(false)
    expect(f.port.command({ kind: 'remove-last' })).toBe(false)
    expect(f.port.command({ kind: 'edit-text' })).toBe(false)
    expect(f.port.command({ kind: 'context-menu' })).toBe(false)
    expect(f.toolHost.command).not.toHaveBeenCalled()
    expect(f.toolHost.menuAt).not.toHaveBeenCalled()
  })

  it('key commands reach the host and the navigation', () => {
    const f = fixture({ reply: () => 'handled' })
    expect(f.port.command({ kind: 'confirm' })).toBe(true)
    expect(f.port.command({ kind: 'rotate-held', stepDeg: -15 })).toBe(true)
    expect(f.port.command({ kind: 'remove-last' })).toBe(true)
    expect(f.toolHost.command.mock.calls.map(([c]) => c)).toEqual([
      { kind: 'confirm' }, { kind: 'rotate-held', stepDeg: -15 }, { kind: 'remove-last' },
    ])
    f.port.command({ kind: 'zoom-step', direction: 1 })
    f.port.command({ kind: 'zoom-step', direction: -1 })
    f.port.command({ kind: 'rotate-view', direction: -1 })
    f.port.command({ kind: 'reset-north' })
    expect(f.navigation.zoomIn).toHaveBeenCalledTimes(1)
    expect(f.navigation.zoomOut).toHaveBeenCalledTimes(1)
    expect(f.navigation.rotateBy).toHaveBeenCalledWith(-1)
    expect(f.navigation.resetNorth).toHaveBeenCalledTimes(1)
    expect(f.port.command({ kind: 'arrow', dir: 'left', large: false })).toBe(true)
    expect(f.navigation.panByPx).toHaveBeenCalledWith({ x: 64, y: 0 })
  })
})

describe('createForwardingCanvasKeyboardPort', () => {
  it('reaches the live session\'s port once there is one and consumes nothing without it', () => {
    let live: ReturnType<typeof createCanvasKeyboardPort> | null = null
    const port = createForwardingCanvasKeyboardPort(() => live, host)

    expect(port.host).toBe(host)
    expect(port.command({ kind: 'confirm' })).toBe(false)
    expect(port.escapeLayers()).toEqual([])
    port.escape('tool')
    expect(keyState(port as Fixture['port'], { key: ' ', code: 'Space' })).toBe('pass')

    const f = fixture({ tool: 'polygon', reply: () => 'handled' })
    live = f.port
    expect(port.command({ kind: 'confirm' })).toBe(true)
    expect(f.toolHost.command).toHaveBeenCalledWith({ kind: 'confirm' })
    expect(port.escapeLayers()).toEqual(['tool'])
    port.escape('tool')
    expect(f.session.escapeTool).toHaveBeenCalledTimes(1)
    expect(keyState(port as Fixture['port'], { key: ' ', code: 'Space' })).toBe('held')
    expect(f.session.keyState).toHaveBeenCalledTimes(1)

    live = null
    expect(port.command({ kind: 'confirm' })).toBe(false)
  })
})
