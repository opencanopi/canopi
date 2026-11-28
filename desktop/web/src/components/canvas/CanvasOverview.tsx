import { useLayoutEffect, useRef } from 'preact/hooks'
import { designName } from '../../app/document-session/store'
import { focusOwner } from '../../app/keyboard/focus-owner'
import type { DesignPinExtent } from '../../geo/view/types'
import { currentCanvasDesignPinHovered, currentCanvasQuerySurface, currentCanvasViewportCommandSurface } from '../../canvas/session'
import { t } from '../../i18n'
import { visibleDesignName } from '../shared/DesignNameField'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { ControlIcon } from '../shared/ControlIcon'
import styles from './CanvasOverview.module.css'

/**
 * Overview (below 0.1 px/m): the Design shows as a named pin at its origin, where the view publishes it (none near an
 * edge); the pin fits the Design, as Return to Design does (canopi-n2cg). Its notice is a top chip (OverviewNotice, in
 * CanvasChrome's top-centre slot). The pin sits over the map host, not in it, and is transparent to the pointer, so every
 * gesture that starts on it (a wheel, a drag, a pinch, a panel drop) is the map's, as on bare map. The map's own input
 * owns its pointer: the pin registers its measured box with the view (setDesignPinExtent), and a tap the canvas
 * recognises on that box fits the Design, while a mouse or pen resting on it sets the map's pointer cursor and shows the
 * pin's tooltip (currentCanvasDesignPinHovered). It is still a button for the keyboard (Tab, then Enter or Space) and
 * assistive tech.
 */
export function CanvasOverview() {
  const view = currentCanvasQuerySurface.value?.view
  if (!view || view.mode.value !== 'overview') return null
  const marker = view.designPin.value
  if (!marker) return null
  return <DesignPin x={marker.x} y={marker.y} />
}

function DesignPin({ x, y }: { x: number; y: number }) {
  const pin = useRef<HTMLButtonElement>(null)
  const name = visibleDesignName(designName.value)
  // The box about the pin's point, measured once laid out and again when its size changes (a renamed Design, a font
  // that loads), and none once the pin is gone.
  useLayoutEffect(() => {
    const element = pin.current
    const viewport = currentCanvasViewportCommandSurface.peek()
    if (!element || !viewport) return
    const register = (): void => { viewport.setDesignPinExtent(measuredExtent(element)) }
    register()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(register)
    observer?.observe(element)
    return () => {
      observer?.disconnect()
      viewport.setDesignPinExtent(null)
    }
  }, [])
  return (
    <button
      ref={pin}
      type="button"
      className={styles.pin}
      style={{ left: `${x}px`, top: `${y}px` }}
      aria-label={t('canvas.overview.designPin', { name })}
      onClick={returnToDesign}
      data-overview-pin
    >
      <span className={styles.pinDot} aria-hidden="true"><ControlIcon name="pin" /></span>
      <span className={styles.pinName} aria-hidden="true">{name}</span>
      <ButtonTooltip label={t('canvas.overview.designPinHint')} side="bottom" hovered={currentCanvasDesignPinHovered.value} />
    </button>
  )
}

/** The pin's box as offsets from its point (its `left` and `top` in its positioned parent); null before it is laid out. */
function measuredExtent(element: HTMLElement): DesignPinExtent | null {
  const parent = element.offsetParent
  if (!parent) return null
  const box = element.getBoundingClientRect()
  const frame = parent.getBoundingClientRect()
  const pointX = frame.left + parent.clientLeft + parseFloat(element.style.left)
  const pointY = frame.top + parent.clientTop + parseFloat(element.style.top)
  return { left: box.left - pointX, top: box.top - pointY, right: box.right - pointX, bottom: box.bottom - pointY }
}

/** The pin and Return to Design leave the overview, unmounting the button pressed, so the map takes focus and its keys
 *  work at once, as after a tool picked in overview. */
function returnToDesign(): void {
  currentCanvasViewportCommandSurface.value?.returnToDesign()
  focusOwner.focusMap()
}

/** In overview, a top chip explains that plants are hidden and offers the one Return to Design action. */
export function OverviewNotice() {
  const view = currentCanvasQuerySurface.value?.view
  if (!view || view.mode.value !== 'overview') return null
  return (
    <div className={styles.notice} role="status" aria-live="polite" data-overview-notice>
      <span className={styles.noticeText}>{t('canvas.overview.zoomInToEdit')}</span>
      <button
        type="button"
        className={styles.returnButton}
        onClick={returnToDesign}
      >
        {t('canvas.overview.returnToDesign')}
      </button>
    </div>
  )
}
