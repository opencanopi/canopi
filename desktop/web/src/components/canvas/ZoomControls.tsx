import type { FunctionComponent } from 'preact'
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { CanvasToolbarActionCommand } from '../../app/canvas-commands'
import { locale } from '../../app/settings/state'
import { phoneLayout } from '../../app/shell/phone-layout'
import {
  COMMON_MAP_SCALES,
  formatMapScale,
  getScaleBarDisplay,
  mapScaleDenominator,
  roundScaleDenominator,
  zoomFactorForScale,
} from '../../canvas/map-scale'
import { currentCanvasQuerySurface, currentCanvasViewportCommandSurface } from '../../canvas/session'
import { t } from '../../i18n'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { ControlIcon, type ControlIconName } from '../shared/ControlIcon'
import { framingMapFrame } from '../../app/shell/visible-map-area'
import { useMapOccluder, usePublishedWidth, useUnderRail } from '../shared/useMapChrome'
import { Compass } from './Compass'
import { InspectionLauncher } from './InspectionLens'
import styles from './ZoomControls.module.css'

const VIEW_ACTION_ICONS: Readonly<Record<string, ControlIconName>> = {
  'zoom-in': 'plus',
  'zoom-out': 'minus',
  'fit-to-design': 'fit',
}

/**
 * The zoom group at the bottom right: scale bar, zoom out, the map scale as
 * a ratio (a menu of common scales), zoom in, Fit to Design and, after a
 * divider, the edition's Show my location (Web) and the compass (always
 * shown). The map attribution pill sits just left of it. On a phone it is a
 * column on the right above the panel sheet: the inspection lens's launcher,
 * zoom in, zoom out, Fit to Design, Show my location and the compass, the only
 * chrome floating over a phone's map, with 44 px targets and no ratio (phones
 * have no scale readout); it is placed from the visible map frame, so it
 * covers no edge, and hides where that frame has no room for it (a full
 * sheet, a half sheet on a short phone). Show my location and the compass are buttons of the group:
 * the group's layer and map registration cover them.
 */
export function ZoomControls({ viewActions, myLocation: MyLocation }: {
  readonly viewActions: readonly CanvasToolbarActionCommand[]
  /** Show my location, rendered before the compass with the group's button class; editions without it pass none. */
  readonly myLocation?: FunctionComponent<{ readonly className: string | undefined }>
}) {
  const zoomIn = viewCommand(viewActions, 'zoom-in')
  const zoomOut = viewCommand(viewActions, 'zoom-out')
  const fit = viewCommand(viewActions, 'fit-to-design')
  const resetNorth = viewCommand(viewActions, 'reset-north')
  const group = useRef<HTMLDivElement>(null)
  const phone = phoneLayout.value !== null
  useMapOccluder(group, 'bottom', !phone)
  useUnderRail(group, 'panel')
  const view = currentCanvasQuerySurface.value?.view
  const zoomLimit = view?.zoomLimit.value ?? null
  const atMinimum = zoomLimit === 'min'
  const atMaximum = zoomLimit === 'max'
  const groundMetresPerPixel = view?.groundMetresPerPixel.value
  const denominator = groundMetresPerPixel === undefined ? null : mapScaleDenominator(groundMetresPerPixel)
  const bar = groundMetresPerPixel === undefined ? null : getScaleBarDisplay(1 / groundMetresPerPixel)

  // The attribution pill is placed against this group's measured width.
  usePublishedWidth(group, '--zoom-group-width')
  const roomless = usePhoneColumnRoomless(group, phone)

  if (phone) {
    return (
      <div ref={group} className={`${styles.group} ${styles.phone}`} role="group" aria-label={t('canvas.grid.zoom')} data-zoom-group="phone"
        data-roomless={roomless ? '' : undefined}>
        <InspectionLauncher className={styles.button} />
        <ZoomButton command={zoomIn} disabled={zoomIn.disabled || atMaximum} />
        <ZoomButton command={zoomOut} disabled={zoomOut.disabled || atMinimum} />
        <ZoomButton command={fit} disabled={fit.disabled} />
        {MyLocation && <MyLocation className={styles.button} />}
        <Compass command={resetNorth} className={styles.button} />
      </div>
    )
  }

  return (
    <div ref={group} className={styles.group} role="group" aria-label={t('canvas.grid.zoom')} data-zoom-group>
      {bar && (
        <span className={styles.scaleBar} role="img" aria-label={t('canvas.zoom.scaleBar', { distance: formatDistance(bar.meters, locale.value) })}>
          <span className={styles.scaleLabel}>{formatDistance(bar.meters, locale.value)}</span>
          <span className={styles.scaleLine} style={{ width: `${Math.round(bar.barScreenPx)}px` }} />
        </span>
      )}
      <span className={styles.rule} aria-hidden="true" />
      <ZoomButton command={zoomOut} disabled={zoomOut.disabled || atMinimum} />
      {denominator !== null && <ScaleMenu denominator={denominator} />}
      <ZoomButton command={zoomIn} disabled={zoomIn.disabled || atMaximum} />
      <ZoomButton command={fit} disabled={fit.disabled} />
      <span className={styles.rule} aria-hidden="true" />
      {MyLocation && <MyLocation className={styles.button} />}
      <Compass command={resetNorth} className={styles.button} />
    </div>
  )
}

/** The least room the phone column keeps between itself and the top bar (`--chrome-rail-top` is the top bar's bottom plus
 *  this). */
const COLUMN_TOP_GAP_PX = 8

/**
 * Whether the phone column is taller or wider than the framing frame it is placed in (answer 25): it then hides rather
 * than stand over the top bar or the panel sheet. Status chrome (`frames: false`, the lock toast) never moves the
 * column, so it takes none of its room. Measured on every render, which the frame's changes cause.
 */
function usePhoneColumnRoomless(group: { readonly current: HTMLElement | null }, phone: boolean): boolean {
  const frame = framingMapFrame.value
  const [roomless, setRoomless] = useState(false)
  useLayoutEffect(() => {
    const element = group.current
    const height = frame.height - frame.top - frame.bottom - COLUMN_TOP_GAP_PX
    const width = frame.width - frame.left - frame.right
    setRoomless(phone && element !== null && frame.height > 0 && (element.offsetHeight > height || element.offsetWidth > width))
  })
  return roomless
}

/** The group's commands are static view commands: a missing one is a wiring bug, not a state to render. */
function viewCommand(viewActions: readonly CanvasToolbarActionCommand[], id: string): CanvasToolbarActionCommand {
  const command = viewActions.find((action) => action.id === id)
  if (!command) throw new Error(`ZoomControls: no view command '${id}'`)
  return command
}

function ZoomButton({ command, disabled }: { readonly command: CanvasToolbarActionCommand; readonly disabled: boolean }) {
  return (
    <button
      type="button"
      className={styles.button}
      data-command={command.commandId}
      aria-label={command.label}
      aria-keyshortcuts={command.ariaShortcut}
      aria-disabled={disabled ? true : undefined}
      onClick={() => { if (!disabled) command.action() }}
    >
      <ControlIcon name={VIEW_ACTION_ICONS[command.id] ?? 'plus'} size={20} />
      <ButtonTooltip label={command.label} shortcut={command.shortcut} side="top" />
    </button>
  )
}

function ScaleMenu({ denominator }: { readonly denominator: number }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const current = roundScaleDenominator(denominator)
  const label = formatMapScale(denominator, locale.value)

  // Focus goes in as the menu commits, so its Esc handler hears the key from the first painted frame (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    if (!open) return
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    const checked = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    ;(checked ?? items?.[0])?.focus()
    const outside = (event: Event) => {
      const target = event.target as Node | null
      if (target && !menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerup', outside)
    return () => document.removeEventListener('pointerup', outside)
  }, [open])

  function close(): void {
    setOpen(false)
    trigger.current?.focus()
  }

  function choose(target: number): void {
    close()
    currentCanvasViewportCommandSurface.peek()?.zoomBy(zoomFactorForScale(denominator, target))
  }

  return (
    <span className={styles.scaleMenuAnchor}>
      <button
        ref={trigger}
        type="button"
        className={styles.ratio}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('canvas.zoom.chooseScale', { scale: label })}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {label}
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className={styles.menu}
          role="menu"
          aria-label={t('canvas.zoom.mapScale')}
          onKeyDown={(event) => {
            const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              items[(index + step + items.length) % items.length]?.focus()
            } else if (event.key === 'Tab') {
              setOpen(false)
            }
          }}
        >
          {COMMON_MAP_SCALES.map((scale) => (
            <button
              key={scale}
              type="button"
              role="menuitemradio"
              aria-checked={scale === current}
              className={styles.menuItem}
              tabIndex={-1}
              onClick={() => choose(scale)}
            >
              <span className={styles.menuCheck} aria-hidden="true">{scale === current && <ControlIcon name="check" />}</span>
              {formatMapScale(scale, locale.value)}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/** "5 m", "2 km", "50 cm": the scale bar's distance in the interface language. */
export function formatDistance(meters: number, activeLocale: string): string {
  const [value, unit] = meters >= 1000 ? [meters / 1000, 'kilometer']
    : meters < 1 ? [meters * 100, 'centimeter']
      : [meters, 'meter']
  return new Intl.NumberFormat(activeLocale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(value)
}
