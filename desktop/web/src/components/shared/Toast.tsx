import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { ControlIcon, type ControlIconName } from './ControlIcon'
import styles from './Toast.module.css'

const TOAST_TIMEOUT_MS = 8000

/**
 * A short confirmation with at most one action (usually Undo). It dismisses itself after
 * `timeoutMs`, but never while it is hovered or holds focus; the countdown restarts after.
 * ToastSlot.tsx places it in the window's one toast position (the canvas lock toast stays canvas chrome); the caller
 * owns which toast is showing.
 */
export function Toast({
  message, actionLabel, onAction, onDismiss, onKeyDown, onLeaveFocused, timeoutMs = TOAST_TIMEOUT_MS, icon = 'check',
}: {
  readonly message: ComponentChildren
  readonly actionLabel?: string
  onAction?(): void
  onDismiss(): void
  /** A key pressed in the toast (ToastSlot hands Tab to an open dialog's trap). */
  onKeyDown?(event: KeyboardEvent): void
  /** The toast is leaving while it holds focus (its Undo was pressed from the keyboard): focus must go somewhere live. */
  onLeaveFocused?(): void
  readonly timeoutMs?: number
  readonly icon?: ControlIconName
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const root = useRef<HTMLDivElement>(null)
  const leaveFocused = useRef(onLeaveFocused)
  leaveFocused.current = onLeaveFocused

  // Runs as the toast unmounts, before its DOM goes, while the focus it holds can still be read.
  useLayoutEffect(() => () => {
    if (root.current?.contains(document.activeElement)) leaveFocused.current?.()
  }, [])

  useEffect(() => {
    if (hovered || focused) return
    const timer = setTimeout(() => dismiss.current(), timeoutMs)
    return () => clearTimeout(timer)
  }, [hovered, focused, timeoutMs])

  return (
    <div
      ref={root}
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
