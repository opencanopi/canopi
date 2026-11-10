import { computed, signal } from '@preact/signals'

/**
 * The one owner of modality. A modal dialog holds the layer while it is
 * mounted. While any hold is open, every registered chrome region (the title
 * bar, the rails, the workspace composition, app notices) is `inert`, so no
 * press, focus or menubar key reaches the UI behind the dialog, and
 * `modalLayerOpen` tells keyboard routes to stand aside.
 *
 * `inert` is set on the DOM synchronously, not through a render, so a closing
 * dialog that releases its hold can give focus back to the chrome that opened
 * it in the same task.
 */
const holds = signal(0)
const regions = new Set<HTMLElement>()

/**
 * How a modal takes the window's toasts (components/shared/ToastSlot.tsx), which sit outside it, into its focus cycle
 * (canopi-f47t.52.36).
 */
export interface ModalToastCycle {
  /** Tab pressed in a toast. */
  trapTab(event: KeyboardEvent): void
  /** A toast holding focus is leaving (its Undo pressed from the keyboard): focus goes back into the modal. */
  returnFocus(): void
}

/** The open holds, oldest first, each with its modal's toast cycle if it has one. */
const stack: Array<{ readonly toastCycle: ModalToastCycle | undefined }> = []

export const modalLayerOpen = computed(() => holds.value > 0)

function applyInert(open: boolean): void {
  for (const region of regions) region.toggleAttribute('inert', open)
}

/**
 * Called by a modal dialog when it mounts, with its toast cycle if the window's toasts join its focus cycle; returns
 * the release.
 */
export function holdModalLayer(toastCycle?: ModalToastCycle): () => void {
  let released = false
  const entry = { toastCycle }
  stack.push(entry)
  holds.value += 1
  if (holds.peek() === 1) applyInert(true)
  return () => {
    if (released) return
    released = true
    stack.splice(stack.indexOf(entry), 1)
    holds.value -= 1
    if (holds.peek() === 0) applyInert(false)
  }
}

/**
 * The topmost modal's toast cycle: a toast's Tab and leaving focus go to it alone, so a modal that does not take part
 * (the command palette over a workspace dialog) leaves them to the browser rather than to the dialog it covers.
 */
export function topModalToastCycle(): ModalToastCycle | undefined {
  return stack.at(-1)?.toastCycle
}

/** Chrome that must be inert behind a modal dialog; returns its release. */
export function registerModalInertRegion(element: HTMLElement): () => void {
  regions.add(element)
  element.toggleAttribute('inert', holds.peek() > 0)
  return () => {
    if (!regions.delete(element)) return
    element.removeAttribute('inert')
  }
}
