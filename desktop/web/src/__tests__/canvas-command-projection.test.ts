import { describe, expect, it, vi } from 'vitest'
import {
  createCanvasCommandProjection,
  type CanvasCommandProjection,
  type CanvasCommandProjectionState,
} from '../app/canvas-commands'
import { ariaKeyShortcuts, formatShortcut } from '../app/shell-commands/shortcut-text'
import { t } from '../i18n'
import type { CanvasEditSelectionAvailability } from '../app/canvas-commands/edit-availability'

/** Every tool, in rail order. */
const projectedCanvasTools = (projection: CanvasCommandProjection) =>
  projection.toolGroups.flatMap((group) => group.tools)

function state(overrides: Partial<CanvasCommandProjectionState> = {}): CanvasCommandProjectionState {
  return {
    activeTool: 'select',
    canvasAvailable: true,
    spatialEditingAvailable: true,
    selection: null,
    held: false,
    lockedObjectsPresent: false,
    canUndo: false,
    canRedo: false,
    gridVisible: false,
    snapToGridEnabled: true,
    ...overrides,
  }
}

/** A selection every selection command applies to. */
const EVERYTHING: CanvasEditSelectionAvailability = {
  copy: true,
  edit: true,
  group: true,
  ungroup: true,
  rotate: true,
  unlock: true,
  selectSameSpecies: true,
  saveAsStamp: true,
}

const KEY_NAMES: Record<string, string> = {
  'shortcutKeys.ctrl': 'Ctrl',
  'shortcutKeys.shift': 'Shift',
  'shortcutKeys.alt': 'Alt',
  'shortcutKeys.delete': 'Del',
  'shortcutKeys.escape': 'Esc',
}
const tagged = (k: string) => KEY_NAMES[k] ?? `t:${k}`


describe('Canvas Command Projection', () => {
  it('owns the tool rail groups and single keys from the Menus board', () => {
    const projection = createCanvasCommandProjection({ state: state(), run: vi.fn(), translate: (k) => k, characterKeys: true })

    expect(projection.toolGroups.map((group) => ({
      id: group.id,
      heading: group.heading,
      tools: group.tools.map((tool) => [tool.tool, tool.shortcut]),
    }))).toEqual([
      { id: 'navigate', heading: undefined, tools: [['select', 'V'], ['hand', 'H']] },
      { id: 'plant', heading: undefined, tools: [['plant-stamp', 'P'], ['plant-spacing', 'W'], ['object-stamp', 'K']] },
      { id: 'zones', heading: 'canvas.tools.zones', tools: [['polygon', 'Z'], ['rectangle', 'R'], ['ellipse', 'E'], ['line', 'L']] },
      { id: 'annotate', heading: undefined, tools: [['text', 'T'], ['measurement-guide', 'M']] },
    ])
    expect(projectedCanvasTools(projection).every((tool) => tool.ariaShortcut === tool.shortcut)).toBe(true)
  })

  it('shows shortcuts with spaces and localized key names, and exposes both modifiers to assistive tech', () => {
    expect(formatShortcut('Ctrl+Shift+Z', t)).toBe('Ctrl Shift Z')
    expect(formatShortcut('Ctrl+Plus', t)).toBe('Ctrl +')
    const french: Readonly<Record<string, string>> = { 'shortcutKeys.ctrl': 'Ctrl', 'shortcutKeys.shift': 'Maj' }
    expect(formatShortcut('Ctrl+Shift+A', (k) => french[k] ?? k)).toBe('Ctrl Maj A')
    expect(ariaKeyShortcuts('Ctrl+Shift+Z')).toBe('Control+Shift+Z Meta+Shift+Z')
    expect(ariaKeyShortcuts('Ctrl+Plus')).toBe('Control+= Meta+=')
    expect(ariaKeyShortcuts('Shift+G')).toBe('Shift+G')
  })

  it('the tool groups keep Pan, and View lists it too', () => {
    const run = vi.fn()
    const projection = createCanvasCommandProjection({ state: state(), run, translate: (k) => k, characterKeys: true })

    expect(projectedCanvasTools(projection).find((tool) => tool.tool === 'hand')).toMatchObject({ commandId: 'canvas.tool.hand', shortcut: 'H' })
    const pan = projection.viewActions.find((view) => view.id === 'pan')!
    expect(pan).toMatchObject({ commandId: 'canvas.tool.hand', label: 'canvas.tools.hand', shortcut: 'H', disabled: false })
    pan.action()
    expect(run).toHaveBeenCalledWith({ type: 'select-tool', tool: 'hand' }, 'menu')
  })

  it('dispatches the chosen tool and marks the active one', () => {
    const run = vi.fn()
    const projection = createCanvasCommandProjection({ state: state({ activeTool: 'ellipse' }), run, translate: (k) => `t:${k}`, characterKeys: true })
    const ellipse = projectedCanvasTools(projection).find((tool) => tool.tool === 'ellipse')!

    expect(ellipse).toMatchObject({ commandId: 'canvas.tool.ellipse', label: 't:canvas.tools.ellipse', active: true, disabled: false })
    ellipse.action('rail')
    expect(run).toHaveBeenCalledWith({ type: 'select-tool', tool: 'ellipse' }, 'rail')
  })

  it('keeps every tool enabled in overview, which disables only the mutating edits', () => {
    const run = vi.fn()
    const projection = createCanvasCommandProjection({
      state: state({ spatialEditingAvailable: false, selection: EVERYTHING }),
      run,
      translate: (k) => k,
      characterKeys: true,
    })
    const tools = projectedCanvasTools(projection)

    expect(tools.filter((tool) => tool.disabled)).toEqual([])
    tools.find((tool) => tool.tool === 'polygon')!.action('menu')
    expect(run).toHaveBeenCalledWith({ type: 'select-tool', tool: 'polygon' }, 'menu')
    const edits = Object.fromEntries(projection.editActions.map((edit) => [edit.id, edit.disabled]))
    expect(edits).toMatchObject({ copy: false, 'select-all': false, cut: true, paste: true, delete: true, group: true, lock: true })
    expect(projection.viewActions.every((view) => !view.disabled)).toBe(true)
  })

  // Which edit each selection allows is the edit-availability table's (edit-availability.test.ts, S3b).
  it('enables every edit a full selection allows, each with its label, keys and run', () => {
    const disabled = (projection: CanvasCommandProjection) => projection.editActions.filter((edit) => edit.disabled).map((edit) => edit.id)
    const run = vi.fn()
    const selected = createCanvasCommandProjection({
      state: state({ selection: EVERYTHING, lockedObjectsPresent: true }),
      run,
      translate: (k) => k,
      characterKeys: true,
    })
    expect(disabled(selected)).toEqual([])
    selected.editActions.find((edit) => edit.id === 'select-same-species')!.action()
    expect(run).toHaveBeenCalledWith({ type: 'edit', action: 'select-same-species' }, 'menu')
    const rotate = selected.editActions.find((edit) => edit.id === 'rotate')!
    expect(rotate).toMatchObject({ commandId: 'canvas.rotateSelected', label: 'menu.edit.rotate', ariaShortcut: 'Control+Alt+R Meta+Alt+R' })
    rotate.action()
    expect(run).toHaveBeenCalledWith({ type: 'edit', action: 'rotate' }, 'menu')
    // Deselect shows Esc, which the map's own Esc chain handles: no keymap row routes to it (keymap.test.ts).
    const deselect = selected.editActions.find((edit) => edit.id === 'deselect')!
    expect(deselect).toMatchObject({ commandId: 'canvas.clearSelection', label: 'menu.edit.deselect', shortcut: 'shortcutKeys.escape', ariaShortcut: 'Escape' })
    // Unlock all needs no selection, only a locked object somewhere in the Design.
    const unlockAll = createCanvasCommandProjection({ state: state({ lockedObjectsPresent: true }), run: vi.fn(), translate: (k) => k, characterKeys: true })
      .editActions.find((edit) => edit.id === 'unlock-all')!
    expect(unlockAll).toMatchObject({ commandId: 'canvas.unlockAll', label: 'menu.edit.unlockAll', disabled: false })

    const noCanvas = createCanvasCommandProjection({ state: state({ canvasAvailable: false }), run: vi.fn(), translate: (k) => k, characterKeys: true })
    expect(noCanvas.editActions.every((edit) => edit.disabled)).toBe(true)
    // View › Pan is the Pan tool, which primes the tool a canvas starts with, like Tools › Pan.
    expect(noCanvas.viewActions.filter((view) => view.disabled).map((view) => view.id))
      .toEqual(noCanvas.viewActions.map((view) => view.id).filter((id) => id !== 'pan'))
  })

  it('projects history, view commands and pressed view toggles', () => {
    const run = vi.fn()
    const projection = createCanvasCommandProjection({
      state: state({ canUndo: true, gridVisible: true, snapToGridEnabled: false }),
      run,
      translate: tagged,
      characterKeys: true,
    })

    expect(projection.historyActions.map(({ action: _action, ...command }) => command)).toEqual([
      { id: 'undo', commandId: 'edit.undo', label: 't:menu.edit.undo', shortcut: 'Ctrl Z', ariaShortcut: 'Control+Z Meta+Z', disabled: false },
      {
        id: 'redo',
        commandId: 'edit.redo',
        label: 't:menu.edit.redo',
        shortcut: 'Ctrl Shift Z',
        ariaShortcut: 'Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y',
        disabled: true,
      },
    ])
    projection.historyActions.forEach((command) => command.action())
    // Redo is disabled: only Undo runs.
    expect(run.mock.calls).toEqual([[{ type: 'undo' }, 'menu']])
    run.mockClear()

    expect(projection.viewActions.map((view) => [view.id, view.shortcut])).toEqual([
      ['zoom-in', 'Ctrl +'],
      ['zoom-out', 'Ctrl −'],
      ['fit-to-design', 'Shift F'],
      ['zoom-to-selection', 'Shift 2'],
      ['reset-north', 'N'],
      ['turn-view-left', 'Shift ←'],
      ['turn-view-right', 'Shift →'],
      ['pan', 'H'],
      ['search-place', 'Ctrl K'],
      ['cycle-labels', 'Shift L'],
    ])
    const view = (id: string) => projection.viewActions.find((command) => command.id === id)!
    view('fit-to-design').action()
    expect(run).toHaveBeenCalledWith({ type: 'view', action: 'fit-to-design' }, 'menu')
    run.mockClear()
    // Home fits with the map focused: shown beside Fit to Design for assistive tech, routed by its key row.
    expect(view('fit-to-design').ariaShortcut).toBe('Shift+F Control+0 Meta+0 Home')
    // Zoom to selection needs a selection.
    expect(view('zoom-to-selection').disabled).toBe(true)
    expect(createCanvasCommandProjection({ state: state({ selection: EVERYTHING }), run, translate: tagged, characterKeys: true })
      .viewActions.find((command) => command.id === 'zoom-to-selection')!.disabled).toBe(false)
    view('zoom-to-selection').action()
    expect(run).not.toHaveBeenCalled()

    expect(projection.settingsToggles.map((toggle) => [toggle.id, toggle.shortcut, toggle.pressed])).toEqual([
      ['grid', 'Shift G', true],
      ['snap', 'Shift S', false],
    ])
    projection.settingsToggles.forEach((toggle) => toggle.action())
    expect(run.mock.calls).toEqual([[{ type: 'toggle-grid' }, 'menu'], [{ type: 'toggle-snap-to-grid' }, 'menu']])
  })
})
