import { useEffect, useId, useRef, useState } from 'preact/hooks'
import type { CanvasToolbarActionCommand } from '../../app/canvas-commands'
import { ESCAPE_PRIORITY, registerEscapeLayer } from '../../app/keyboard/escape-chain'
import type { RotationSession } from '../../geo/view/read-surface'
import { DEFAULT_THRESHOLDS } from '../../canvas/runtime/input/thresholds'
import { currentCanvasQuerySurface, currentCanvasViewportCommandSurface } from '../../canvas/session'
import { t } from '../../i18n'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import styles from './Compass.module.css'

/** Within this radius of the centre, on the needle, the pointer's angle is noise: it turns nothing, and the angle is
 *  taken up again where the pointer leaves it. It never decides click or drag; travel alone does. */
const CENTRE_DEAD_ZONE_PX = 6

interface ScreenPoint { readonly x: number; readonly y: number }

/** One press on the compass face, from pointerdown to its release. */
interface Press {
  readonly pointerId: number
  readonly start: ScreenPoint
  readonly centre: ScreenPoint
  /** Travel that makes the press a drag: the canvas's drag slop for the pointer kind (U17), 3 px for a mouse or pen and 8 px
   *  for a finger, whose tap rolls further, so a jittery tap still resets north (spec §4.2). */
  readonly dragStartPx: number
  /** pending: under the drag start's travel, a click; turning: the view follows the pointer; ended: Esc, a lost capture or a window blur
   *  ended it while the pointer is still down, so its release is no click. */
  phase: 'pending' | 'turning' | 'ended'
  /** Where the pointer last was, if outside the dead zone; null while it is inside, so the next angle starts afresh. */
  last: ScreenPoint | null
  /** Clockwise degrees swept since the press, unwrapped. */
  swept: number
  session: RotationSession | null
  /** Drops the Esc layer and the window blur listener. */
  release(): void
}

/**
 * The compass, the last button of the zoom group (spec §4.2; pattern canvas-navigation.md): its needle points to true
 * north, turned by −bearing. A click, Enter or Space runs Keyboard's `reset-north` command, whose label and keys it
 * shows. A primary drag on the face past 3 px for a mouse or pen, or 8 px for a finger (so a tap that rolls stays a
 * tap), turns the view about the screen centre by the pointer's angle around the compass, so the needle follows the
 * pointer (a clockwise drag lowers the bearing); Shift steps to 15° multiples, read on each move. Within 6 px of the centre the angle is
 * ignored, so a drag there turns nothing and a drag that crosses it, even in one step between two moves, takes the
 * angle up again on the far side; past the travel a press is a drag wherever the pointer is. The drag runs outside the input pipeline, so while a press is live it holds an Esc
 * layer at the gesture priority (fixture I9): Esc restores the starting camera, or before the drag starts ends the press
 * with no reset. A pointer cancel, a lost capture and a window blur cancel it too.
 */
export function Compass({ command, className }: {
  readonly command: CanvasToolbarActionCommand
  /** The zoom group's button class: size, hover and focus ring. Required, so no caller leaves the compass unsized; a CSS
   *  module's class reads as possibly undefined. */
  readonly className: string | undefined
}) {
  const view = currentCanvasQuerySurface.value?.view
  const bearingDeg = view?.bearingDeg.value ?? 0
  const northUp = view?.northUp.value ?? true
  const descriptionId = useId()
  const press = useRef<Press | null>(null)
  /** Set by the release of a press that was not a click, until the next press: the pointer click the browser sends
   *  after it does nothing. A touch tap sends that click from its own gesture, a task or more after the release, so no
   *  timer can bound it. A click of detail 0 (a screen reader, a script) is never a pointer's, so it always runs. */
  const swallowClick = useRef(false)
  const [turning, setTurning] = useState(false)

  useEffect(() => () => {
    press.current?.session?.cancel()
    press.current?.release()
    press.current = null
  }, [])

  /** Ends the live press with the starting camera back; its release, if one follows, is no click. */
  function cancel(): void {
    const current = press.current
    if (!current || current.phase === 'ended') return
    current.session?.cancel()
    current.phase = 'ended'
    current.release()
    setTurning(false)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || event.isPrimary === false || isLive(press.current)) return
    const button = event.currentTarget as HTMLButtonElement
    event.preventDefault()
    button.focus({ preventScroll: true })
    try { button.setPointerCapture?.(event.pointerId) } catch { /* A host without capture still sends the moves here. */ }
    swallowClick.current = false
    press.current?.release()
    const box = button.getBoundingClientRect()
    const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    const start = { x: event.clientX, y: event.clientY }
    const disposeEscape = registerEscapeLayer({
      priority: ESCAPE_PRIORITY.gesture,
      isActive: () => isLive(press.current),
      escape: ({ focus }) => {
        if (focus === 'modal') return false
        cancel()
        return true
      },
    })
    const onBlur = () => cancel()
    window.addEventListener('blur', onBlur)
    press.current = {
      pointerId: event.pointerId,
      start,
      centre,
      dragStartPx: DEFAULT_THRESHOLDS.dragSlopPx[event.pointerType === 'touch' || event.pointerType === 'pen' ? event.pointerType : 'mouse'],
      phase: 'pending',
      last: outsideDeadZone(centre, start) ? start : null,
      swept: 0,
      session: null,
      release: () => {
        disposeEscape()
        window.removeEventListener('blur', onBlur)
      },
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId || current.phase === 'ended') return
    const point = { x: event.clientX, y: event.clientY }
    const outside = outsideDeadZone(current.centre, point)
    // A step whose path passes through the dead zone crossed the centre, however fast: it turns nothing either.
    if (outside && current.last && !passesThroughDeadZone(current.centre, current.last, point)) {
      current.swept += wrapDegrees(angleAbout(current.centre, point) - angleAbout(current.centre, current.last))
    }
    current.last = outside ? point : null
    if (current.phase === 'pending') {
      if (Math.hypot(point.x - current.start.x, point.y - current.start.y) < current.dragStartPx) return
      const viewport = currentCanvasViewportCommandSurface.peek()
      if (!viewport) return
      current.session = viewport.beginRotation('centre')
      current.phase = 'turning'
      setTurning(true)
    }
    // The needle follows the pointer: a clockwise sweep turns the map clockwise on screen, which lowers the bearing.
    current.session?.update(-current.swept, { step: event.shiftKey })
  }

  function onPointerUp(event: PointerEvent): void {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId) return
    press.current = null
    current.release()
    if (current.phase === 'pending') return
    if (current.phase === 'turning') {
      current.session?.end()
      setTurning(false)
    }
    // The click that follows this release, however late, belongs to the drag (or the Esc that ended it).
    swallowClick.current = true
  }

  function onPointerCancel(event: PointerEvent): void {
    if (press.current?.pointerId !== event.pointerId) return
    cancel()
    press.current = null
  }

  return (
    <>
      <button
        type="button"
        className={[className, styles.compass].filter(Boolean).join(' ')}
        data-compass
        data-turned={northUp ? undefined : 'true'}
        data-dragging={turning ? 'true' : undefined}
        data-command={command.commandId}
        aria-label={command.label}
        aria-keyshortcuts={command.ariaShortcut}
        aria-describedby={descriptionId}
        aria-disabled={command.disabled ? true : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={(event) => { if (press.current?.pointerId === event.pointerId) cancel() }}
        onClick={(event) => {
          if (swallowClick.current && event.detail !== 0) {
            swallowClick.current = false
            return
          }
          if (!command.disabled) command.action()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          // Handled here, so the key's own button activation does not run the command a second time.
          event.preventDefault()
          if (!event.repeat && !command.disabled && !isLive(press.current)) command.action()
        }}
        onKeyUp={(event) => { if (event.key === ' ') event.preventDefault() }}
      >
        <svg className={styles.glyph} width={20} height={20} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle className={styles.ring} cx="10" cy="10" r="8.2" />
          <g data-needle transform={`rotate(${-bearingDeg} 10 10)`}>
            <path className={styles.north} d="M10 3.6L12.6 10H7.4z" />
            <path className={styles.south} d="M7.4 10h5.2L10 16.4z" />
          </g>
        </svg>
        <ButtonTooltip label={command.label} shortcut={command.shortcut} description={t('canvas.compass.hint')} side="top" />
      </button>
      <span id={descriptionId} className={styles.description}>
        {northUp ? t('canvas.compass.northUp') : t('canvas.compass.bearing', { degrees: spokenBearing(bearingDeg) })}
      </span>
    </>
  )
}

/** The bearing in whole degrees for the screen reader; within half a degree of north, its tenth, so it never reads 0°
 *  or 360° while the view is turned. */
function spokenBearing(bearingDeg: number): number {
  const whole = Math.round(bearingDeg) % 360
  return whole === 0 ? bearingDeg : whole
}

function isLive(press: Press | null): boolean {
  return press !== null && press.phase !== 'ended'
}

function outsideDeadZone(centre: ScreenPoint, point: ScreenPoint): boolean {
  return Math.hypot(point.x - centre.x, point.y - centre.y) >= CENTRE_DEAD_ZONE_PX
}

/** Whether the straight step from one point to the next comes within the dead zone. */
function passesThroughDeadZone(centre: ScreenPoint, from: ScreenPoint, to: ScreenPoint): boolean {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSq = dx * dx + dy * dy
  const along = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((centre.x - from.x) * dx + (centre.y - from.y) * dy) / lengthSq))
  return !outsideDeadZone(centre, { x: from.x + along * dx, y: from.y + along * dy })
}

/** The angle of a point about a centre on screen, in degrees (0 to the right, 90 down). */
function angleAbout(centre: ScreenPoint, point: ScreenPoint): number {
  return Math.atan2(point.y - centre.y, point.x - centre.x) * 180 / Math.PI
}

/** A difference of angles in (−180, 180]. */
function wrapDegrees(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180
  return wrapped === -180 ? 180 : wrapped
}
