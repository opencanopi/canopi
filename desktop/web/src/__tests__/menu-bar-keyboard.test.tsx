// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuAction, MenuDefinition } from '../app/shell-commands/menus'
import { MenuBar } from '../components/shared/MenuBar'
import { appCommandGraphChromeProjection } from '../commands/graph/projections'
import { setCurrentCanvasSession } from '../canvas/session'
import { currentCanvasTool } from '../canvas/session-state'
import {
  createTestCanvasCommandSurface,
  createTestCanvasKeyboardPort,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'
import { installCanvasKeyRouter, pressKey } from './support/key-router'
import { beforePaint } from './support/before-paint'

function action(id: string, overrides: Partial<MenuAction> = {}): MenuAction {
  return { type: 'action', id, label: id, disabled: false, action: vi.fn(), ...overrides }
}

function menus(): MenuDefinition[] {
  return [
    {
      id: 'file',
      label: 'File',
      items: [
        action('new', { shortcut: 'Ctrl N', ariaShortcut: 'Control+N Meta+N' }),
        { type: 'separator' },
        {
          type: 'submenu',
          id: 'export',
          label: 'Export',
          disabled: false,
          items: [action('pdf'), action('geojson')],
        },
        action('quit', { disabled: true }),
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        action('grid', { check: 'checkbox', checked: true }),
        action('snap', { check: 'checkbox', checked: false }),
        {
          type: 'submenu',
          id: 'background',
          label: 'Background',
          shortcut: 'B',
          ariaShortcut: 'B',
          disabled: false,
          items: [action('map', { check: 'radio', checked: true }), action('none', { check: 'radio', checked: false })],
        },
      ],
    },
    { id: 'help', label: 'Help', items: [action('about')] },
  ]
}

describe('MenuBar keyboard and semantics', () => {
  let container: HTMLDivElement
  let items: MenuDefinition[]
  const onMenuOpen = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    items = menus()
    onMenuOpen.mockClear()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  const trigger = (id: string) => container.querySelector<HTMLButtonElement>(`[data-menu-id="${id}"]`)!
  const openMenu = () => container.querySelector<HTMLElement>('[data-menu-popup="root"]')
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  // Focus moves on the frame after the menu renders.
  const key = async (target: Element, name: string) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
    })
    await act(async () => { await frame() })
  }

  it('is a labelled menubar of menu buttons that open menus with shortcuts and a check column', async () => {
    await act(async () => { render(<MenuBar menus={items} label="Menus" onMenuOpen={onMenuOpen} />, container) })
    const bar = container.querySelector('[role="menubar"]')!
    expect(bar.getAttribute('aria-label')).toBe('Menus')
    expect(trigger('file').getAttribute('aria-haspopup')).toBe('menu')

    await act(async () => { trigger('view').click() })
    expect(onMenuOpen).toHaveBeenCalledWith('view')
    const view = openMenu()!
    const grid = view.querySelector('[data-command-id="grid"]')!
    expect(grid.getAttribute('role')).toBe('menuitemcheckbox')
    expect(grid.getAttribute('aria-checked')).toBe('true')
    expect(grid.querySelector('svg')).not.toBeNull()
    expect(view.querySelector('[data-command-id="snap"]')!.getAttribute('aria-checked')).toBe('false')
    // A submenu whose key acts on it as a whole shows that key (View › Labels, Shift+L; View › Background, B).
    const background = view.querySelector('[data-submenu-id="background"]')!
    expect(background.textContent).toBe('BackgroundB')
    expect(background.getAttribute('aria-keyshortcuts')).toBe('B')

    await act(async () => { trigger('file').click() })
    const file = openMenu()!
    expect(file.querySelector('[data-command-id="new"]')!.textContent).toBe('newCtrl N')
    expect(file.querySelector('[data-command-id="new"]')!.getAttribute('aria-keyshortcuts')).toBe('Control+N Meta+N')
    expect(file.querySelector('[role="separator"]')).not.toBeNull()
    // No checkable items in File: no check column.
    expect(file.querySelector('[data-command-id="new"] > span')!.className).toContain('itemLabel')

    await act(async () => { trigger('file').click() })
    expect(openMenu()).toBeNull()
  })

  it('moves through items with arrows, Home and End, and between menus with Left and Right', async () => {
    await act(async () => { render(<MenuBar menus={items} label="Menus" />, container) })
    trigger('file').focus()
    await key(trigger('file'), 'ArrowDown')
    const file = openMenu()!
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('new')

    await key(file, 'ArrowDown')
    expect(document.activeElement?.getAttribute('data-submenu-id')).toBe('export')
    await key(file, 'End')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('quit')
    await key(file, 'ArrowDown')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('new')
    await key(file, 'ArrowUp')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('quit')
    await key(file, 'Home')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('new')

    await key(file, 'ArrowRight')
    expect(trigger('view').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('grid')
    await key(openMenu()!, 'ArrowLeft')
    expect(trigger('file').getAttribute('aria-expanded')).toBe('true')

    await key(openMenu()!, 'Escape')
    expect(openMenu()).toBeNull()
    expect(document.activeElement).toBe(trigger('file'))
  })

  it('opens a submenu with Right, walks it, and returns with Left or Escape', async () => {
    await act(async () => { render(<MenuBar menus={items} label="Menus" />, container) })
    trigger('file').focus()
    await key(trigger('file'), 'Enter')
    const file = openMenu()!
    await key(file, 'ArrowDown')
    const exportTrigger = document.activeElement as HTMLElement
    await key(exportTrigger, 'ArrowRight')
    expect(exportTrigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('pdf')

    const submenu = file.querySelector('[role="menu"]')!
    await key(submenu, 'ArrowDown')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('geojson')
    await key(submenu, 'ArrowDown')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('pdf')
    await key(submenu, 'End')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('geojson')
    await key(submenu, 'Home')
    await key(submenu, 'ArrowUp')
    expect(document.activeElement?.getAttribute('data-command-id')).toBe('geojson')
    await key(submenu, 'ArrowLeft')
    expect(document.activeElement).toBe(exportTrigger)
    expect(exportTrigger.getAttribute('aria-expanded')).toBe('false')

    await act(async () => { exportTrigger.click() })
    await act(async () => { await frame() })
    await key(file.querySelector('[role="menu"]')!, 'Escape')
    expect(file.querySelector('[role="menu"]')).toBeNull()
    expect(openMenu()).not.toBeNull()
  })

  it('entered from a menu button, an Esc or a command gives focus to the button of the menu open last (APG)', async () => {
    await act(async () => { render(<MenuBar menus={items} label="Menus" />, container) })
    trigger('file').focus()
    await key(trigger('file'), 'Enter')
    await key(openMenu()!, 'ArrowRight')
    expect(trigger('view').getAttribute('aria-expanded')).toBe('true')
    await key(openMenu()!, 'Escape')
    expect(openMenu()).toBeNull()
    expect(document.activeElement, 'View\'s menu closed, so its button has focus').toBe(trigger('view'))

    // Left and Right on the buttons while a menu is open move the open menu with them.
    await key(trigger('view'), 'ArrowDown')
    trigger('view').focus()
    await key(trigger('view'), 'ArrowRight')
    expect(trigger('help').getAttribute('aria-expanded')).toBe('true')
    await key(trigger('help'), 'Escape')
    expect(document.activeElement).toBe(trigger('help'))

    // A command run from a sibling menu reached by keyboard returns focus to that menu's button.
    await key(trigger('help'), 'ArrowLeft')
    await key(trigger('view'), 'ArrowDown')
    await key(openMenu()!, 'ArrowLeft')
    expect(trigger('file').getAttribute('aria-expanded')).toBe('true')
    await key(openMenu()!, 'ArrowRight')
    await act(async () => { openMenu()!.querySelector<HTMLButtonElement>('[data-command-id="grid"]')!.click() })
    expect(openMenu()).toBeNull()
    expect(document.activeElement).toBe(trigger('view'))
  })

  it('opened by a click from outside the bar, an Esc after moving to another menu gives focus back to where it was', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    try {
      await act(async () => { render(<MenuBar menus={items} label="Menus" />, container) })
      outside.focus()
      await act(async () => {
        trigger('file').dispatchEvent(new Event('pointerdown', { bubbles: true }))
        trigger('file').focus()
        trigger('file').click()
      })
      await act(async () => { trigger('help').dispatchEvent(new MouseEvent('mouseenter')) })
      expect(trigger('help').getAttribute('aria-expanded')).toBe('true')
      await key(openMenu()!, 'Escape')
      expect(openMenu()).toBeNull()
      expect(document.activeElement).toBe(outside)
    } finally {
      outside.remove()
    }
  })

  it('runs an enabled item, closes and returns focus; disabled items stay put', async () => {
    await act(async () => { render(<MenuBar menus={items} label="Menus" />, container) })
    await act(async () => { trigger('file').click() })
    const quit = openMenu()!.querySelector<HTMLButtonElement>('[data-command-id="quit"]')!
    expect(quit.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { quit.click() })
    expect((items[0]!.items[3] as MenuAction).action).not.toHaveBeenCalled()
    expect(openMenu()).not.toBeNull()

    await act(async () => { openMenu()!.querySelector<HTMLButtonElement>('[data-command-id="new"]')!.click() })
    expect((items[0]!.items[0] as MenuAction).action).toHaveBeenCalledOnce()
    expect(openMenu()).toBeNull()
    expect(document.activeElement).toBe(trigger('file'))
  })

  it('switches open menus on hover and closes on an outside press or Tab', async () => {
    await act(async () => { render(<MenuBar menus={items} label="Menus" />, container) })
    await act(async () => { trigger('file').dispatchEvent(new MouseEvent('mouseenter')) })
    expect(openMenu()).toBeNull()
    await act(async () => { trigger('file').click() })
    await act(async () => { trigger('help').dispatchEvent(new MouseEvent('mouseenter')) })
    expect(trigger('help').getAttribute('aria-expanded')).toBe('true')

    await act(async () => { document.body.dispatchEvent(new Event('pointerup', { bubbles: true })) })
    expect(openMenu()).toBeNull()

    trigger('view').focus()
    await key(trigger('view'), 'ArrowUp')
    expect(document.activeElement?.getAttribute('data-submenu-id')).toBe('background')
    await key(openMenu()!, 'Tab')
    expect(openMenu()).toBeNull()

    trigger('view').focus()
    await key(trigger('view'), 'ArrowRight')
    expect(document.activeElement).toBe(trigger('help'))
    await key(trigger('help'), 'ArrowLeft')
    expect(document.activeElement).toBe(trigger('view'))
  })

  it('an Esc from the map closes a menu opened by click, never reaches the canvas, and gives the map its focus back', async () => {
    const map = document.createElement('div')
    map.tabIndex = -1
    document.body.appendChild(map)
    const escape = vi.fn()
    const port = createTestCanvasKeyboardPort({ host: map, escapeLayers: () => ['tool-transient', 'tool'], escape })
    const keys = installCanvasKeyRouter(() => port)
    try {
      await act(async () => { render(<MenuBar menus={items} label="Menus" />, container) })
      // A polygon draft is live on the focused map; a click opens File. Safari and WKWebView leave focus on the map.
      map.focus()
      const openByClick = async (focusesButton: boolean) => {
        await act(async () => {
          trigger('file').dispatchEvent(new Event('pointerdown', { bubbles: true }))
          if (focusesButton) trigger('file').focus()
          trigger('file').click()
        })
        expect(openMenu()).not.toBeNull()
      }
      await openByClick(false)
      expect(document.activeElement).toBe(map)

      const first = pressKey({ key: 'Escape' }, map)
      await act(async () => { await frame() })
      expect(openMenu()).toBeNull()
      expect(first.defaultPrevented).toBe(true)
      expect(escape).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(map)

      // Chromium focuses the button on press; its Esc still hands focus back to the map, not to the button.
      await openByClick(true)
      const second = pressKey({ key: 'Escape' }, trigger('file'))
      await act(async () => { await frame() })
      expect(openMenu()).toBeNull()
      expect(second.defaultPrevented).toBe(true)
      expect(escape).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(map)

      // With the menu closed, Esc is the canvas's again.
      pressKey({ key: 'Escape' }, map)
      expect(escape).toHaveBeenCalledWith('tool-transient')
    } finally {
      keys.dispose()
      map.remove()
    }
  })

  // canopi-f47t.52.228.20: the open menu's Esc layer registered after paint (useSignalEffect re-runs there in Preact 11),
  // so an Esc right after the click reached the canvas and the menu stayed open (e2e/canvas/menu-esc-focus.spec.ts).
  it('canopi-f47t.52.228.20: a menu opened by click takes an Esc from the map on its first painted frame', async () => {
    const map = document.createElement('div')
    map.tabIndex = -1
    document.body.appendChild(map)
    const escape = vi.fn()
    const port = createTestCanvasKeyboardPort({ host: map, escapeLayers: () => ['tool-transient', 'tool'], escape })
    const keys = installCanvasKeyRouter(() => port)
    try {
      await act(async () => { render(<MenuBar menus={items} label="Menus" />, container) })
      map.focus()
      trigger('file').dispatchEvent(new Event('pointerdown', { bubbles: true }))
      trigger('file').click()
      await beforePaint()
      expect(openMenu()).not.toBeNull()

      const press = pressKey({ key: 'Escape' }, map)
      await beforePaint()
      expect(escape, 'the canvas never heard it').not.toHaveBeenCalled()
      expect(press.defaultPrevented).toBe(true)
      expect(openMenu(), 'Esc closed the menu').toBeNull()
      expect(document.activeElement).toBe(map)
    } finally {
      keys.dispose()
      map.remove()
    }
  })

  it('marks radio submenu items with menuitemradio', async () => {
    await act(async () => { render(<MenuBar menus={items} label="Menus" />, container) })
    await act(async () => { trigger('view').click() })
    const wrap = openMenu()!.querySelector('[data-submenu-id="background"]')!.parentElement!
    await act(async () => { wrap.dispatchEvent(new MouseEvent('mouseenter')) })
    const map = openMenu()!.querySelector('[data-command-id="map"]')!
    expect(map.getAttribute('role')).toBe('menuitemradio')
    expect(map.getAttribute('aria-checked')).toBe('true')
  })
})

describe('MenuBar with the Desktop menus', () => {
  let container: HTMLDivElement
  const setTool = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    setTool.mockReset()
    currentCanvasTool.value = 'select'
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ commands: createTestCanvasCommandSurface({ tools: { setTool } }) }))
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
    currentCanvasTool.value = 'select'
  })

  const DesktopMenus = () => <MenuBar menus={appCommandGraphChromeProjection.value.menus} label="Menus" />
  const openMenuItems = async (id: string) => {
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-menu-id="${id}"]`)!.click() })
    return container.querySelector<HTMLElement>('[data-menu-popup="root"]')!
  }

  it('View › Pan arms the Pan tool', async () => {
    await act(async () => { render(<DesktopMenus />, container) })
    const view = await openMenuItems('view')
    const pan = view.querySelector<HTMLElement>('[data-command-id="canvas.tool.hand"]')!
    expect(pan.textContent).toBe('PanH')
    await act(async () => { pan.click() })
    expect(setTool).toHaveBeenCalledWith('hand')
    expect(currentCanvasTool.value).toBe('hand')
  })

  it('the Tools menu still lists Pan', async () => {
    await act(async () => { render(<DesktopMenus />, container) })
    const tools = await openMenuItems('tools')
    expect([...tools.querySelectorAll<HTMLElement>('[data-command-id]')].slice(0, 2).map((item) => item.dataset.commandId))
      .toEqual(['canvas.tool.select', 'canvas.tool.hand'])
  })
})
