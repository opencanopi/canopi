/**
 * components/shared/ToastSlot.tsx: Owner of the one window-level toast position (notice-only-in-failures, contracts §18
 * F3, 2.1-Q292). Invariant: every toast in the window (an Undo after a delete, a transient result such as "Import
 * cancelled") is drawn in one layer on <body> (`[data-toast-layer]`, styles/global.css) at --z-toast, above the active
 * dialog: no chrome region holds it, so a modal's inert hold never reaches it and its action stays pressable while the
 * dialog is open. A component that owns its toast's state renders `SlotToast`; a raiser that is not a component calls
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

/** A toast whose state its component owns (an Undo toast), drawn in the window's one toast position. */
export function SlotToast(props: ComponentProps<typeof Toast>) {
  return createPortal(<Toast {...props} />, toastLayer())
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
