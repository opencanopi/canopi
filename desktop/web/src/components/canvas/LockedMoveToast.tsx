import { currentCanvasLockedMoveNotice, dismissCanvasLockedMoveNotice } from '../../canvas/session-state'
import { t } from '../../i18n'
import { Toast } from '../shared/Toast'
import styles from './LockedMoveToast.module.css'

/** How long the lock toast stays: a short notice with no action. */
const LOCKED_MOVE_TOAST_MS = 4000

/**
 * The toast a drag refused by a lock raises (2.1-Q177), for a locked object or a group holding a locked member: one per
 * refused drag, and a new refusal restarts it.
 */
export function LockedMoveToast() {
  const notice = currentCanvasLockedMoveNotice.value
  if (!notice) return null
  return (
    <div className={styles.slot}>
      <Toast
        key={notice.id}
        icon="info"
        message={t('canvas.lockToast.move')}
        timeoutMs={LOCKED_MOVE_TOAST_MS}
        onDismiss={() => dismissCanvasLockedMoveNotice(notice)}
      />
    </div>
  )
}
