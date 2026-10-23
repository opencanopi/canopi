import { useId, useLayoutEffect, useRef } from 'preact/hooks'
import { useSignal, useSignalEffect } from '@preact/signals'
import { createPortal, type ComponentChildren } from 'preact'
import { computeFloatingDirection, shouldAlignRight } from '../../utils/floating-position'
import { ControlIcon } from './ControlIcon'
import styles from './Dropdown.module.css'

export interface DropdownItem<T> {
  value: T
  label: ComponentChildren
  disabled?: boolean
}

interface Props<T> {
  /** Rendered inside the trigger button alongside the chevron. */
  trigger: ComponentChildren
  items: DropdownItem<T>[]
  value: T
  onChange: (value: T) => void
  /** 'up' opens menu above trigger, 'down' below. Default: 'down'. */
  menuDirection?: 'up' | 'down'
  /** What the value is (e.g. "Units"). The trigger's accessible name is this label followed by the shown value. */
  ariaLabel: string
  /** Extra class on the outermost wrapper. */
  className?: string
  /** Extra class on the trigger button. */
  triggerClassName?: string
  /** Extra class on the menu container. */
  menuClassName?: string
  /** Extra class on each option button. */
  optionClassName?: string
  /** Prevent parent overlays from treating this dropdown as an outside click. */
  preserveOverlays?: boolean
  /** Position the menu against the viewport so a scroll region cannot clip it. */
  floating?: boolean
}

export function Dropdown<T>({
  trigger,
  items,
  value,
  onChange,
  menuDirection = 'down',
  ariaLabel,
  className,
  triggerClassName,
  menuClassName,
  optionClassName,
  preserveOverlays = false,
  floating = false,
}: Props<T>) {
  const open = useSignal(false)
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const openFocus = useRef<'selected' | 'first' | 'last'>('selected')
  const isOpen = open.value

  function closeAndRestoreFocus(): void {
    open.value = false
    triggerRef.current?.focus({ preventScroll: true })
  }

  function openMenu(focus: 'selected' | 'first' | 'last' = 'selected'): void {
    openFocus.current = focus
    open.value = true
  }

  // Close on click-outside (pointerup, not mousedown — avoids catching the opening click)
  // and when focus leaves for another control (a floating menu is portalled, so a
  // dialog's Tab trap cannot see it). Escape is handled at the dropdown root so
  // containing panels do not also react.
  useSignalEffect(() => {
    if (!open.value) return
    const handleOutside = (e: Event) => {
      if (!(e.target instanceof Node)) return
      if (ref.current?.contains(e.target) || menuRef.current?.contains(e.target)) return
      open.value = false
    }
    const dismissFloating = (event: Event) => {
      if (!floating) return
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      const restoreFocus = menuRef.current?.contains(document.activeElement)
      open.value = false
      if (restoreFocus) triggerRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerup', handleOutside)
    document.addEventListener('focusin', handleOutside)
    window.addEventListener('resize', dismissFloating)
    window.addEventListener('scroll', dismissFloating, true)
    return () => {
      document.removeEventListener('pointerup', handleOutside)
      document.removeEventListener('focusin', handleOutside)
      window.removeEventListener('resize', dismissFloating)
      window.removeEventListener('scroll', dismissFloating, true)
    }
  })

  // Viewport-aware direction, max-height, and horizontal alignment
  let resolvedDir: 'up' | 'down' = menuDirection
  let menuMaxHeight: number | undefined
  let alignRight = false
  if (open.value && triggerRef.current) {
    const rect = triggerRef.current.getBoundingClientRect()
    const result = computeFloatingDirection(rect, { preferred: menuDirection })
    resolvedDir = result.direction
    menuMaxHeight = result.availableHeight
    alignRight = shouldAlignRight(rect, 120) // 120 = CSS min-width of .menu
  }

  useLayoutEffect(() => {
    if (!isOpen || !floating || !triggerRef.current || !menuRef.current) return
    const anchor = triggerRef.current.getBoundingClientRect()
    const menu = menuRef.current
    const rect = menu.getBoundingClientRect()
    const gap = 4
    const top = resolvedDir === 'down'
      ? Math.min(anchor.bottom + gap, window.innerHeight - rect.height - 8)
      : Math.max(8, anchor.top - rect.height - gap)
    menu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(8, top)}px`
    menu.style.minWidth = `${anchor.width}px`
  }, [floating, isOpen, resolvedDir])

  useLayoutEffect(() => {
    if (!isOpen) return
    const enabled = optionRefs.current.filter((option): option is HTMLButtonElement => (
      option !== null && !option.disabled
    ))
    if (enabled.length === 0) return
    const selected = optionRefs.current[items.findIndex((item) => item.value === value)]
    const target = openFocus.current === 'first'
      ? enabled[0]
      : openFocus.current === 'last'
        ? enabled.at(-1)
        : selected && !selected.disabled
          ? selected
          : enabled[0]
    target?.focus({ preventScroll: true })
  }, [isOpen])

  const menuDirClass = resolvedDir === 'up' ? styles.menuUp : styles.menuDown

  const menu = isOpen && (
    <div
      ref={menuRef}
      className={`${styles.menu} ${menuDirClass}${floating ? ` ${styles.menuFloating}` : ''}${menuClassName ? ` ${menuClassName}` : ''}`}
      role="listbox"
      aria-label={ariaLabel}
      data-popup
      data-floating-popup={floating ? 'true' : undefined}
      data-preserve-overlays={floating || preserveOverlays ? 'true' : undefined}
      onKeyDown={(event) => {
        const enabled = optionRefs.current.filter((option): option is HTMLButtonElement => (
          option !== null && !option.disabled
        ))
        const currentIndex = enabled.findIndex((option) => option === document.activeElement)
        let nextIndex: number | null = null
        if (enabled.length > 0) {
          if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % enabled.length
          if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? enabled.length - 1 : (currentIndex - 1 + enabled.length) % enabled.length
          if (event.key === 'Home') nextIndex = 0
          if (event.key === 'End') nextIndex = enabled.length - 1
        }
        const nextOption = nextIndex === null ? undefined : enabled[nextIndex]
        if (nextOption) {
          event.preventDefault()
          event.stopPropagation()
          nextOption.focus({ preventScroll: true })
          return
        }
        if ((event.key === 'Enter' || event.key === ' ') && document.activeElement instanceof HTMLButtonElement) {
          const option = optionRefs.current.find((candidate) => candidate === document.activeElement)
          if (option && !option.disabled) {
            event.preventDefault()
            event.stopPropagation()
            option.click()
          }
          return
        }
        if (event.key === 'Tab') {
          // Close and let Tab continue from the trigger, not from a stale portal.
          closeAndRestoreFocus()
          return
        }
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        closeAndRestoreFocus()
      }}
      style={{
        ...(menuMaxHeight !== undefined ? { maxHeight: `${menuMaxHeight}px` } : {}),
        ...(floating ? { right: 'auto', bottom: 'auto' } : {}),
        ...(!floating && alignRight ? { left: 'auto', right: 0 } : {}),
      }}
    >
      {items.map((item, index) => (
        <button
          key={String(item.value)}
          ref={(option) => { optionRefs.current[index] = option }}
          className={`${styles.option} ${item.value === value ? styles.optionActive : ''}${optionClassName ? ` ${optionClassName}` : ''}`}
          role="option"
          type="button"
          aria-selected={item.value === value}
          disabled={item.disabled}
          onClick={() => {
            open.value = false
            onChange(item.value)
            triggerRef.current?.focus({ preventScroll: true })
          }}
        >
            <span className={styles.optionLabel}>{item.label}</span>
          {item.value === value && <ControlIcon name="check" className={styles.optionCheck} />}
        </button>
      ))}
    </div>
  )

  return (
    <div
      className={`${styles.dropdown}${className ? ` ${className}` : ''}`}
      ref={ref}
      data-preserve-overlays={preserveOverlays ? 'true' : undefined}
      onKeyDown={(event) => {
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open.value) {
          event.preventDefault()
          event.stopPropagation()
          openMenu(event.key === 'ArrowDown' ? 'first' : 'last')
          return
        }
        if (event.key !== 'Escape' || !open.value) return
        event.preventDefault()
        event.stopPropagation()
        closeAndRestoreFocus()
      }}
    >
      <button
        ref={triggerRef}
        className={`${styles.trigger}${triggerClassName ? ` ${triggerClassName}` : ''}`}
        type="button"
        onClick={() => {
          if (open.value) {
            open.value = false
            return
          }
          openMenu()
        }}
        aria-expanded={open.value}
        aria-haspopup="listbox"
        aria-labelledby={`${id}-label ${id}-value`}
      >
        <span id={`${id}-label`} className={styles.srOnly}>{ariaLabel}</span>
        <span id={`${id}-value`} className={styles.value}>{trigger}</span>
        <ControlIcon name="chevron-down" className={`${styles.chevron} ${open.value ? styles.chevronOpen : ''}`} />
      </button>
      {menu && (floating ? createPortal(menu, document.body) : menu)}
    </div>
  )
}
