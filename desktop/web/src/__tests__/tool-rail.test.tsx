// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRail } from '../components/canvas/ToolRail'
import { ViewChip } from '../components/canvas/ViewChip'
import { workspaceCanvasCommandProjection } from '../app/workspace-commands/canvas-actions'
import {
  installToolRailLearning,
  RAIL_TOOL_IDS,
  toggleToolNames,
  toolRailShowsNames,
  toolRailShowsNamesOnMap,
} from '../app/tool-rail/learning'
import { toolRailRoom, visibleMapFrame } from '../app/shell/visible-map-area'
import { phoneLayout } from '../app/shell/phone-layout'
import { toolNamesVisible, usedCanvasTools, snapToGridEnabled } from '../app/settings/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { currentCanvasTool, currentCanvasSelection } from '../canvas/session-state'
import { activePanel, sidePanel } from '../app/shell/state'
import { gridVisible } from '../app/canvas-settings/signals'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { appCommandGraphChromeProjection } from '../commands/graph/projections'
import { flattenMenuActions } from '../app/shell-commands/menus'
import { installDesktopKeys } from './support/desktop-key-router'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'
import { hoveredTooltip } from './support/tooltip'

/** The rail as both editions mount it: the shared projection and the first-use setting. */
function Rail() {
  return <ToolRail projection={workspaceCanvasCommandProjection.value} showNames={toolRailShowsNamesOnMap.value} />
}

function Chip() {
  return <ViewChip toggles={workspaceCanvasCommandProjection.value.settingsToggles} />
}

describe('ToolRail', () => {
  let container: HTMLDivElement
  const canUndo = signal(false)
  const canRedo = signal(false)
  const setTool = vi.fn()
  const undo = vi.fn()
  const redo = vi.fn()
  const toggleGrid = vi.fn()
  const toggleSnapToGrid = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    currentCanvasTool.value = 'select'
    canUndo.value = false
    canRedo.value = false
    setTool.mockReset()
    undo.mockReset()
    redo.mockReset()
    toggleGrid.mockReset()
    toggleSnapToGrid.mockReset()
    currentCanvasSelection.value = new Set()
    activePanel.value = 'canvas'
    sidePanel.value = null
    gridVisible.value = true
    snapToGridEnabled.value = false
    usedCanvasTools.value = []
    toolNamesVisible.value = null
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({
        tools: { setTool },
        history: {
          canUndo,
          canRedo,
          undo,
          redo,
        },
        chrome: {
          toggleGrid,
          toggleSnapToGrid,
        },
      }),
      queries: createTestCanvasQuerySurface(),
    }))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    phoneLayout.value = null
    currentCanvasTool.value = 'select'
    currentCanvasSelection.value = new Set()
    activePanel.value = 'canvas'
    sidePanel.value = null
    gridVisible.value = true
    snapToGridEnabled.value = false
    setCurrentCanvasSession(null)
  })

  const mount = async (node = <Rail />) => {
    await act(async () => {
      render(node, container)
      await Promise.resolve()
    })
  }
  const railButton = (command: string) => container.querySelector<HTMLButtonElement>(`button[data-command="${command}"]`)!

  it('shows names and keys until every tool has been used once, then 52 px icons with tooltips', async () => {
    await mount()
    const rail = container.querySelector('[role="toolbar"]')!
    expect(rail.getAttribute('data-tool-rail')).toBe('named')
    expect(railButton('canvas.tool.plantSpacing').textContent).toBe('Plant a rowW')
    expect(railButton('canvas.tool.plantSpacing').hasAttribute('aria-label')).toBe(false)
    expect(container.textContent).toContain('Zones')
    expect(railButton('edit.undo').textContent).toBe('UndoCtrl Z')

    await act(async () => {
      usedCanvasTools.value = [...RAIL_TOOL_IDS]
    })
    expect(rail.getAttribute('data-tool-rail')).toBe('icons')
    const polygon = railButton('canvas.tool.polygon')
    expect(polygon.getAttribute('aria-label')).toBe('Polygon zone (Z)')
    expect(hoveredTooltip(polygon)?.textContent).toBe('Polygon zoneZ')
    expect(container.textContent).not.toContain('Zones')
  })

  it('records each tool the first time it becomes active, not the tool a canvas starts with', async () => {
    const uninstall = installToolRailLearning()
    try {
      expect(usedCanvasTools.value).toEqual([])
      await act(async () => { currentCanvasTool.value = 'polygon' })
      await act(async () => { currentCanvasTool.value = 'select' })
      await act(async () => { currentCanvasTool.value = 'polygon' })
      expect(usedCanvasTools.value).toEqual(['polygon', 'select'])
    } finally {
      uninstall()
    }
  })

  it('lets View › Tool names pin the rail either way, whatever has been used', async () => {
    await mount()
    expect(toolRailShowsNames.value).toBe(true)
    await act(async () => { toggleToolNames() })
    expect(toolNamesVisible.value).toBe(false)
    expect(container.querySelector('[data-tool-rail="icons"]')).not.toBeNull()

    await act(async () => { usedCanvasTools.value = [...RAIL_TOOL_IDS] })
    await act(async () => { toggleToolNames() })
    expect(toolNamesVisible.value).toBe(true)
    expect(container.querySelector('[data-tool-rail="named"]')).not.toBeNull()
  })

  it('keeps to icons with labelled tooltips when names would crowd the map beside an open dock', async () => {
    try {
      // 720 × 800 window with a 380 px dock open: the labelled rail would leave about 30 px of map.
      visibleMapFrame.value = { width: 720, height: 800, top: 60, right: 456, bottom: 56, left: 236 }
      await mount()
      expect(toolRailShowsNames.value).toBe(true)
      expect(container.querySelector('[data-tool-rail="icons"]')).not.toBeNull()
      const select = container.querySelector<HTMLButtonElement>('[data-command="canvas.tool.select"]')!
      expect(select.getAttribute('aria-label')).toMatch(/Select/)

      // Closing the dock gives the room back, and the names return.
      await act(async () => { visibleMapFrame.value = { width: 720, height: 800, top: 60, right: 76, bottom: 56, left: 64 } })
      expect(container.querySelector('[data-tool-rail="named"]')).not.toBeNull()
    } finally {
      visibleMapFrame.value = { width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }
    }
  })

  it('keeps to icons with labelled tooltips when a name would be cut off in the labelled rail', async () => {
    // A long label ("Wiederherstellen" in German) overflows its 224 px row.
    const long = 'Redo'
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-rail-label') && this.textContent === long ? 180 : 60
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-rail-label') ? 120 : 0
    })
    try {
      await mount()
      expect(toolRailShowsNames.value).toBe(true)
      const rail = container.querySelector('[role="toolbar"]')!
      expect(rail.getAttribute('data-tool-rail')).toBe('icons')
      expect(railButton('edit.redo').getAttribute('aria-label')).toBe('Redo (Ctrl Shift Z)')
      expect(hoveredTooltip(railButton('edit.redo')!)?.textContent).toBe('RedoCtrl Shift Z')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('presses the active tool and groups tools as the Menus board does', async () => {
    currentCanvasTool.value = 'ellipse'
    await mount()
    const tools = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
    expect(tools.map((button) => button.dataset.command)).toEqual([
      'canvas.tool.select',
      'canvas.tool.plantStamp', 'canvas.tool.plantSpacing', 'canvas.tool.objectStamp',
      'canvas.tool.polygon', 'canvas.tool.rectangle', 'canvas.tool.ellipse', 'canvas.tool.line',
      'canvas.tool.text', 'canvas.tool.measurementGuide',
    ])
    expect(tools.filter((button) => button.getAttribute('aria-pressed') === 'true').map((button) => button.dataset.command))
      .toEqual(['canvas.tool.ellipse'])
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(4)
  })

  it('selects a tool on click and keeps an open side panel', async () => {
    sidePanel.value = 'plant-db'
    await mount()
    await act(async () => { railButton('canvas.tool.line').click() })
    expect(setTool).toHaveBeenCalledWith('line')
    expect(currentCanvasTool.value).toBe('line')
    expect(sidePanel.value).toBe('plant-db')
    expect(activePanel.value).toBe('canvas')
  })

  it('moves focus with the arrow keys without choosing a tool (one tab stop)', async () => {
    await mount()
    const tabStops = [...container.querySelectorAll<HTMLButtonElement>('[data-rail-item]')].filter((button) => button.tabIndex === 0)
    expect(tabStops.map((button) => button.dataset.command)).toEqual(['canvas.tool.select'])

    railButton('canvas.tool.select').focus()
    await act(async () => {
      railButton('canvas.tool.select').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(railButton('canvas.tool.plantStamp'))
    expect(railButton('canvas.tool.plantStamp').tabIndex).toBe(0)
    expect(setTool).not.toHaveBeenCalled()

    await act(async () => {
      railButton('canvas.tool.plantStamp').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(document.activeElement).toBe(railButton('edit.redo'))
  })

  it('runs undo and redo from the rail only while history allows it', async () => {
    await mount()
    expect(railButton('edit.undo').getAttribute('aria-disabled')).toBe('true')
    await act(async () => { railButton('edit.undo').click() })
    expect(undo).not.toHaveBeenCalled()

    await act(async () => {
      canUndo.value = true
      canRedo.value = true
    })
    await act(async () => { railButton('edit.undo').click() })
    await act(async () => { railButton('edit.redo').click() })
    expect(undo).toHaveBeenCalledOnce()
    expect(redo).toHaveBeenCalledOnce()
  })

  it('keeps plant color and symbol off the rail: they live in the right-click menu', async () => {
    await mount()
    await act(async () => {
      usedCanvasTools.value = [...RAIL_TOOL_IDS]
      currentCanvasSelection.value = new Set(['plant-1'])
    })

    const labels = [...container.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label') ?? button.textContent)
    expect(labels.some((label) => /plant (color|symbol)/i.test(label ?? ''))).toBe(false)
    expect(container.querySelectorAll('button[data-rail-item]')).toHaveLength(
      RAIL_TOOL_IDS.length + 2,
    )
  })

  it('keeps to a strip of Select, Pan, Place plants and Polygon zone on a phone, with the rest in More and Undo in the top bar', async () => {
    await mount()
    await act(async () => {
      phoneLayout.value = 'portrait'
      currentCanvasTool.value = 'rectangle'
    })
    const rail = container.querySelector<HTMLElement>('[role="toolbar"]')!
    expect(rail.dataset.toolRail).toBe('phone')
    expect([...container.querySelectorAll<HTMLButtonElement>('[data-rail-item]')].map((button) => button.dataset.command ?? 'more')).toEqual([
      'canvas.tool.select', 'canvas.tool.hand', 'canvas.tool.plantStamp', 'canvas.tool.polygon', 'more',
    ])
    expect(railButton('edit.undo')).toBeNull()
    const more = container.querySelector<HTMLButtonElement>('[data-tool-rail-more]')!
    expect(more.hasAttribute('data-holds-active')).toBe(true)
    // Names never show on the strip, even before each tool has been used.
    expect(railButton('canvas.tool.polygon').getAttribute('aria-label')).toBe('Polygon zone (Z)')

    await act(async () => { phoneLayout.value = null })
    expect(rail.dataset.toolRail).toBe('named')
    expect(railButton('edit.undo')).not.toBeNull()
  })

  it('Pan is not on the main rail and stays in the phone strip', async () => {
    currentCanvasTool.value = 'hand'
    await mount()
    const railItems = () => [...container.querySelectorAll<HTMLButtonElement>('[data-rail-item]')]
    expect(railButton('canvas.tool.hand')).toBeNull()
    expect(container.querySelector('[data-tool-rail-more]')).toBeNull()
    // With Pan armed off the rail, the rail keeps its one tab stop on the first tool.
    expect(railItems().filter((button) => button.tabIndex === 0).map((button) => button.dataset.command)).toEqual(['canvas.tool.select'])
    // Using every rail tool ends first-use naming without Pan.
    expect(RAIL_TOOL_IDS).not.toContain('hand')
    await act(async () => { usedCanvasTools.value = [...RAIL_TOOL_IDS] })
    expect(container.querySelector('[role="toolbar"]')!.getAttribute('data-tool-rail')).toBe('icons')

    await act(async () => { phoneLayout.value = 'portrait' })
    expect(railItems().map((button) => button.dataset.command ?? 'more')).toEqual([
      'canvas.tool.select', 'canvas.tool.hand', 'canvas.tool.plantStamp', 'canvas.tool.polygon', 'more',
    ])
    expect(railButton('canvas.tool.hand').getAttribute('aria-pressed')).toBe('true')
  })

  describe('in a short window', () => {
    // The rail's measured layout: 4 px padding, 36 px buttons 2 px apart.
    const RAIL_TOP = 72
    const itemTop = (index: number) => RAIL_TOP + 4 + index * 38
    const box = (top: number, height: number) =>
      ({ left: 12, top, width: 52, height, x: 12, y: top, right: 64, bottom: top + height, toJSON: () => ({}) }) as DOMRect

    beforeEach(() => {
      usedCanvasTools.value = [...RAIL_TOOL_IDS]
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const rail = this.closest<HTMLElement>('[role="toolbar"]')
        if (!rail) return box(0, 0)
        const items = Array.from(rail.querySelectorAll('[data-rail-item]'))
        if (this === rail) return box(RAIL_TOP, itemTop(items.length - 1) + 36 + 4 - RAIL_TOP)
        const index = items.indexOf(this)
        return index < 0 ? box(0, 0) : box(itemTop(index), 36)
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
      toolRailRoom.value = null
    })

    const railItems = () => [...container.querySelectorAll<HTMLButtonElement>('[data-rail-item]')]
      .map((button) => button.dataset.command ?? button.getAttribute('aria-label'))

    it('folds the last tools into More before Undo and Redo, keeping tab order and the keys', async () => {
      await mount()
      expect(container.querySelector('[data-tool-rail-more]')).toBeNull()

      // Four tools, More, Undo and Redo end at 4 + 7 × 38 − 2 + 4 = 272 px.
      await act(async () => {
        toolRailRoom.value = 300
        await Promise.resolve()
      })
      expect(railItems()).toEqual([
        'canvas.tool.select', 'canvas.tool.plantStamp', 'canvas.tool.plantSpacing', 'canvas.tool.objectStamp',
        'More tools', 'edit.undo', 'edit.redo',
      ])
      const more = container.querySelector<HTMLButtonElement>('[data-tool-rail-more]')!
      expect(more.getAttribute('aria-haspopup')).toBe('menu')
      // Still one tab stop, and the arrows walk through More to Undo without opening it.
      expect(railItems().filter((_, index) => container.querySelectorAll<HTMLButtonElement>('[data-rail-item]')[index]!.tabIndex === 0))
        .toEqual(['canvas.tool.select'])
      railButton('canvas.tool.objectStamp').focus()
      await act(async () => {
        railButton('canvas.tool.objectStamp').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      expect(document.activeElement).toBe(more)
      await act(async () => {
        more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
      expect(document.activeElement).toBe(railButton('edit.undo'))
      expect(document.querySelector('[role="menu"]')).toBeNull()

      await act(async () => { more.click() })
      const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]'))
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringContaining('Polygon zone'),
        expect.stringContaining('Rectangle zone'),
        expect.stringContaining('Ellipse zone'),
        expect.stringContaining('Line zone'),
        expect.stringContaining('Text note'),
        expect.stringContaining('Measure'),
      ])
      expect(items[1]!.textContent).toContain('R')
      expect(items[1]!.getAttribute('aria-keyshortcuts')).toBe('R')
      await act(async () => { items[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(setTool).toHaveBeenCalledWith('rectangle')
      expect(currentCanvasTool.value).toBe('rectangle')
      // More shows that it holds the active tool.
      expect(container.querySelector('[data-tool-rail-more]')!.hasAttribute('data-holds-active')).toBe(true)

      // A taller window gives the tools back.
      await act(async () => {
        toolRailRoom.value = 900
        await Promise.resolve()
      })
      expect(container.querySelector('[data-tool-rail-more]')).toBeNull()
      expect(railItems()).toHaveLength(RAIL_TOOL_IDS.length + 2)
    })
  })
})

describe('ViewChip', () => {
  let container: HTMLDivElement
  const toggleGrid = vi.fn()
  const toggleSnapToGrid = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    toggleGrid.mockReset()
    toggleSnapToGrid.mockReset()
    gridVisible.value = false
    snapToGridEnabled.value = true
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ chrome: { toggleGrid, toggleSnapToGrid } }),
    }))
  })

  afterEach(async () => {
    await act(async () => { render(null, container) })
    container.remove()
    setCurrentCanvasSession(null)
  })

  it('the view chip and View menu show Grid and Snap to grid only, and Shift+R does nothing', async () => {
    const setTool = vi.fn()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ tools: { setTool }, chrome: { toggleGrid, toggleSnapToGrid } }),
    }))
    await act(async () => { render(<Chip />, container) })
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Grid', 'Snap to grid'])

    const view = appCommandGraphChromeProjection.value.menus.find((menu) => menu.id === 'view')!
    const toggles = flattenMenuActions([view]).filter((entry) => entry.id.startsWith('canvas.toggle'))
    expect(toggles.map((entry) => entry.label)).toEqual(['Grid', 'Snap to grid'])

    const keys = installDesktopKeys()
    try {
      const press = (key: string) => {
        const event = new KeyboardEvent('keydown', { key, shiftKey: true, cancelable: true })
        window.dispatchEvent(event)
        return event.defaultPrevented
      }
      expect(press('R')).toBe(false)
      expect(setTool).not.toHaveBeenCalled()
      expect(toggleGrid).not.toHaveBeenCalled()
      expect(toggleSnapToGrid).not.toHaveBeenCalled()
      // The router is live: Shift+G still toggles the grid.
      expect(press('G')).toBe(true)
      expect(toggleGrid).toHaveBeenCalledOnce()
    } finally {
      keys.dispose()
    }
  })

  it('shows Grid and Snap to grid as pressed toggles with a check when on', async () => {
    await act(async () => { render(<Chip />, container) })
    const toggles = [...container.querySelectorAll<HTMLButtonElement>('button')]
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('View')
    expect(toggles.map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
      ['Grid', 'false'],
      ['Snap to grid', 'true'],
    ])
    expect(toggles.map((button) => button.querySelector('svg') !== null)).toEqual([false, true])
    expect(toggles[0]!.getAttribute('aria-keyshortcuts')).toBe('Shift+G')

    await act(async () => { toggles.forEach((button) => button.click()) })
    expect(toggleGrid).toHaveBeenCalledOnce()
    expect(toggleSnapToGrid).toHaveBeenCalledOnce()

    await act(async () => { gridVisible.value = true })
    expect(toggles[0]!.getAttribute('aria-pressed')).toBe('true')
    expect(toggles[0]!.querySelector('svg')).not.toBeNull()
  })
})
