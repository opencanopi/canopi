import type { ComponentChildren } from 'preact'
import { useId, useLayoutEffect, useRef } from 'preact/hooks'
import { placeSearch } from '../../app/geocoding/place-search-session'
import { PLACE_SEARCH_ZOOM } from '../../app/geocoding/place-search-ui'
import { armCanvasTool } from '../../app/keyboard/arming'
import { focusOwner } from '../../app/keyboard/focus-owner'
import { selectPanel } from '../../app/shell/state'
import {
  closeStartDesignCard,
  finishSiteLocate,
  foundSiteLabel,
  searchSiteAgain,
  siteLocateOpen,
  startDesignCardOpen,
} from '../../app/site-onboarding/state'
import { currentCanvasViewportCommandSurface } from '../../canvas/session'
import { t } from '../../i18n'
import { ControlIcon } from '../shared/ControlIcon'
import { PlaceCombobox } from './PlaceSearch'
import styles from './SiteOnboarding.module.css'

/**
 * Set when the user answers "Where is your site?" (a place or Skip), so the Start card that answer opens takes focus;
 * a card that mounts again over a session where it was already open (the chrome back from another panel) does not.
 */
let startCardOpenedByUser = false

function answerSiteLocate(placeLabel: string | null): void {
  startCardOpenedByUser = true
  finishSiteLocate(placeLabel)
}

/**
 * New-Design guidance over the map: where the site is, then how to start. The Start card shows in the tool card slot
 * with the place found; the top chips (`children`, CanvasChrome's top-centre slot) follow them in their row while it
 * shows, beside the card or wrapped below it on a narrow map, instead of covering it.
 */
export function SiteOnboarding({ children }: { readonly children?: ComponentChildren }) {
  if (siteLocateOpen.value) return <><SiteLocateDialog />{children}</>
  if (!startDesignCardOpen.value) return <>{children}</>
  return (
    <div className={styles.startRow} data-start-row>
      <StartDesignCard />
      <FoundSiteChip />
      {children}
    </div>
  )
}

function SiteLocateDialog() {
  const titleId = useId()
  const attribution = placeSearch.attribution.value

  return (
    <section
      className={styles.locate}
      role="dialog"
      aria-labelledby={titleId}
      data-site-locate
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        answerSiteLocate(null)
      }}
    >
      <h2 className={styles.locateTitle} id={titleId}>{t('siteOnboarding.locateTitle')}</h2>
      <p className={styles.locateIntro}>{t('siteOnboarding.locateIntro')}</p>
      <PlaceCombobox
        variant="dialog"
        autoFocus
        label={t('canvas.placeSearch.placeholder')}
        onPick={(result, label) => {
          currentCanvasViewportCommandSurface.peek()?.showPlace(result, PLACE_SEARCH_ZOOM, { motion: 'fly' })
          answerSiteLocate(label)
        }}
      />
      <div className={styles.locateFooter}>
        <span className={styles.attribution}>{attribution ?? t('siteOnboarding.placeNamesCredit')}</span>
        <button type="button" className={styles.link} onClick={() => answerSiteLocate(null)}>
          {t('siteOnboarding.skip')}
        </button>
      </div>
    </section>
  )
}

function StartDesignCard() {
  const titleId = useId()
  const card = useRef<HTMLElement>(null)

  // Focus goes in as the card commits, so it is never on the page where Skip or the found place had been
  // (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    const openedByUser = startCardOpenedByUser
    startCardOpenedByUser = false
    const primary = card.current?.querySelector<HTMLButtonElement>('[data-start-primary]')
    if (openedByUser && primary) focusOwner.focusOnOpen(primary)
  }, [])

  return (
    <section ref={card} className={styles.startCard} role="region" aria-labelledby={titleId} data-start-design>
      <div className={styles.startHeader}>
        <h2 className={styles.startTitle} id={titleId}>{t('siteOnboarding.startTitle')}</h2>
        <button type="button" className={styles.close} aria-label={t('siteOnboarding.closeStart')} onClick={closeStartDesignCard}>
          <ControlIcon name="close" size={18} />
        </button>
      </div>
      <ol className={styles.steps}>
        <li>{t('siteOnboarding.stepZone')}</li>
        <li>{t('siteOnboarding.stepCatalog')}</li>
        <li>{t('siteOnboarding.stepSave')}</li>
      </ol>
      <div className={styles.startActions}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            closeStartDesignCard()
            selectPanel('plant-db')
          }}
        >
          {t('siteOnboarding.openCatalog')}
        </button>
        <button
          type="button"
          className={styles.primary}
          data-start-primary
          onClick={() => {
            closeStartDesignCard()
            armCanvasTool('polygon', { from: 'start-card' })
          }}
        >
          {t('siteOnboarding.drawZone')}
        </button>
      </div>
    </section>
  )
}

function FoundSiteChip() {
  const label = foundSiteLabel.value
  return (
    <div className={styles.foundChip} role="status" data-found-site>
      <ControlIcon name="pin" />
      <span className={styles.foundLabel}>{label ?? t('siteOnboarding.noPlace')}</span>
      <button type="button" className={styles.link} onClick={searchSiteAgain}>
        {t('siteOnboarding.searchAgain')}
      </button>
    </div>
  )
}
