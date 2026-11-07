import { SurfaceBoundary } from '../shared/SurfaceBoundary'
import { useEffect, useId, useLayoutEffect, useRef } from 'preact/hooks'
import {
  goToPresentedStep,
  leaveStoryPresentation,
  nextPresentedStep,
  presentationFullScreen,
  presentationFullScreenAvailable,
  presentedStep,
  previousPresentedStep,
  togglePresentationFullScreen,
  type PresentedStep,
} from '../../app/story-presentation'
import { highlightedSpeciesSummary } from '../../app/stories'
import { t } from '../../i18n'
import { PresentedMapNotice } from '../canvas/MapNotice'
import { ButtonTooltip } from '../shared/ButtonTooltip'
import { ControlIcon } from '../shared/ControlIcon'
import { useModalLayer } from '../shared/useModalLayer'
import { RichTextView } from './RichTextView'
import styles from './StoryPresenter.module.css'

/** A horizontal swipe this long (CSS px) moves a step on touch screens. */
const SWIPE_MIN_PX = 48

/**
 * A story presented full-window over the map (boards StoryPresent and
 * StoryPhone): a floating text card, step dots, Previous and Next, full screen
 * and Leave. It is modal: the workspace behind it is inert, so no editing
 * command or tool key reaches the map, and Tab stays in the presenter. The
 * map's notice, and its Retry, show in the presenter's own layer and Tab cycle.
 */
export function StoryPresenter() {
  const presented = presentedStep.value
  return presented ? <SurfaceBoundary surface="story-presenter" onClose={leaveStoryPresentation}><StoryPresenterContent presented={presented} /></SurfaceBoundary> : null
}

function StoryPresenterContent({ presented }: { readonly presented: PresentedStep }) {
  useModalLayer()
  const root = useRef<HTMLDivElement>(null)
  const next = useRef<HTMLButtonElement>(null)
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null)
  const titleId = useId()
  const { story, step, view, index, count } = presented
  const number = index + 1
  const first = index === 0
  const last = index === count - 1
  const title = step.title.trim() || t('stories.untitledStep')
  const species = view ? highlightedSpeciesSummary(view) : []
  const fullScreen = presentationFullScreen.value
  const fullScreenLabel = fullScreen ? t('presentation.exitFullScreen') : t('presentation.fullScreen')

  useLayoutEffect(() => {
    // Start on Next (Finish in a one-step story) so the keys and Enter work at once.
    next.current?.focus({ preventScroll: true })
  }, [])

  // The card's text starts at the top for every step.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-presenter-card]')?.scrollTo?.({ top: 0 })
  }, [step.id])

  function onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target as HTMLElement | null
    const onControl = !!target?.closest('button, a, input, textarea, [contenteditable="true"]')
    switch (event.key) {
      case 'ArrowRight':
      case 'PageDown':
        event.preventDefault()
        nextPresentedStep()
        return
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault()
        previousPresentedStep()
        return
      case ' ':
        // Space presses a focused button; elsewhere it moves on.
        if (onControl) return
        event.preventDefault()
        nextPresentedStep()
        return
      case 'Home':
        event.preventDefault()
        goToPresentedStep(0)
        return
      case 'End':
        event.preventDefault()
        goToPresentedStep(count - 1)
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        leaveStoryPresentation()
        return
      case 'f':
      case 'F':
        if (!presentationFullScreenAvailable()) return
        event.preventDefault()
        void togglePresentationFullScreen()
        return
      case 'Tab':
        trapFocus(event)
    }
  }

  function trapFocus(event: KeyboardEvent): void {
    const all = [...root.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []]
    // Controls a narrow layout hides take no part (a layout-less DOM keeps them all).
    const shown = all.filter((element) => element.getClientRects().length > 0)
    const focusables = shown.length > 0 ? shown : all
    const active = document.activeElement
    if (focusables.length === 0 || !active) return
    // Wrap when no control lies ahead of focus in the Tab direction, wherever focus sits: on the last control, on the
    // map notice that holds focus after Retry, or on the presenter itself. Otherwise focus would leave the page.
    const ahead = event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING
    if (focusables.some((element) => (active.compareDocumentPosition(element) & ahead) !== 0)) return
    event.preventDefault()
    const wrapTo = event.shiftKey ? focusables.at(-1)! : focusables[0]!
    wrapTo.focus()
  }

  return (
    <div
      ref={root}
      className={styles.presenter}
      role="dialog"
      aria-modal="true"
      aria-label={t('presentation.region', { story: story.name })}
      data-story-presenter
      // A press on the map keeps focus in the presenter, so the keys keep working.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse') return
        swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
      }}
      onPointerUp={(event) => {
        const start = swipe.current
        swipe.current = null
        if (!start || start.id !== event.pointerId) return
        const dx = event.clientX - start.x
        const dy = event.clientY - start.y
        if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return
        if (dx < 0) nextPresentedStep()
        else previousPresentedStep()
      }}
      onPointerCancel={() => { swipe.current = null }}
    >
      <div className={styles.topBar}>
        <span className={styles.topTitle}>{story.name}</span>
        <span className={styles.phoneProgress} aria-hidden="true">
          <span className={styles.phoneStep}>{t('presentation.stepOf', { number, count })}</span>
          <span className={styles.phoneDots}>
            {Array.from({ length: count }, (_, dot) => <span key={dot} className={styles.phoneDot} data-current={dot === index ? 'true' : undefined} />)}
          </span>
        </span>
        {presentationFullScreenAvailable() && (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={fullScreenLabel}
            aria-pressed={fullScreen}
            aria-keyshortcuts="F"
            onClick={() => { void togglePresentationFullScreen() }}
          >
            <ControlIcon name={fullScreen ? 'collapse' : 'expand'} size={20} />
            <ButtonTooltip label={fullScreenLabel} shortcut="F" side="bottom" />
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('presentation.leave')}
          aria-keyshortcuts="Escape"
          data-presenter-leave
          onClick={leaveStoryPresentation}
        >
          <ControlIcon name="close" size={20} />
          <ButtonTooltip label={t('presentation.leave')} shortcut="Esc" side="bottom" />
        </button>
      </div>

      <article className={styles.card} aria-labelledby={titleId} data-presenter-card>
        <span className={styles.kicker}>{t('presentation.storyStep', { story: story.name, number, count })}</span>
        <h1 className={styles.title} id={titleId}>{title}</h1>
        <RichTextView blocks={step.text ?? []} className={styles.text} />
        {(step.images ?? []).map((image, imageIndex) => (
          <img key={imageIndex} className={styles.image} src={image.src} alt={image.alt ?? ''} />
        ))}
        {species.length > 0 && (
          <ul className={styles.tags}>
            {species.map((entry) => (
              <li key={entry.canonicalName} className={styles.tag}>
                {t('presentation.speciesPlants', { name: entry.name, count: entry.count })}
              </li>
            ))}
          </ul>
        )}
        <nav className={styles.nav} aria-label={t('presentation.steps')}>
          {/* aria-disabled keeps focus on the button on the first step, so the keys keep working. */}
          <button type="button" className={styles.navButton} aria-disabled={first ? true : undefined} onClick={previousPresentedStep}>
            <ControlIcon name="chevron-left" size={18} />
            {t('presentation.previous')}
          </button>
          <div className={styles.dots}>
            {story.steps.map((entry, dot) => {
              const label = t('presentation.goToStep', { number: dot + 1, title: entry.title.trim() || t('stories.untitledStep') })
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={styles.dot}
                  aria-label={label}
                  aria-current={dot === index ? 'step' : undefined}
                  onClick={() => goToPresentedStep(dot)}
                >
                  <span className={styles.dotMark} aria-hidden="true" />
                </button>
              )
            })}
          </div>
          {/* One button, Next then Finish on the last step, so focus stays on it. */}
          <button
            ref={next}
            type="button"
            className={`${styles.navButton} ${styles.primary}`}
            onClick={last ? leaveStoryPresentation : nextPresentedStep}
          >
            {last ? t('presentation.finish') : t('presentation.next')}
            {!last && <ControlIcon name="chevron-right" size={18} />}
          </button>
        </nav>
        <span className={styles.hint} data-hint="keys">{t('presentation.keysHint')}</span>
        <span className={styles.hint} data-hint="swipe">{t('presentation.swipeHint')}</span>
      </article>
      {/* Clear of the bar and the card, where the canvas would have shown it under the presenter. */}
      <div className={styles.notice}>
        <PresentedMapNotice focusHome={root} />
      </div>
      <div className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        {t('presentation.announce', { number, count, title })}
      </div>
    </div>
  )
}
