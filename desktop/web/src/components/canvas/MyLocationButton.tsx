import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { geolocationSupported } from '../../app/my-location/geolocation'
import { myLocation, type MyLocationMode } from '../../app/my-location/session'
import { t } from '../../i18n'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import styles from './MyLocationButton.module.css'

/**
 * Show my location: the button in the zoom group, before the compass (canopi-f47t.53, U54 Q9, Q13, Q16, Q18;
 * 2.1-Q146; pattern canvas-navigation.md). Web, Desktop Linux and Desktop Windows pass it when `my-location` is in
 * their capability set (macOS Desktop omits it per ADR 0030), and the button hides without a secure context or
 * `navigator.geolocation` (design check A1). A click runs the location session's press: from Off it shows the dot and
 * follows it, while Following it turns location off, while Moved away it re-centres and follows again. It is pressed
 * only while Following; Blocked disables it with the reason in its tooltip, and a stale fix says location is
 * unavailable. A touch screen has no hover, so a tap shows that tooltip for a few seconds while it has a reason to give.
 */
export function MyLocationButton({ className }: { readonly className: string | undefined }) {
  if (!geolocationSupported()) return null
  return (
    <MyLocationButtonView
      className={className}
      mode={myLocation.mode.value}
      unavailable={myLocation.unavailable.value}
      hasReading={myLocation.reading.value !== null}
      onPress={() => myLocation.press()}
    />
  )
}

/** How long a tap shows the tooltip's reason on a touch screen. */
const TAP_TOOLTIP_MS = 4000

/** The button for a given state, so the UI gallery can show each one without a device location. */
export function MyLocationButtonView({ className, mode, unavailable, hasReading = false, onPress }: {
  /** The zoom group's button class, which gives the button its size, hover and focus. */
  readonly className: string | undefined
  readonly mode: MyLocationMode
  /** The browser reported the position unavailable or timed out since the last fix. */
  readonly unavailable: boolean
  /** True once a device reading has arrived in this session (boolean only; never exposes coordinates). */
  readonly hasReading?: boolean
  readonly onPress: () => void
}) {
  const descriptionId = useId()
  const label = t('canvas.myLocation.show')
  const blocked = mode === 'blocked'
  const following = mode === 'following'
  const description = blocked
    ? t('canvas.myLocation.blocked')
    : unavailable ? t('canvas.myLocation.unavailable') : null
  const touchPress = useRef(false)
  const [tapped, setTapped] = useState(0)
  useEffect(() => {
    if (tapped === 0) return
    const timer = setTimeout(() => setTapped(0), TAP_TOOLTIP_MS)
    return () => clearTimeout(timer)
  }, [tapped])
  return (
    <>
      <button
        type="button"
        className={[className, styles.location].filter(Boolean).join(' ')}
        data-my-location={mode}
        data-my-location-unavailable={unavailable ? 'true' : undefined}
        data-my-location-fix={hasReading ? 'true' : undefined}
        aria-label={label}
        aria-pressed={following ? true : undefined}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={description ? descriptionId : undefined}
        onPointerDown={(event) => { touchPress.current = event.pointerType === 'touch' }}
        onClick={() => {
          if (touchPress.current) setTapped((count) => count + 1)
          touchPress.current = false
          if (!blocked) onPress()
        }}
      >
        <svg className={styles.glyph} width={20} height={20} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle cx="10" cy="10" r="5.5" />
          <path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3" />
          <circle className={following ? styles.centreOn : undefined} cx="10" cy="10" r="2.2" />
        </svg>
        <ButtonTooltip label={label} description={description ?? undefined} side="top" shown={tapped > 0 && description !== null} />
      </button>
      {description && <span id={descriptionId} className={styles.description}>{description}</span>}
    </>
  )
}
