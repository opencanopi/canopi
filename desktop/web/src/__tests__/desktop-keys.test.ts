// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signal } from '@preact/signals'
import { currentCanvasSelection } from '../canvas/session-state'
import { activePanel, sidePanel } from '../app/shell/state'
import * as documentActions from '../app/document-session/actions'
import { commandPaletteOpen } from '../commands/registry'
import type { KeyRouterHandle } from '../app/keyboard/key-router'
import { installDesktopKeys } from './support/desktop-key-router'
import { currentCanvasTool, setCurrentCanvasSession } from '../canvas/session'
import { designSessionFixture, markTestDesignDirty } from './support/design-session-state'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'
import { registerPlantFinder } from '../app/plant-finder/focus'
import { placeSearchFocusRequest } from '../app/geocoding/place-search-ui'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { applyRotateSelection, rotateSelectionDialog } from '../app/rotate-selection/state'

function mountCanvasCommandSurface(overrides: Parameters<typeof createTestCanvasCommandSurface>[0]): void {
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands: createTestCanvasCommandSurface(overrides),
    // The edit table reads what the selection can do: two editable targets, one a group.
    queries: createTestCanvasQuerySurface({ selection: [{ kind: 'plant', id: 'plant-1' }, { kind: 'group', id: 'group-1' }] }),
  }))
}

describe('Desktop keys', () => {
  let keys: KeyRouterHandle

  beforeEach(() => {
    activePanel.value = 'canvas'
    sidePanel.value = null
    currentCanvasSelection.value = new Set()
    setCurrentCanvasSession(null)
    designSessionFixture.file = null
    commandPaletteOpen.value = false
    keys = installDesktopKeys()
  })

  afterEach(() => {
    keys.dispose()
    setCurrentCanvasSession(null)
    currentCanvasSelection.value = new Set()
    designSessionFixture.file = null
    commandPaletteOpen.value = false
  })

  it('routes tool shortcuts through the live canvas session when mounted', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }))

    expect(setTool).toHaveBeenCalledWith('rectangle')
    expect(currentCanvasTool.value).toBe('rectangle')
  })

  // A key the active tool consumed (Backspace in a polygon draft) is not also
  // an app shortcut: the dispatcher honours defaultPrevented like any listener.
  it('ignores a key an earlier listener already consumed', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })
    const event = new KeyboardEvent('keydown', { key: 'r', cancelable: true })
    event.preventDefault()

    window.dispatchEvent(event)

    expect(setTool).not.toHaveBeenCalled()
    expect(currentCanvasTool.value).toBe('select')
  })

  it('routes the ellipse tool shortcut through the live canvas session', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }))

    expect(setTool).toHaveBeenCalledWith('ellipse')
    expect(currentCanvasTool.value).toBe('ellipse')
  })

  it('routes the Line tool shortcut through the live canvas session', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }))

    expect(setTool).toHaveBeenCalledWith('line')
    expect(currentCanvasTool.value).toBe('line')
  })

  it('routes the polygon tool shortcut through the live canvas session', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' }))

    expect(setTool).toHaveBeenCalledWith('polygon')
    expect(currentCanvasTool.value).toBe('polygon')
  })

  it('routes the Plant Spacing shortcut through the live canvas session', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))

    expect(setTool).toHaveBeenCalledWith('plant-spacing')
    expect(currentCanvasTool.value).toBe('plant-spacing')
  })

  it('does not route tool shortcuts while an editable input is focused', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }))

    expect(setTool).not.toHaveBeenCalled()
    expect(currentCanvasTool.value).toBe('select')
    input.remove()
  })

  it('drops a tool shortcut without priming mirror state before session mount (2.1-Q41)', () => {
    setCurrentCanvasSession(null)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))

    expect(currentCanvasTool.value).toBe('select')
  })

  it('keeps panel shortcuts aligned with the command registry mapping', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', ctrlKey: true }))

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('plant-db')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', ctrlKey: true }))

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)
  })

  it('leaves bare digits to the map and text fields', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }))
    expect(sidePanel.value).toBe(null)
  })

  it('focuses the open panel plant finder on Ctrl+F, and opens the Plant catalog when no finder is open', () => {
    const finder = document.createElement('input')
    document.body.append(finder)
    const focus = vi.fn(() => finder.focus())
    const unregister = registerPlantFinder(focus)

    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(finder)

    commandPaletteOpen.value = true
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true }))
    expect(focus).toHaveBeenCalledOnce()
    commandPaletteOpen.value = false

    unregister()
    const unclaimed = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
    window.dispatchEvent(unclaimed)
    expect(unclaimed.defaultPrevented).toBe(true)
    expect(sidePanel.value).toBe('plant-db')
    finder.remove()
  })

  it('toggles and closes the command palette through the keyboard seam', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true }))

    expect(commandPaletteOpen.value).toBe(true)

    // Esc belongs to the palette's own field and the map's Esc chain, not the seam.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(commandPaletteOpen.value).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true }))

    expect(commandPaletteOpen.value).toBe(false)
  })

  it('routes file shortcuts through document-session actions', () => {
    designSessionFixture.file = {
      version: 9,
      name: 'test',
      description: null,
      plant_species_colors: {},
      layers: [],
      plants: [],
      zones: [],
      annotations: [],
      consortiums: [],
      groups: [],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      created_at: '',
      updated_at: '',
      extra: {},
    }
    markTestDesignDirty()
    const saveSpy = vi.spyOn(documentActions, 'saveCurrentDesign').mockResolvedValue(true)
    const saveAsSpy = vi.spyOn(documentActions, 'saveAsCurrentDesign').mockResolvedValue(null)
    const openSpy = vi.spyOn(documentActions, 'openDesign').mockResolvedValue(undefined)
    const newSpy = vi.spyOn(documentActions, 'newDesignAction').mockResolvedValue(undefined)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }))

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveAsSpy).toHaveBeenCalledTimes(1)
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(newSpy).toHaveBeenCalledTimes(1)
  })

  it('routes view and history shortcuts through the App Command Graph adapter', () => {
    const zoomIn = vi.fn()
    const zoomOut = vi.fn()
    const zoomToFit = vi.fn()
    const undo = vi.fn()
    const redo = vi.fn()
    mountCanvasCommandSurface({
      viewport: {
        zoomIn,
        zoomOut,
        zoomToFit,
      },
      history: {
        canUndo: signal(true),
        canRedo: signal(true),
        undo,
        redo,
      },
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', shiftKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true }))

    expect(zoomIn).toHaveBeenCalledTimes(1)
    expect(zoomOut).toHaveBeenCalledTimes(1)
    expect(zoomToFit).toHaveBeenCalledTimes(1)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(redo).toHaveBeenCalledTimes(1)
  })

  it('routes canvas edit, ordering, lock, and grouping shortcuts through the App Command Graph adapter', () => {
    const copy = vi.fn()
    const paste = vi.fn()
    const duplicateSelected = vi.fn()
    const deleteSelected = vi.fn()
    const selectAll = vi.fn()
    const bringToFront = vi.fn()
    const sendToBack = vi.fn()
    const lockSelected = vi.fn()
    const unlockSelected = vi.fn()
    const groupSelected = vi.fn()
    const ungroupSelected = vi.fn()
    mountCanvasCommandSurface({
      sceneEdits: {
        copy,
        paste,
        duplicateSelected,
        deleteSelected,
        selectAll,
        bringToFront,
        sendToBack,
        lockSelected,
        unlockSelected,
        groupSelected,
        ungroupSelected,
      },
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))
    // Nothing is selected: selection edits stay quiet, Paste and Select all still run.
    expect(copy).not.toHaveBeenCalled()
    currentCanvasSelection.value = new Set(['plant-1'])
    const focusRequest = placeSearchFocusRequest.value
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }))
    // Lock is Ctrl Shift L: Ctrl L is the browser's address bar on Web.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }))
    expect(lockSelected).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', ctrlKey: true, shiftKey: true }))
    currentCanvasSelection.value = new Set()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))

    expect(copy).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledTimes(1)
    expect(duplicateSelected).toHaveBeenCalledTimes(1)
    expect(deleteSelected).toHaveBeenCalledTimes(1)
    expect(selectAll).toHaveBeenCalledTimes(1)
    expect(bringToFront).toHaveBeenCalledTimes(1)
    expect(sendToBack).toHaveBeenCalledTimes(1)
    expect(lockSelected).toHaveBeenCalledTimes(1)
    expect(unlockSelected).not.toHaveBeenCalled()
    expect(groupSelected).toHaveBeenCalledTimes(1)
    expect(ungroupSelected).toHaveBeenCalledTimes(1)
    expect(placeSearchFocusRequest.value).toBe(focusRequest + 1)
  })
  it('leaves a disabled canvas edit\'s key to the browser, as the Web sink does', () => {
    const copy = vi.fn()
    mountCanvasCommandSurface({ sceneEdits: { copy } })
    const press = () => {
      const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })
      window.dispatchEvent(event)
      return event
    }

    // No map selection: Copy is disabled, so the page's own copy (a panel's selected text) runs.
    expect(press().defaultPrevented).toBe(false)
    expect(copy).not.toHaveBeenCalled()
    currentCanvasSelection.value = new Set(['plant-1'])
    expect(press().defaultPrevented).toBe(true)
    expect(copy).toHaveBeenCalledOnce()
  })

  it('keeps a selection edit\'s key from the browser while the map has a selection, even one the edit cannot change', () => {
    const groupSelected = vi.fn()
    const duplicateSelected = vi.fn()
    const queries = createTestCanvasQuerySurface({ selection: [{ kind: 'plant', id: 'plant-1' }] })
    let locked = false
    const base = queries.getDesignObjectSelection
    queries.getDesignObjectSelection = () => {
      const selection = base()
      return locked ? { ...selection, editableTargets: [], lockedTargets: selection.editableTargets } : selection
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ sceneEdits: { groupSelected, duplicateSelected } }),
      queries,
    }))
    currentCanvasSelection.value = new Set(['plant-1'])
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      window.dispatchEvent(event)
      return event
    }

    // One plant cannot be grouped, yet Ctrl+G is the canvas's, not the browser's find bar.
    expect(press({ key: 'g', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(groupSelected).not.toHaveBeenCalled()
    // A locked plant cannot be duplicated, yet Ctrl+D is the canvas's, not the browser's bookmark dialog.
    locked = true
    expect(press({ key: 'd', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(duplicateSelected).not.toHaveBeenCalled()
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
    currentCanvasSelection.value = new Set(['plant-1', 'plant-2'])
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      window.dispatchEvent(event)
      return event
    }

    for (const init of [
      { key: 'Delete' },
      { key: 'Backspace' },
      { key: 'x', ctrlKey: true },
      { key: 'c', ctrlKey: true },
      { key: 'd', ctrlKey: true },
    ]) {
      expect(press(init).defaultPrevented, `${JSON.stringify(init)} is the canvas's`).toBe(true)
    }
    // Delete, Backspace and Ctrl+X delete; Ctrl+X and Ctrl+C copy.
    expect(deleteSelected).toHaveBeenCalledTimes(3)
    expect(copy).toHaveBeenCalledTimes(2)
    expect(duplicateSelected).toHaveBeenCalledOnce()
  })

  it('opens Rotate… with Ctrl Alt R only for a selection that can turn', () => {
    const rotateSelected = vi.fn()
    const queries = createTestCanvasQuerySurface()
    let rotatable = false
    queries.getDesignObjectSelection = () => ({
      editableTargets: rotatable ? [{ kind: 'zone', id: 'zone-1' }] : [{ kind: 'plant', id: 'plant-1' }],
      lockedTargets: [],
      blockedTargets: [],
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      sameSpeciesReferenceCanonicalName: null,
      plantNamePinning: { plantIds: [], allPinned: false },
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ sceneEdits: { rotateSelected } }),
      queries,
    }))
    currentCanvasSelection.value = new Set(['plant-1'])

    // A lone plant has nothing to turn.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, altKey: true, code: 'KeyR' }))
    expect(rotateSelectionDialog.value).toBeNull()

    rotatable = true
    currentCanvasSelection.value = new Set(['zone-1'])
    // On a Mac, Cmd Option R types ®: the physical key still names the shortcut.
    keys.dispose()
    keys = installDesktopKeys({ os: 'mac', gestureEvents: false })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '®', metaKey: true, altKey: true, code: 'KeyR' }))
    expect(rotateSelectionDialog.value).not.toBeNull()
    applyRotateSelection('-30')
    expect(rotateSelected).toHaveBeenCalledWith(-30)
  })
})
