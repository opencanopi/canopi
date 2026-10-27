// @vitest-environment jsdom

import { signal, type Signal } from '@preact/signals'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestCanvasDocumentSurface, createTestCanvasRuntimeSurfaces } from '../../__tests__/support/canvas-runtime-surfaces'
import type { CanvasInspectionHandle } from '../../canvas/inspection'
import { setCurrentCanvasSession } from '../../canvas/session'
import { InspectionLens } from '../../components/canvas/InspectionLens'
import type { CanvasEscapeLayer, CanvasKeyboardPort, CanvasKeyCommand, CanvasKeyState, CanvasKeyVerdict } from '../../canvas/runtime/runtime'
import { afterPrimaryPress, lastInputWasKey } from './input-modality'
import { installKeyRouter, type KeyRouterDeps, type KeyRouterHandle } from './key-router'
import { CANVAS_KEYMAP_ROWS, pushKeyScope, type KeymapRow } from './keymap'

/** A canvas port whose answers each test sets. */
function fakePort(host: HTMLElement) {
  const state = {
    verdict: 'pass' as CanvasKeyVerdict,
    layers: [] as CanvasEscapeLayer[],
    command: (_c: CanvasKeyCommand): boolean => true,
    /** A pointer session or a tool transient holds the selection's deletes. */
    holdsDeletes: false,
  }
  const port = {
    host,
    keyState: vi.fn((_k: CanvasKeyState): CanvasKeyVerdict => state.verdict),
    command: vi.fn((c: CanvasKeyCommand) => state.command(c)),
    escapeLayers: vi.fn(() => state.layers),
    escape: vi.fn((_layer: CanvasEscapeLayer) => {}),
    holdsSelectionDeletes: () => state.holdsDeletes,
  } satisfies CanvasKeyboardPort
  return { port, state }
}

const F2_RENAME_ROW: KeymapRow = { command: 'file.rename', chords: [{ key: 'F2', mod: false, ctrl: false, shift: false, alt: false }], scope: 'command', singleKey: 'n/a' }

let host: HTMLDivElement
let router: KeyRouterHandle | null
let modal: boolean
let singleKeys: Signal<boolean>
let run: ReturnType<typeof vi.fn<(command: string) => boolean>>
let cycleRegion: ReturnType<typeof vi.fn<(step: 1 | -1) => boolean>>
let fake: ReturnType<typeof fakePort>

function install(overrides: Partial<KeyRouterDeps> = {}): KeyRouterHandle {
  router = installKeyRouter({
    target: window,
    keymap: [F2_RENAME_ROW, ...CANVAS_KEYMAP_ROWS],
    commands: { run },
    canvas: () => fake.port,
    singleKeys,
    focus: { cycleRegion },
    isModalOpen: () => modal,
    platform: { os: 'linux', gestureEvents: false },
    document,
    ...overrides,
  })
  return router
}

function press(init: KeyboardEventInit, target: EventTarget = document.activeElement ?? window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  host = document.createElement('div')
  host.tabIndex = 0
  document.body.append(host)
  router = null
  modal = false
  singleKeys = signal(true)
  run = vi.fn(() => true)
  cycleRegion = vi.fn(() => true)
  fake = fakePort(host)
})

afterEach(() => {
  router?.dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('key router', () => {
  it('installs window capture and bubble keydown listeners and a capture keyup listener, and removes them', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const documentAdd = vi.spyOn(document, 'addEventListener')
    const documentRemove = vi.spyOn(document, 'removeEventListener')
    const capture = (options: unknown) => options === true
    const handle = install()

    const added = add.mock.calls.map(([type, listener, options]) => [type, listener, capture(options)])
    expect(added.map(([type, , isCapture]) => [type, isCapture])).toEqual([
      ['keydown', true],
      ['keydown', false],
      ['keyup', true],
      // The held keys go on a blur, as on a visibility change.
      ['blur', false],
    ])
    // The held keys go when the page hides; a press or a focus move records whether it landed on the map, and a press
    // from pointerdown to pointerup or pointercancel is the held primary press.
    expect(documentAdd.mock.calls.map(([type, , options]) => [type, capture(options)])).toEqual([
      ['visibilitychange', false],
      ['pointerdown', true],
      ['pointerup', true],
      ['pointercancel', true],
      ['focusin', true],
    ])
    handle.dispose()
    handle.dispose()
    expect(remove.mock.calls.map(([type, listener, options]) => [type, listener, capture(options)])).toEqual(added)
    expect(documentRemove.mock.calls.map(([type, listener, options]) => [type, listener, capture(options)]))
      .toEqual(documentAdd.mock.calls.map(([type, listener, options]) => [type, listener, capture(options)]))
  })

  it('keyState runs first for every key, and a held Space stops the key there', () => {
    install()
    host.focus()
    const field = document.createElement('input')
    document.body.append(field)
    // An element handler that takes the key still comes after keyState.
    field.addEventListener('keydown', (event) => event.preventDefault())

    press({ key: 'a', code: 'KeyA' }, field)
    press({ key: 'Escape', code: 'Escape' }, host)
    const up = new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true })
    host.dispatchEvent(up)
    expect(fake.port.keyState.mock.calls.map(([k]) => [k.type, k.key, k.text, k.onCanvas])).toEqual([
      ['keydown', 'a', true, false],
      ['keydown', 'Escape', false, true],
      ['keyup', 'a', false, true],
    ])

    fake.state.verdict = 'held'
    const space = press({ key: ' ', code: 'Space' }, host)
    expect(space.defaultPrevented).toBe(true)
    expect(fake.port.command).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('records whether the last input was a key or a pointer press, for a tooltip on keyboard focus (canopi-xpqt)', () => {
    install()
    press({ key: 'ArrowDown' }, document.body)
    expect(lastInputWasKey()).toBe(true)
    host.focus()
    expect(lastInputWasKey(), 'a focus move is no pointer press').toBe(true)
    host.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(lastInputWasKey()).toBe(false)
  })

  it('forgets a key pressed before the window was left, so focus coming back with the window shows no tooltip (canopi-xpqt)', () => {
    install()
    // Alt+Tab: the page hears the Alt before the system takes the window away.
    press({ key: 'Alt', code: 'AltLeft', altKey: true }, document.body)
    expect(lastInputWasKey()).toBe(true)
    window.dispatchEvent(new Event('blur'))
    expect(lastInputWasKey(), 'after a window blur').toBe(false)
    press({ key: 'Tab' }, document.body)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(lastInputWasKey(), 'after the page hides').toBe(false)
  })

  it('with nothing focused, the canvas keys act only when the last press landed on the map', () => {
    install()
    const dock = document.createElement('section')
    const text = document.createElement('p')
    text.textContent = 'Malus domestica'
    dock.append(text)
    document.body.append(dock)
    const pressOn = (target: Element) => target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    const canvasKeys = () => [
      press({ key: 'ArrowDown' }, document.body),
      press({ key: 'Enter' }, document.body),
      press({ key: 'Escape' }, document.body),
      press({ key: 'ContextMenu' }, document.body),
    ].map((event) => event.defaultPrevented)
    fake.state.layers = ['selection']

    // A click on a dock panel's text leaves focus on <body>: the keys are the page's, the selection stays.
    pressOn(text)
    expect(canvasKeys()).toEqual([false, false, false, false])
    expect(fake.port.command).not.toHaveBeenCalled()
    expect(fake.port.escape).not.toHaveBeenCalled()
    // Space still pans with nothing focused (spec §1.6, step 3).
    press({ key: ' ', code: 'Space' }, document.body)
    expect(fake.port.keyState.mock.lastCall?.[0].onCanvas).toBe(true)

    // After a press on the map, the same keys act on the canvas as before.
    pressOn(host)
    expect(canvasKeys()).toEqual([true, true, true, true])
    expect(fake.port.command.mock.calls.map(([c]) => c.kind)).toEqual(['arrow', 'confirm', 'context-menu'])
    expect(fake.port.escape).toHaveBeenCalledExactlyOnceWith('selection')
    press({ key: ' ', code: 'Space' }, document.body)
    expect(fake.port.keyState.mock.lastCall?.[0].onCanvas).toBe(true)
  })

  it('focus leaving the map by keyboard takes <body> off the map, and focus entering it puts <body> back', () => {
    install()
    const dock = document.createElement('section')
    const control = document.createElement('button')
    dock.append(control)
    document.body.append(dock)
    fake.state.layers = ['selection']
    const arrow = () => press({ key: 'ArrowDown' }, document.body).defaultPrevented
    // A press on the map, then F6 or Tab to a dock control that unmounts: focus falls to <body>.
    host.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    host.focus()
    control.focus()
    control.remove()
    expect(document.activeElement).toBe(document.body)
    expect(arrow()).toBe(false)
    expect(press({ key: 'Escape' }, document.body).defaultPrevented).toBe(false)
    expect(fake.port.command).not.toHaveBeenCalled()
    expect(fake.port.escape).not.toHaveBeenCalled()

    // F6 back to the map, then its focused control unmounts: <body> is the map's again, with no press.
    const unlock = document.createElement('button')
    host.append(unlock)
    unlock.focus()
    unlock.remove()
    expect(document.activeElement).toBe(document.body)
    expect(arrow()).toBe(true)
    expect(fake.port.command).toHaveBeenCalledExactlyOnceWith({ kind: 'arrow', dir: 'down', large: false })
  })

  describe('the selection edits run anywhere but a text field and the dock', () => {
    /** The edits of the map's selection, each one's event, and whether the router took it. */
    const edits = (target: EventTarget) => [
      press({ key: 'c', ctrlKey: true }, target),
      press({ key: 'x', ctrlKey: true }, target),
      press({ key: 'a', ctrlKey: true }, target),
      press({ key: 'A', ctrlKey: true, shiftKey: true }, target),
      press({ key: 'd', ctrlKey: true }, target),
      press({ key: 'g', ctrlKey: true }, target),
      press({ key: 'Delete' }, target),
    ].map((event) => event.defaultPrevented)
    const EDITS = [
      'canvas.copy', 'canvas.cut', 'canvas.selectAll', 'canvas.selectSameSpecies', 'canvas.duplicateSelected',
      'canvas.groupSelected', 'canvas.deleteSelected',
    ]

    /** The side-panel dock's root as SidePanelDock and PhoneSheet mark it, with text and a control. */
    function dock() {
      const root = document.createElement('div')
      root.dataset.keyRegion = 'dock'
      const text = document.createElement('p')
      text.textContent = 'Malus domestica'
      const row = document.createElement('button')
      root.append(text, row)
      document.body.append(root)
      return { root, text, row }
    }

    it('after a click on Zoom in or other floating chrome, Delete and Ctrl+C act on the map selection', () => {
      install()
      host.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      const zoomIn = document.createElement('button')
      document.body.append(zoomIn)

      // The click focuses the button (Chromium) or leaves focus on <body> (WebKit): the edits are the map's either way.
      zoomIn.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      expect(edits(zoomIn)).toEqual(EDITS.map(() => true))
      expect(edits(document.body)).toEqual(EDITS.map(() => true))
      expect(run.mock.calls.map(([command]) => command)).toEqual([...EDITS, ...EDITS])
    })

    it('after a press on dock text or a dock control, Ctrl+C and Ctrl+A stay the page\'s; undo works anywhere', () => {
      install()
      const { root, text, row } = dock()

      text.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      expect(edits(document.body)).toEqual(EDITS.map(() => false))
      expect(edits(row)).toEqual(EDITS.map(() => false))
      expect(edits(root)).toEqual(EDITS.map(() => false))
      expect(run).not.toHaveBeenCalled()
      // Undo and redo still run from any focus but a text field, as before phase F.
      expect(press({ key: 'z', ctrlKey: true }, document.body).defaultPrevented).toBe(true)
      expect(press({ key: 'Z', ctrlKey: true, shiftKey: true }, row).defaultPrevented).toBe(true)
      expect(run.mock.calls).toEqual([['edit.undo'], ['edit.redo']])

      // A dock control that Tab reached keeps them too, and a press back on the map hands them back.
      run.mockClear()
      row.dispatchEvent(new Event('focusin', { bubbles: true }))
      expect(press({ key: 'c', ctrlKey: true }, document.body).defaultPrevented).toBe(false)
      host.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      // No zone corner is selected, so the map's Delete falls back to deleting the selection.
      fake.state.command = (c) => c.kind !== 'delete-handle'
      expect(edits(document.body)).toEqual(EDITS.map(() => true))
      expect(run.mock.calls.map(([command]) => command)).toEqual(EDITS)
    })

    it('at startup, with no press yet, Ctrl+A selects the map\'s objects as before phase F', () => {
      install()
      expect(press({ key: 'a', ctrlKey: true }, document.body).defaultPrevented).toBe(true)
      expect(run).toHaveBeenCalledExactlyOnceWith('canvas.selectAll')
    })

    it('a text field keeps every edit, in the dock or out of it', () => {
      install()
      const { root } = dock()
      const inDock = document.createElement('input')
      root.append(inDock)
      const outside = document.createElement('input')
      document.body.append(outside)
      host.dispatchEvent(new Event('pointerdown', { bubbles: true }))

      expect(edits(outside)).toEqual(EDITS.map(() => false))
      expect(edits(inDock)).toEqual(EDITS.map(() => false))
      expect(run).not.toHaveBeenCalled()
    })
  })

  it('runs canvas-focus rows on the map and <body> after a press on the map, never from a control', () => {
    install()
    host.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    const button = document.createElement('button')
    document.body.append(button)

    expect(press({ key: 'ArrowRight' }, host).defaultPrevented).toBe(true)
    expect(press({ key: 'ArrowRight' }, document.body).defaultPrevented).toBe(true)
    expect(press({ key: 'ArrowRight' }, button).defaultPrevented).toBe(false)
    expect(fake.port.command.mock.calls.map(([c]) => c)).toEqual([
      { kind: 'arrow', dir: 'right', large: false },
      { kind: 'arrow', dir: 'right', large: false },
    ])
    // A refused canvas command without a fallback leaves the key to the page.
    fake.state.command = () => false
    expect(press({ key: 'ArrowRight' }, host).defaultPrevented).toBe(false)
  })

  it('a pushed scope takes its key before the keymap, outside text fields', () => {
    install()
    const handle = vi.fn((chord: { key: string; mod: boolean }) => chord.key === 'z' && chord.mod)
    const dispose = pushKeyScope(handle)
    const field = document.createElement('input')
    document.body.append(field)
    try {
      expect(press({ key: 'z', ctrlKey: true }, field).defaultPrevented).toBe(false)
      expect(handle).not.toHaveBeenCalled()
      expect(press({ key: 'z', ctrlKey: true }, host).defaultPrevented).toBe(true)
      expect(run).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
    press({ key: 'z', ctrlKey: true }, host)
    expect(run).toHaveBeenCalledExactlyOnceWith('edit.undo')
  })

  it('the story presenter\'s own handler runs under the modal step and no canvas key reaches the map (I12, I12b)', () => {
    install()
    const root = document.createElement('div')
    const next = document.createElement('button')
    root.append(next)
    document.body.append(root)
    const presenterKeys: string[] = []
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== ' ' && event.key !== 'Escape') return
      presenterKeys.push(event.key)
      event.preventDefault()
    })
    modal = true

    // I12: focus in the presenter.
    next.focus()
    press({ key: 'ArrowRight' }, next)
    press({ key: 'n' }, next)
    expect(presenterKeys).toEqual(['ArrowRight'])
    // I12b: focus on <body>; the presenter hears only keys inside its root.
    press({ key: 'ArrowRight' }, document.body)
    press({ key: ' ', code: 'Space' }, document.body)
    press({ key: 'Escape' }, document.body)
    expect(presenterKeys).toEqual(['ArrowRight'])

    expect(fake.port.command).not.toHaveBeenCalled()
    expect(fake.port.escape).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    // A modal holds the keys: Space is reported off the map, so the map never holds it.
    expect(fake.port.keyState.mock.calls.every(([k]) => !k.onCanvas)).toBe(true)
  })

  it('runs only the rows that work in a modal while one is open', () => {
    const palette: KeymapRow = {
      command: 'help.commandPalette',
      chords: [{ key: 'p', mod: true, ctrl: false, shift: true, alt: false }],
      scope: 'global',
      singleKey: 'n/a',
      worksInModal: true,
    }
    install({ keymap: [palette, ...CANVAS_KEYMAP_ROWS] })
    modal = true
    expect(press({ key: 'z', ctrlKey: true }, host).defaultPrevented).toBe(false)
    expect(press({ key: 'P', ctrlKey: true, shiftKey: true }, host).defaultPrevented).toBe(true)
    expect(run.mock.calls).toEqual([['help.commandPalette']])
  })

  it('a widget that handles its own arrows runs first: Shift+↑ on the scale button opens its menu (H23)', () => {
    install()
    const scale = document.createElement('button')
    let menuOpen = false
    scale.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      menuOpen = true
    })
    document.body.append(scale)
    scale.focus()

    press({ key: 'ArrowUp', shiftKey: true }, scale)

    expect(menuOpen).toBe(true)
    expect(fake.port.command).not.toHaveBeenCalled()
  })

  it('with single keys off a held stamp still turns on the map, and nothing turns from <body> (H24)', () => {
    install()
    singleKeys.value = false
    let held = true
    fake.state.command = (c) => c.kind === 'rotate-held' && held

    expect(press({ key: ']' }, host).defaultPrevented).toBe(true)
    expect(fake.port.command).toHaveBeenLastCalledWith({ kind: 'rotate-held', stepDeg: 15 })
    expect(press({ key: ']' }, document.body).defaultPrevented).toBe(false)
    expect(fake.port.command).toHaveBeenCalledOnce()
    // Nothing held: the switch keeps Bring to front off too.
    held = false
    expect(press({ key: ']' }, host).defaultPrevented).toBe(false)
    expect(run).not.toHaveBeenCalled()

    singleKeys.value = true
    expect(press({ key: ']' }, document.body).defaultPrevented).toBe(true)
    expect(run).toHaveBeenCalledExactlyOnceWith('canvas.bringToFront')
  })

  it('] turns a held stamp while the Change stamp button has focus, and never runs Bring to front (canopi-h90p.67)', () => {
    install()
    fake.state.command = (c) => c.kind === 'rotate-held'
    const change = document.createElement('button')
    change.textContent = 'Change stamp'
    document.body.append(change)
    change.focus()

    expect(press({ key: ']' }, change).defaultPrevented).toBe(true)
    expect(press({ key: '[' }, change).defaultPrevented).toBe(true)
    expect(fake.port.command.mock.calls).toEqual([
      [{ kind: 'rotate-held', stepDeg: 15 }],
      [{ kind: 'rotate-held', stepDeg: -15 }],
    ])
    expect(run).not.toHaveBeenCalled()
  })

  it('arrows during a live drag do nothing (H25)', () => {
    install()
    fake.state.verdict = 'pass-live'
    fake.state.command = (c) => c.kind !== 'arrow'
    const arrow = press({ key: 'ArrowRight' }, host)
    expect(fake.port.command).toHaveBeenCalledExactlyOnceWith({ kind: 'arrow', dir: 'right', large: false })
    expect(arrow.defaultPrevented).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('N resets north with the switch on, and only Shift+N with it off (H14)', () => {
    install()
    host.focus()
    expect(press({ key: 'n' }, host).defaultPrevented).toBe(true)
    expect(run).toHaveBeenCalledExactlyOnceWith('view.resetNorth')
    singleKeys.value = false
    expect(press({ key: 'n' }, host).defaultPrevented).toBe(false)
    expect(run).toHaveBeenCalledOnce()
    expect(fake.port.command).not.toHaveBeenCalled()
    expect(press({ key: 'N', shiftKey: true }, host).defaultPrevented).toBe(true)
    expect(fake.port.command).toHaveBeenCalledExactlyOnceWith({ kind: 'reset-north' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('Shift+L cycles labels and N resets north, never cycling labels (H16)', () => {
    install()
    host.focus()
    press({ key: 'L', shiftKey: true }, host)
    press({ key: 'n' }, host)
    expect(run.mock.calls).toEqual([['view.cycleLabels'], ['view.resetNorth']])
  })

  it('Ctrl+→ is the large step, Shift+→ turns, a Mac Ctrl+→ does nothing (H17)', () => {
    install()
    host.focus()
    expect(press({ key: 'ArrowRight', ctrlKey: true }, host).defaultPrevented).toBe(true)
    expect(fake.port.command).toHaveBeenLastCalledWith({ kind: 'arrow', dir: 'right', large: true })
    expect(press({ key: 'ArrowRight' }, host).defaultPrevented).toBe(true)
    expect(fake.port.command).toHaveBeenLastCalledWith({ kind: 'arrow', dir: 'right', large: false })
    // Shift turns the view instead of taking the large step.
    fake.port.command.mockClear()
    expect(press({ key: 'ArrowRight', shiftKey: true }, host).defaultPrevented).toBe(true)
    expect(fake.port.command).toHaveBeenCalledExactlyOnceWith({ kind: 'rotate-view', direction: 1 })

    router?.dispose()
    install({ platform: { os: 'mac', gestureEvents: false } })
    fake.port.command.mockClear()
    expect(press({ key: 'ArrowRight', metaKey: true }, host).defaultPrevented).toBe(true)
    expect(fake.port.command).toHaveBeenCalledExactlyOnceWith({ kind: 'arrow', dir: 'right', large: true })
    // Mission Control's chord on a Mac.
    expect(press({ key: 'ArrowRight', ctrlKey: true }, host).defaultPrevented).toBe(false)
    expect(fake.port.command).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })

  it('en-US Shift+= types + and zooms one step in on the focused map (H20)', () => {
    install()
    host.focus()
    expect(press({ key: '+', code: 'Equal', shiftKey: true }, host).defaultPrevented).toBe(true)
    expect(fake.port.command).toHaveBeenCalledExactlyOnceWith({ kind: 'zoom-step', direction: 1 })
    expect(run).not.toHaveBeenCalled()
  })

  it('Shift+2 zooms to the selection by the digit key, whatever the layout types (H21, H22)', () => {
    install()
    host.focus()
    // H21: en-US Shift+2 types @, so the digit row names it.
    expect(press({ key: '@', code: 'Digit2', shiftKey: true }, host).defaultPrevented).toBe(true)
    // H22: French AZERTY Shift+é types 2.
    expect(press({ key: '2', code: 'Digit2', shiftKey: true }, host).defaultPrevented).toBe(true)
    expect(run.mock.calls).toEqual([['view.zoomToSelection'], ['view.zoomToSelection']])
  })

  it('a Mac Cmd+←/→ away from the map runs nothing and never reaches the browser, which would go Back (H17)', () => {
    install({ platform: { os: 'mac', gestureEvents: false } })
    const zoomIn = document.createElement('button')
    host.append(zoomIn)
    const dock = document.createElement('div')
    dock.setAttribute('data-key-region', 'dock')
    const field = document.createElement('input')
    document.body.append(dock, field)

    // A map control that a click focused (Chrome focuses buttons) is not the map.
    zoomIn.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    zoomIn.focus()
    expect(press({ key: 'ArrowLeft', metaKey: true }, zoomIn).defaultPrevented).toBe(true)
    expect(press({ key: 'ArrowRight', metaKey: true }, zoomIn).defaultPrevented).toBe(true)
    // Nor is <body> after a press on a dock panel.
    zoomIn.blur()
    dock.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(press({ key: 'ArrowLeft', metaKey: true }, document.body).defaultPrevented).toBe(true)
    expect(fake.port.command).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()

    // Cmd+↑ and Cmd+↓ only scroll; a text field moves its caret; a modal keeps its keys.
    expect(press({ key: 'ArrowUp', metaKey: true }, document.body).defaultPrevented).toBe(false)
    field.focus()
    expect(press({ key: 'ArrowLeft', metaKey: true }, field).defaultPrevented).toBe(false)
    field.blur()
    modal = true
    expect(press({ key: 'ArrowLeft', metaKey: true }, document.body).defaultPrevented).toBe(false)
  })

  it('an arrow-owning widget outside the map keeps Shift+arrows, and a plain focusable div does not (H26)', () => {
    install()
    const world = document.createElement('div')
    world.tabIndex = 0
    world.setAttribute('data-owns-keys', 'arrows')
    const plain = document.createElement('div')
    plain.tabIndex = 0
    document.body.append(world, plain)
    world.focus()

    press({ key: 'ArrowRight', shiftKey: true }, world)
    press({ key: 'ArrowUp', shiftKey: true }, world)

    expect(fake.port.command).not.toHaveBeenCalled()
    // The positive control: the same presses on a plain focusable div turn the view and reset north.
    plain.focus()
    expect(press({ key: 'ArrowRight', shiftKey: true }, plain).defaultPrevented).toBe(true)
    expect(press({ key: 'ArrowUp', shiftKey: true }, plain).defaultPrevented).toBe(true)
    expect(fake.port.command.mock.calls.map(([c]) => c)).toEqual([{ kind: 'rotate-view', direction: 1 }, { kind: 'reset-north' }])
  })

  it('Shift+arrows in a listbox stay the listbox\'s; on a button outside any widget the view turns (H15)', () => {
    install()
    const list = document.createElement('ul')
    list.setAttribute('role', 'listbox')
    list.tabIndex = 0
    const compass = document.createElement('button')
    document.body.append(list, compass)

    list.focus()
    expect(press({ key: 'ArrowRight', shiftKey: true }, list).defaultPrevented).toBe(false)
    expect(fake.port.command).not.toHaveBeenCalled()
    compass.focus()
    expect(press({ key: 'ArrowRight', shiftKey: true }, compass).defaultPrevented).toBe(true)
    expect(press({ key: 'ArrowLeft', shiftKey: true }, compass).defaultPrevented).toBe(true)
    expect(fake.port.command.mock.calls.map(([c]) => c)).toEqual([
      { kind: 'rotate-view', direction: 1 },
      { kind: 'rotate-view', direction: -1 },
    ])
    expect(run).not.toHaveBeenCalled()
  })

  it('the dock splitter and the tool rail keep Shift+arrows (H18)', () => {
    install()
    // SidePanelDock's splitter: a focusable separator that resizes the dock.
    const splitter = document.createElement('div')
    splitter.setAttribute('role', 'separator')
    splitter.tabIndex = 0
    let resized = 0
    splitter.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft') resized += 1 })
    // ToolRail: a toolbar whose buttons move focus with the arrows.
    const rail = document.createElement('div')
    rail.setAttribute('role', 'toolbar')
    const tool = document.createElement('button')
    rail.append(tool)
    document.body.append(splitter, rail)

    splitter.focus()
    press({ key: 'ArrowLeft', shiftKey: true }, splitter)
    tool.focus()
    press({ key: 'ArrowUp', shiftKey: true }, tool)

    expect(resized).toBe(1)
    expect(fake.port.command).not.toHaveBeenCalled()
  })

  it('declared arrow owners keep Shift+arrows: the lens, the phone sheet, the calendar and the carousel (H19)', () => {
    install()
    const owner = (attribute: boolean) => {
      const root = document.createElement('div')
      if (attribute) root.setAttribute('data-owns-keys', 'arrows')
      const inner = document.createElement('button')
      root.append(inner)
      document.body.append(root)
      return inner
    }
    const lens = owner(true)
    const sheet = owner(true)
    const carousel = owner(true)
    // A calendar date button: its grid prevents every arrow itself, so it declares nothing.
    const date = owner(false)
    date.parentElement!.addEventListener('keydown', (event) => { if (event.key.startsWith('Arrow')) event.preventDefault() })

    for (const [target, key] of [[lens, 'ArrowRight'], [sheet, 'ArrowUp'], [date, 'ArrowRight'], [carousel, 'ArrowLeft']] as const) {
      target.focus()
      press({ key, shiftKey: true }, target)
    }

    expect(fake.port.command).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('opening the lens from a focused launcher hands focus to the map, so ArrowUp nudges and Esc clears (canopi-f47t.24)', async () => {
    install()
    const root = document.createElement('div')
    document.body.append(root)
    const view = {
      state: signal(null), sourceQuad: signal(null), inspectAtScreenPoint: vi.fn(), inspectAtWorldPoint: vi.fn(),
      centerOnCanvas: vi.fn(), panByScreen: vi.fn(), zoomBy: vi.fn(), highlightPlant: vi.fn(), focusPlant: vi.fn(), dispose: vi.fn(),
    } as unknown as CanvasInspectionHandle
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      documents: createTestCanvasDocumentSurface({ attachInspectionTo: () => view }),
    }))
    try {
      await act(async () => render(h(InspectionLens, { canvasRef: { current: host } }), root))
      // A real press on the launcher (outside the map host) focuses it, as WebView2, WebKitGTK and Tab-then-Enter do;
      // the launcher hides as the lens opens, so the map host must take focus or the keys reach neither map nor lens.
      const launcher = root.querySelector<HTMLButtonElement>('button[aria-expanded]')!
      launcher.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      launcher.focus()
      await act(async () => launcher.click())
      expect(root.querySelector('[data-inspection-frame]')).not.toBeNull()
      expect(document.activeElement).toBe(host)
      fake.state.command = (c) => c.kind === 'arrow'
      fake.state.layers = ['selection']

      press({ key: 'ArrowUp' }, document.activeElement!)
      expect(fake.port.command).toHaveBeenCalledExactlyOnceWith({ kind: 'arrow', dir: 'up', large: false })
      expect(view.panByScreen).not.toHaveBeenCalled()
      press({ key: 'Escape' }, document.activeElement!)
      expect(fake.port.escape).toHaveBeenCalledExactlyOnceWith('selection')
      expect(root.querySelector('[data-inspection-frame]')).not.toBeNull()
    } finally {
      await act(async () => render(null, root))
      setCurrentCanvasSession(null)
    }
  })

  it('F2 falls through to the shell when the map has no note to edit (H27)', () => {
    install()
    host.focus()
    fake.state.command = () => false
    expect(press({ key: 'F2' }, host).defaultPrevented).toBe(true)
    expect(fake.port.command).toHaveBeenLastCalledWith({ kind: 'edit-text' })
    expect(run).toHaveBeenCalledExactlyOnceWith('file.rename')

    fake.state.command = (c) => c.kind === 'edit-text'
    press({ key: 'F2' }, host)
    expect(run).toHaveBeenCalledOnce()
    // Away from the map, F2 renames the Design.
    const list = document.createElement('div')
    list.tabIndex = 0
    document.body.append(list)
    press({ key: 'F2' }, list)
    expect(run).toHaveBeenCalledTimes(2)
    expect(fake.port.command).toHaveBeenCalledTimes(2)
  })

  it('F6 reaches the next region past a widget that stops propagation (I11), never in a modal', () => {
    install()
    const lens = document.createElement('div')
    lens.tabIndex = 0
    lens.addEventListener('keydown', (event) => event.stopPropagation())
    document.body.append(lens)
    lens.focus()

    const f6 = press({ key: 'F6' }, lens)
    expect(cycleRegion).toHaveBeenCalledExactlyOnceWith(1)
    expect(f6.defaultPrevented).toBe(true)
    press({ key: 'F6', shiftKey: true }, lens)
    expect(cycleRegion).toHaveBeenLastCalledWith(-1)
    press({ key: 'F6', ctrlKey: true }, lens)
    modal = true
    press({ key: 'F6' }, lens)
    expect(cycleRegion).toHaveBeenCalledTimes(2)
  })

  it('Esc runs the Esc chain after element handlers, and before them while a drag or nudge series is live (steps 4 and 8)', () => {
    install()
    const panel = document.createElement('div')
    const row = document.createElement('li')
    row.tabIndex = 0
    panel.append(row)
    document.body.append(panel)
    // A panel that takes its own Esc.
    const panelEscape = vi.fn((event: KeyboardEvent) => event.preventDefault())
    panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') panelEscape(event) })
    fake.state.layers = ['tool']

    expect(press({ key: 'Escape' }, row).defaultPrevented).toBe(true)
    expect(panelEscape).toHaveBeenCalledOnce()
    expect(fake.port.escape).not.toHaveBeenCalled()
    expect(press({ key: 'Escape' }, host).defaultPrevented).toBe(true)
    expect(fake.port.escape).toHaveBeenCalledExactlyOnceWith('tool')

    // A live drag takes the Esc first, wherever focus is, and the panel never hears it.
    fake.port.escape.mockClear()
    fake.state.verdict = 'pass-live'
    fake.state.layers = ['gesture', 'tool']
    expect(press({ key: 'Escape' }, row).defaultPrevented).toBe(true)
    expect(fake.port.escape).toHaveBeenCalledExactlyOnceWith('gesture')
    expect(panelEscape).toHaveBeenCalledOnce()
    // So does a nudge series.
    fake.port.escape.mockClear()
    fake.state.verdict = 'pass'
    fake.state.layers = ['nudge-series', 'selection']
    press({ key: 'Escape' }, row)
    expect(fake.port.escape).toHaveBeenCalledExactlyOnceWith('nudge-series')
    expect(panelEscape).toHaveBeenCalledOnce()
  })

  it('Backspace and Delete delete nothing while a pointer session is live; a tool\'s own Backspace still runs', () => {
    install()
    host.focus()
    fake.state.verdict = 'pass-live'
    fake.state.layers = ['gesture', 'selection']
    fake.state.holdsDeletes = true
    fake.state.command = () => false
    // A still drag or twist is live: the deletion would wait for it to settle and land after the release.
    expect(press({ key: 'Backspace' }, host).defaultPrevented).toBe(true)
    expect(press({ key: 'Delete' }, host).defaultPrevented).toBe(true)
    expect(run).not.toHaveBeenCalled()

    // A Polygon draft's Backspace removes its last corner with a corner's press held.
    fake.state.command = (c) => c.kind === 'remove-last'
    expect(press({ key: 'Backspace' }, host).defaultPrevented).toBe(true)
    expect(fake.port.command).toHaveBeenLastCalledWith({ kind: 'remove-last' })
    expect(run).not.toHaveBeenCalled()

    fake.state.verdict = 'pass'
    fake.state.layers = ['selection']
    fake.state.holdsDeletes = false
    fake.state.command = () => false
    press({ key: 'Backspace' }, host)
    press({ key: 'Delete' }, host)
    expect(run.mock.calls.map(([command]) => command)).toEqual(['canvas.deleteSelected', 'canvas.deleteSelected'])
  })

  it('Delete, Backspace\'s fallback and Ctrl+X delete nothing during a polygon draft, from the map or a map control (canopi-f47t.21)', () => {
    install()
    const zoomIn = document.createElement('button')
    document.body.append(zoomIn)
    host.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    // A Polygon draft with two corners and a selection: no pointer is pressed, the tool holds a transient.
    fake.state.holdsDeletes = true
    fake.state.layers = ['tool-transient', 'tool', 'selection']
    fake.state.command = () => false
    host.focus()
    expect(press({ key: 'Delete' }, host).defaultPrevented).toBe(true)
    expect(press({ key: 'Backspace' }, host).defaultPrevented).toBe(true)
    expect(press({ key: 'x', code: 'KeyX', ctrlKey: true }, host).defaultPrevented).toBe(true)
    zoomIn.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    zoomIn.focus()
    expect(press({ key: 'Delete' }, zoomIn).defaultPrevented).toBe(true)
    expect(press({ key: 'x', code: 'KeyX', ctrlKey: true }, zoomIn).defaultPrevented).toBe(true)
    expect(run).not.toHaveBeenCalled()

    // Once the draft ends, the selection deletes again.
    fake.state.holdsDeletes = false
    fake.state.layers = ['selection']
    press({ key: 'Delete' }, zoomIn)
    expect(run.mock.calls.map(([command]) => command)).toEqual(['canvas.deleteSelected'])
  })

  it('Ctrl+X cuts nothing while a pointer session is live, and cuts once it settles', () => {
    install()
    host.focus()
    fake.state.verdict = 'pass-live'
    fake.state.layers = ['gesture', 'selection']
    fake.state.holdsDeletes = true
    fake.state.command = () => false
    // Cut deletes the selection too: the deletion would wait for the session to settle and land after the release.
    expect(press({ key: 'x', code: 'KeyX', ctrlKey: true }, host).defaultPrevented).toBe(true)
    expect(run).not.toHaveBeenCalled()

    fake.state.verdict = 'pass'
    fake.state.layers = ['selection']
    fake.state.holdsDeletes = false
    press({ key: 'x', code: 'KeyX', ctrlKey: true }, host)
    expect(run.mock.calls.map(([command]) => command)).toEqual(['canvas.cut'])
  })

  it('Esc in a text field or with a modifier leaves the tool and the selection alone', () => {
    install()
    const field = document.createElement('input')
    document.body.append(field)
    fake.state.layers = ['tool-transient', 'tool', 'selection']

    expect(press({ key: 'Escape' }, field).defaultPrevented).toBe(false)
    expect(press({ key: 'Escape', shiftKey: true }, host).defaultPrevented).toBe(true)
    expect(fake.port.escape).toHaveBeenCalledExactlyOnceWith('tool-transient')
    fake.state.layers = ['tool', 'selection']
    expect(press({ key: 'Escape', ctrlKey: true }, host).defaultPrevented).toBe(false)
    expect(fake.port.escape).toHaveBeenCalledOnce()
  })

  it('lets go of every held key when Meta comes up, on blur and when the page hides (H10)', () => {
    const save: KeymapRow = { command: 'file.save', chords: [{ key: 's', mod: true, ctrl: false, shift: false, alt: false }], scope: 'global', singleKey: 'n/a', worksInTextFields: true }
    install({ keymap: [save], platform: { os: 'mac', gestureEvents: false } })
    host.focus()
    const up = (key: string, code: string) => host.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true }))
    const released = () => fake.port.keyState.mock.calls.filter(([k]) => k.type === 'keyup').map(([k]) => k.code)

    press({ key: 'Meta', code: 'MetaLeft', metaKey: true }, host)
    press({ key: 's', code: 'KeyS', metaKey: true }, host)
    // macOS sends no keyup for S while Cmd is down.
    up('Meta', 'MetaLeft')
    expect(run).toHaveBeenCalledExactlyOnceWith('file.save')
    expect(released()).toEqual(['MetaLeft', 'KeyS'])

    fake.port.keyState.mockClear()
    press({ key: ' ', code: 'Space' }, host)
    press({ key: 'Control', code: 'ControlLeft', ctrlKey: true }, host)
    window.dispatchEvent(new Event('blur'))
    expect(released()).toEqual(['Space', 'ControlLeft'])

    fake.port.keyState.mockClear()
    press({ key: ' ', code: 'Space' }, host)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(released()).toEqual(['Space'])
    // Nothing is held twice.
    window.dispatchEvent(new Event('blur'))
    expect(released()).toEqual(['Space'])
  })

  it('lets go of a Space held from before Cmd when Meta comes up, since its keyup may be lost', () => {
    install({ platform: { os: 'mac', gestureEvents: false } })
    host.focus()
    const up = (key: string, code: string) => host.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true }))
    const released = () => fake.port.keyState.mock.calls.filter(([k]) => k.type === 'keyup').map(([k]) => k.code)

    press({ key: ' ', code: 'Space' }, host)
    press({ key: 'Meta', code: 'MetaLeft', metaKey: true }, host)
    press({ key: '=', code: 'Equal', metaKey: true }, host)
    // Space is released first, while Cmd is down: macOS drops its keyup, so the router sees only Meta's.
    up('Meta', 'MetaLeft')
    // No order of keyups tells "still held" from "released under Cmd", so Space is let go too and the next drag selects.
    expect(released()).toEqual(['MetaLeft', 'Space', 'Equal'])
  })

  it('a composing keydown runs nothing (H11, G12)', () => {
    install()
    host.focus()
    const composing = (init: KeyboardEventInit, keyCode = 229): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      Object.defineProperty(event, 'keyCode', { value: keyCode })
      host.dispatchEvent(event)
      return event
    }
    // H11: WebKit commits a composition, then sends its Enter with keyCode 229 and isComposing false.
    host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    composing({ key: 'Process', code: 'KeyK', isComposing: true })
    host.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    const enter = composing({ key: 'Enter', code: 'Enter' })
    // G12: Space while composing arms no pan.
    fake.state.verdict = 'held'
    const space = composing({ key: ' ', code: 'Space', isComposing: true }, 0)
    composing({ key: 'v', code: 'KeyV', isComposing: true }, 0)
    composing({ key: 'Escape', code: 'Escape', isComposing: true }, 0)
    composing({ key: 'F6', code: 'F6', isComposing: true }, 0)

    expect(fake.port.keyState).not.toHaveBeenCalled()
    expect(fake.port.command).not.toHaveBeenCalled()
    expect(fake.port.escape).not.toHaveBeenCalled()
    expect(cycleRegion).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(enter.defaultPrevented).toBe(false)
    expect(space.defaultPrevented).toBe(false)
  })

  describe('the held primary press record', () => {
    const pointer = (type: string, init: PointerEventInit = {}): void => {
      host.dispatchEvent(new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true, ...init }))
    }
    /** The release's waiting work runs in a later task, after the press's own click. */
    const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    const releases: ReadonlyArray<readonly [string, () => void]> = [
      ['pointerup', () => pointer('pointerup')],
      ['pointercancel', () => pointer('pointercancel')],
      ['a window blur', () => window.dispatchEvent(new Event('blur'))],
      ['the page hiding', () => document.dispatchEvent(new Event('visibilitychange'))],
    ]
    for (const [name, release] of releases) {
      it(`releases a held primary press on ${name}, and the work waiting for it runs after`, async () => {
        install()
        pointer('pointerdown')
        const apply = vi.fn()
        afterPrimaryPress({}, apply)
        expect(apply).not.toHaveBeenCalled()
        release()
        expect(apply).not.toHaveBeenCalled()
        await nextTask()
        expect(apply).toHaveBeenCalledOnce()
      })
    }

    it('a pointerup from another pointer, or a secondary button press, holds nothing back', async () => {
      install()
      const owner = {}
      pointer('pointerdown')
      const apply = vi.fn()
      afterPrimaryPress(owner, apply)
      pointer('pointerup', { pointerId: 2 })
      await nextTask()
      expect(apply).not.toHaveBeenCalled()
      pointer('pointerup')
      await nextTask()
      expect(apply).toHaveBeenCalledOnce()

      pointer('pointerdown', { button: 2 })
      const now = vi.fn()
      afterPrimaryPress(owner, now)
      expect(now).toHaveBeenCalledOnce()
    })
  })

  it('without a canvas, canvas rows fall back to the shell and the rest run nowhere', () => {
    install({ canvas: () => null })
    expect(press({ key: 'F2' }, document.body).defaultPrevented).toBe(true)
    expect(run).toHaveBeenCalledExactlyOnceWith('file.rename')
    expect(press({ key: 'ArrowLeft' }, document.body).defaultPrevented).toBe(false)
    expect(press({ key: 'Escape' }, document.body).defaultPrevented).toBe(false)
  })
})
