import type { ComponentChildren } from 'preact'
import { useId, useLayoutEffect, useRef } from 'preact/hooks'
import { SurfaceBoundary } from './SurfaceBoundary'
import { t } from '../../i18n'
import { ControlIcon } from './ControlIcon'
import { toastFocusables, trapToastTab } from './ToastSlot'
import { useModalLayer } from './useModalLayer'
import { useScrimPress } from './useScrimPress'
import styles from './WorkspaceDialog.module.css'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * A modal workspace dialog: Literata title, close button, focus moved in on
 * open, trapped while open (with the window's toasts, so an Undo stays in
 * reach) and returned on close (`useModalLayer`, which also
 * makes the chrome behind it inert); Escape closes. `large` is a sheet of fixed
 * size, min(1200 px, 100vw − 48) × min(860 px, 100vh − 48), whose body does not
 * scroll: its content lays out panes that scroll on their own (the Data library).
 */
export function WorkspaceDialog({ title, onClose, children, footer, wide = false, large = false }: {
  readonly title: string
  onClose(): void
  readonly children: ComponentChildren
  readonly footer?: ComponentChildren
  readonly wide?: boolean
  readonly large?: boolean
}) {
  const dialog = useRef<HTMLElement>(null)
  const titleId = useId()

  useModalLayer()
  const scrim = useScrimPress(onClose)
  // Tab wraps inside the dialog, through the window's toasts (an Undo shown above it sits in its cycle). Only a step
  // across an end of that cycle is moved by hand; the browser moves every other.
  const trapTab = (event: KeyboardEvent) => {
    const own = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const toasts = toastFocusables()
    const cycle = [...own, ...toasts]
    const at = cycle.findIndex((element) => element === document.activeElement)
    const crossing = at >= 0 && (at >= own.length || at === (event.shiftKey ? 0 : own.length - 1))
    if (!crossing) return
    event.preventDefault()
    cycle[(at + (event.shiftKey ? -1 : 1) + cycle.length) % cycle.length]?.focus()
  }
  // The dialog control that last had focus: a focused toast that leaves (its Undo pressed from the keyboard) gives
  // focus back to it, or to the initial control once it is gone, so Escape and Tab stay the dialog's.
  const lastFocused = useRef<HTMLElement | null>(null)
  const focusInitial = () => {
    const initial = dialog.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ?? dialog.current?.querySelector<HTMLElement>(FOCUSABLE)
    initial?.focus()
  }
  const returnFocus = () => {
    const last = lastFocused.current
    if (last && dialog.current?.contains(last)) last.focus()
    else focusInitial()
  }
  useLayoutEffect(() => trapToastTab({ trapTab, returnFocus }), [])
  // Focus goes in as the dialog commits, after the modal layer has read the focus to give back, so an Esc at once is
  // the dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(focusInitial, [])

  return (
    <div className={styles.overlay} {...scrim}>
      <section
        ref={dialog}
        className={`${styles.dialog} ${wide ? styles.wide : ''} ${large ? styles.large : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-preserve-overlays="true"
        onFocusIn={(event) => { if (event.target instanceof HTMLElement) lastFocused.current = event.target }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key === 'Tab') trapTab(event)
        }}
      >
        <header className={styles.header}>
          <h2 className={styles.title} id={titleId}>{title}</h2>
          <button type="button" className={styles.close} aria-label={t('window.close')} onClick={onClose}>
            <ControlIcon name="close" size={18} />
          </button>
        </header>
        <div className={styles.body}><SurfaceBoundary surface="workspace-dialog">{children}</SurfaceBoundary></div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </section>
    </div>
  )
}
