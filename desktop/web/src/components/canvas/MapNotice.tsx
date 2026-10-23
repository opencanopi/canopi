import type { RefObject } from 'preact'
import { signal } from '@preact/signals'
import { useCallback, useLayoutEffect, useRef } from 'preact/hooks'
import { t } from '../../i18n'
import type { MapNoticeReadModel } from '../../app/canvas-map-surface/map-notice'
import { focusOwner } from '../../app/keyboard/focus-owner'
import { phoneLayout } from '../../app/shell/phone-layout'
import { siteLocateOpen } from '../../app/site-onboarding/state'
import { storyPresentationActive } from '../../app/story-presentation'
import { useMapOccluder } from '../shared/useMapChrome'
import styles from '../panels/Panels.module.css'

interface MapNoticeProps {
  readonly notice: MapNoticeReadModel
  readonly onRetry: () => void
  /** The focusable map surface, which takes keyboard focus when the chip goes while holding it. */
  readonly canvasRef: RefObject<HTMLElement | null>
}

/**
 * The canvas's notice and its map's Retry while the canvas does not draw them: a presented story's presenter draws them
 * (`PresentedMapNotice`), and on a phone the context bar does (`BarMapNotice`).
 */
const relayedNotice = signal<{ readonly notice: MapNoticeReadModel, readonly onRetry: () => void } | null>(null)

/**
 * The map's status chip, the same in both editions: a fixed sentence, with Retry when the map or basemap can be
 * rebuilt. Only the sentence is the live region. While a story is presented the canvas draws no chip: the full-window
 * presenter is modal over the map, so it draws this notice itself, with the same Retry, inside its own layer and Tab
 * cycle (`PresentedMapNotice`). On a phone the canvas draws none either: the notice is a status row on top of the
 * context bar (`BarMapNotice`, answer 24), in the panel sheet, whose registration covers it. Elsewhere the chip stands
 * above the bottom row, so it takes none of the map credits' room; while it shows it is bottom chrome on the
 * visible-map-area seam only so the selection chip stands above it; it comes and goes with load state, so it registers
 * with `frames: false` and never moves the camera's framing.
 */
export function MapNotice({ notice, onRetry, canvasRef }: MapNoticeProps) {
  // While "Where is your site?" shows, a phone's sheet and its bar step aside: the canvas draws the notice then.
  const relayed = storyPresentationActive.value || (phoneLayout.value !== null && !siteLocateOpen.value)
  const latestRetry = useRef(onRetry)
  latestRetry.current = onRetry
  const retry = useCallback(() => latestRetry.current(), [])
  const { visible, tone, statusText, retry: offersRetry } = notice
  useLayoutEffect(() => {
    if (relayed) relayedNotice.value = { notice, onRetry: retry }
  }, [relayed, visible, tone, statusText, offersRetry])
  useLayoutEffect(() => {
    if (relayed) return () => { relayedNotice.value = null }
  }, [relayed])
  const focusMap = () => canvasRef.current?.focus({ preventScroll: true })
  return <NoticeChip notice={notice} shown={visible && !relayed} onRetry={onRetry} returnFocus={focusMap} layer="map" />
}

/** The canvas's map notice inside the story presenter, which takes focus when the chip goes while holding it. */
export function PresentedMapNotice({ focusHome }: { readonly focusHome: RefObject<HTMLElement | null> }) {
  return <RelayedNotice layer="presenter" returnFocus={() => focusHome.current?.focus({ preventScroll: true })} />
}

/** The canvas's map notice as the status row on top of a phone's context bar; the map takes focus when it goes. */
export function BarMapNotice() {
  return <RelayedNotice layer="bar" returnFocus={() => focusOwner.focusMap()} />
}

function RelayedNotice({ layer, returnFocus }: { readonly layer: 'presenter' | 'bar', readonly returnFocus: () => void }) {
  const relayed = relayedNotice.value
  const notice = relayed?.notice ?? HIDDEN
  return <NoticeChip notice={notice} shown={notice.visible} onRetry={relayed?.onRetry ?? noRetry} returnFocus={returnFocus} layer={layer} />
}

const HIDDEN: MapNoticeReadModel = { visible: false, mapSurfaceVisible: false, tone: 'ready', statusText: '', retry: false }
const noRetry = () => {}

interface NoticeChipProps {
  readonly notice: MapNoticeReadModel
  readonly shown: boolean
  readonly onRetry: () => void
  /** Where focus goes when the chip goes while holding it: the map, or the presenter. */
  readonly returnFocus: () => void
  /** On the canvas, where it registers with the visible-map-area seam; in the presenter or the phone's context bar, which
   *  place it themselves. */
  readonly layer: 'map' | 'presenter' | 'bar'
}

/**
 * A press on Retry always takes Retry away (the map or basemap shows it loading, or Retry is refused), so focus moves
 * to the chip first instead of falling to the page; when the chip itself goes while holding focus (the map
 * recovered), focus moves to its home: the map, or the presenter.
 */
function NoticeChip({ notice, shown, onRetry, returnFocus, layer }: NoticeChipProps) {
  const chip = useRef<HTMLDivElement>(null)
  const handOff = useRef(false)
  useMapOccluder(chip, 'bottom', layer === 'map' && shown, { frames: false })
  // Read before the commit removes the chip: afterwards focus has already fallen to the page.
  if (!shown && chip.current?.contains(document.activeElement)) handOff.current = true
  useLayoutEffect(() => {
    if (!handOff.current) return
    handOff.current = false
    returnFocus()
  })
  if (!shown) return null
  const retry = (event: MouseEvent) => {
    if (document.activeElement === event.currentTarget) chip.current?.focus()
    onRetry()
  }
  return (
    <div
      ref={chip}
      className={styles.basemapFeedback}
      data-map-notice=""
      data-tone={notice.tone}
      data-layer={layer === 'map' ? undefined : layer}
      tabIndex={-1}
    >
      <span className={styles.basemapFeedbackLead}>
        <span className={styles.basemapFeedbackDot} aria-hidden="true" />
        <span className={styles.basemapFeedbackText} role="status" aria-live="polite">{notice.statusText}</span>
      </span>
      {notice.retry && (
        <button type="button" className={styles.basemapFeedbackRetry} onClick={retry}>
          {t('canvas.layers.retryMap')}
        </button>
      )}
    </div>
  )
}
