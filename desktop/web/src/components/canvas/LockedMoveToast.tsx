import { useRef } from 'preact/hooks'
import { currentCanvasLockedMoveNotice, dismissCanvasLockedMoveNotice } from '../../canvas/session-state'
import { t } from '../../i18n'
import { Toast } from '../shared/Toast'
import { useMapOccluder } from '../shared/useMapChrome'
import styles from './LockedMoveToast.module.css'

/** How long the lock toast stays: a short notice with no action. */
const LOCKED_MOVE_TOAST_MS = 4000

/**
 * The toast a drag refused by a lock raises (2.1-Q177), for a locked object or a group holding a locked member: one per
 * refused drag, and a new refusal restarts it. It stands at the top of the visible map, as status chrome on the
 * visible-map-area seam (`frames: false`): chips avoid it, and it never moves the camera's framing.
 */
export function LockedMoveToast() {
  const notice = currentCanvasLockedMoveNotice.value
  const slot = useRef<HTMLDivElement>(null)
  useMapOccluder(slot, 'top', notice !== null, { frames: false })
  if (!notice) return null
  return (
    <div ref={slot} className={styles.slot} data-locked-move-toast="">
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
