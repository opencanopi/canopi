/**
 * components/shared/NoticeRow.tsx: Owner of the one notice row (contracts §18 F3, 2.1-Q290). Invariant: it shows the
 * oldest queued notice of failures/notices.ts, with its place in the count ("1 of 3") once more than one waits, in the
 * current locale; it takes no focus and registers with the visible-map-area seam as status chrome (`frames: false`),
 * so chips avoid it and the camera's framing never moves.
 */
import { useRef } from 'preact/hooks'
import { dismissNotice, notices } from '../../failures/notices'
import { t } from '../../i18n'
import { ControlIcon } from './ControlIcon'
import { Notice } from './Notice'
import { useMapOccluder } from './useMapChrome'
import styles from './NoticeRow.module.css'

export function NoticeRow() {
  const queued = notices.value
  const slot = useRef<HTMLDivElement>(null)
  const notice = queued[0]
  useMapOccluder(slot, 'bottom', notice !== undefined, { frames: false })
  if (!notice) return null
  const { action } = notice
  const tone = notice.tone ?? 'info'
  // A warning or an error announces itself through its Notice; an info notice is announced politely by the row.
  return (
    <div ref={slot} className={styles.row} role={tone === 'info' ? 'status' : undefined} data-notice-row="" data-notice-key={notice.key}>
      <Notice
        tone={tone}
        action={(
          <>
            {action && <button type="button" className={styles.action} onClick={() => action.run()}>{t(action.label)}</button>}
            <button type="button" className={styles.dismiss} aria-label={t('notice.dismiss')} onClick={() => dismissNotice(notice.id)}>
              <ControlIcon name="close" size={16} />
            </button>
          </>
        )}
      >
        {notice.title && <strong className={styles.title}>{t(notice.title)}</strong>}
        <span>{t(notice.message, notice.params)}</span>
        {queued.length > 1 && (
          <span className={styles.count} data-notice-count="">{t('notice.count', { index: 1, count: queued.length })}</span>
        )}
      </Notice>
    </div>
  )
}
