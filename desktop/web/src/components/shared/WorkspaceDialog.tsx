import type { ComponentChildren } from 'preact'
import { useId, useLayoutEffect, useRef } from 'preact/hooks'
import { t } from '../../i18n'
import { ControlIcon } from './ControlIcon'
import { useModalLayer } from './useModalLayer'
import { useScrimPress } from './useScrimPress'
import styles from './WorkspaceDialog.module.css'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * A modal workspace dialog: Literata title, close button, focus moved in on
 * open, trapped while open and returned on close (`useModalLayer`, which also
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
  // Focus goes in as the dialog commits, after the modal layer has read the focus to give back, so an Esc at once is
  // the dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    const initial = dialog.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ?? dialog.current?.querySelector<HTMLElement>(FOCUSABLE)
    initial?.focus()
  }, [])

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
            return
          }
          if (event.key !== 'Tab') return
          const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
          const first = focusable[0]
          const last = focusable.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <header className={styles.header}>
          <h2 className={styles.title} id={titleId}>{title}</h2>
          <button type="button" className={styles.close} aria-label={t('window.close')} onClick={onClose}>
            <ControlIcon name="close" size={18} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </section>
    </div>
  )
}
