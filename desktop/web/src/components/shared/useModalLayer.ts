import type { RefObject } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'
import { holdModalLayer, registerModalInertRegion } from '../../app/shell/modal-layer'
import { toastFocusables } from './ToastSlot'

/**
 * What a modal that keeps focus inside itself gives the modal layer, so the window's toasts
 * (components/shared/ToastSlot.tsx) join its Tab cycle: an Undo shown above it stays in keyboard reach, and Escape
 * pressed in a toast is the modal's Escape (canopi-f47t.52.36). The modal's own key handler sends Tab to
 * `trapTabWithToasts` with the same tab stops.
 */
export interface ModalFocus {
  /** The modal's element. */
  readonly root: RefObject<HTMLElement | null>
  /** The modal's own tab stops, in order. */
  tabStops(): HTMLElement[]
  /** The modal's Escape (close it, or step back); its own Escape handler runs the same. */
  escape(): void
}

/**
 * Makes the calling dialog modal: the chrome behind it is inert while it is
 * mounted, and focus goes back to what had it once the chrome is live again.
 * The element that had focus is read before the chrome turns inert, since a
 * browser drops focus from an element that becomes inert.
 *
 * The returned function releases the layer early, before the dialog unmounts.
 * A dialog that closes to run a command calls it first, so the command finds
 * the chrome live and any focus it moves is not undone by the unmount.
 *
 * `focus`, whose root is read once at mount (its tab stops and Escape at each use), puts the window's toasts in the
 * dialog's Tab cycle while it is the topmost modal. A focused toast that leaves (its Undo pressed from the keyboard) gives
 * focus back to the dialog control that last had it, or to its initial control (`[data-dialog-initial-focus]`, else
 * its first tab stop) once that is gone.
 */
export function useModalLayer(focus?: ModalFocus): () => void {
  const releaseRef = useRef<() => void>(() => {})
  const latest = useRef(focus)
  latest.current = focus
  useLayoutEffect(() => {
    const previous = document.activeElement
    const root = latest.current?.root.current ?? null
    let lastFocused: HTMLElement | null = null
    const onFocusIn = (event: FocusEvent) => { if (event.target instanceof HTMLElement) lastFocused = event.target }
    root?.addEventListener('focusin', onFocusIn)
    const hold = holdModalLayer(root ? {
      trapTab: (event) => trapTabWithToasts(latest.current?.tabStops() ?? [], event),
      returnFocus: () => {
        if (lastFocused && root.contains(lastFocused)) return lastFocused.focus()
        const initial = root.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? latest.current?.tabStops()[0]
        initial?.focus()
      },
      escape: () => latest.current?.escape(),
    } : undefined)
    let released = false
    const release = () => {
      if (released) return
      released = true
      root?.removeEventListener('focusin', onFocusIn)
      hold()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
    releaseRef.current = release
    return release
  }, [])
  return () => releaseRef.current()
}

/**
 * Tab in a modal whose cycle is its own tab stops then the window's toasts. Only a step across an end of that cycle is
 * moved by hand; the browser moves every other, so a radio group stays one stop. Focus on no tab stop (a notice that
 * kept focus after Retry, or the modal itself) crosses when no tab stop lies ahead of it in the Tab direction, since
 * the browser would take it out of the page.
 */
export function trapTabWithToasts(own: readonly HTMLElement[], event: KeyboardEvent): void {
  const cycle = [...own, ...toastFocusables()]
  const active = document.activeElement
  if (cycle.length === 0 || !active) return
  const back = event.shiftKey
  const at = cycle.findIndex((element) => element === active)
  let to: number
  if (at >= 0) {
    if (at < own.length && at !== (back ? 0 : own.length - 1)) return
    to = at + (back ? -1 : 1)
  } else {
    const ahead = back ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING
    if (own.some((element) => (active.compareDocumentPosition(element) & ahead) !== 0)) return
    to = back ? -1 : own.length
  }
  event.preventDefault()
  cycle[(to + cycle.length) % cycle.length]?.focus()
}

/** Marks chrome that must be inert while a modal dialog is open. */
export function useModalInertRegion(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current
    return element ? registerModalInertRegion(element) : undefined
  }, [ref])
}
