import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { ControlIcon, type ControlIconName } from './ControlIcon'
import styles from './Toast.module.css'

const TOAST_TIMEOUT_MS = 8000

/**
 * A short confirmation with at most one action (usually Undo). It dismisses itself after
 * `timeoutMs`, but never while it is hovered or holds focus; the countdown restarts after.
 * ToastSlot.tsx places it in the window's one toast position (the canvas lock toast stays canvas chrome); the caller
 * owns which toast is showing.
 */
export function Toast({ message, actionLabel, onAction, onDismiss, onKeyDown, timeoutMs = TOAST_TIMEOUT_MS, icon = 'check' }: {
  readonly message: ComponentChildren
  readonly actionLabel?: string
  onAction?(): void
  onDismiss(): void
  /** A key pressed in the toast (ToastSlot hands Tab to an open dialog's trap). */
  onKeyDown?(event: KeyboardEvent): void
  readonly timeoutMs?: number
  readonly icon?: ControlIconName
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    if (hovered || focused) return
    const timer = setTimeout(() => dismiss.current(), timeoutMs)
    return () => clearTimeout(timer)
  }, [hovered, focused, timeoutMs])

  return (
    <div
      className={styles.toast}
      role="status"
      onKeyDown={onKeyDown}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusIn={() => setFocused(true)}
      onFocusOut={(event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(false)
      }}
    >
      <ControlIcon name={icon} size={18} />
      <span className={styles.message}>{message}</span>
      {actionLabel && onAction && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            onAction()
            dismiss.current()
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
