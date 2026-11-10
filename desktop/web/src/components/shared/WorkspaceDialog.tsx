import type { ComponentChildren } from 'preact'
import { useId, useLayoutEffect, useRef } from 'preact/hooks'
import { SurfaceBoundary } from './SurfaceBoundary'
import { t } from '../../i18n'
import { ControlIcon } from './ControlIcon'
import { trapTabWithToasts, useModalLayer } from './useModalLayer'
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

  const focusInitial = () => {
    const initial = dialog.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ?? dialog.current?.querySelector<HTMLElement>(FOCUSABLE)
    initial?.focus()
  }
  // Tab wraps inside the dialog, through the window's toasts while it is the topmost modal (an Undo shown above it
  // sits in its cycle), and Escape in a toast closes it.
  const tabStops = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
  useModalLayer({ root: dialog, tabStops, escape: onClose })
  const scrim = useScrimPress(onClose)
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
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
          if (event.key === 'Tab') trapTabWithToasts(tabStops(), event)
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
