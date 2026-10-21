import { useEffect, useRef } from 'preact/hooks'
import { phoneLayout } from '../../app/shell/phone-layout'
import { clearCanvasLockedMoveNotice, currentCanvasLockedMoveNotice, dismissCanvasLockedMoveNotice } from '../../canvas/session-state'
import { t } from '../../i18n'
import { Toast } from '../shared/Toast'
import { useMapOccluder } from '../shared/useMapChrome'
import styles from './LockedMoveToast.module.css'

/** How long the lock toast stays: a short notice with no action. */
const LOCKED_MOVE_TOAST_MS = 4000

/**
 * The toast a drag refused by a lock raises (2.1-Q177), for a locked object or a group holding a locked member: one per
 * refused drag, and a new refusal restarts it. It stands at the top of the visible map, as status chrome on the
 * visible-map-area seam (`frames: false`): chips avoid it, and it never moves the camera's framing. On a phone it wraps
 * clear of the zoom column, which stays shown beside it. It mounts with the canvas chrome and clears the notice when
 * that unmounts (a Design closed within the toast's time), so the next Design's canvas never replays it (canopi-eon8.14.3).
 */
export function LockedMoveToast() {
  const notice = currentCanvasLockedMoveNotice.value
  const slot = useRef<HTMLDivElement>(null)
  useEffect(() => clearCanvasLockedMoveNotice, [])
  useMapOccluder(slot, 'top', notice !== null, { frames: false })
  if (!notice) return null
  return (
    <div ref={slot} className={styles.slot} data-locked-move-toast="" data-phone={phoneLayout.value !== null ? '' : undefined}>
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
