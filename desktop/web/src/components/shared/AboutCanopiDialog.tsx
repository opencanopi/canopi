import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { aboutCanopiDialogOpen, closeAboutCanopiDialog } from '../../app/about/state'
import {
  CANOPI_COPYRIGHT,
  CANOPI_LICENSE,
  CANOPI_VERSION,
} from '../../app/about/metadata'
import { t } from '../../i18n'
import { OpenSourceNotices, OpenSourceNoticesLink } from './OpenSourceNotices'
import { useModalLayer } from './useModalLayer'
import { useScrimPress } from './useScrimPress'
import styles from './AboutCanopiDialog.module.css'

export function AboutCanopiDialog() {
  if (!aboutCanopiDialogOpen.value) return null
  return <AboutCanopiDialogContent />
}

function AboutCanopiDialogContent() {
  const closeRef = useRef<HTMLButtonElement>(null)
  const noticesLinkRef = useRef<HTMLButtonElement>(null)
  // The notices view replaces About inside the same modal layer; leaving it returns focus to its link (2.1-Q221).
  const [noticesOpen, setNoticesOpen] = useState(false)
  const noticesShown = useRef(false)
  useModalLayer()
  const scrim = useScrimPress(closeAboutCanopiDialog)
  // Focus goes in as the dialog commits, with its modal layer, so an Esc at once is the dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    closeRef.current?.focus()
  }, [])
  useLayoutEffect(() => {
    if (noticesOpen) noticesShown.current = true
    else if (noticesShown.current) noticesLinkRef.current?.focus()
  }, [noticesOpen])

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeAboutCanopiDialog()
  }

  if (noticesOpen) return <OpenSourceNotices onClose={() => setNoticesOpen(false)} />

  return (
    <div className={styles.overlay} {...scrim}>
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-canopi-title"
        data-preserve-overlays="true"
        onKeyDown={onKeyDown}
      >
        <header className={styles.header}>
          <img
            src={new URL('../../assets/canopi-logo.svg', import.meta.url).href}
            className={styles.logo}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          <div className={styles.identity}>
            <h2 id="about-canopi-title" className={styles.title}>
              {t('about.title')}
            </h2>
            <p className={styles.version}>
              {t('about.version', { version: CANOPI_VERSION })}
            </p>
          </div>
        </header>

        <dl className={styles.meta}>
          <div>
            <dt>{t('about.licenseLabel')}</dt>
            <dd>{CANOPI_LICENSE}</dd>
          </div>
          <div>
            <dt>{t('about.copyrightLabel')}</dt>
            <dd>{CANOPI_COPYRIGHT}</dd>
          </div>
        </dl>
        <OpenSourceNoticesLink linkRef={noticesLinkRef} onOpen={() => setNoticesOpen(true)} />

        <footer className={styles.footer}>
          <button
            ref={closeRef}
            type="button"
            className={styles.closeButton}
            onClick={closeAboutCanopiDialog}
          >
            {t('window.close')}
          </button>
        </footer>
      </section>
    </div>
  )
}
