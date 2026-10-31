// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { signal } from '@preact/signals'
import { currentCanvasSelection, currentCanvasTool } from '../canvas/session-state'
import { activePanel, sidePanel } from '../app/shell/state'
import {
  gridVisible,
  snapToGridEnabled,
} from '../app/canvas-settings/signals'
import { singleKeyShortcuts, theme } from '../app/settings/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { designSessionFixture, resetDirtyBaselines } from './support/design-session-state'
import * as documentActions from '../app/document-session/actions'
import { problemReportDialogOpen } from '../app/problem-report/state'
import { answerSaveProblem, requestSaveProblemDecision } from '../app/document-session/save-problem'
import {
  recentFrontendDiagnostics,
  resetFrontendDiagnosticsForTests,
} from '../app/problem-report/diagnostics'
import * as settingsProjection from '../app/settings/projection'
import {
  appCommandGraphChromeProjection,
  appCommandGraphPanelProjection,
  appCommandGraphToolbarProjection,
  commandPaletteOpen,
} from '../commands/registry'
import type { KeyRouterHandle } from '../app/keyboard/key-router'
import { installDesktopKeys } from './support/desktop-key-router'
import { pressKey } from './support/key-router'
import { APP_COMMANDS, isCatalogCommandDisabled, type AppCommandId } from '../commands/graph/catalog'
import { flattenMenuActions } from '../app/shell-commands/menus'
import { currentDesign } from '../app/document-session/store'
import { designRenameRequest } from '../app/shell/requests'
import { keyboardShortcutsDialogOpen, settingsDialogOpen } from '../app/shell/dialogs'
import { placeSearchFocusRequest } from '../app/geocoding/place-search-ui'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'

function paletteCommands() {
  return appCommandGraphChromeProjection.value.paletteCommands
}

function menus() {
  return appCommandGraphChromeProjection.value.menus
}

function runPanelCommand(commandId: string): void {
  const projection = appCommandGraphPanelProjection.value
  const command = [...projection.primary, ...projection.design, ...projection.planning]
    .find((entry) => entry.commandId === commandId)
  if (!command) throw new Error(`Missing panel command ${commandId}`)
  command.action()
}

function getCommand(id: string) {
  const command = paletteCommands().find((entry) => entry.id === id)
  if (!command) throw new Error(`Missing command ${id}`)
  return command
}

function mountCanvasCommandSurface(overrides: Parameters<typeof createTestCanvasCommandSurface>[0]): void {
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands: createTestCanvasCommandSurface(overrides),
  }))
}

describe('command registry canvas tool switching', () => {
  it('keeps Web-only file identities outside the Desktop command interface', () => {
    expectTypeOf<'file.openCanopi'>().not.toMatchTypeOf<AppCommandId>()
    expectTypeOf<'file.downloadCanopi'>().not.toMatchTypeOf<AppCommandId>()
    expect(APP_COMMANDS.map((command) => command.id)).not.toContain('file.openCanopi')
    expect(APP_COMMANDS.map((command) => command.id)).not.toContain('file.downloadCanopi')
  })

  let keys: KeyRouterHandle

  beforeEach(() => {
    keys = installDesktopKeys()
    currentCanvasTool.value = 'select'
    activePanel.value = 'canvas'
    sidePanel.value = null
    setCurrentCanvasSession(null)
    designSessionFixture.file = null
    designSessionFixture.nonCanvasRevision = 0
    designSessionFixture.nonCanvasSavedRevision = 0
    gridVisible.value = true
    snapToGridEnabled.value = false
    settingsProjection.resetSettingsProjectionForTests()
    problemReportDialogOpen.value = false
    resetFrontendDiagnosticsForTests()
  })

  afterEach(() => {
    keys.dispose()
    vi.restoreAllMocks()
    setCurrentCanvasSession(null)
    currentCanvasTool.value = 'select'
    designSessionFixture.file = null
    theme.value = 'light'
    gridVisible.value = true
    snapToGridEnabled.value = false
    problemReportDialogOpen.value = false
    resetFrontendDiagnosticsForTests()
  })

  it('routes tool commands through the live canvas session when mounted', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    getCommand('canvas.tool.hand').action()

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)
    expect(setTool).toHaveBeenCalledWith('hand')
    expect(currentCanvasTool.value).toBe('hand')
  })

  it('preserves side panels only when tool commands already start from the canvas', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    sidePanel.value = 'plant-db'
    getCommand('canvas.tool.ellipse').action()

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('plant-db')
    expect(setTool).toHaveBeenCalledWith('ellipse')
    expect(currentCanvasTool.value).toBe('ellipse')

    activePanel.value = 'templates'
    sidePanel.value = null
    getCommand('canvas.tool.hand').action()

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)
    expect(setTool).toHaveBeenCalledWith('hand')
    expect(currentCanvasTool.value).toBe('hand')
  })

  it('exposes the ellipse tool through the shared command graph', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    getCommand('canvas.tool.ellipse').action()

    expect(getCommand('canvas.tool.ellipse').shortcut).toBe('E')
    expect(activePanel.value).toBe('canvas')
    expect(setTool).toHaveBeenCalledWith('ellipse')
    expect(currentCanvasTool.value).toBe('ellipse')
  })

  it('exposes the polygon tool through the shared command graph', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    getCommand('canvas.tool.polygon').action()

    expect(getCommand('canvas.tool.polygon').shortcut).toBe('Z')
    expect(activePanel.value).toBe('canvas')
    expect(setTool).toHaveBeenCalledWith('polygon')
    expect(currentCanvasTool.value).toBe('polygon')
  })

  it('exposes the Line tool through the shared command graph', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    getCommand('canvas.tool.line').action()

    expect(getCommand('canvas.tool.line').shortcut).toBe('L')
    expect(activePanel.value).toBe('canvas')
    expect(setTool).toHaveBeenCalledWith('line')
    expect(currentCanvasTool.value).toBe('line')
  })

  it('exposes the Measurement Guide tool through the shared command graph', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    getCommand('canvas.tool.measurementGuide').action()

    expect(activePanel.value).toBe('canvas')
    expect(setTool).toHaveBeenCalledWith('measurement-guide')
    expect(currentCanvasTool.value).toBe('measurement-guide')
    expect(appCommandGraphToolbarProjection.value.toolGroups.flatMap((group) => group.tools).some((tool) =>
      tool.tool === 'measurement-guide'
      && tool.commandId === 'canvas.tool.measurementGuide',
    )).toBe(true)
  })

  it('exposes Object Stamp through the shared command graph', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    getCommand('canvas.tool.objectStamp').action()

    expect(activePanel.value).toBe('canvas')
    expect(setTool).toHaveBeenCalledWith('object-stamp')
    expect(currentCanvasTool.value).toBe('object-stamp')
  })

  it('exposes Plant Spacing through the shared command graph', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    getCommand('canvas.tool.plantSpacing').action()

    expect(getCommand('canvas.tool.plantSpacing').shortcut).toBe('W')
    expect(activePanel.value).toBe('canvas')
    expect(setTool).toHaveBeenCalledWith('plant-spacing')
    expect(currentCanvasTool.value).toBe('plant-spacing')
  })

  it('H arms Pan', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })

    expect(pressKey({ key: 'h' }, document.body).defaultPrevented).toBe(true)

    expect(setTool).toHaveBeenCalledWith('hand')
    expect(currentCanvasTool.value).toBe('hand')
  })

  it('Shift+2 zooms to the selection on the Desktop keymap, and does nothing without one', () => {
    const zoomToSelection = vi.fn()
    mountCanvasCommandSurface({ viewport: { zoomToSelection } })
    const press = () => pressKey({ key: '@', code: 'Digit2', shiftKey: true }, document.body).defaultPrevented

    expect(press()).toBe(false)
    expect(zoomToSelection).not.toHaveBeenCalled()
    currentCanvasSelection.value = new Set(['plant-1'])
    try {
      expect(press()).toBe(true)
      expect(zoomToSelection).toHaveBeenCalledOnce()
    } finally {
      currentCanvasSelection.value = new Set()
    }
  })

  it('falls back to priming the mirror tool state when no session is mounted', () => {
    getCommand('canvas.tool.text').action()

    expect(activePanel.value).toBe('canvas')
    expect(currentCanvasTool.value).toBe('text')
  })

  it('uses the shared shortcut definitions for panel navigation and tools', () => {
    expect(paletteCommands().some((command) => command.id === 'nav.canvas')).toBe(false)
    expect(getCommand('nav.layers').shortcut).toBe('Ctrl 1')
    expect(getCommand('nav.siteData').shortcut).toBe('Ctrl 2')
    expect(getCommand('nav.speciesKey').shortcut).toBe('Ctrl 3')
    expect(getCommand('nav.plantDb').shortcut).toBe('Ctrl 4')
    expect(getCommand('nav.favorites').shortcut).toBe('Ctrl 5')
    expect(getCommand('nav.calendar').shortcut).toBe('Ctrl 6')
    expect(getCommand('nav.designNotebook').shortcut).toBe('Ctrl 9')
    expect(getCommand('nav.stories').shortcut).toBeUndefined()
    expect(getCommand('canvas.tool.select').shortcut).toBe('V')
    expect(getCommand('canvas.tool.line').shortcut).toBe('L')
    expect(getCommand('canvas.tool.text').shortcut).toBe('T')
    expect(getCommand('canvas.tool.measurementGuide').shortcut).toBe('M')
  })

  it('routes file commands through document-session actions', () => {
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
    designSessionFixture.nonCanvasRevision = 1
    designSessionFixture.nonCanvasSavedRevision = 0
    const newSpy = vi.spyOn(documentActions, 'newDesignAction').mockResolvedValue(undefined)
    const openSpy = vi.spyOn(documentActions, 'openDesign').mockResolvedValue(undefined)
    const saveSpy = vi.spyOn(documentActions, 'saveCurrentDesign').mockResolvedValue(true)
    const saveAsSpy = vi.spyOn(documentActions, 'saveAsCurrentDesign').mockResolvedValue(null)

    getCommand('file.new').action()
    getCommand('file.open').action()
    getCommand('file.save').action()
    getCommand('file.saveAs').action()

    expect(newSpy).toHaveBeenCalledTimes(1)
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveAsSpy).toHaveBeenCalledTimes(1)
  })

  it('does not expose Design Report PDF export from the command graph', () => {
    expect(paletteCommands().some((command) => String(command.id) === 'file.exportDesignReportPdf')).toBe(false)
    expect(flattenMenuActions(menus()).some((entry) => entry.id === 'file.exportDesignReportPdf')).toBe(false)
  })

  it('enables Save for any open Design, clean or not', () => {
    const saveCommand = getCommand('file.save')
    const saveSpy = vi.spyOn(documentActions, 'saveCurrentDesign').mockResolvedValue(true)

    expect(saveCommand.disabled()).toBe(true)

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
    resetDirtyBaselines()

    expect(saveCommand.disabled()).toBe(false)

    saveCommand.action()

    expect(saveSpy).toHaveBeenCalledTimes(1)
  })

  it('projects menu entries from the same command graph', () => {
    const commandIds = new Set(paletteCommands().map((command) => command.id))
    const menuCommandIds = menus()
      .flatMap((menu) => menu.items)
      .flatMap((entry) => entry.type === 'action' ? [entry.id] : [])

    expect(menuCommandIds).toContain('file.save')
    expect(menuCommandIds).toContain('edit.undo')
    expect(menuCommandIds).toContain('view.zoomIn')
    expect(commandIds.has('file.save')).toBe(true)
    expect(commandIds.has('view.zoomIn')).toBe(true)
  })

  it('exposes reactive chrome projections from the App Command Graph', () => {
    const fileSave = () => appCommandGraphChromeProjection.value.menus
      .find((menu) => menu.id === 'file')!
      .items.find((entry) => entry.type === 'action' && entry.id === 'file.save')
    const undo = () => appCommandGraphChromeProjection.value.menus
      .find((menu) => menu.id === 'edit')!
      .items.find((entry) => entry.type === 'action' && entry.id === 'edit.undo')
    const zoomIn = () => appCommandGraphChromeProjection.value.paletteCommands
      .find((entry) => entry.id === 'view.zoomIn')!

    expect(fileSave()).toMatchObject({ disabled: true })
    expect(undo()).toMatchObject({ disabled: true })
    expect(zoomIn().disabled()).toBe(true)

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
    designSessionFixture.nonCanvasRevision = 1
    designSessionFixture.nonCanvasSavedRevision = 0
    mountCanvasCommandSurface({ history: { canUndo: signal(true) } })

    expect(fileSave()).toMatchObject({ disabled: false })
    expect(undo()).toMatchObject({ disabled: false })
    expect(zoomIn().disabled()).toBe(false)
  })

  it('exposes panel navigation through the App Command Graph', () => {
    const panelCommand = (id: string) => [
      ...appCommandGraphPanelProjection.value.primary,
      ...appCommandGraphPanelProjection.value.design,
      ...appCommandGraphPanelProjection.value.planning,
    ].find((entry) => entry.panel === id)!

    expect(panelCommand('canvas')).toMatchObject({
      commandId: 'nav.canvas',
      disabled: false,
      active: true,
    })
    expect(panelCommand('location')).toBeUndefined()
    expect(panelCommand('plant-db')).toMatchObject({
      commandId: 'nav.plantDb',
      disabled: true,
      active: false,
    })
    expect(panelCommand('design-notebook')).toMatchObject({
      commandId: 'nav.designNotebook',
      disabled: false,
      active: false,
    })
    expect(panelCommand('favorites')).toMatchObject({
      commandId: 'nav.favorites',
      disabled: true,
      active: false,
    })
    runPanelCommand('nav.designNotebook')
    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('design-notebook')
    expect(panelCommand('design-notebook')).toMatchObject({ disabled: false, active: true })
    runPanelCommand('nav.designNotebook')
    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)

    runPanelCommand('nav.plantDb')
    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('plant-db')
    expect(panelCommand('plant-db')).toMatchObject({ disabled: false, active: true })
    runPanelCommand('nav.plantDb')
    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)

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

    expect(panelCommand('plant-db')).toMatchObject({ disabled: false, active: false })
    runPanelCommand('nav.plantDb')
    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('plant-db')
    expect(panelCommand('plant-db')).toMatchObject({ disabled: false, active: true })

    runPanelCommand('nav.plantDb')
    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe(null)
  })

  it('exposes toolbar commands through the App Command Graph', () => {
    const setTool = vi.fn()
    const undo = vi.fn()
    const toggleGrid = vi.fn()
    const toggleSnapToGrid = vi.fn()

    const railTool = (tool: string) => appCommandGraphToolbarProjection.value.toolGroups
      .flatMap((group) => group.tools)
      .find((entry) => entry.tool === tool)!
    const primaryTool = railTool
    const creationTool = railTool
    const reuseTool = railTool
    const historyAction = (id: string) => appCommandGraphToolbarProjection.value.historyActions
      .find((entry) => entry.id === id)!
    const settingToggle = (id: string) => appCommandGraphToolbarProjection.value.settingsToggles
      .find((entry) => entry.id === id)!

    expect(primaryTool('select')).toMatchObject({
      commandId: 'canvas.tool.select',
      active: true,
      disabled: false,
      shortcut: 'V',
    })
    expect(creationTool('line')).toMatchObject({
      commandId: 'canvas.tool.line',
      active: false,
      disabled: false,
      shortcut: 'L',
    })
    expect(creationTool('ellipse')).toMatchObject({
      commandId: 'canvas.tool.ellipse',
      active: false,
      disabled: false,
      shortcut: 'E',
    })
    expect(reuseTool('plant-spacing')).toMatchObject({
      commandId: 'canvas.tool.plantSpacing',
      active: false,
      disabled: false,
      shortcut: 'W',
    })
    expect(historyAction('undo')).toMatchObject({
      commandId: 'edit.undo',
      disabled: true,
      shortcut: 'Ctrl Z',
    })
    expect(settingToggle('grid')).toMatchObject({
      commandId: 'canvas.toggleGrid',
      disabled: true,
      pressed: true,
    })
    expect(settingToggle('snap')).toMatchObject({
      commandId: 'canvas.toggleSnapToGrid',
      disabled: true,
      pressed: false,
    })

    mountCanvasCommandSurface({
      tools: { setTool },
      history: {
        canUndo: signal(true),
        undo,
      },
      chrome: {
        toggleGrid,
        toggleSnapToGrid,
      },
    })
    snapToGridEnabled.value = true

    expect(historyAction('undo')).toMatchObject({ disabled: false })
    expect(settingToggle('grid')).toMatchObject({ disabled: false, pressed: true })
    expect(settingToggle('snap')).toMatchObject({ disabled: false, pressed: true })

    creationTool('ellipse').action('rail')
    historyAction('undo').action()
    settingToggle('grid').action()
    settingToggle('snap').action()

    expect(activePanel.value).toBe('canvas')
    expect(setTool).toHaveBeenCalledWith('ellipse')
    expect(currentCanvasTool.value).toBe('ellipse')
    expect(undo).toHaveBeenCalledTimes(1)
    expect(toggleGrid).toHaveBeenCalledTimes(1)
    expect(toggleSnapToGrid).toHaveBeenCalledTimes(1)
  })

  it('re-acquires the live Canvas surface for retained toolbar actions', () => {
    const detachedUndo = vi.fn()
    const replacementUndo = vi.fn()
    mountCanvasCommandSurface({
      history: {
        canUndo: signal(true),
        undo: detachedUndo,
      },
    })
    const retainedUndo = appCommandGraphToolbarProjection.value.historyActions
      .find((entry) => entry.id === 'undo')!.action

    setCurrentCanvasSession(null)
    retainedUndo()

    expect(detachedUndo).not.toHaveBeenCalled()

    mountCanvasCommandSurface({
      history: {
        canUndo: signal(true),
        undo: replacementUndo,
      },
    })
    retainedUndo()

    expect(detachedUndo).not.toHaveBeenCalled()
    expect(replacementUndo).toHaveBeenCalledTimes(1)
  })

  it('leaves editable undo shortcuts to native text editing', () => {
    const undo = vi.fn()
    mountCanvasCommandSurface({
      history: {
        canUndo: signal(true),
        undo,
      },
    })
    const input = document.createElement('input')
    document.body.append(input)

    const event = pressKey({ key: 'z', ctrlKey: true }, input)

    expect(event.defaultPrevented).toBe(false)
    expect(undo).not.toHaveBeenCalled()
    input.remove()
  })

  it('cycles View › Labels with Shift+L on the map, never while typing, and N resets north', () => {
    designSessionFixture.file = { ...emptyDesign() }
    const resetNorth = vi.fn()
    mountCanvasCommandSurface({ viewport: { resetNorth } })
    const keyDown = (target: EventTarget) => pressKey({ key: 'L', shiftKey: true }, target).defaultPrevented
    const labels = () => (currentDesign.value?.extra?.plant_display as { labels?: string } | undefined)?.labels ?? 'names'

    expect(keyDown(document.body)).toBe(true)
    expect(labels()).toBe('none')
    keyDown(document.body)
    expect(labels()).toBe('codes')
    keyDown(document.body)
    expect(labels()).toBe('names')

    const input = document.createElement('input')
    document.body.append(input)
    expect(keyDown(input)).toBe(false)
    expect(labels()).toBe('names')
    input.remove()

    // N moved from Labels to Reset north (spec §3.6).
    expect(pressKey({ key: 'n' }, document.body).defaultPrevented).toBe(true)
    expect(labels()).toBe('names')
    expect(resetNorth).toHaveBeenCalledOnce()
  })

  it('turns character-key shortcuts off everywhere with Settings › Keyboard, and keeps Ctrl and named keys', () => {
    designSessionFixture.file = { ...emptyDesign() }
    const undo = vi.fn()
    mountCanvasCommandSurface({ history: { undo, canUndo: signal(true) } } as never)
    const keyDown = (init: KeyboardEventInit) => pressKey(init).defaultPrevented
    const toolShortcut = () => flattenMenuActions(menus()).find((entry) => entry.id === 'canvas.tool.polygon')!.shortcut
    const fitShortcut = () => flattenMenuActions(menus()).find((entry) => entry.id === 'view.fitToDesign')!.shortcut
    const labels = () => (currentDesign.value?.extra?.plant_display as { labels?: string } | undefined)?.labels ?? 'names'

    try {
      expect(toolShortcut()).toBe('Z')
      expect(getCommand('canvas.tool.polygon').shortcut).toBe('Z')
      singleKeyShortcuts.value = false

      expect(keyDown({ key: 'z' })).toBe(false)
      expect(currentCanvasTool.value).toBe('select')
      expect(keyDown({ key: 'L', shiftKey: true })).toBe(false)
      expect(labels()).toBe('names')
      expect(keyDown({ key: 'F', shiftKey: true })).toBe(false)
      // Menus, the palette and the F1 list drop the keys that no longer work.
      expect(toolShortcut()).toBeUndefined()
      expect(getCommand('canvas.tool.polygon').shortcut).toBeUndefined()
      expect(fitShortcut()).toBe('Ctrl 0')
      // Reset north shows the chord that still works: Shift N.
      expect(flattenMenuActions(menus()).find((entry) => entry.id === 'view.resetNorth')!.shortcut).toBe('Shift N')

      expect(keyDown({ key: ',', ctrlKey: true })).toBe(true)
      expect(settingsDialogOpen.value).toBe(true)
    } finally {
      singleKeyShortcuts.value = true
      settingsDialogOpen.value = false
    }
    expect(keyDown({ key: 'L', shiftKey: true })).toBe(true)
    expect(labels()).toBe('none')
  })

  it('ignores app shortcuts and the palette while the save dialog is open', async () => {
    const openSpy = vi.spyOn(documentActions, 'openDesign').mockResolvedValue(undefined)
    const keyDown = (init: KeyboardEventInit) => {
      const event = pressKey(init)
      return { handled: event.defaultPrevented, event }
    }
    const decision = requestSaveProblemDecision({ kind: 'revert' })

    const open = keyDown({ key: 'o', ctrlKey: true })
    const palette = keyDown({ key: 'P', ctrlKey: true, shiftKey: true })

    expect(open.handled).toBe(false)
    expect(open.event.defaultPrevented).toBe(false)
    expect(palette.handled).toBe(false)
    expect(commandPaletteOpen.value).toBe(false)
    expect(openSpy).not.toHaveBeenCalled()

    answerSaveProblem('cancel')
    await expect(decision).resolves.toBe('cancel')
    expect(keyDown({ key: 'o', ctrlKey: true }).handled).toBe(true)
    expect(openSpy).toHaveBeenCalledOnce()
  })

  it('toggles theme through the settings projection seam', () => {
    theme.value = 'light'
    const mutateSpy = vi.spyOn(settingsProjection, 'mutateSettingsProjection')

    getCommand('view.toggleTheme').action()

    expect(theme.value).toBe('dark')
    expect(mutateSpy).toHaveBeenCalledWith(expect.any(Function), { persist: 'immediate' })
  })

  it('opens problem reporting from the shared command graph', () => {
    getCommand('help.reportProblem').action()

    expect(problemReportDialogOpen.value).toBe(true)

    const help = menus().find((menu) => menu.id === 'help')
    expect(flattenMenuActions(help ? [help] : []).some((entry) => entry.id === 'help.reportProblem')).toBe(true)
  })

  it('records async command failures for Problem Reports', async () => {
    vi.spyOn(documentActions, 'newDesignAction').mockRejectedValue(new Error('disk failed at /home/alice/design.canopi'))

    getCommand('file.new').action()
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))

    expect(recentFrontendDiagnostics()).toEqual([
      expect.objectContaining({
        level: 'error',
        source: 'command:New design',
        message: expect.stringContaining('disk failed'),
      }),
    ])
    expect(recentFrontendDiagnostics()[0]!.message).not.toContain('/home/alice')
  })

  it('puts every command in File, Edit, View, Tools or Help with its shortcut', () => {
    const byMenu = Object.fromEntries(menus().map((menu) => [menu.id, flattenMenuActions([menu]).map((item) => item.id)]))

    expect(Object.keys(byMenu)).toEqual(['file', 'edit', 'view', 'tools', 'help'])
    expect(byMenu.file).toEqual([
      'file.new', 'file.open', 'file.rename', 'file.save', 'file.saveAs', 'file.revert',
      'file.addData', 'file.importGeoJson', 'file.dataLibrary', 'file.exportCanvasPdf', 'file.exportGeoJson', 'file.exportBudgetCsv',
      'app.settings', 'file.close', 'file.exit',
    ])
    expect(byMenu.edit).toEqual([
      'edit.undo', 'edit.redo',
      'canvas.cut', 'canvas.copy', 'canvas.paste', 'canvas.duplicateSelected', 'canvas.deleteSelected',
      'canvas.selectAll', 'canvas.selectSameSpecies', 'canvas.clearSelection', 'edit.findPlants',
      'canvas.groupSelected', 'canvas.ungroupSelected', 'canvas.bringToFront', 'canvas.sendToBack',
      'canvas.rotateSelected',
      'canvas.lockSelected', 'canvas.unlockSelected', 'canvas.unlockAll', 'canvas.saveSelectionAsStamp',
    ])
    expect(byMenu.view).toEqual([
      'view.zoomIn', 'view.zoomOut', 'view.fitToDesign', 'view.zoomToSelection',
      'view.resetNorth', 'view.turnViewLeft', 'view.turnViewRight', 'canvas.tool.hand', 'view.searchPlace',
      'view.saveCurrentView', 'view.manageViews',
      'canvas.toggleGrid', 'canvas.toggleSnapToGrid',
      'view.labels:none', 'view.labels:codes', 'view.labels:names', 'view.toggleToolNames',
      'nav.layers', 'nav.siteData', 'nav.speciesKey', 'nav.plantDb', 'nav.favorites',
      'nav.calendar', 'nav.budget', 'nav.consortium', 'nav.designNotebook', 'nav.stories',
      'view.backgroundSatellite', 'view.backgroundMap', 'view.backgroundNone', 'view.toggleTheme',
    ])
    expect(byMenu.tools).toEqual([
      'canvas.tool.select', 'canvas.tool.hand',
      'canvas.tool.plantStamp', 'canvas.tool.plantSpacing', 'canvas.tool.objectStamp',
      'canvas.tool.polygon', 'canvas.tool.rectangle', 'canvas.tool.ellipse', 'canvas.tool.line',
      'canvas.tool.text', 'canvas.tool.measurementGuide',
    ])
    expect(byMenu.help).toEqual(['help.commandPalette', 'help.shortcuts', 'help.gettingStarted', 'help.reportProblem', 'help.aboutCanopi'])

    // Every palette command with a shortcut shows the same shortcut in its menu
    // item, or on the submenu it acts on (Shift L on View › Labels).
    const menuShortcut = new Map([
      ...flattenMenuActions(menus()).map((item) => [item.id, item.shortcut] as const),
      ...menus().flatMap((menu) => menu.items).flatMap((entry) => entry.type === 'submenu' && entry.shortcut
        ? [[entry.id, entry.shortcut] as const]
        : []),
    ])
    for (const command of paletteCommands()) {
      if (command.shortcut) expect(menuShortcut.get(command.id), command.id).toBe(command.shortcut)
    }
    expect(menuShortcut.get('file.rename')).toBe('F2')
    expect(menuShortcut.get('app.settings')).toBe('Ctrl ,')
    expect(menuShortcut.get('view.fitToDesign')).toBe('Shift F')
    expect(menuShortcut.get('view.zoomToSelection')).toBe('Shift 2')
    expect(menuShortcut.get('view.searchPlace')).toBe('Ctrl K')
    expect(menuShortcut.get('help.shortcuts')).toBe('F1')
    // The palette is a Help command like F1, so its key is discoverable there and in the F1 list.
    expect(menuShortcut.get('help.commandPalette')).toBe('Ctrl Shift P')
    expect(paletteCommands().some((command) => command.id === 'help.commandPalette')).toBe(false)
    expect(menuShortcut.get('file.exportCanvasPdf')).toBe('Ctrl P')
    expect(menuShortcut.get('edit.findPlants')).toBe('Ctrl F')
    expect(menuShortcut.get('view.cycleLabels')).toBe('Shift L')
    expect(menuShortcut.get('view.resetNorth')).toBe('N')
    expect(menuShortcut.get('file.close')).toBe('Ctrl W')
    expect(menuShortcut.get('canvas.rotateSelected')).toBe('Ctrl Alt R')
    expect(menuShortcut.get('canvas.lockSelected')).toBe('Ctrl Shift L')
    // Esc belongs to the map's own chain; the menu names it without routing it.
    expect(menuShortcut.get('canvas.clearSelection')).toBe('Esc')
  })

  it('lists Reset north, Turn view left 15° and Turn view right 15° in the View menu and the palette, after Fit to Design and Zoom to selection', () => {
    const resetNorth = vi.fn()
    const rotateBy = vi.fn()
    mountCanvasCommandSurface({ viewport: { resetNorth, rotateBy } })
    const view = menus().find((menu) => menu.id === 'view')!
    const rows = flattenMenuActions([view]).filter((item) => item.id === 'view.resetNorth' || item.id.startsWith('view.turnView'))

    expect(rows.map((item) => [item.label, item.shortcut, item.ariaShortcut, item.disabled])).toEqual([
      ['Reset north', 'N', 'N Shift+N Shift+ArrowUp', false],
      ['Turn view left 15°', 'Shift ←', 'Shift+ArrowLeft', false],
      ['Turn view right 15°', 'Shift →', 'Shift+ArrowRight', false],
    ])
    const ids = flattenMenuActions([view]).map((item) => item.id)
    expect(ids.indexOf('view.zoomToSelection')).toBe(ids.indexOf('view.fitToDesign') + 1)
    expect(ids.indexOf('view.resetNorth')).toBe(ids.indexOf('view.zoomToSelection') + 1)
    for (const id of ['view.resetNorth', 'view.turnViewLeft', 'view.turnViewRight']) {
      expect(getCommand(id).shortcut, id).toBe(rows.find((item) => item.id === id)!.shortcut)
    }

    rows[0]!.action()
    rows[1]!.action()
    getCommand('view.turnViewRight').action()
    expect(resetNorth).toHaveBeenCalledOnce()
    expect(rotateBy.mock.calls).toEqual([[-1], [1]])
  })

  it('places Open recent right after Open in the File menu', () => {
    const file = menus().find((menu) => menu.id === 'file')!
    const ids = file.items.flatMap((entry) => entry.type === 'separator' ? [] : [entry.id])
    expect(ids[ids.indexOf('file.open') + 1]).toBe('file.openRecent')
    expect(ids.filter((id) => id === 'file.openRecent')).toHaveLength(1)
  })

  it('marks checkable View items with their state and groups Export, Arrange, Saved views and Background as submenus', () => {
    theme.value = 'dark'
    gridVisible.value = true
    snapToGridEnabled.value = false
    const view = menus().find((menu) => menu.id === 'view')!
    const item = (id: string) => flattenMenuActions([view]).find((entry) => entry.id === id)!

    expect(item('view.toggleTheme')).toMatchObject({ check: 'checkbox', checked: true })
    expect(item('view.labels:names')).toMatchObject({ label: 'Names', check: 'radio', checked: true })
    expect(item('view.labels:none')).toMatchObject({ label: 'None', check: 'radio', checked: false })
    expect(item('canvas.toggleGrid')).toMatchObject({ check: 'checkbox', checked: true })
    expect(item('canvas.toggleSnapToGrid')).toMatchObject({ check: 'checkbox', checked: false })
    expect(item('view.backgroundMap').check).toBe('radio')
    expect(item('view.zoomIn').check).toBeUndefined()
    const submenus = menus().flatMap((menu) => menu.items).flatMap((entry) => entry.type === 'submenu' ? [entry.id] : [])
    expect(submenus).toEqual(['file.openRecent', 'submenu.export', 'edit.arrange', 'view.savedViews', 'view.cycleLabels', 'submenu.background'])
  })

  it('routes F2, Ctrl , and F1 to the title bar and dialogs from anywhere', () => {
    designSessionFixture.file = { ...emptyDesign() }
    const before = designRenameRequest.value
    const keyDown = (init: KeyboardEventInit) => pressKey(init).defaultPrevented

    expect(keyDown({ key: 'F2' })).toBe(true)
    expect(designRenameRequest.value).toBe(before + 1)
    expect(keyDown({ key: ',', ctrlKey: true })).toBe(true)
    expect(settingsDialogOpen.value).toBe(true)
    expect(keyDown({ key: 'F1' })).toBe(true)
    expect(keyboardShortcutsDialogOpen.value).toBe(true)
    settingsDialogOpen.value = false
    keyboardShortcutsDialogOpen.value = false
  })

  it('offers Profile in the Desktop palette with no shortcut, disabled until an elevation or height layer is shown (U49 Q31)', () => {
    designSessionFixture.file = { ...emptyDesign() }
    const profile = getCommand('siteData.profile')

    expect(profile.label()).toBe('Profile')
    expect(profile.shortcut).toBeUndefined()
    expect(isCatalogCommandDisabled('siteData.profile')).toBe(true)
    expect(flattenMenuActions(menus()).some((item) => item.id === 'siteData.profile')).toBe(false)
  })

  it('opens panels with Ctrl 1–9 and never with a bare digit', () => {
    designSessionFixture.file = { ...emptyDesign() }
    const keyDown = (init: KeyboardEventInit) => pressKey(init).defaultPrevented

    expect(keyDown({ key: '1' })).toBe(false)
    expect(sidePanel.value).toBe(null)
    expect(keyDown({ key: '1', ctrlKey: true })).toBe(true)
    expect(sidePanel.value).toBe('layers')
    expect(keyDown({ key: '2', ctrlKey: true })).toBe(true)
    expect(sidePanel.value).toBe('site-data')
    expect(keyDown({ key: '7', ctrlKey: true })).toBe(true)
    expect(sidePanel.value).toBe('budget')
  })

  it('focuses the title-bar place field with Ctrl K, even from a text field', () => {
    mountCanvasCommandSurface({})
    const before = placeSearchFocusRequest.value
    const input = document.createElement('input')
    document.body.append(input)
    const event = pressKey({ key: 'k', ctrlKey: true }, input)

    expect(event.defaultPrevented).toBe(true)
    expect(placeSearchFocusRequest.value).toBe(before + 1)
    input.remove()
  })

  it('runs canvas edits from the menus on the live surface', () => {
    const copy = vi.fn()
    const deleteSelected = vi.fn()
    mountCanvasCommandSurface({ sceneEdits: { copy, deleteSelected } })
    const edit = menus().find((menu) => menu.id === 'edit')!
    const cut = flattenMenuActions([edit]).find((entry) => entry.id === 'canvas.cut')!

    expect(cut.disabled).toBe(true)
    cut.action()
    expect(copy).not.toHaveBeenCalled()
  })

  it('arms Place plants without a species, for the tool card to offer its chooser', () => {
    const setTool = vi.fn()
    mountCanvasCommandSurface({ tools: { setTool } })
    sidePanel.value = null

    getCommand('canvas.tool.plantStamp').action()
    expect(setTool).toHaveBeenCalledWith('plant-stamp')
    expect(sidePanel.value).toBeNull()
  })

})

function emptyDesign() {
  return {
    version: 7,
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
}
