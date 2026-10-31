import type { ComponentChildren } from 'preact'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import { aboutCanopiDialogOpen, closeAboutCanopiDialog, openAboutCanopiDialog } from '../../app/about/state'
import {
  CANOPI_COPYRIGHT,
  CANOPI_LICENSE,
  CANOPI_VERSION,
} from '../../app/about/metadata'
import { locale } from '../../app/settings/state'
import type { UpdateController } from '../../app/updates/controller'
import type { UpdateState } from '../../app/updates/state'
import type { UpdateProgress } from '../../generated/contracts'
import { formatCount } from '../../utils/format-count'
import { t } from '../../i18n'
import { Notice } from './Notice'
import { Toast } from './Toast'
import { OpenSourceNotices, OpenSourceNoticesLink } from './OpenSourceNotices'
import { useModalLayer } from './useModalLayer'
import { useScrimPress } from './useScrimPress'
import styles from './AboutCanopiDialog.module.css'

/**
 * Help › About Canopi. `updates` is the Desktop root's update section (AboutUpdates): a capability passed on, rendered
 * as given and never tested here, so the Web root passes none and About shows no updater (ADR 0030, 2.1-Q201).
 */
export function AboutCanopiDialog({ updates }: { readonly updates?: ComponentChildren }) {
  if (!aboutCanopiDialogOpen.value) return null
  return <AboutCanopiDialogContent updates={updates} />
}

function AboutCanopiDialogContent({ updates }: { readonly updates?: ComponentChildren }) {
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
        {updates}
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

/** What About's one update button does in each state; `null` shows it unavailable (aria-disabled), never removed. */
type UpdateAction = 'check' | 'retry' | 'download' | 'install' | 'restart' | null

function updateAction(state: UpdateState, canRetry: boolean): { readonly label: string, readonly action: UpdateAction } {
  switch (state.kind) {
    case 'failed':
      return canRetry ? { label: t('update.retry'), action: 'retry' } : { label: t('update.check'), action: 'check' }
    case 'idle':
      return { label: t('update.check'), action: 'check' }
    case 'checking':
      return { label: t('update.checking'), action: null }
    case 'available':
      return { label: t('update.download'), action: 'download' }
    case 'link_only':
      return { label: t('update.download'), action: null }
    case 'downloading':
      return { label: downloadingLabel(state.progress), action: null }
    case 'verified':
      return { label: t('update.install'), action: 'install' }
    case 'installing':
    case 'close_requested':
      return { label: t('update.install'), action: null }
    case 'installed':
      return { label: t('update.restart'), action: 'restart' }
  }
}

/** "Downloading… {percent}%", the number in the user's locale; plain "Downloading…" while the size is unknown. */
function downloadingLabel({ received, total }: UpdateProgress): string {
  if (total === null || total <= 0) return t('update.downloading')
  const percent = Math.min(100, Math.floor((received / total) * 100))
  return t('update.downloadingPercent', { percent: formatCount(percent, locale.value) })
}

/** An external link: the Desktop shell opens it in the system browser (services/external_links.rs). */
function ExternalLink({ href, children }: { readonly href: string, readonly children: ComponentChildren }) {
  return <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
}

/**
 * About's update section on Desktop (contracts §3, 2.1-Q235 to Q237): one button whose label and action follow the
 * controller's state, and a status line. The button is the same element in every state and is only marked
 * unavailable while an op runs, so a check, download or install settling never moves or drops focus. Cancel sits
 * beside a running download (2.1-Q251). When the download settles Cancel leaves, unless it has focus: then it stays,
 * marked unavailable, until the user moves focus away within the page (a switch to another app does not count), so a
 * key press meant for Cancel never lands on Install and restart or Retry. Closing About cancels nothing: the controller is the Desktop root's, and the download finishes.
 */
export function AboutUpdates({ controller, downloadPage }: { readonly controller: UpdateController, readonly downloadPage: string }) {
  const state = controller.state.value
  const { label, action } = updateAction(state, controller.canRetry.value)
  const [cancelFocused, setCancelFocused] = useState(false)
  const downloading = state.kind === 'downloading'
  const run = (): void => {
    if (action === null) return
    void controller[action]()
  }
  return (
    <div className={styles.updates} data-about-updates="">
      <p className={styles.updateStatus} role="status">
        <UpdateStatus controller={controller} downloadPage={downloadPage} />
      </p>
      <div className={styles.updateActions}>
        <button
          type="button"
          className={styles.closeButton}
          aria-disabled={action === null ? 'true' : undefined}
          onClick={run}
        >
          {label}
        </button>
        {(downloading || cancelFocused) && (
          <button
            type="button"
            className={styles.closeButton}
            data-update-cancel=""
            aria-disabled={downloading ? undefined : 'true'}
            onFocusIn={() => setCancelFocused(true)}
            onFocusOut={(event) => { if (event.relatedTarget !== null || document.hasFocus()) setCancelFocused(false) }}
            onClick={() => { if (downloading) controller.cancel() }}
          >
            {t('update.cancel')}
          </button>
        )}
      </div>
    </div>
  )
}

function UpdateStatus({ controller, downloadPage }: { readonly controller: UpdateController, readonly downloadPage: string }) {
  const state = controller.state.value
  const message = controller.failureMessage.value
  if (state.kind === 'link_only') return <ExternalLink href={state.url}>{t('update.linkOnly')}</ExternalLink>
  // About stays open over the root's closing notice while the install or the update's exit runs, so it says so
  // itself (2.1-Q254).
  if (state.kind === 'installing') return <>{t('update.installing')}</>
  if (state.kind === 'close_requested') return <>{t('update.finishing')}</>
  if (message !== null) {
    if (message.key === 'update.linkOnly') return <ExternalLink href={downloadPage}>{t('update.linkOnly')}</ExternalLink>
    return <>{message.reason === undefined ? t(message.key) : t(message.key, { reason: t(message.reason) })}</>
  }
  const offer = controller.offer.value
  if (state.kind !== 'idle' && state.kind !== 'checking' && offer !== null) {
    return <>{t('update.available', { version: offer.version })} <ExternalLink href={offer.notes_url}>{t('update.whatsNew')}</ExternalLink></>
  }
  return state.kind === 'idle' && controller.upToDate.value ? <>{t('update.upToDate')}</> : null
}

/**
 * "Canopi {version} is available", the launch check's one notice (2.1-Q164, M211): a toast that takes no focus and
 * whose action opens About, where the download starts (Q235). Only the Desktop root mounts it.
 */
export function UpdateAvailableNotice({ version, onDismiss }: { readonly version: string, onDismiss(): void }) {
  return (
    <div className={styles.notice} data-update-notice="">
      <Toast
        icon="info"
        message={t('update.available', { version })}
        actionLabel={t('about.title')}
        onAction={openAboutCanopiDialog}
        onDismiss={onDismiss}
      />
    </div>
  )
}

/**
 * "Update not installed", the next launch after a Windows update that did not install (2.1-Q234). The host clears its
 * marker as it is read, so this is the only time the user hears of it: a warning that takes no focus and stays until
 * the user dismisses it, never a toast that times out. Only the Desktop root mounts it.
 */
export function UpdateNotInstalledNotice({ onDismiss }: { onDismiss(): void }) {
  return (
    <div className={`${styles.notice} ${styles.failedNotice}`} data-update-failed-notice="">
      <Notice
        tone="warning"
        action={<button type="button" className={styles.dismiss} onClick={onDismiss}>{t('update.dismiss')}</button>}
      >
        {t('update.failure.notInstalledPlain')}
      </Notice>
    </div>
  )
}

/**
 * While a window close waits for an update (2.1-Q254): "Installing update…" for its install, "Finishing update…" for
 * its exit (its exit flush, then the installer or the restart). The window stays open until that settles, then Canopi
 * closes by itself, so the notice has no action. Only the Desktop root mounts it.
 */
export function UpdateClosingNotice({ waitsFor }: { readonly waitsFor: 'install' | 'exit' }) {
  return (
    <div className={styles.notice} data-update-closing-notice="" role="status">
      <Notice tone="info">{t(waitsFor === 'install' ? 'update.installing' : 'update.finishing')}</Notice>
    </div>
  )
}
