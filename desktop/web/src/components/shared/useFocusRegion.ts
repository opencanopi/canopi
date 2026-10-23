import type { RefObject } from 'preact'
import { useLayoutEffect } from 'preact/hooks'
import { focusOwner, type FocusRegion } from '../../app/keyboard/focus-owner'

/** Registers a workspace keyboard region that F6 and Shift F6 move between, with the focus owner. */
export function useFocusRegion(ref: RefObject<HTMLElement | null>, id: FocusRegion): void {
  useLayoutEffect(() => {
    const element = ref.current
    return element ? focusOwner.registerRegion(id, element) : undefined
  }, [ref, id])
}
