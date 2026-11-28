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

const wrap = (i: number, len: number, dir: -1 | 1) => dir < 0 ? (i > 0 ? i - 1 : len - 1) : (i < len - 1 ? i + 1 : 0)
/** The CSS gap between a menu button and its menu, and the margin kept from the window edge. */
const EDGE_PX = 8

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
export function MenuBar({ menus, label, compactLabel, onMenuOpen }: MenuBarProps) {
  // Narrow windows get one menu whose submenus are File, Edit, View, Tools and Help.
  const compactMenu: MenuDefinition | null = compactLabel ? {
    id: 'file',
    label: compactLabel,
    items: menus.map((menu) => ({
      type: 'submenu' as const,
      id: `compact.${menu.id}`,
      label: menu.label,
      disabled: false,
      items: flattenMenuActions([menu]),
    })),
  } : null
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
  const menuScrollTop = useRef(0)

  // A modal dialog makes the bar inert; a menu open under it closes.
  useSignalEffect(() => { if (modalLayerOpen.value && openMenuId.peek()) closeAll(false) })

  // An Esc from outside the open menu closes it before the map's draft or tool hears it (inside, its own handler runs).
  usePopoverEscapeLayer(Boolean(openMenuId.value), () => closeAll(true))

  useSignalEffect(() => {
    if (!openMenuId.value) return
    const handleOutside = (event: Event) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) closeAll(false)
    }
    document.addEventListener('pointerup', handleOutside)
    return () => document.removeEventListener('pointerup', handleOutside)
  })

  const qBtns = (el: HTMLElement, sel: string) => [...el.querySelectorAll<HTMLButtonElement>(sel)]
  const rootItems = (menuEl: HTMLElement) => qBtns(menuEl, '[data-menu-root-item="true"]')

  const focusRootItemAfterRender = (position: 'first' | 'last' = 'first') => requestAnimationFrame(() => {
    const menuEl = barRef.current?.querySelector<HTMLElement>('[data-menu-popup="root"]')
    if (!menuEl) return
    const items = rootItems(menuEl)
    focusMenuItem(position === 'first' ? items[0] : items.at(-1))
  })

  const focusFirstSubmenuItemAfterRender = (submenuId: string) => requestAnimationFrame(() => {
    focusMenuItem(submenuRefs.current.get(submenuId)?.querySelector<HTMLButtonElement>('button'))
  })

  const setSub = (id: string | null) => { openSubmenuId.value = id }

  /** Opens a menu; `focusBefore` is where focus was before it, kept while the bar moves between menus. */
  function openRootMenu(menuId: string, focusBefore: Element | null = document.activeElement): void {
    if (modalLayerOpen.peek()) return
    if (!openMenuId.peek()) focusBeforeOpen.current = focusBefore
    menuScrollTop.current = 0
    openMenuId.value = menuId
    setSub(null)
    onMenuOpen?.(menuId === 'compact' ? 'file' : menuId)
  }

  function closeAll(returnFocus: boolean): void {
    const triggerId = openMenuId.value
    const before = focusBeforeOpen.current
    focusBeforeOpen.current = null
    menuScrollTop.current = 0
    openMenuId.value = null
    setSub(null)
    if (!returnFocus || !triggerId) return
    // Entered from a menu button, the bar gives focus to the button of the menu open last (APG menubar); otherwise back to
    // where it was before a click opened the menu.
    const fromBar = before instanceof Node && barRef.current?.contains(before) === true
    if (!fromBar && before instanceof HTMLElement && before.isConnected && before !== document.body) before.focus({ preventScroll: true })
    else triggerRefs.current.get(triggerId)?.focus()
  }

  function moveToSiblingMenu(menuId: string, direction: -1 | 1): void {
    if (openMenuId.value === 'compact') return
    const next = menus[wrap(menus.findIndex((m) => m.id === menuId), menus.length, direction)]
    if (!next) return
    openRootMenu(next.id)
    focusRootItemAfterRender()
  }

  function runAction(entry: MenuAction): void {
    if (entry.disabled) return
    closeAll(true)
    entry.action()
  }

  const consume = (event: KeyboardEvent, stop = false) => {
    event.preventDefault()
    if (stop) event.stopPropagation()
  }

  function focusListKey(event: KeyboardEvent, items: readonly HTMLButtonElement[], stopProp: boolean): boolean {
    const k = event.key
    if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return false
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const target = k === 'ArrowDown' ? items[wrap(index, items.length, 1)]
      : k === 'ArrowUp' ? items[wrap(index < 0 ? 0 : index, items.length, -1)]
      : k === 'Home' ? items[0]
      : items.at(-1)
    consume(event, stopProp)
    focusMenuItem(target)
    return true
  }

  function handleMenuKeyDown(event: KeyboardEvent, menu: MenuDefinition): void {
    if (focusListKey(event, rootItems(event.currentTarget as HTMLElement), false)) return
    const k = event.key
    if (k === 'ArrowLeft') { consume(event); moveToSiblingMenu(menu.id, -1) }
    else if (k === 'ArrowRight') {
      consume(event)
      const submenuId = (event.target as HTMLElement).dataset.submenuId
      const entry = submenuId ? menu.items.find((item) => item.type === 'submenu' && item.id === submenuId) : null
      if (entry?.type === 'submenu' && !entry.disabled) {
        setSub(entry.id)
        focusFirstSubmenuItemAfterRender(entry.id)
      } else moveToSiblingMenu(menu.id, 1)
    } else if (k === 'Escape') { consume(event, true); closeAll(true) }
    else if (k === 'Tab') closeAll(false)
  }

  function handleSubmenuKeyDown(event: KeyboardEvent, submenuId: string): void {
    if (focusListKey(event, qBtns(event.currentTarget as HTMLElement, 'button'), true)) return
    const k = event.key
    if (k === 'ArrowLeft' || k === 'Escape') {
      consume(event, true)
      setSub(null)
      submenuTriggerRefs.current.get(submenuId)?.focus()
    } else if (k === 'ArrowRight') consume(event, true)
  }

  function handleTriggerKeyDown(event: KeyboardEvent, menuId: string): void {
    const k = event.key
    if (menuId === 'compact' && (k === 'ArrowLeft' || k === 'ArrowRight')) return
    if (k === 'ArrowDown' || k === 'Enter' || k === ' ' || k === 'ArrowUp') {
      consume(event)
      openRootMenu(menuId)
      focusRootItemAfterRender(k === 'ArrowUp' ? 'last' : 'first')
    } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      consume(event)
      const next = menus[wrap(menus.findIndex((m) => m.id === menuId), menus.length, k === 'ArrowLeft' ? -1 : 1)]
      if (!next) return
      triggerRefs.current.get(next.id)?.focus()
      if (openMenuId.value) openRootMenu(next.id)
    } else if (k === 'Escape' && openMenuId.value) {
      consume(event)
      closeAll(true)
    }
  }

  function renderAction(entry: MenuAction, rootItem: boolean, checkable: boolean) {
    const role = entry.check ? (`menuitem${entry.check}` as const) : 'menuitem'
    const clearSub = rootItem ? () => setSub(null) : undefined
    return (
      <button
        key={entry.id}
        className={styles.item}
        role={role}
        type="button"
        tabIndex={-1}
        aria-checked={entry.check ? Boolean(entry.checked) : undefined}
        aria-disabled={entry.disabled || undefined}
        aria-keyshortcuts={entry.ariaShortcut}
        data-command-id={entry.id}
        data-menu-root-item={rootItem ? 'true' : undefined}
        onMouseEnter={clearSub}
        onFocusIn={clearSub}
        onClick={() => runAction(entry)}
      >
        {checkable && (
          <span className={styles.check} aria-hidden="true">
            {entry.checked && <ControlIcon name="check" />}
          </span>
        )}
        {entry.thumbnail && <MenuThumbnail thumbnail={entry.thumbnail} />}
        <span className={styles.itemLabel}>{entry.label}</span>
        {entry.note && <span className={styles.itemNote} data-testid="menu-item-note">{entry.note}</span>}
        {entry.shortcut && <span className={styles.itemShortcut} aria-hidden="true">{entry.shortcut}</span>}
      </button>
    )
  }

  /** Caps a root menu to the room below its menu button; the menu scrolls inside. */
  function placeRootMenu(element: HTMLDivElement | null, key: string): void {
    const trigger = element && triggerRefs.current.get(key)
    if (!element || !trigger) return
    element.style.maxHeight = `${Math.max(0, window.innerHeight - trigger.getBoundingClientRect().bottom - EDGE_PX * 2)}px`
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
    const { top, maxHeight } = placeSidePopupVertically(item.getBoundingClientRect().top - 4, size.height, window.innerHeight, { margin: EDGE_PX })
    element.style.top = `${top - rootBounds.top}px`
    element.style.maxHeight = `${maxHeight}px`
    element.dataset.side = rootBounds.right + 4 + size.width <= window.innerWidth - EDGE_PX ? 'right' : 'left'
  }

  const bindMap = <T extends HTMLElement>(map: Map<string, T>, id: string) => (el: T | null) => {
    if (el) map.set(id, el)
    else map.delete(id)
  }

  function renderSubmenuPopup(entry: Extract<MenuEntry, { type: 'submenu' }>, inline: boolean) {
    const submenuCheckable = entry.items.some((item) => item.check)
    return (
      <div
        ref={(element) => {
          bindMap(submenuRefs.current, entry.id)(element)
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
      <div key={entry.id} className={styles.submenuWrap} onMouseEnter={() => { if (!entry.disabled) setSub(entry.id) }}>
        <button
          ref={bindMap(submenuTriggerRefs.current, entry.id)}
          className={styles.item}
          role="menuitem"
          type="button"
          tabIndex={-1}
          aria-disabled={entry.disabled || undefined}
          aria-haspopup="menu"
          aria-expanded={submenuOpen}
          aria-keyshortcuts={entry.ariaShortcut}
          data-menu-root-item="true"
          data-submenu-id={entry.id}
          onClick={() => {
            if (entry.disabled) return
            setSub(entry.id)
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
    const isOpen = openMenuId.value === key
    const checkable = menu.items.some((entry) => entry.type === 'action' && entry.check !== undefined)
    return (
      <div key={key} className={`${styles.menuGroup} ${compact ? styles.compactGroup : styles.fullGroup}`}>
        <button
          ref={bindMap(triggerRefs.current, key)}
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
            onMouseEnter={() => { if (openMenuId.value && openMenuId.value !== key) openRootMenu(key) }}
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
                onScroll={(event) => {
                  // Ignore no-op scroll events (WebKit dispatches scroll with unchanged scrollTop=0 after a submenu click).
                  const nextTop = event.currentTarget.scrollTop
                  if (nextTop === menuScrollTop.current) return
                  menuScrollTop.current = nextTop
                  if (!compact && openSubmenuId.peek()) setSub(null)
                }}
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

/** An item's picture: asks for it when the item is shown and follows it as it arrives. */
function MenuThumbnail({ thumbnail }: { readonly thumbnail: MenuItemThumbnail }) {
  useEffect(() => {
    thumbnail.load()
  }, [thumbnail])
  const { url, loading } = thumbnail.source()
  return <ThumbnailFrame url={url} loading={loading} size="menu" />
}
