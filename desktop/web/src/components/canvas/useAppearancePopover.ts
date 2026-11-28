import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import type { PlantAppearanceAnchor } from '../../app/canvas-context-menu/state'

/** Anchor for a positioned popover: provides bounds and accepts focus on close. */
interface PopoverAnchor extends PlantAppearanceAnchor {
  getBoundingClientRect(): {
    readonly top: number
    readonly right: number
    readonly left?: number
    readonly bottom?: number
  }
}

/** What a popover opens beside or below and returns focus to on close. */
export interface AppearanceAnchorRef {
  readonly current: PopoverAnchor | null
}

export interface AppearancePopoverOptions {
  /** `'beside'` opens to the right of the anchor (default); `'below'` opens under it and flips above if needed. */
  readonly placement?: 'beside' | 'below'
  /** Called when a pointer interaction begins outside the popover, its anchor (or label), and preserved overlays. */
  readonly onOutsidePointer?: () => void
}

/** The appearance popover owns its viewport positioning, resize subscription, and optional outside-pointer dismissal. */
export function useAppearancePopover(
  open: boolean,
  buttonRef: AppearanceAnchorRef,
  options: AppearancePopoverOptions = {},
) {
  const { placement = 'beside', onOutsidePointer } = options
  const hasOutsidePointer = Boolean(onOutsidePointer)
  const menuRef = useRef<HTMLDivElement>(null)
  const onOutsidePointerRef = useRef(onOutsidePointer)
  onOutsidePointerRef.current = onOutsidePointer

  useLayoutEffect(() => {
    const menu = menuRef.current
    const button = buttonRef.current
    if (!open || !menu || !button) return
    const place = () => {
      const anchor = button.getBoundingClientRect()
      const bounds = menu.getBoundingClientRect()
      if (placement === 'below') {
        const left = Math.max(8, Math.min(anchor.left ?? anchor.right, window.innerWidth - bounds.width - 8))
        const below = (anchor.bottom ?? anchor.top) + 6
        const top = below + bounds.height <= window.innerHeight - 8
          ? below
          : Math.max(8, anchor.top - bounds.height - 6)
        menu.style.left = `${left}px`
        menu.style.top = `${top}px`
      } else {
        menu.style.left = `${Math.max(8, Math.min(anchor.right + 8, window.innerWidth - bounds.width - 8))}px`
        menu.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - bounds.height - 8))}px`
      }
    }
    place()
    ;(menu.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? menu.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'))?.focus({ preventScroll: true })
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    observer?.observe(menu)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, buttonRef, placement])

  useEffect(() => {
    if (!open || !hasOutsidePointer) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target)) return
      const anchor = buttonRef.current
      if (anchor instanceof Node && anchor.contains(target)) return
      if (anchor instanceof HTMLElement && target instanceof Element && target.closest('label')?.control === anchor) return
      if (target instanceof Element && target.closest('[data-preserve-overlays="true"]')) return
      onOutsidePointerRef.current?.()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open, buttonRef, hasOutsidePointer])

  return menuRef
}

/** Arrow keys preview a choice; application still requires the explicit scope action. */
export function navigateAppearanceChoices(event: KeyboardEvent, columns: number) {
  const target = event.target
  if (!(target instanceof HTMLButtonElement) || target.getAttribute('role') !== 'option') return
  const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }
  const options = Array.from(target.closest('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
  const index = options.indexOf(target)
  const step = steps[event.key]
  if (index < 0 || (step === undefined && event.key !== 'Home' && event.key !== 'End')) return
  event.preventDefault()
  event.stopPropagation()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (step ?? 0) + options.length) % options.length
  options[next]?.focus()
  options[next]?.click()
}
