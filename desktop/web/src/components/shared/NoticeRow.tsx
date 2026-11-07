/**
 * components/shared/NoticeRow.tsx: Owner of the one notice row (contracts §18 F3, 2.1-Q290). Invariant: it shows the
 * first queued notice of failures/notices.ts (a status, else the oldest), with its place in the count ("1 of 3") once more than one waits, in the
 * current locale, and Dismiss unless the notice is undismissable; it takes no focus. At the window's foot (Desktop) it
 * registers with the visible-map-area seam as status chrome (`frames: false`), so chips avoid it and the camera's
 * framing never moves; below the title bar (Web, `belowTitleBar`, where the phone sheet holds the foot) it is a chrome
 * row like the Web shell's other notices, which the rails start below.
 */
import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'
import { dismissNotice, notices, type Notice as QueuedNotice } from '../../failures/notices'
import { t } from '../../i18n'
import { ControlIcon } from './ControlIcon'
import { Notice } from './Notice'
import { useChromeRow, useMapOccluder } from './useMapChrome'
import styles from './NoticeRow.module.css'

export function NoticeRow({ belowTitleBar }: {
  /** Place the row below the title bar, whose measured bottom is `top` (null: the title bar's token height). */
  readonly belowTitleBar?: { readonly top: number | null }
}) {
  const queued = notices.value
  const notice = queued[0]
  if (!notice) return null
  const content = <NoticeContent notice={notice} count={queued.length} />
  return belowTitleBar
    ? <TitleBarRow notice={notice} top={belowTitleBar.top}>{content}</TitleBarRow>
    : <FootRow notice={notice}>{content}</FootRow>
}

function FootRow({ notice, children }: { readonly notice: QueuedNotice; readonly children: ComponentChildren }) {
  const slot = useRef<HTMLDivElement>(null)
  useMapOccluder(slot, 'bottom', true, { frames: false })
  return <div ref={slot} className={styles.row} {...rowAttributes(notice)}>{children}</div>
}

function TitleBarRow({ notice, top, children }: {
  readonly notice: QueuedNotice
  readonly top: number | null
  readonly children: ComponentChildren
}) {
  const slot = useRef<HTMLDivElement>(null)
  useChromeRow(slot, top)
  return (
    <div
      ref={slot}
      className={`${styles.row} ${styles.belowTitleBar}`}
      style={top === null ? undefined : { top: `calc(${top}px + var(--space-2))` }}
      {...rowAttributes(notice)}
    >
      {children}
    </div>
  )
}

// A warning or an error announces itself through its Notice; an info notice is announced politely by the row.
function rowAttributes(notice: QueuedNotice) {
  return {
    role: (notice.tone ?? 'info') === 'info' ? ('status' as const) : undefined,
    'data-notice-row': '',
    'data-notice-key': notice.key,
  }
}

function NoticeContent({ notice, count }: { readonly notice: QueuedNotice; readonly count: number }) {
  const { action } = notice
  return (
    <Notice
      tone={notice.tone ?? 'info'}
      action={(
        <>
          {action && <button type="button" className={styles.action} onClick={() => action.run()}>{t(action.label)}</button>}
          {!notice.undismissable && (
            <button type="button" className={styles.dismiss} aria-label={t('notice.dismiss')} onClick={() => dismissNotice(notice.id)}>
              <ControlIcon name="close" size={16} />
            </button>
          )}
        </>
      )}
    >
      {notice.title && <strong className={styles.title}>{t(notice.title)}</strong>}
      <span>{t(notice.message, notice.params)}</span>
      {count > 1 && (
        <span className={styles.count} data-notice-count="">{t('notice.count', { index: 1, count })}</span>
      )}
    </Notice>
  )
}
