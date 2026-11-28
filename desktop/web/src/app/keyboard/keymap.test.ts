// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keyLike, TEST_KEY_PLATFORM } from '../../__tests__/support/key-router'
import { DESKTOP_KEYMAP } from '../../commands/graph/shortcuts'
import { createBrowserShellCatalog } from '../../editions/web/browser-shell-commands'
import { canvasCommandDefinitions } from '../canvas-commands'
import type { CanvasKeyCommand } from '../../canvas/runtime/runtime'
import { composeShellCommandCatalog } from '../shell-commands'
import { chordMatches, chordOf, chordsOfShortcut, type KeyboardEventLike } from './key-chord'
import { installKeyRouter, type KeyRouterHandle } from './key-router'
import { CANVAS_KEYMAP_ROWS, shellKeymapRows, type KeymapRow } from './keymap'

/** The rows a press names, in keymap order. */
function rowsFor(rows: readonly KeymapRow[], press: KeyboardEventLike): readonly KeymapRow[] {
  const chord = chordOf(press, TEST_KEY_PLATFORM)
  return chord ? rows.filter((row) => row.chords.some((rowChord) => chordMatches(rowChord, chord))) : []
}

/** The catalogue command a press names among the canvas rows: a command row's, else a key row's fallback. */
function canvasCommandFor(press: KeyboardEventLike): string | null {
  const rows = rowsFor(CANVAS_KEYMAP_ROWS, press)
  const row = rows.find((candidate) => !candidate.canvas) ?? rows.find((candidate) => candidate.fallback)
  return row ? (row.canvas ? row.fallback! : row.command) : null
}

function webKeymap(): readonly KeymapRow[] {
  const catalog = createBrowserShellCatalog({
    newDesign: vi.fn(), openCanopi: vi.fn(), downloadCanopi: vi.fn(), revertDesign: vi.fn(),
    importGeoJson: vi.fn(), exportGeoJson: vi.fn(), exportBudgetCsv: vi.fn(), closeDesign: vi.fn(), navigate: vi.fn(),
  }, { canvasReady: () => true })
  // Without the shortcuts a browser keeps, which the Web omits: a superset of its keymap.
  return [...shellKeymapRows(catalog), ...CANVAS_KEYMAP_ROWS]
}

let router: KeyRouterHandle | null = null

afterEach(() => {
  router?.dispose()
  router = null
  document.body.replaceChildren()
})

describe('keymap', () => {
  it('single keys follow the switch', () => {
    const singleKey = (press: KeyboardEventLike) => rowsFor(CANVAS_KEYMAP_ROWS, press).map((row) => row.singleKey)

    expect(singleKey(keyLike('v'))).toEqual(['follows-switch'])
    expect(singleKey(keyLike('n'))).toEqual(['follows-switch'])
    expect(singleKey(keyLike('G', { shiftKey: true }))).toEqual(['follows-switch'])
    expect(singleKey(keyLike('F', { shiftKey: true }))).toEqual(['follows-switch'])
    // A held stamp's turn follows it too, and still runs on the focused map with it off (the router's rule).
    expect(singleKey(keyLike(']'))).toEqual(['follows-switch'])
    expect(singleKey(keyLike('z', { ctrlKey: true }))).toEqual(['n/a'])
    expect(singleKey(keyLike('0', { ctrlKey: true }))).toEqual(['n/a'])
    expect(singleKey(keyLike('Delete'))).toEqual(['n/a', 'n/a'])
    expect(singleKey(keyLike('ArrowLeft'))).toEqual(['n/a'])
    expect(singleKey(keyLike('Enter'))).toEqual(['n/a'])
  })

  it('command rows run outside text fields and dialogs', () => {
    const run = vi.fn(() => true)
    let modal = false
    router = installKeyRouter({
      target: window,
      keymap: CANVAS_KEYMAP_ROWS,
      commands: { run },
      canvas: () => null,
      singleKeys: signal(true),
      focus: { cycleRegion: () => false },
      isModalOpen: () => modal,
      platform: TEST_KEY_PLATFORM,
      document,
    })
    const press = (target: EventTarget) => {
      const event = new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    const button = document.createElement('button')
    const list = document.createElement('div')
    const field = document.createElement('input')
    const area = document.createElement('textarea')
    document.body.append(button, list, field, area)

    expect([press(window), press(button), press(list)]).toEqual([true, true, true])
    expect(run).toHaveBeenCalledTimes(3)
    expect(run).toHaveBeenCalledWith('canvas.tool.select')
    expect([press(field), press(area)]).toEqual([false, false])
    modal = true
    expect(press(button)).toBe(false)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('shell shortcuts run from text fields and controls too; canvas rows stay out of text fields', () => {
    const ran: string[] = []
    router = installKeyRouter({
      target: window,
      keymap: DESKTOP_KEYMAP,
      commands: { run: (command) => { ran.push(command); return true } },
      canvas: () => null,
      singleKeys: signal(true),
      focus: { cycleRegion: () => false },
      isModalOpen: () => false,
      platform: TEST_KEY_PLATFORM,
      document,
    })
    const search = document.createElement('input')
    const slider = Object.assign(document.createElement('input'), { type: 'range' })
    const notes = document.createElement('textarea')
    document.body.append(search, slider, notes)
    const press = (target: HTMLElement, init: KeyboardEventInit) => {
      target.focus()
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }

    expect(press(search, { key: 'P', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(press(slider, { key: '4', code: 'Digit4', ctrlKey: true })).toBe(true)
    expect(press(search, { key: 'o', ctrlKey: true })).toBe(true)
    expect(press(notes, { key: 'n', ctrlKey: true })).toBe(true)
    expect(press(search, { key: ',', ctrlKey: true })).toBe(true)
    expect(press(search, { key: 'F2' })).toBe(true)
    expect(press(search, { key: 's', ctrlKey: true })).toBe(true)
    expect(ran).toEqual(['help.commandPalette', 'nav.plantDb', 'file.open', 'file.new', 'app.settings', 'file.rename', 'file.save'])

    // A text field keeps its letters, its undo and its arrows.
    ran.length = 0
    expect([
      press(search, { key: 'v' }),
      press(notes, { key: 'z', ctrlKey: true }),
      press(search, { key: 'ArrowLeft' }),
    ]).toEqual([false, false, false])
    expect(ran).toEqual([])
  })

  it('each platform\'s keymap has one row per chord', () => {
    for (const keymap of [DESKTOP_KEYMAP, webKeymap()]) {
      const seen = new Map<string, string>()
      const duplicates: string[] = []
      for (const row of keymap) {
        for (const chord of row.chords) {
          const id = `${row.scope} ${JSON.stringify(chord)}`
          const other = seen.get(id)
          if (other) duplicates.push(`${id}: ${other} and ${row.command}`)
          seen.set(id, row.command)
        }
      }
      expect(duplicates).toEqual([])
    }
    expect(rowsFor(shellKeymapRows([], { omit: new Set(['Ctrl+1']) }), keyLike('1', { ctrlKey: true }))).toEqual([])
    expect(rowsFor(DESKTOP_KEYMAP, keyLike('1', { ctrlKey: true })).map((row) => row.command)).toEqual(['nav.layers'])
  })

  it('no catalogue row has an arrow chord', () => {
    // The routed rotation chords are canvas key rows; a catalogue definition only shows them (keyHints).
    const arrowChords = canvasCommandDefinitions.flatMap((definition) => (definition.shortcuts ?? [])
      .filter((shortcut) => /Arrow/.test(shortcut)).map((shortcut) => `${definition.commandId} ${shortcut}`))
    expect(arrowChords).toEqual([])
    const catalogueRows = CANVAS_KEYMAP_ROWS.filter((row) => !row.canvas && !row.keepsFromBrowser)
    expect(catalogueRows.flatMap((row) => row.chords).filter((chord) => chord.key.startsWith('Arrow'))).toEqual([])
    expect(canvasCommandDefinitions.find((definition) => definition.commandId === 'view.turnViewLeft')?.keyHints)
      .toEqual(['Shift+ArrowLeft'])
  })

  it('canvas rows come from definition.shortcuts through the switch, never from keyHints; no row has Escape', () => {
    for (const definition of canvasCommandDefinitions) {
      for (const shortcut of definition.shortcuts ?? []) {
        const named = CANVAS_KEYMAP_ROWS.some((row) =>
          (row.command === definition.commandId || row.fallback === definition.commandId)
          && chordsOfShortcut(shortcut).every((chord) => row.chords.some((rowChord) => chordMatches(rowChord, chord))))
        expect(named, `${definition.commandId} ${shortcut}`).toBe(true)
      }
    }
    expect(CANVAS_KEYMAP_ROWS.flatMap((row) => row.chords).some((chord) => chord.key === 'Escape')).toBe(false)
    expect(CANVAS_KEYMAP_ROWS.some((row) => row.command === 'canvas.clearSelection')).toBe(false)

    expect(canvasCommandFor(keyLike('z'))).toBe('canvas.tool.polygon')
    expect(canvasCommandFor(keyLike('z', { ctrlKey: true }))).toBe('edit.undo')
    expect(canvasCommandFor(keyLike('Z', { ctrlKey: true, shiftKey: true }))).toBe('edit.redo')
    expect(canvasCommandFor(keyLike('y', { ctrlKey: true }))).toBe('edit.redo')
    expect(canvasCommandFor(keyLike('z', { ctrlKey: true, metaKey: true }))).toBeNull()
    expect(canvasCommandFor(keyLike('z', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(canvasCommandFor(keyLike('G', { shiftKey: true }))).toBe('canvas.toggleGrid')
    expect(canvasCommandFor(keyLike('g', { ctrlKey: true }))).toBe('canvas.groupSelected')
    expect(canvasCommandFor(keyLike('G', { ctrlKey: true, shiftKey: true }))).toBe('canvas.ungroupSelected')
    expect(canvasCommandFor(keyLike('F', { shiftKey: true }))).toBe('view.fitToDesign')
    expect(canvasCommandFor(keyLike('0', { ctrlKey: true }))).toBe('view.fitToDesign')
    expect(canvasCommandFor(keyLike('=', { ctrlKey: true }))).toBe('view.zoomIn')
    expect(canvasCommandFor(keyLike('+', { ctrlKey: true, shiftKey: true }))).toBe('view.zoomIn')
    expect(canvasCommandFor(keyLike('-', { ctrlKey: true }))).toBe('view.zoomOut')
    expect(canvasCommandFor(keyLike('k', { ctrlKey: true }))).toBe('view.searchPlace')
    expect(canvasCommandFor(keyLike('f', { ctrlKey: true }))).toBeNull()
    expect(canvasCommandFor(keyLike('A', { ctrlKey: true, shiftKey: true }))).toBe('canvas.selectSameSpecies')
    expect(canvasCommandFor(keyLike('Backspace'))).toBe('canvas.deleteSelected')
    expect(canvasCommandFor(keyLike('E', { shiftKey: true }))).toBeNull()
    expect(canvasCommandFor(keyLike('r', { ctrlKey: true, altKey: true, code: 'KeyR' }))).toBe('canvas.rotateSelected')
    expect(canvasCommandFor(keyLike('r', { ctrlKey: true }))).toBeNull()
    expect(canvasCommandFor(keyLike(']'))).toBe('canvas.bringToFront')
    expect(canvasCommandFor(keyLike('['))).toBe('canvas.sendToBack')
    expect(canvasCommandFor(keyLike('Escape'))).toBeNull()
  })

  it('mod+←/→ away from the map runs nothing and is only kept from the browser', () => {
    const kept = CANVAS_KEYMAP_ROWS.filter((row) => row.keepsFromBrowser)
    expect(kept.map((row) => [row.scope, row.canvas, row.chords])).toEqual([[
      'command',
      undefined,
      [{ key: 'ArrowLeft', mod: true, ctrl: false, shift: false, alt: false },
        { key: 'ArrowRight', mod: true, ctrl: false, shift: false, alt: false }],
    ]])
  })

  it('N follows the switch', () => {
    expect(rowsFor(CANVAS_KEYMAP_ROWS, keyLike('n')).map((row) => [row.command, row.scope, row.singleKey]))
      .toEqual([['view.resetNorth', 'command', 'follows-switch']])
    expect(rowsFor(CANVAS_KEYMAP_ROWS, keyLike('L', { shiftKey: true })).map((row) => [row.command, row.singleKey]))
      .toEqual([['view.cycleLabels', 'follows-switch']])
  })

  it('the Shift+N row is always on', () => {
    const rows = rowsFor(CANVAS_KEYMAP_ROWS, keyLike('N', { shiftKey: true }))
    expect(rows.map((row) => [row.command, row.scope, row.singleKey])).toEqual([['canvas.reset-north', 'command', 'always-on']])
    expect(rows[0]!.canvas).toEqual({ kind: 'reset-north' })
  })

  it('Shift+arrows do nothing inside a listbox or slider', () => {
    const command = vi.fn((_c: CanvasKeyCommand) => true)
    const host = document.createElement('div')
    host.tabIndex = 0
    router = installKeyRouter({
      target: window,
      keymap: CANVAS_KEYMAP_ROWS,
      commands: { run: vi.fn(() => true) },
      canvas: () => ({
        host, keyState: () => 'pass', command, escapeLayers: () => [], escape: () => {}, holdsSelectionDeletes: () => false,
      }),
      singleKeys: signal(true),
      focus: { cycleRegion: () => false },
      isModalOpen: () => false,
      platform: TEST_KEY_PLATFORM,
      document,
    })
    const listbox = document.createElement('div')
    listbox.setAttribute('role', 'listbox')
    listbox.tabIndex = 0
    const option = document.createElement('div')
    option.setAttribute('role', 'option')
    option.tabIndex = -1
    listbox.append(option)
    const slider = document.createElement('div')
    slider.setAttribute('role', 'slider')
    slider.tabIndex = 0
    document.body.append(host, listbox, slider)
    const shiftArrows = (target: HTMLElement) => ['ArrowLeft', 'ArrowRight', 'ArrowUp'].map((key) => {
      target.focus()
      const event = new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    })

    expect([...shiftArrows(listbox), ...shiftArrows(option), ...shiftArrows(slider)].every((taken) => !taken)).toBe(true)
    expect(command).not.toHaveBeenCalled()
    // Outside them the routed rows turn the view and reset north.
    expect(shiftArrows(host)).toEqual([true, true, true])
    expect(command.mock.calls.map(([c]) => c)).toEqual([
      { kind: 'rotate-view', direction: -1 },
      { kind: 'rotate-view', direction: 1 },
      { kind: 'reset-north' },
    ])
  })

  it('Delete with no corner selected deletes the selection as before', () => {
    const run = vi.fn((_command: string) => true)
    // No zone corner is selected: the map refuses its corner deletion.
    const command = vi.fn((_c: CanvasKeyCommand) => false)
    const host = document.createElement('div')
    host.tabIndex = 0
    const rail = document.createElement('button')
    document.body.append(host, rail)
    router = installKeyRouter({
      target: window,
      keymap: CANVAS_KEYMAP_ROWS,
      commands: { run },
      canvas: () => ({
        host, keyState: () => 'pass', command, escapeLayers: () => [], escape: () => {}, holdsSelectionDeletes: () => false,
      }),
      singleKeys: signal(true),
      focus: { cycleRegion: () => false },
      isModalOpen: () => false,
      platform: TEST_KEY_PLATFORM,
      document,
    })
    const pressDelete = (target: HTMLElement) => {
      target.focus()
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }

    // On the map the corner is asked first, then the selection goes.
    expect(pressDelete(host)).toBe(true)
    expect(command.mock.calls.map(([c]) => c)).toEqual([{ kind: 'delete-handle' }])
    expect(run.mock.calls.map(([c]) => c)).toEqual(['canvas.deleteSelected'])
    // Away from the map Delete deletes the selection without asking.
    expect(pressDelete(rail)).toBe(true)
    expect(command).toHaveBeenCalledOnce()
    expect(run.mock.calls.map(([c]) => c)).toEqual(['canvas.deleteSelected', 'canvas.deleteSelected'])
  })

  /** A router over the canvas rows with a focusable map host and a rail button beside it. */
  function canvasRouter(singleKeys: boolean) {
    const run = vi.fn((_command: string) => true)
    const command = vi.fn((_c: CanvasKeyCommand) => true)
    const host = document.createElement('div')
    host.tabIndex = 0
    const rail = document.createElement('button')
    document.body.append(host, rail)
    router = installKeyRouter({
      target: window,
      keymap: CANVAS_KEYMAP_ROWS,
      commands: { run },
      canvas: () => ({
        host, keyState: () => 'pass', command, escapeLayers: () => [], escape: () => {}, holdsSelectionDeletes: () => false,
      }),
      singleKeys: signal(singleKeys),
      focus: { cycleRegion: () => false },
      isModalOpen: () => false,
      platform: TEST_KEY_PLATFORM,
      document,
    })
    const press = (target: HTMLElement, init: KeyboardEventInit) => {
      target.focus()
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    return { run, command, host, rail, press }
  }

  it('+ and − zoom one step with map focus', () => {
    // They act only while the map has focus, so they stay on with single-key shortcuts off.
    const { command, run, host, rail, press } = canvasRouter(false)

    expect(press(host, { key: '+', code: 'Equal', shiftKey: true })).toBe(true)
    expect(press(host, { key: '=', code: 'Equal' })).toBe(true)
    expect(press(host, { key: '-', code: 'Minus' })).toBe(true)
    expect(press(host, { key: '+', code: 'NumpadAdd' })).toBe(true)
    expect(command.mock.calls.map(([c]) => c)).toEqual([
      { kind: 'zoom-step', direction: 1 },
      { kind: 'zoom-step', direction: 1 },
      { kind: 'zoom-step', direction: -1 },
      { kind: 'zoom-step', direction: 1 },
    ])
    // Away from the map they are left to the page.
    expect(press(rail, { key: '+', code: 'Equal', shiftKey: true })).toBe(false)
    expect(press(rail, { key: '-', code: 'Minus' })).toBe(false)
    expect(command).toHaveBeenCalledTimes(4)
    expect(run).not.toHaveBeenCalled()
    // Ctrl+Plus and Ctrl+Minus stay View › Zoom in and Zoom out.
    expect(rowsFor(CANVAS_KEYMAP_ROWS, keyLike('=', { ctrlKey: true })).map((row) => row.command)).toEqual(['view.zoomIn'])
    expect(rowsFor(CANVAS_KEYMAP_ROWS, keyLike('-', { ctrlKey: true })).map((row) => row.command)).toEqual(['view.zoomOut'])
  })

  it('Shift+2 zooms to the selection', () => {
    expect(rowsFor(CANVAS_KEYMAP_ROWS, keyLike('2', { code: 'Digit2', shiftKey: true })).map((row) => [row.command, row.scope, row.singleKey]))
      .toEqual([['view.zoomToSelection', 'command', 'follows-switch']])
    const { run, rail, press } = canvasRouter(true)
    // From any focus but text, like Shift+G; AZERTY types 2 with Shift.
    expect(press(rail, { key: '2', code: 'Digit2', shiftKey: true })).toBe(true)
    expect(run.mock.calls.map(([c]) => c)).toEqual(['view.zoomToSelection'])
  })

  it('Home fits', () => {
    expect(rowsFor(CANVAS_KEYMAP_ROWS, keyLike('Home')).map((row) => [row.command, row.scope, row.singleKey]))
      .toEqual([['view.fitToDesign', 'canvas-focus', 'n/a']])
    const { run, host, rail, press } = canvasRouter(false)
    expect(press(host, { key: 'Home', code: 'Home' })).toBe(true)
    expect(run.mock.calls.map(([c]) => c)).toEqual(['view.fitToDesign'])
    // Elsewhere Home keeps its own meaning (a list's first item, a field's start).
    expect(press(rail, { key: 'Home', code: 'Home' })).toBe(false)
    expect(run).toHaveBeenCalledOnce()
  })

  it('composes an edition\'s shell rows from its catalogue, F2 after the map, every row working in text fields', () => {
    const execute = () => undefined
    const catalog = composeShellCommandCatalog({
      saveDesignAs: { execute },
      navigateCanvas: { execute },
      navigatePlantDatabase: { execute },
      renameDesign: { execute },
      saveDesign: { execute },
      showShortcuts: { execute },
    })
    const rows = shellKeymapRows(catalog)
    const command = (press: KeyboardEventLike) => rowsFor(rows, press).map((row) => row.command)

    expect(command(keyLike('S', { ctrlKey: true, shiftKey: true }))).toEqual(['file.saveAs'])
    expect(command(keyLike('4', { ctrlKey: true }))).toEqual(['nav.plantDb'])
    expect(command(keyLike('3', { ctrlKey: true }))).toEqual([])
    expect(command(keyLike('4', { ctrlKey: true, altKey: true }))).toEqual([])
    expect(command(keyLike('s', { ctrlKey: true, metaKey: true }))).toEqual([])
    expect(command(keyLike('3'))).toEqual([])
    expect(rows.find((row) => row.command === 'file.rename')?.scope).toBe('command')
    expect(rows.every((row) => row.worksInTextFields)).toBe(true)
    expect(rows.every((row) => !row.worksInModal)).toBe(true)
  })
})
