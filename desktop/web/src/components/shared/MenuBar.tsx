import { useEffect, useRef } from 'preact/hooks'
import { useSignal, useSignalEffect } from '@preact/signals'
import {
  flattenMenuActions,
  type MenuAction,
  type MenuDefinition,
  type MenuEntry,
  type MenuItemThumbnail,
} from '../../app/shell-commands/menus'
import { modalLayerOpen } from '../../app/shell/modal-layer'
import { usePopoverEscapeLayer } from '../../app/keyboard/use-popover-escape-layer'
import { ButtonTooltip } from './ButtonTooltip'
import { ControlIcon } from './ControlIcon'
import { ThumbnailFrame } from './SavedViewThumbnail'
import { focusMenuItem, placeSidePopupVertically } from '../../utils/floating-position'
import styles from './MenuBar.module.css'

const wrapPrev = (i: number, len: number) => i > 0 ? i - 1 : len - 1
const wrapNext = (i: number, len: number) => i < len - 1 ? i + 1 : 0
/** The CSS gap between a menu button and its menu, and the margin kept from the window edge. */
const MENU_GAP_PX = 8
const VIEWPORT_MARGIN_PX = 8

interface MenuBarProps {
  readonly menus: readonly MenuDefinition[]
  readonly label: string
  /** Name of the single menu narrow windows show instead of the menu bar. */
  readonly compactLabel?: string
  /** Called when a menu opens, so callers can refresh data it lists (Open recent). */
  readonly onMenuOpen?: (menuId: string) => void
}

/**
 * The title-bar menu bar: a `menubar` of menu buttons, each opening a `menu`
 * of commands with their shortcuts. Checkable items are `menuitemcheckbox`
 * or `menuitemradio`, and a check column is reserved when a menu has any.
 * An open menu is the Esc chain's popover layer, so an Esc from anywhere
 * outside it (the map, where Safari leaves focus after a click) closes the
 * menu and nothing else; closing it with a key or a command gives focus back
 * to where it was before the menu opened.
 */
export function MenuBar({ menus: fullMenus, label, compactLabel, onMenuOpen }: MenuBarProps) {
  // Narrow windows get one menu whose submenus are File, Edit, View, Tools and Help.
  const compactMenu: MenuDefinition | null = compactLabel ? {
    id: 'file',
    label: compactLabel,
    items: fullMenus.map((menu) => ({
      type: 'submenu' as const,
      id: `compact.${menu.id}`,
      label: menu.label,
      disabled: false,
      items: flattenMenuActions([menu]),
    })),
  } : null
  const menus = fullMenus
  const openMenuId = useSignal<string | null>(null)
  const openSubmenuId = useSignal<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const submenuTriggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const submenuRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  /**
   * Where focus was before the open menu opened; a press on a menu button records it before the press moves focus. A
   * menu button there means the bar was entered from it, and closing focuses the current menu's button instead.
   */
  const focusBeforeOpen = useRef<Element | null>(null)
  const focusAtPress = useRef<Element | null>(null)

  // A modal dialog makes the bar inert; a menu open under it closes.
  useSignalEffect(() => {
    if (modalLayerOpen.value && openMenuId.peek() !== null) closeAll(false)
  })

  // An Esc from outside the open menu closes it before the map's draft or tool hears it (inside, its own handler runs).
  usePopoverEscapeLayer(openMenuId.value !== null, () => closeAll(true))

  useSignalEffect(() => {
    if (!openMenuId.value) return
    const handleOutside = (event: Event) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) closeAll(false)
    }
    document.addEventListener('pointerup', handleOutside)
    return () => document.removeEventListener('pointerup', handleOutside)
  })

  function rootItems(menuEl: HTMLElement): HTMLButtonElement[] {
    return Array.from(menuEl.querySelectorAll<HTMLButtonElement>('[data-menu-root-item="true"]'))
  }

  function focusRootItemAfterRender(position: 'first' | 'last' = 'first'): void {
    requestAnimationFrame(() => {
      const menuEl = barRef.current?.querySelector<HTMLElement>('[data-menu-popup="root"]')
      if (!menuEl) return
      const items = rootItems(menuEl)
      focusMenuItem(position === 'first' ? items[0] : items.at(-1))
    })
  }

  function focusFirstSubmenuItemAfterRender(submenuId: string): void {
    requestAnimationFrame(() => {
      focusMenuItem(submenuRefs.current.get(submenuId)?.querySelector<HTMLButtonElement>('button'))
    })
  }

  /** Opens a menu; `focusBefore` is where focus was before it, kept while the bar moves between menus. */
  function openRootMenu(menuId: string, focusBefore: Element | null = document.activeElement): void {
    if (modalLayerOpen.peek()) return
    if (openMenuId.peek() === null) focusBeforeOpen.current = focusBefore
    openMenuId.value = menuId
    openSubmenuId.value = null
    onMenuOpen?.(menuId === 'compact' ? 'file' : menuId)
  }

  function closeAll(returnFocus: boolean): void {
    const triggerId = openMenuId.value
    const before = focusBeforeOpen.current
    focusBeforeOpen.current = null
    openMenuId.value = null
    openSubmenuId.value = null
    if (!returnFocus || !triggerId) return
    // Entered from a menu button, the bar gives focus to the button of the menu open last (APG menubar); otherwise back to
    // where it was before a click opened the menu.
    const fromBar = before instanceof Node && barRef.current?.contains(before) === true
    if (!fromBar && before instanceof HTMLElement && before.isConnected && before !== document.body) before.focus({ preventScroll: true })
    else triggerRefs.current.get(triggerId)?.focus()
  }

  function moveToSiblingMenu(menuId: string, direction: -1 | 1): void {
    if (openMenuId.value === 'compact') return
    const index = menus.findIndex((menu) => menu.id === menuId)
    const next = menus[direction < 0 ? wrapPrev(index, menus.length) : wrapNext(index, menus.length)]
    if (!next) return
    openRootMenu(next.id)
    focusRootItemAfterRender()
  }

  function runAction(entry: MenuAction): void {
    if (entry.disabled) return
    closeAll(true)
    entry.action()
  }

  function handleMenuKeyDown(event: KeyboardEvent, menu: MenuDefinition): void {
    const items = rootItems(event.currentTarget as HTMLElement)
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusMenuItem(items[wrapNext(index, items.length)])
        break
      case 'ArrowUp':
        event.preventDefault()
        focusMenuItem(items[wrapPrev(index < 0 ? 0 : index, items.length)])
        break
      case 'Home':
        event.preventDefault()
        focusMenuItem(items[0])
        break
      case 'End':
        event.preventDefault()
        focusMenuItem(items.at(-1))
        break
      case 'ArrowLeft':
        event.preventDefault()
        moveToSiblingMenu(menu.id, -1)
        break
      case 'ArrowRight': {
        event.preventDefault()
        const submenuId = (event.target as HTMLElement).dataset.submenuId
        const entry = submenuId ? menu.items.find((item) => item.type === 'submenu' && item.id === submenuId) : null
        if (entry?.type === 'submenu' && !entry.disabled) {
          openSubmenuId.value = entry.id
          focusFirstSubmenuItemAfterRender(entry.id)
          break
        }
        moveToSiblingMenu(menu.id, 1)
        break
      }
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        closeAll(true)
        break
      case 'Tab':
        closeAll(false)
        break
    }
  }

  function handleSubmenuKeyDown(event: KeyboardEvent, submenuId: string): void {
    const items = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button'))
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const stop = () => { event.preventDefault(); event.stopPropagation() }
    switch (event.key) {
      case 'ArrowDown': stop(); focusMenuItem(items[wrapNext(index, items.length)]); break
      case 'ArrowUp': stop(); focusMenuItem(items[wrapPrev(index < 0 ? 0 : index, items.length)]); break
      case 'Home': stop(); focusMenuItem(items[0]); break
      case 'End': stop(); focusMenuItem(items.at(-1)); break
      case 'ArrowLeft':
      case 'Escape':
        stop()
        openSubmenuId.value = null
        submenuTriggerRefs.current.get(submenuId)?.focus()
        break
      case 'ArrowRight': stop(); break
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent, menuId: string): void {
    const index = menus.findIndex((menu) => menu.id === menuId)
    if (menuId === 'compact' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault()
        openRootMenu(menuId)
        focusRootItemAfterRender()
        break
      case 'ArrowUp':
        event.preventDefault()
        openRootMenu(menuId)
        focusRootItemAfterRender('last')
        break
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault()
        const next = menus[event.key === 'ArrowLeft' ? wrapPrev(index, menus.length) : wrapNext(index, menus.length)]
        if (!next) break
        triggerRefs.current.get(next.id)?.focus()
        if (openMenuId.value) openRootMenu(next.id)
        break
      }
      case 'Escape':
        if (openMenuId.value) {
          event.preventDefault()
          closeAll(true)
        }
        break
    }
  }

  function renderAction(entry: MenuAction, rootItem: boolean, checkable: boolean) {
    const role = entry.check === 'radio' ? 'menuitemradio' : entry.check === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'
    return (
      <button
        key={entry.id}
        className={styles.item}
        role={role}
        type="button"
        tabIndex={-1}
        aria-checked={entry.check ? entry.checked === true : undefined}
        aria-disabled={entry.disabled ? true : undefined}
        aria-keyshortcuts={entry.ariaShortcut}
        data-command-id={entry.id}
        data-menu-root-item={rootItem ? 'true' : undefined}
        onMouseEnter={() => { if (rootItem) openSubmenuId.value = null }}
        onFocusIn={() => { if (rootItem) openSubmenuId.value = null }}
        onClick={() => runAction(entry)}
      >
        {checkable && (
          <span className={styles.check} aria-hidden="true">
            {entry.checked && <ControlIcon name="check" />}
          </span>
        )}
        {entry.thumbnail && <MenuThumbnail thumbnail={entry.thumbnail} />}
        <span className={styles.itemLabel}>{entry.label}</span>
        {entry.shortcut && <span className={styles.itemShortcut} aria-hidden="true">{entry.shortcut}</span>}
      </button>
    )
  }

  /** Caps a root menu to the room below its menu button; the menu scrolls inside. */
  function placeRootMenu(element: HTMLDivElement | null, key: string): void {
    const trigger = element && triggerRefs.current.get(key)
    if (!element || !trigger) return
    const room = window.innerHeight - trigger.getBoundingClientRect().bottom - MENU_GAP_PX - VIEWPORT_MARGIN_PX
    element.style.maxHeight = `${Math.max(0, room)}px`
  }

  /**
   * Places a submenu beside its item, outside the root menu's scrolling list so
   * the list cannot clip it: level with the item, moved up to end inside the
   * window, capped to the window and flipped left when there is no room right.
   */
  function placeSubmenu(element: HTMLDivElement | null, submenuId: string): void {
    const root = element?.parentElement
    const item = submenuTriggerRefs.current.get(submenuId)
    if (!element || !root || !item) return
    element.style.maxHeight = ''
    const rootBounds = root.getBoundingClientRect()
    const size = element.getBoundingClientRect()
    const { top, maxHeight } = placeSidePopupVertically(
      item.getBoundingClientRect().top - 4,
      size.height,
      window.innerHeight,
      { margin: VIEWPORT_MARGIN_PX },
    )
    element.style.top = `${top - rootBounds.top}px`
    element.style.maxHeight = `${maxHeight}px`
    element.dataset.side = rootBounds.right + 4 + size.width <= window.innerWidth - VIEWPORT_MARGIN_PX ? 'right' : 'left'
  }

  function renderSubmenuPopup(entry: Extract<MenuEntry, { type: 'submenu' }>, inline: boolean) {
    const submenuCheckable = entry.items.some((item) => item.check)
    return (
      <div
        ref={(element) => {
          if (element) submenuRefs.current.set(entry.id, element)
          else submenuRefs.current.delete(entry.id)
          if (!inline) placeSubmenu(element, entry.id)
        }}
        className={`${styles.menu} ${styles.submenu}`}
        role="menu"
        aria-label={entry.label}
        onKeyDown={(event) => handleSubmenuKeyDown(event, entry.id)}
      >
        {entry.items.map((item) => renderAction(item, false, submenuCheckable))}
      </div>
    )
  }

  function renderEntry(entry: MenuEntry, index: number, checkable: boolean, inlineSubmenus: boolean) {
    if (entry.type === 'separator') return <div key={`sep-${index}`} className={styles.separator} role="separator" />
    if (entry.type === 'action') return renderAction(entry, true, checkable)
    const submenuOpen = openSubmenuId.value === entry.id && !entry.disabled
    return (
      <div key={entry.id} className={styles.submenuWrap} onMouseEnter={() => { if (!entry.disabled) openSubmenuId.value = entry.id }}>
        <button
          ref={(element) => {
            if (element) submenuTriggerRefs.current.set(entry.id, element)
            else submenuTriggerRefs.current.delete(entry.id)
          }}
          className={styles.item}
          role="menuitem"
          type="button"
          tabIndex={-1}
          aria-disabled={entry.disabled ? true : undefined}
          aria-haspopup="menu"
          aria-expanded={submenuOpen}
          aria-keyshortcuts={entry.ariaShortcut}
          data-menu-root-item="true"
          data-submenu-id={entry.id}
          onClick={() => {
            if (entry.disabled) return
            openSubmenuId.value = entry.id
            focusFirstSubmenuItemAfterRender(entry.id)
          }}
        >
          {checkable && <span className={styles.check} aria-hidden="true" />}
          <span className={styles.itemLabel}>{entry.label}</span>
          {entry.shortcut && <span className={styles.itemShortcut} aria-hidden="true">{entry.shortcut}</span>}
          <ControlIcon name="chevron-right" className={styles.submenuChevron} />
        </button>
        {submenuOpen && inlineSubmenus && renderSubmenuPopup(entry, true)}
      </div>
    )
  }

  return (
    <div className={styles.menuBar} ref={barRef} role="menubar" aria-label={label}>
      {compactMenu && renderRootMenu(compactMenu, true)}
      {menus.map((menu) => renderRootMenu(menu, false))}
    </div>
  )

  function renderRootMenu(menu: MenuDefinition, compact: boolean) {
    const key = compact ? 'compact' : menu.id
    {
      const isOpen = openMenuId.value === key
      const checkable = menu.items.some((entry) => entry.type === 'action' && entry.check !== undefined)
      return (
        <div key={key} className={`${styles.menuGroup} ${compact ? styles.compactGroup : styles.fullGroup}`}>
          <button
            ref={(element) => {
              if (element) triggerRefs.current.set(key, element)
              else triggerRefs.current.delete(key)
            }}
            className={styles.trigger}
            type="button"
            role="menuitem"
            data-menu-id={compact ? undefined : menu.id}
            aria-label={compact ? menu.label : undefined}
            onPointerDown={() => { focusAtPress.current = document.activeElement }}
            onClick={() => {
              const focusBefore = focusAtPress.current ?? document.activeElement
              focusAtPress.current = null
              if (isOpen) closeAll(false)
              else openRootMenu(key, focusBefore)
            }}
            onMouseEnter={() => { if (openMenuId.value !== null && openMenuId.value !== key) openRootMenu(key) }}
            onKeyDown={(event) => handleTriggerKeyDown(event, key)}
            aria-expanded={isOpen}
            aria-haspopup="menu"
          >
            {compact
              ? <><ControlIcon name="menu" size={20} /><ButtonTooltip label={menu.label} side="bottom" /></>
              : menu.label}
          </button>
          {isOpen && (
            <div
              ref={(element) => placeRootMenu(element, key)}
              className={`${styles.menu} ${styles.rootMenu}`}
              role="menu"
              aria-label={menu.label}
              data-menu-popup="root"
              onKeyDown={(event) => handleMenuKeyDown(event, menu)}
            >
              <div
                className={styles.menuScroll}
                data-menu-scroll
                onScroll={() => { if (!compact && openSubmenuId.peek() !== null) openSubmenuId.value = null }}
              >
                {menu.items.map((entry, index) => renderEntry(entry, index, checkable, compact))}
              </div>
              {!compact && menu.items.map((entry) => (
                entry.type === 'submenu' && !entry.disabled && openSubmenuId.value === entry.id
                  ? renderSubmenuPopup(entry, false)
                  : null
              ))}
            </div>
          )}
        </div>
      )
    }
  }
}

/** An item's picture: asks for it when the item is shown and follows it as it arrives. */
function MenuThumbnail({ thumbnail }: { readonly thumbnail: MenuItemThumbnail }) {
  useEffect(() => {
    thumbnail.load()
  }, [thumbnail])
  const { url, loading } = thumbnail.source()
  return <ThumbnailFrame url={url} loading={loading} size="menu" />
}
