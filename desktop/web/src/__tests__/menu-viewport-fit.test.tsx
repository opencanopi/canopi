// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuAction, MenuDefinition } from '../app/shell-commands/menus'
import { ActionMenu, ContextMenu } from '../components/shared/ActionMenu'
import { MenuBar } from '../components/shared/MenuBar'
import { placePopupVertically, placeSidePopupVertically } from '../utils/floating-position'

// jsdom has no layout: every element reports this rect unless a test overrides it.
type Rect = { top: number; left: number; width: number; height: number }
const rects = new Map<Element, Rect>()
let defaultPopupHeight = 0

function domRect({ top, left, width, height }: Rect): DOMRect {
  return {
    top, left, width, height, x: left, y: top, right: left + width, bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

function action(id: string): MenuAction {
  return { type: 'action', id, label: id, disabled: false, action: vi.fn() }
}

function longMenus(): MenuDefinition[] {
  const many = Array.from({ length: 30 }, (_, index) => action(`item-${index}`))
  return [{
    id: 'view',
    label: 'View',
    items: [
      ...many,
      { type: 'submenu', id: 'saved', label: 'Saved views', disabled: false, items: many.map((item) => ({ ...item, id: `sub-${item.id}` })) },
    ],
  }]
}

describe('menus fit the viewport', () => {
  let container: HTMLDivElement
  let innerHeight: number
  const scrolled: Element[] = []

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    innerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const known = rects.get(this)
      if (known) return domRect(known)
      if (this.getAttribute('role') === 'menu') return domRect({ top: 0, left: 0, width: 240, height: defaultPopupHeight })
      return domRect({ top: 0, left: 0, width: 0, height: 0 })
    })
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    rects.clear()
    scrolled.length = 0
    defaultPopupHeight = 0
    vi.restoreAllMocks()
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight })
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('places popups below, flips above or caps to the roomier side', () => {
    expect(placePopupVertically({ top: 100, bottom: 130 }, 200, 800)).toEqual({ direction: 'down', top: 134, maxHeight: 658 })
    expect(placePopupVertically({ top: 700, bottom: 730 }, 300, 800)).toEqual({ direction: 'up', top: 396, maxHeight: 688 })
    expect(placePopupVertically({ top: 20, bottom: 50 }, 2000, 800)).toEqual({ direction: 'down', top: 54, maxHeight: 738 })
    // A popup beside a pointer may slide instead: it ends inside the viewport without scrolling.
    expect(placePopupVertically({ top: 400, bottom: 400 }, 600, 800, { gap: 0, slide: true }))
      .toEqual({ direction: 'down', top: 192, maxHeight: 784 })
    expect(placePopupVertically({ top: 400, bottom: 400 }, 300, 800, { gap: 0, slide: true }))
      .toEqual({ direction: 'down', top: 400, maxHeight: 392 })
    expect(placePopupVertically({ top: 400, bottom: 400 }, 2000, 800, { gap: 0, slide: true }))
      .toEqual({ direction: 'down', top: 8, maxHeight: 784 })
    expect(placeSidePopupVertically(700, 400, 800)).toEqual({ top: 392, maxHeight: 784 })
    expect(placeSidePopupVertically(100, 2000, 800)).toEqual({ top: 8, maxHeight: 784 })
  })

  it('caps a menubar menu to the room below its trigger and keeps keyboard focus in view', async () => {
    await act(async () => { render(<MenuBar menus={longMenus()} label="Menus" />, container) })
    const trigger = container.querySelector<HTMLButtonElement>('[data-menu-id="view"]')!
    rects.set(trigger, { top: 12, left: 60, width: 48, height: 28 })
    defaultPopupHeight = 1000

    await act(async () => { trigger.click() })
    const menu = container.querySelector<HTMLElement>('[data-menu-popup="root"]')!
    // 800 − (trigger bottom 40 + 8 px gap) − 8 px margin.
    expect(menu.style.maxHeight).toBe('744px')

    const items = [...menu.querySelectorAll<HTMLButtonElement>('[data-menu-root-item="true"]')]
    items[0]!.focus()
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(document.activeElement).toBe(items.at(-1))
    expect(scrolled).toContain(items.at(-1))
  })

  it('opens a menubar submenu beside the scrolling menu, capped to the viewport', async () => {
    await act(async () => { render(<MenuBar menus={longMenus()} label="Menus" />, container) })
    const trigger = container.querySelector<HTMLButtonElement>('[data-menu-id="view"]')!
    rects.set(trigger, { top: 12, left: 60, width: 48, height: 28 })
    defaultPopupHeight = 1000
    await act(async () => { trigger.click() })
    const menu = container.querySelector<HTMLElement>('[data-menu-popup="root"]')!
    rects.set(menu, { top: 48, left: 60, width: 240, height: 744 })
    const parent = menu.querySelector<HTMLButtonElement>('[data-submenu-id="saved"]')!
    rects.set(parent, { top: 700, left: 64, width: 232, height: 32 })

    await act(async () => { parent.click() })
    const submenu = container.querySelector<HTMLElement>('[role="menu"][aria-label="Saved views"]')!
    // The submenu is not inside the scrolling list, so the list cannot clip it.
    const scroller = submenu.parentElement!.querySelector('[data-menu-scroll]')!
    expect(scroller.contains(submenu)).toBe(false)
    expect(submenu.style.maxHeight).toBe('784px')
    // Level with its item would end below the window; it moves up to fit (8 px margin).
    expect(Number.parseFloat(submenu.style.top) + 48).toBe(8)
  })

  it('keeps an open submenu on a no-op scroll event (WebKit) and closes it only when scrollTop changes', async () => {
    await act(async () => { render(<MenuBar menus={longMenus()} label="Menus" />, container) })
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-menu-id="view"]')!.click() })
    const menu = container.querySelector<HTMLElement>('[data-menu-popup="root"]')!
    const scroller = menu.querySelector<HTMLDivElement>('[data-menu-scroll]')!
    const parent = menu.querySelector<HTMLButtonElement>('[data-submenu-id="saved"]')!
    const submenu = () => container.querySelector<HTMLElement>('[role="menu"][aria-label="Saved views"]')

    await act(async () => { parent.click() })
    expect(submenu()).not.toBeNull()

    // WebKit dispatches a deferred scroll event with an unchanged scrollTop=0 after clicking a submenu item.
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    expect(submenu()).not.toBeNull()

    // Actually scrolling the root list moves the parent item away from the side popup, so the submenu closes.
    scroller.scrollTop = 40
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    expect(submenu()).toBeNull()

    // Re-opening at the new scroll position survives another no-op scroll event at scrollTop=40.
    await act(async () => { parent.click() })
    expect(submenu()).not.toBeNull()
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    expect(submenu()).not.toBeNull()
  })

  it('caps an ActionMenu to the viewport and flips it above a trigger near the bottom', async () => {
    await act(async () => { render(<ActionMenu label="Row actions" items={[{ label: 'Rename', run: vi.fn() }]} />, container) })
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    rects.set(trigger, { top: 700, left: 1000, width: 28, height: 28 })
    defaultPopupHeight = 300
    await act(async () => { trigger.click() })
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.style.top).toBe(`${700 - 4 - 300}px`)
    expect(menu.style.maxHeight).toBe(`${700 - 4 - 8}px`)
  })

  it('caps a context menu taller than the window to the window, beside the pointer', async () => {
    defaultPopupHeight = 900
    await act(async () => {
      render(<ContextMenu label="Plant" anchor={{ left: 400, top: 300, right: 400, bottom: 300 }} onClose={vi.fn()}
        entries={Array.from({ length: 30 }, (_, index) => ({ label: `Command ${index}`, run: vi.fn() }))} />, container)
    })
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.style.maxHeight).toBe(`${800 - 8 - 8}px`)
    expect(menu.style.top).toBe('8px')
    expect(menu.style.left).toBe('400px')

    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    expect(document.activeElement).toBe(items.at(-1))
    expect(scrolled).toContain(items.at(-1))
  })
})
