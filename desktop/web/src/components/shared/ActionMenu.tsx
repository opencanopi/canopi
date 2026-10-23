import { createPortal, type ComponentChildren } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { ButtonTooltip } from './ButtonTooltip'
import { ControlIcon, type ControlIconName } from './ControlIcon'
import { focusMenuItem, placePopupVertically, placeSidePopupVertically } from '../../utils/floating-position'
import styles from './ActionMenu.module.css'

interface ActionMenuCommand {
  readonly label: string
  /**
   * Runs after the menu closes. `itemBounds` is where the item was, so a
   * command that opens a popover can place it beside the menu.
   */
  run(itemBounds?: DOMRect): void
  /** Stable id for the item (`data-command`). */
  readonly id?: string
  /** The command opens a dialog beside the menu; the item shows a chevron. */
  readonly opensDialog?: boolean
  readonly danger?: boolean
  /** Disabled commands stay focusable (`aria-disabled`) so they can be discovered. */
  readonly disabled?: boolean
  /** Set on checkable commands (`menuitemcheckbox`); the menu then reserves a check column. */
  readonly checked?: boolean
  /** Shortcut as shown, e.g. "Ctrl D". */
  readonly shortcut?: string
  /** Shortcut for `aria-keyshortcuts`, e.g. "Control+D". */
  readonly keyShortcuts?: string
}

interface ActionMenuSubmenu {
  readonly label: string
  /** Stable id for the item (`data-command`). */
  readonly id?: string
  readonly submenu: readonly ActionMenuEntry[]
  readonly disabled?: boolean
}

export type ActionMenuEntry = ActionMenuCommand | ActionMenuSubmenu | { readonly separator: true }

const VIEWPORT_MARGIN = 8

/** A viewport rectangle the menu opens beside; a pointer is a rectangle of zero size. */
export interface MenuAnchorRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

interface MenuAnchor {
  getBoundingClientRect(): MenuAnchorRect
}

/** A compact command menu, portalled so scrollable lists cannot clip actions. */
export function ActionMenu({
  label, items, placement = 'below', triggerClassName, iconSize = 18, triggerData,
  openKey = 'ArrowDown', tabIndex, tooltipSide = 'left', triggerLabel, triggerIcon = 'more',
}: {
  label: string
  items: readonly ActionMenuEntry[]
  /** Where the menu opens: below the trigger, or beside it (a rail's More button). */
  placement?: 'below' | 'side'
  /** A presentation for the trigger other than the compact row button. */
  triggerClassName?: string
  iconSize?: 18 | 20
  /** `data-*` attributes on the trigger. */
  triggerData?: Readonly<Record<`data-${string}`, string | undefined>>
  /** The key that opens the menu from the trigger; a vertical toolbar keeps ArrowDown for moving. */
  openKey?: 'ArrowDown' | 'ArrowRight'
  /** For a trigger inside a roving-tabindex toolbar. */
  tabIndex?: number
  tooltipSide?: 'left' | 'right'
  /** Visible text beside the icon, shown instead of the tooltip (a labelled rail). */
  triggerLabel?: ComponentChildren
  /** The trigger's glyph: More by default, Plus for an "Add" menu. */
  triggerIcon?: ControlIconName
}) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    // Submenus are separate portals, so "inside" means any popup of this menu or the trigger.
    const inside = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
      return !!element && (!!element.closest(`[data-action-menu="${menuId}"]`) || !!trigger.current?.contains(element))
    }
    const outside = (event: Event) => { if (event.target instanceof Node && !inside(event.target)) setOpen(false) }
    const dismiss = (event: Event) => { if (!inside(event.target)) setOpen(false) }
    document.addEventListener('pointerup', outside)
    document.addEventListener('focusin', outside)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerup', outside)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [open, menuId])

  function close(): void {
    setOpen(false)
    trigger.current?.focus()
  }

  return <>
    <button ref={trigger} type="button" className={triggerClassName ?? styles.trigger} aria-label={label} aria-haspopup="menu" aria-expanded={open}
      {...triggerData} tabIndex={tabIndex}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key === openKey) { event.preventDefault(); setOpen(true) }
      }}><ControlIcon name={triggerIcon} size={iconSize} />{triggerLabel ?? <ButtonTooltip label={label} side={tooltipSide} />}</button>
    {open && trigger.current && (
      <MenuPopup menuId={menuId} label={label} entries={items} anchor={trigger.current} placement={placement} onClose={close} onBack={close} />
    )}
  </>
}

function isSubmenu(entry: ActionMenuEntry): entry is ActionMenuSubmenu {
  return 'submenu' in entry
}

function isCommand(entry: ActionMenuEntry): entry is ActionMenuCommand {
  return 'run' in entry
}

/**
 * A context menu opened at a pointer or beside a selection. It closes on an
 * outside press, focus leaving it, resize or scroll (`restoreFocus` false), and
 * on Escape, Tab or a chosen command (`restoreFocus` true).
 */
export function ContextMenu({ label, heading, entries, anchor, onClose }: {
  readonly label: string
  /** A quiet line above the items naming what they act on (the right-click menu's selection). */
  readonly heading?: string
  readonly entries: readonly ActionMenuEntry[]
  readonly anchor: MenuAnchorRect
  onClose(restoreFocus: boolean): void
}) {
  const menuId = useId()
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const inside = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
      return !!element?.closest(`[data-action-menu="${menuId}"]`)
    }
    // A secondary release never closes the menu: the canvas's own still right-click release opens it, or replaces it
    // (a right press on the map has already closed the one before, ToolHost.rawPress), so a double right-click
    // replaces the menu (spec §3.1).
    const outside = (event: PointerEvent) => { if (event.button !== 2 && !inside(event.target)) close.current(false) }
    const leave = (event: FocusEvent) => { if (!inside(event.target)) close.current(false) }
    const dismiss = (event: Event) => { if (!inside(event.target)) close.current(false) }
    document.addEventListener('pointerup', outside)
    document.addEventListener('focusin', leave)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerup', outside)
      document.removeEventListener('focusin', leave)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [menuId])

  const restore = () => close.current(true)
  return (
    <MenuPopup menuId={menuId} label={label} heading={heading} entries={entries} anchor={{ getBoundingClientRect: () => anchor }}
      placement="point" fitLabels onClose={restore} onBack={restore} />
  )
}

function MenuPopup({ menuId, label, heading, entries, anchor, placement, fitLabels = false, onClose, onBack }: {
  readonly menuId: string
  readonly label: string
  readonly heading?: string
  readonly entries: readonly ActionMenuEntry[]
  readonly anchor: MenuAnchor
  /** `below` a trigger, to the `side` of a parent item, or at a `point`. */
  readonly placement: 'below' | 'side' | 'point'
  /**
   * As wide as its longest label and shortcut on one line, up to a cap (the
   * right-click menu and its submenus), instead of the compact default.
   */
  readonly fitLabels?: boolean
  /** Close the whole menu and return focus to its trigger. */
  onClose(): void
  /** Close this level only (Escape, or ArrowLeft in a submenu). */
  onBack(): void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const items = useRef<Array<HTMLButtonElement | null>>([])
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null)
  const checkable = entries.some((entry) => isCommand(entry) && entry.checked !== undefined)

  useLayoutEffect(() => {
    const popup = menu.current
    if (!popup) return
    const bounds = anchor.getBoundingClientRect()
    popup.style.maxHeight = ''
    const rect = popup.getBoundingClientRect()
    const maxLeft = window.innerWidth - rect.width - VIEWPORT_MARGIN
    let left: number
    // A menu at a pointer (not a keyboard-opened one over a selection's bounds)
    // that opens right or left of it may slide up rather than scroll: it never
    // covers the pointer.
    let besidePointer = false
    if (placement === 'point') {
      // Right of the anchor; else left of it; else as far as the viewport allows.
      besidePointer = bounds.left === bounds.right && bounds.top === bounds.bottom
      if (bounds.left <= maxLeft) left = bounds.left
      else if (bounds.right - rect.width >= VIEWPORT_MARGIN) left = bounds.right - rect.width
      else {
        left = maxLeft
        besidePointer = false
      }
    } else if (placement === 'below') {
      left = Math.min(bounds.right - rect.width, maxLeft)
    } else {
      const right = bounds.right + 2
      left = right <= maxLeft ? right : bounds.left - rect.width - 2
    }
    const vertical = placement === 'side'
      ? placeSidePopupVertically(bounds.top - 5, rect.height, window.innerHeight, { margin: VIEWPORT_MARGIN })
      : placePopupVertically(bounds, rect.height, window.innerHeight, {
        gap: placement === 'point' ? 0 : 4,
        margin: VIEWPORT_MARGIN,
        slide: besidePointer,
      })
    popup.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft))}px`
    popup.style.top = `${vertical.top}px`
    popup.style.maxHeight = `${vertical.maxHeight}px`
    items.current.find(Boolean)?.focus()
  }, [])

  function closeSubmenu(index: number): void {
    setOpenSubmenu(null)
    items.current[index]?.focus()
  }

  function activate(index: number): void {
    const entry = entries[index]
    if (!entry || 'separator' in entry || entry.disabled) return
    if (isSubmenu(entry)) {
      setOpenSubmenu(index)
      return
    }
    const itemBounds = items.current[index]?.getBoundingClientRect()
    onClose()
    entry.run(itemBounds)
  }

  items.current.length = entries.length
  const submenuEntry = openSubmenu === null ? null : entries[openSubmenu]
  const submenuAnchor = openSubmenu === null ? null : items.current[openSubmenu]

  return createPortal(<>
    <div ref={menu} className={styles.menu} role="menu" aria-label={label} data-preserve-overlays="true" data-action-menu={menuId}
      data-fit-labels={fitLabels ? 'true' : undefined}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        const buttons = items.current.filter((item): item is HTMLButtonElement => item !== null)
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const entryIndex = index < 0 ? -1 : items.current.indexOf(buttons[index]!)
        if (event.key === 'Escape' || (event.key === 'ArrowLeft' && placement === 'side')) {
          event.preventDefault(); event.stopPropagation(); onBack()
        } else if (event.key === 'Tab') {
          onClose()
        } else if (event.key === 'ArrowRight') {
          const entry = entries[entryIndex]
          if (entry && isSubmenu(entry) && !entry.disabled) { event.preventDefault(); setOpenSubmenu(entryIndex) }
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          focusMenuItem(buttons[next])
        }
      }}>
      {/* The menu's accessible name already says this; the line is for sighted users. */}
      {/* Outside the scrolling items, so it stays in view. */}
      {heading && <div className={styles.heading} role="presentation" aria-hidden="true">{heading}</div>}
      <div className={styles.items} data-menu-items>
      {entries.map((entry, index) => {
        if ('separator' in entry) {
          items.current[index] = null
          return <div key={`separator-${index}`} className={styles.separator} role="separator" />
        }
        const submenu = isSubmenu(entry)
        const command = isCommand(entry) ? entry : null
        const checked = command?.checked
        return (
          <button key={entry.label} ref={(item) => { items.current[index] = item }} type="button"
            className={styles.item}
            role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={checked}
            aria-label={entry.label}
            aria-disabled={entry.disabled ? true : undefined}
            aria-haspopup={submenu ? 'menu' : command?.opensDialog ? 'dialog' : undefined}
            aria-expanded={submenu ? openSubmenu === index : undefined}
            aria-keyshortcuts={command?.keyShortcuts}
            data-command={command?.id ?? (submenu ? entry.id : undefined)}
            data-danger={command?.danger ? 'true' : undefined}
            onPointerEnter={() => { if (openSubmenu !== null && openSubmenu !== index) setOpenSubmenu(null) }}
            onClick={() => activate(index)}>
            {checkable && <span className={styles.check}>{checked && <ControlIcon name="check" />}</span>}
            <span className={styles.label}>{entry.label}</span>
            {command?.shortcut && <span className={styles.shortcut}>{command.shortcut}</span>}
            {(submenu || command?.opensDialog) && <ControlIcon name="chevron-right" className={styles.submenuChevron} />}
          </button>
        )
      })}
      </div>
    </div>
    {submenuEntry && isSubmenu(submenuEntry) && submenuAnchor && openSubmenu !== null && (
      <MenuPopup menuId={menuId} label={submenuEntry.label} entries={submenuEntry.submenu} anchor={submenuAnchor}
        placement="side" fitLabels={fitLabels} onClose={onClose} onBack={() => closeSubmenu(openSubmenu)} />
    )}
  </>, document.body)
}
