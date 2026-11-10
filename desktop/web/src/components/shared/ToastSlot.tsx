/**
 * components/shared/ToastSlot.tsx: Owner of the one window-level toast position (notice-only-in-failures, contracts §18
 * F3, 2.1-Q292). Invariant: every toast in the window (an Undo after a delete, a transient result such as "Import
 * cancelled") is drawn in one layer on <body> (`[data-toast-layer]`, styles/global.css) at --z-toast, above the active
 * dialog: no chrome region holds it, so a modal's inert hold never reaches it and its action stays pressable while the
 * dialog is open, and in that dialog's Tab cycle (`trapToastTab`). A component that owns its toast's state renders `SlotToast`; a raiser that is not a component calls
 * failures/toasts.ts `showToast`, which `ToastSlot` (mounted once in each root) draws. The canvas lock toast stays canvas
 * chrome (components/canvas/LockedMoveToast.tsx, canopi-eon8.14.3).
 */
import type { ComponentProps } from 'preact'
import { createPortal } from 'preact/compat'
import { dismissToast, toasts } from '../../failures/toasts'
import { t } from '../../i18n'
import { Toast } from './Toast'

const LAYER_ATTRIBUTE = 'data-toast-layer'
let layer: HTMLElement | null = null

/** The one toast layer on <body>, created at its first use (and again if a test emptied the body). */
function toastLayer(): HTMLElement {
  if (layer?.isConnected) return layer
  layer = document.body.querySelector<HTMLElement>(`:scope > [${LAYER_ATTRIBUTE}]`)
  if (!layer) {
    layer = document.createElement('div')
    layer.setAttribute(LAYER_ATTRIBUTE, '')
    document.body.appendChild(layer)
  }
  return layer
}

/** How a dialog takes the window's toasts into its focus cycle. */
export interface ToastFocusCycle {
  /** Tab pressed in a toast. */
  trapTab(event: KeyboardEvent): void
  /** A toast holding focus is leaving: focus goes back into the dialog. */
  returnFocus(): void
}

/** The focus cycles of the open modal dialogs, oldest first; a toast's focus goes to the topmost. */
const cycles: ToastFocusCycle[] = []

/**
 * Puts the window's toasts in an open dialog's focus cycle (canopi-f47t.52.36): the toast layer sits outside the
 * dialog, so Tab pressed in a toast is handed to the topmost dialog's cycle, and a focused toast that leaves (its Undo
 * pressed from the keyboard) gives focus back to it. Returns the release.
 */
export function trapToastTab(cycle: ToastFocusCycle): () => void {
  cycles.push(cycle)
  return () => {
    const index = cycles.indexOf(cycle)
    if (index >= 0) cycles.splice(index, 1)
  }
}

/** The toasts' pressable controls, in order, for a dialog's Tab cycle. */
export function toastFocusables(): HTMLElement[] {
  return layer?.isConnected ? Array.from(layer.querySelectorAll<HTMLElement>('button:not([disabled])')) : []
}

/** A toast whose state its component owns (an Undo toast), drawn in the window's one toast position. */
export function SlotToast(props: ComponentProps<typeof Toast>) {
  return createPortal(
    <Toast
      {...props}
      onKeyDown={(event) => { if (event.key === 'Tab') cycles.at(-1)?.trapTab(event) }}
      onLeaveFocused={() => cycles.at(-1)?.returnFocus()}
    />,
    toastLayer(),
  )
}

/** Draws the transient results raised through failures/toasts.ts; mounted once in each edition's root. */
export function ToastSlot() {
  return (
    <>
      {toasts.value.map((toast) => (
        <SlotToast
          key={toast.id}
          icon="info"
          message={t(toast.message, toast.params)}
          {...(toast.timeoutMs === undefined ? {} : { timeoutMs: toast.timeoutMs })}
          onDismiss={() => dismissToast(toast.id)}
        />
      ))}
    </>
  )
}
