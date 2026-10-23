import type { RefObject } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'
import { holdModalLayer, registerModalInertRegion } from '../../app/shell/modal-layer'

/**
 * Makes the calling dialog modal: the chrome behind it is inert while it is
 * mounted, and focus goes back to what had it once the chrome is live again.
 * The element that had focus is read before the chrome turns inert, since a
 * browser drops focus from an element that becomes inert.
 *
 * The returned function releases the layer early, before the dialog unmounts.
 * A dialog that closes to run a command calls it first, so the command finds
 * the chrome live and any focus it moves is not undone by the unmount.
 */
export function useModalLayer(): () => void {
  const releaseRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const previous = document.activeElement
    const hold = holdModalLayer()
    let released = false
    const release = () => {
      if (released) return
      released = true
      hold()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
    releaseRef.current = release
    return release
  }, [])
  return () => releaseRef.current()
}

/** Marks chrome that must be inert while a modal dialog is open. */
export function useModalInertRegion(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current
    return element ? registerModalInertRegion(element) : undefined
  }, [ref])
}
