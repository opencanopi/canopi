// @vitest-environment jsdom
//
// Phase 2 commit 0: 2.1-Q343's shared chords, written before 2a-2 builds them, so each case is expected to fail until
// then (it.fails). Alt+Shift+N, Alt+Shift+W, Alt+Shift+1-9 and the palette on Alt+Shift+P work on both editions;
// Desktop keeps Ctrl+N, Ctrl+W, Ctrl+1-9 and Ctrl+Shift+P as aliases. 2a-2 turns each it.fails into it.

import { signal } from '@preact/signals'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEST_KEY_PLATFORM } from '../../__tests__/support/key-router'
import { DESKTOP_KEYMAP } from '../../commands/graph/shortcuts'
import { createBrowserShellCatalog, installWebKeyRouter } from '../../web/browser-shell-commands'
import { installKeyRouter, type KeyRouterHandle } from './key-router'

let router: KeyRouterHandle | null = null

afterEach(() => {
  router?.dispose()
  router = null
  document.body.replaceChildren()
})

/** A keydown as Chromium on Linux sends it with Alt and Shift held (US layout: Shift turns a digit into its symbol). */
function altShift(letterOrDigit: string): KeyboardEventInit {
  const digit = /^[1-9]$/u.test(letterOrDigit)
  const symbol = '!@#$%^&*('[Number(letterOrDigit) - 1]
  return {
    key: digit ? symbol : letterOrDigit.toUpperCase(),
    code: digit ? `Digit${letterOrDigit}` : `Key${letterOrDigit.toUpperCase()}`,
    altKey: true,
    shiftKey: true,
  }
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(event)
  return event
}

function desktopRouter(ran: string[]): KeyRouterHandle {
  return installKeyRouter({
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
}

describe('2.1-Q343 shared chords', () => {
  it.fails('Q343 (2a-2): on Web, Alt+Shift+N, Alt+Shift+W, Alt+Shift+1-9 and Alt+Shift+P run New, Close, the panels and the palette', () => {
    const capabilities = {
      newDesign: vi.fn(), openCanopi: vi.fn(), downloadCanopi: vi.fn(), revertDesign: vi.fn(),
      importGeoJson: vi.fn(), exportGeoJson: vi.fn(), exportBudgetCsv: vi.fn(), closeDesign: vi.fn(), navigate: vi.fn(),
    }
    const catalog = createBrowserShellCatalog(capabilities, { templatesEnabled: false, canvasReady: () => true })
    router = installWebKeyRouter({
      catalog,
      readState: () => ({ hasDesign: true, revertAvailable: false, activePanel: 'canvas', sidePanel: null }),
    }, TEST_KEY_PLATFORM)

    expect(press(altShift('n')).defaultPrevented, 'Alt+Shift+N is taken').toBe(true)
    expect(capabilities.newDesign).toHaveBeenCalledTimes(1)
    expect(press(altShift('w')).defaultPrevented, 'Alt+Shift+W is taken').toBe(true)
    expect(capabilities.closeDesign).toHaveBeenCalledTimes(1)
    expect(press(altShift('1')).defaultPrevented, 'Alt+Shift+1 is taken').toBe(true)
    expect(capabilities.navigate).toHaveBeenCalledWith('layers')
    expect(press(altShift('p')).defaultPrevented, 'Alt+Shift+P opens the palette').toBe(true)
  })

  it.fails('Q343 (2a-2): on Desktop, the Alt+Shift chords run the same commands and the Ctrl chords stay as aliases', () => {
    const ran: string[] = []
    router = desktopRouter(ran)

    for (const chord of ['n', 'w', '1', '9', 'p']) press(altShift(chord))
    expect(ran, 'the shared Alt+Shift chords').toEqual(['file.new', 'file.close', 'nav.layers', 'nav.designNotebook', 'help.commandPalette'])

    ran.length = 0
    press({ key: 'n', code: 'KeyN', ctrlKey: true })
    press({ key: 'w', code: 'KeyW', ctrlKey: true })
    press({ key: '1', code: 'Digit1', ctrlKey: true })
    press({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
    expect(ran, 'the Desktop aliases').toEqual(['file.new', 'file.close', 'nav.layers', 'help.commandPalette'])
  })
})
