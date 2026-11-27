// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentCanvasTool, setCurrentCanvasSession } from '../canvas/session'
import { currentCanvasSelection } from '../canvas/session-state'
import { placeSearchFocusRequest } from '../app/geocoding/place-search-ui'
import { keyboardShortcutsDialogOpen } from '../app/shell/dialogs'
import { activePanel, sidePanel } from '../app/shell/state'
import { singleKeyShortcuts } from '../app/settings/state'
import { t } from '../i18n'
import {
  createBrowserShellCatalog,
  installWebKeyRouter,
  type BrowserShellCatalog,
} from '../editions/web/browser-shell-commands'
import type { KeyRouterHandle } from '../app/keyboard/key-router'
import { answerSaveProblem, requestSaveProblemDecision } from '../app/document-session/save-problem'
import { registerPlantFinder } from '../app/plant-finder/focus'
import { formatShortcut, setShortcutPlatform } from '../app/shell-commands/shortcut-text'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'

let keys: KeyRouterHandle | null = null

/** The Web key router over a catalog (none: the canvas rows alone), on Linux unless a test names a Mac. */
function installWebKeys(catalog: BrowserShellCatalog = [], os: 'linux' | 'mac' = 'linux'): KeyRouterHandle {
  keys = installWebKeyRouter({
    catalog,
    readState: () => ({ hasDesign: true, revertAvailable: false, activePanel: 'canvas', sidePanel: null }),
  }, { os, gestureEvents: false })
  return keys
}

function webCatalog(newDesign = vi.fn()): BrowserShellCatalog {
  return createBrowserShellCatalog({
    newDesign, openCanopi: vi.fn(), downloadCanopi: vi.fn(), revertDesign: vi.fn(),
    importGeoJson: vi.fn(), exportGeoJson: vi.fn(), exportBudgetCsv: vi.fn(), closeDesign: vi.fn(), navigate: vi.fn(),
  }, { templatesEnabled: false, canvasReady: () => true })
}

describe('Web keys', () => {
  beforeEach(() => {
    setCurrentCanvasSession(null)
  })

  afterEach(() => {
    keys?.dispose()
    keys = null
    setCurrentCanvasSession(null)
    currentCanvasSelection.value = new Set()
    activePanel.value = 'canvas'
    sidePanel.value = null
    document.body.innerHTML = ''
    setShortcutPlatform({ os: 'linux' })
    vi.restoreAllMocks()
  })

  it('labels the mod key for the platform it routes keys on: Cmd on a Mac, Ctrl elsewhere', () => {
    installWebKeys([], 'mac')
    expect(formatShortcut('Ctrl+Shift+Z', t)).toBe('Cmd Shift Z')

    installWebKeys([], 'linux')
    expect(formatShortcut('Ctrl+Shift+Z', t)).toBe('Ctrl Shift Z')
  })

  it('ignores a key an earlier listener already consumed', () => {
    installWebKeys()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces())
    const event = shortcutEvent({ key: 'r' })
    event.preventDefault()

    window.dispatchEvent(event)

    expect(currentCanvasTool.value).toBe('select')
  })

  it('focuses the place field on Ctrl+K only while a Design canvas is live', () => {
    installWebKeys()
    const before = placeSearchFocusRequest.value
    expect(dispatchShortcut({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(placeSearchFocusRequest.value).toBe(before)

    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces())
    expect(dispatchShortcut({ key: 'k', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false)
    expect(dispatchShortcut({ key: 'f', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(dispatchShortcut({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(placeSearchFocusRequest.value).toBe(before + 1)
  })

  it('leaves character keys to the page while single-key shortcuts are off', () => {
    installWebKeys()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces())
    singleKeyShortcuts.value = false
    try {
      expect(dispatchShortcut({ key: 'z' }).defaultPrevented).toBe(false)
      expect(currentCanvasTool.value).toBe('select')
      const before = placeSearchFocusRequest.value
      expect(dispatchShortcut({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(true)
      expect(placeSearchFocusRequest.value).toBe(before + 1)
    } finally {
      singleKeyShortcuts.value = true
    }
  })

  it('routes the shell shortcuts a browser lets a page keep, and leaves the rest to the browser', () => {
    const newDesign = vi.fn()
    installWebKeys(webCatalog(newDesign))

    expect(dispatchShortcut({ key: 'F1' }).defaultPrevented).toBe(true)
    expect(keyboardShortcutsDialogOpen.value).toBe(true)
    keyboardShortcutsDialogOpen.value = false
    expect(dispatchShortcut({ key: 'n', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(newDesign).not.toHaveBeenCalled()
  })

  it('focuses the open panel plant finder on Ctrl+F, even from another field, and opens the catalog without one', () => {
    installWebKeys(webCatalog())
    const other = document.createElement('input')
    const finder = document.createElement('input')
    document.body.append(other, finder)
    finder.value = 'pommier'
    const unregister = registerPlantFinder(() => { finder.focus(); finder.select() })
    other.focus()

    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
    other.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(finder)
    expect(finder.selectionStart).toBe(0)
    expect(finder.selectionEnd).toBe(7)
    unregister()
    expect(dispatchShortcut({ key: 'f', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(sidePanel.value).toBe('plant-db')
  })

  it('ignores canvas shortcuts while the save dialog is open', async () => {
    const undo = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ history: { canUndo: signal(true), undo } }),
    }))
    installWebKeys()
    const decision = requestSaveProblemDecision({ kind: 'revert' })

    expect(dispatchShortcut({ key: 'z', ctrlKey: true }).defaultPrevented).toBe(false)
    const focusRequest = placeSearchFocusRequest.value
    expect(dispatchShortcut({ key: 'k', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(undo).not.toHaveBeenCalled()
    expect(placeSearchFocusRequest.value).toBe(focusRequest)

    answerSaveProblem('cancel')
    await decision
    expect(dispatchShortcut({ key: 'z', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(undo).toHaveBeenCalledOnce()
  })

  it('dispatches tool and history shortcuts with exact Ctrl (Cmd on a Mac), Shift and Alt semantics', () => {
    const setTool = vi.fn()
    const undo = vi.fn()
    const redo = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        tools: { setTool },
        history: {
          canUndo: signal(true),
          canRedo: signal(true),
          undo,
          redo,
        },
      }),
    }))
    installWebKeys()

    expect(dispatchShortcut({ key: 'e' }).defaultPrevented).toBe(true)
    expect(dispatchShortcut({ key: 'E', shiftKey: true }).defaultPrevented).toBe(false)
    expect(dispatchShortcut({ key: 'z', ctrlKey: true }).defaultPrevented).toBe(true)
    // The OS key is no shortcut outside a Mac.
    expect(dispatchShortcut({ key: 'z', metaKey: true }).defaultPrevented).toBe(false)
    expect(dispatchShortcut({ key: 'z', ctrlKey: true, metaKey: true }).defaultPrevented).toBe(false)
    expect(dispatchShortcut({ key: 'z', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false)
    expect(dispatchShortcut({ key: 'Z', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)

    keys!.dispose()
    installWebKeys([], 'mac')
    expect(dispatchShortcut({ key: 'z', metaKey: true }).defaultPrevented).toBe(true)
    // A physical Ctrl on a Mac is not Cmd.
    expect(dispatchShortcut({ key: 'z', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(dispatchShortcut({ key: 'Z', metaKey: true, shiftKey: true }).defaultPrevented).toBe(true)
    expect(dispatchShortcut({
      key: 'Z',
      metaKey: true,
      shiftKey: true,
      altKey: true,
    }).defaultPrevented).toBe(false)

    expect(setTool).toHaveBeenCalledOnce()
    expect(setTool).toHaveBeenCalledWith('ellipse')
    expect(currentCanvasTool.value).toBe('ellipse')
    expect(undo).toHaveBeenCalledTimes(2)
    expect(redo).toHaveBeenCalledTimes(2)
  })

  it('suppresses Canvas shortcuts from editable targets', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const setTool = vi.fn()
    const undo = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        tools: { setTool },
        history: { canUndo: signal(true), undo },
      }),
    }))
    installWebKeys()

    input.dispatchEvent(shortcutEvent({ key: 'e', bubbles: true }))
    input.dispatchEvent(shortcutEvent({ key: 'z', ctrlKey: true, bubbles: true }))

    expect(setTool).not.toHaveBeenCalled()
    expect(undo).not.toHaveBeenCalled()
    expect(currentCanvasTool.value).toBe('select')
  })

  it('re-reads the live Canvas surface across detach and replacement', () => {
    const firstUndo = vi.fn()
    const replacementUndo = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        history: { canUndo: signal(true), undo: firstUndo },
      }),
    }))
    installWebKeys()

    dispatchShortcut({ key: 'z', ctrlKey: true })
    setCurrentCanvasSession(null)
    const detachedShortcut = dispatchShortcut({ key: 'z', ctrlKey: true })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        history: { canUndo: signal(true), undo: replacementUndo },
      }),
    }))
    dispatchShortcut({ key: 'z', ctrlKey: true })

    expect(firstUndo).toHaveBeenCalledOnce()
    expect(replacementUndo).toHaveBeenCalledOnce()
    expect(detachedShortcut.defaultPrevented).toBe(false)
  })

  it('does not swallow disabled undo or redo shortcuts', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        history: {
          canUndo: signal(false),
          canRedo: signal(false),
          undo,
          redo,
        },
      }),
    }))
    installWebKeys()

    const undoShortcut = dispatchShortcut({ key: 'z', ctrlKey: true })
    const redoShortcut = dispatchShortcut({ key: 'Z', ctrlKey: true, shiftKey: true })

    expect(undoShortcut.defaultPrevented).toBe(false)
    expect(redoShortcut.defaultPrevented).toBe(false)
    expect(undo).not.toHaveBeenCalled()
    expect(redo).not.toHaveBeenCalled()
  })

  it('keeps a selection edit\'s key from the browser while the map has a selection, and leaves Copy with none to the page', () => {
    const groupSelected = vi.fn()
    const duplicateSelected = vi.fn()
    const copy = vi.fn()
    const queries = createTestCanvasQuerySurface({ selection: [{ kind: 'plant', id: 'plant-1' }] })
    let locked = false
    const base = queries.getDesignObjectSelection
    queries.getDesignObjectSelection = () => {
      const selection = base()
      return locked ? { ...selection, editableTargets: [], lockedTargets: selection.editableTargets } : selection
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ sceneEdits: { groupSelected, duplicateSelected, copy } }),
      queries,
    }))
    installWebKeys()
    currentCanvasSelection.value = new Set(['plant-1'])

    // One plant cannot be grouped, yet Ctrl+G is the canvas's, not the browser's find bar.
    expect(dispatchShortcut({ key: 'g', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(groupSelected).not.toHaveBeenCalled()
    // A locked plant cannot be duplicated, yet Ctrl+D is the canvas's, not the browser's bookmark dialog.
    locked = true
    expect(dispatchShortcut({ key: 'd', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(duplicateSelected).not.toHaveBeenCalled()

    // With nothing selected, Copy leaves its key to the page.
    currentCanvasSelection.value = new Set()
    expect(dispatchShortcut({ key: 'c', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(copy).not.toHaveBeenCalled()
  })

  it('on a selection mixing locked and unlocked objects, Delete, Ctrl+X, Ctrl+C and Ctrl+D act on the unlocked part (U59)', () => {
    // User decision 2026-10-13 (U55 overturned): Delete, Cut, Copy and Duplicate act on the unlocked objects and silently
    // leave the locked ones; the runtime acts on the editable targets only (mutations.test.ts).
    const deleteSelected = vi.fn()
    const copy = vi.fn()
    const duplicateSelected = vi.fn()
    const queries = createTestCanvasQuerySurface({ selection: [{ kind: 'plant', id: 'plant-1' }, { kind: 'plant', id: 'plant-2' }] })
    const base = queries.getDesignObjectSelection
    queries.getDesignObjectSelection = () => {
      const selection = base()
      return {
        ...selection,
        editableTargets: selection.editableTargets.filter((target) => target.id === 'plant-1'),
        lockedTargets: selection.editableTargets.filter((target) => target.id === 'plant-2'),
      }
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ sceneEdits: { deleteSelected, copy, duplicateSelected } }),
      queries,
    }))
    installWebKeys()
    currentCanvasSelection.value = new Set(['plant-1', 'plant-2'])

    for (const init of [
      { key: 'Delete' },
      { key: 'Backspace' },
      { key: 'x', ctrlKey: true },
      { key: 'c', ctrlKey: true },
      { key: 'd', ctrlKey: true },
    ]) {
      expect(dispatchShortcut(init).defaultPrevented, `${JSON.stringify(init)} is the canvas's`).toBe(true)
    }
    // Delete, Backspace and Ctrl+X delete; Ctrl+X and Ctrl+C copy.
    expect(deleteSelected).toHaveBeenCalledTimes(3)
    expect(copy).toHaveBeenCalledTimes(2)
    expect(duplicateSelected).toHaveBeenCalledOnce()
  })

  it('replaces its key router on a second install and disposes it once', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const keyListeners = (calls: readonly unknown[][]) => calls.filter(([type]) => type === 'keydown' || type === 'keyup')

    const first = installWebKeys()
    const firstListeners = keyListeners(add.mock.calls)
    expect(firstListeners).toHaveLength(3)
    const replacement = installWebKeys()
    expect(keyListeners(remove.mock.calls).map(([, listener]) => listener))
      .toEqual(firstListeners.map(([, listener]) => listener))

    first.dispose()
    expect(keyListeners(remove.mock.calls)).toHaveLength(3)
    replacement.dispose()
    replacement.dispose()
    expect(keyListeners(remove.mock.calls)).toHaveLength(6)
  })
})

interface ShortcutEventInit {
  readonly key: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly shiftKey?: boolean
  readonly altKey?: boolean
  readonly bubbles?: boolean
}

function shortcutEvent(init: ShortcutEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    ...init,
    cancelable: true,
  })
}

function dispatchShortcut(init: ShortcutEventInit): KeyboardEvent {
  const event = shortcutEvent(init)
  window.dispatchEvent(event)
  return event
}
