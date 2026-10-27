import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { locale } from '../../app/settings/state'
import { t } from '../../i18n'
import { ActionMenu } from './ActionMenu'
import { recentDesignLocations, type RecentDesignLocation } from '../../app/recent-files/locations'
import type { RecentDesignPreview, RecentDesignUnreadableReason } from '../../types/design'
import { ControlIcon, type ControlIconName } from './ControlIcon'
import { DesignSketchThumbnail } from './DesignSketchThumbnail'
import { visibleDesignName } from './DesignNameField'
import { EmptyState } from './EmptyState'
import { formatRelativeDate } from './relative-date'
import styles from './StartScreen.module.css'

interface StartScreenAction {
  readonly label: string
  readonly shortcut?: string
  run(): void
}

interface StartScreenLink extends StartScreenAction {
  readonly icon: ControlIconName
}

interface StartScreenDesign {
  readonly id: string
  readonly name: string
  /** The file's path, shown in part only when another row has the same name. */
  readonly path?: string
  readonly updatedAt: string
  /** What the file says about the Design; absent until it has been read. */
  readonly preview?: RecentDesignPreview
  open(): void
  /** More › Show in folder: the file's folder in the system file manager. */
  showInFolder(): void
  /** More › Remove from list; the file itself is untouched. */
  remove(): void
}

export interface StartScreenDraft {
  readonly id: string
  readonly name: string
  readonly updatedAt: string
  open(): void
  delete(): void
  /** More-menu items before Delete (Web: Download a copy). */
  readonly actions?: readonly StartScreenAction[]
}

/** One line beside the ways in: `info` explains, `warning` is amber and names what to do. */
interface StartScreenNotice {
  readonly tone: 'info' | 'warning'
  readonly text: string
  /** Names the line for the edition's checks (`data-notice`). */
  readonly id?: string
  /** A second line under the text, with its own `data-notice` name. */
  readonly detail?: { readonly text: string; readonly id?: string } | null
  /** One action the notice offers, under its lines. */
  readonly action?: StartScreenAction | null
}

interface StartScreenProps {
  readonly newDesign: StartScreenAction
  readonly openDesign: StartScreenAction
  readonly links: readonly StartScreenLink[]
  readonly footer: string
  /** Null when the edition keeps no recent files (Web). */
  readonly recent: readonly StartScreenDesign[] | null
  readonly drafts: readonly StartScreenDraft[]
  /** True until the edition has listed its Designs, so first run does not flash the empty state. */
  readonly loading?: boolean
  /** A line under the ways in; Desktop passes none. */
  readonly notice?: StartScreenNotice | null
}

/**
 * The start screen both editions share: purpose and the two ways in on the
 * left; recent Designs and Drafts on the right, searchable. With nothing saved
 * yet, the right column says where Designs will appear and offers New Design.
 * Deleting a Draft confirms inline and names it, because a Draft cannot be recovered.
 */
export function StartScreen({ newDesign, openDesign, links, footer, recent, drafts, loading = false, notice = null }: StartScreenProps) {
  const [query, setQuery] = useState('')
  const searchId = useId()
  const needle = fold(query.trim())
  const matches = (name: string) => !needle || fold(visibleDesignName(name)).includes(needle)
  const visibleRecent = recent?.filter((design) => matches(design.name)) ?? null
  // Namesakes are found across the whole list, so a row keeps its label while searching.
  const recentLocations = recentDesignLocations((recent ?? []).map((design) => ({ name: visibleDesignName(design.name), path: design.path })))
  const locationById = new Map((recent ?? []).map((design, index) => [design.id, recentLocations[index] ?? null]))
  const visibleDrafts = drafts.filter((draft) => matches(draft.name))
  const nothingMatches = needle !== '' && (visibleRecent?.length ?? 0) === 0 && visibleDrafts.length === 0
  const nothingSaved = (recent?.length ?? 0) === 0 && drafts.length === 0
  // A notice action unmounts under focus once it runs (Keep my drafts, 2.1-Q198): focus moves to the notice's line,
  // and to New Design once the notice leaves, never to the page (P3-3). The hold ends when focus leaves a line that
  // stays (a refusal, then a click elsewhere), so later renders never pull focus back (P4-2).
  const noticeLine = useRef<HTMLParagraphElement>(null)
  const newDesignButton = useRef<HTMLButtonElement>(null)
  const holdFocus = useRef(false)
  // After paint on purpose (focus-only-in-layout-effect entry): recovers focus lost when a notice action unmounts its control.
  useEffect(() => {
    if (!holdFocus.current) return
    const focused = document.activeElement
    if (focused && focused !== document.body && focused.isConnected) {
      if (focused !== noticeLine.current) holdFocus.current = false
      return
    }
    if (noticeLine.current) {
      noticeLine.current.focus()
    } else {
      holdFocus.current = false
      newDesignButton.current?.focus()
    }
  })

  return (
    <div className={styles.start} role="region" aria-label={t('start.region')} data-start-screen>
      <div className={styles.intro}>
        <div className={styles.brand}>
          <img
            src={new URL('../../assets/canopi-logo.svg', import.meta.url).href}
            className={styles.logo}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          <h1 className={styles.title}>Canopi</h1>
        </div>
        <p className={styles.purpose}>{t('start.purpose')}</p>
        <div className={styles.ways}>
          <button ref={newDesignButton} type="button" className={styles.primary} onClick={newDesign.run}>
            <span>{newDesign.label}</span>
            {newDesign.shortcut && <kbd className={styles.key}>{newDesign.shortcut}</kbd>}
          </button>
          <button type="button" className={styles.secondary} onClick={openDesign.run}>
            <span>{openDesign.label}</span>
            {openDesign.shortcut && <kbd className={styles.key}>{openDesign.shortcut}</kbd>}
          </button>
        </div>
        {notice && (
          <div className={notice.tone === 'warning' ? styles.warningNotice : styles.infoNotice} role="status" data-start-notice={notice.tone}>
            {notice.tone === 'warning' && <ControlIcon name="alert" />}
            <div className={styles.noticeBody}>
              <p
                ref={noticeLine}
                className={styles.noticeLine}
                data-notice={notice.id}
                tabIndex={-1}
                onFocusOut={() => {
                  // Removed under focus (kept): the ref is gone and the hold carries focus on to New Design.
                  queueMicrotask(() => { if (noticeLine.current?.isConnected) holdFocus.current = false })
                }}
              >
                {notice.text}
              </p>
              {notice.detail && <p className={styles.noticeLine} data-notice={notice.detail.id}>{notice.detail.text}</p>}
              {notice.action && (
                <button type="button" className={styles.noticeAction} onClick={() => {
                  holdFocus.current = true
                  notice.action?.run()
                }}>{notice.action.label}</button>
              )}
            </div>
          </div>
        )}
        <nav className={styles.links} aria-label={t('start.more')}>
          {links.map((link) => (
            <button key={link.label} type="button" className={styles.link} onClick={link.run}>
              <ControlIcon name={link.icon} />
              {link.label}
            </button>
          ))}
        </nav>
        <p className={styles.footer}>{footer}</p>
      </div>

      <div className={styles.library} data-start-library>
        {loading ? null : nothingSaved ? (
          <section className={styles.section} aria-labelledby={`${searchId}-empty`}>
            <h2 className={styles.sectionTitle} id={`${searchId}-empty`}>
              {t(recent ? 'start.recentDesigns' : 'drafts.title')}
            </h2>
            <EmptyState
              icon={<ControlIcon name={recent ? 'pin' : 'draft'} size={20} />}
              action={{ label: newDesign.label, onClick: newDesign.run }}
            >
              {t(recent ? 'start.emptyDesktop' : 'start.emptyWeb')}
            </EmptyState>
          </section>
        ) : <>
          <label className={styles.search} htmlFor={searchId}>
            <ControlIcon name="search" />
            <input
              id={searchId}
              type="search"
              className={styles.searchInput}
              value={query}
              placeholder={t('start.searchDesigns')}
              aria-label={t('start.searchDesigns')}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault()
                  setQuery('')
                }
              }}
            />
          </label>
          {nothingMatches && <p className={styles.empty} role="status">{t('start.noMatches', { query: query.trim() })}</p>}

          {visibleRecent && visibleRecent.length > 0 && (
            <section className={styles.section} aria-labelledby={`${searchId}-recent`}>
              <h2 className={styles.sectionTitle} id={`${searchId}-recent`}>{t('start.recentDesigns')}</h2>
              <ul className={styles.rows}>
                {visibleRecent.map((design) => <RecentRow key={design.id} design={design} location={locationById.get(design.id) ?? null} />)}
              </ul>
            </section>
          )}

          {visibleDrafts.length > 0 && (
            <section className={styles.section} aria-labelledby={`${searchId}-drafts`} data-design-drafts>
              <h2 className={styles.sectionTitle} id={`${searchId}-drafts`}>{t('drafts.title')}</h2>
              <p className={styles.sectionIntro}>{t('drafts.intro')}</p>
              <ul className={styles.rows}>
                {visibleDrafts.map((draft) => <DraftRow key={draft.id} draft={draft} />)}
              </ul>
            </section>
          )}
        </>}
      </div>
    </div>
  )
}

const UNREADABLE_MESSAGE_KEYS: Record<RecentDesignUnreadableReason, string> = {
  missing: 'start.cantReadMissing',
  older_version: 'start.cantReadOlderVersion',
  newer_version: 'start.cantReadNewerVersion',
  damaged: 'start.cantReadDamaged',
  unknown: 'start.cantRead',
}

function RecentRow({ design, location }: { readonly design: StartScreenDesign; readonly location: RecentDesignLocation | null }) {
  const name = visibleDesignName(design.name)
  const preview = design.preview
  const sketch = preview?.kind === 'read' ? preview.sketch : null
  const status = preview?.kind === 'read'
    ? `${t('start.plantCount', { count: preview.plant_count })} · ${t('start.zoneCount', { count: preview.zone_count })}`
    : preview?.kind === 'unreadable' ? t(UNREADABLE_MESSAGE_KEYS[preview.reason]) : null
  const place = location?.kind === 'file' ? location.text : location ? t('start.inFolder', { folder: location.text }) : null
  return (
    <li className={styles.row}>
      <div className={styles.rowLine}>
        <button type="button" className={styles.rowButton} onClick={design.open}>
          <span className={`${styles.thumb} ${sketch ? styles.sketchThumb : ''}`} aria-hidden="true">
            {sketch ? <DesignSketchThumbnail sketch={sketch} /> : <ControlIcon name="pin" size={20} />}
          </span>
          {/* No place name yet: a Design does not store its site's name (canopi-h90p.23). */}
          <span className={styles.rowText}>
            <span className={styles.rowName}>{name}</span>
            {(place || status) && (
              <span className={styles.rowMeta}>
                {place && <span className={styles.rowPlace}>{place}</span>}
                {place && status && ' · '}
                {status}
              </span>
            )}
          </span>
          <span className={styles.rowDate}>{formatRelativeDate(design.updatedAt, locale.value)}</span>
        </button>
        <ActionMenu
          label={t('start.designActions', { name })}
          items={[
            { label: t('start.showInFolder'), run: design.showInFolder },
            { label: t('start.removeFromList'), run: design.remove },
          ]}
        />
      </div>
    </li>
  )
}

function DraftRow({ draft }: { readonly draft: StartScreenDraft }) {
  const [confirming, setConfirming] = useState(false)
  const name = visibleDesignName(draft.name)
  return (
    <li className={styles.row}>
      <div className={styles.rowLine}>
        <button type="button" className={styles.rowButton} onClick={draft.open}>
          <span className={`${styles.thumb} ${styles.draftThumb}`} aria-hidden="true"><ControlIcon name="draft" size={20} /></span>
          <span className={styles.rowText}>
            <span className={styles.rowName}>{name}</span>
            <span className={styles.rowMeta}>{t('drafts.neverSaved')}</span>
          </span>
          <span className={styles.rowDate}>{formatRelativeDate(draft.updatedAt, locale.value)}</span>
        </button>
        <ActionMenu
          label={t('drafts.actions', { name })}
          items={[
            ...(draft.actions ?? []).map((action) => ({ label: action.label, run: action.run })),
            { label: t('drafts.deleteItem'), danger: true, run: () => setConfirming(true) },
          ]}
        />
      </div>
      {confirming && (
        <div className={styles.confirm} role="alertdialog" aria-label={t('drafts.confirmDelete', { name })}>
          <span className={styles.confirmText}>{t('drafts.confirmDelete', { name })}</span>
          <button type="button" className={styles.secondarySmall} onClick={() => setConfirming(false)} autoFocus>
            {t('canvas.file.cancel')}
          </button>
          <button
            type="button"
            className={styles.danger}
            onClick={() => {
              setConfirming(false)
              draft.delete()
            }}
          >
            {t('drafts.confirmDeleteAction')}
          </button>
        </div>
      )}
    </li>
  )
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()
}
