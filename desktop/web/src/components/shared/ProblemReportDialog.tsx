import { SurfaceBoundary } from './SurfaceBoundary'
import { useLayoutEffect, useRef } from 'preact/hooks'
import { problemReportDialogOpen } from '../../app/problem-report/state'
import { problemReportSubmission } from '../../app/problem-report/submission'
export { installProblemReportPort } from '../../app/problem-report/submission'
import type { ReportOrigin } from '../../failures/report'
import { t } from '../../i18n'
import type { LocaleKey } from '../../generated/locale-keys'
import { REPORT_SECTIONS, type ReportConsent, type ReportSectionId } from '../../generated/contracts'
import type { EditionSections } from '../../platform/problem-report'
import styles from './ProblemReportDialog.module.css'
import { ControlIcon } from './ControlIcon'
import { useModalLayer } from './useModalLayer'
import { useScrimPress } from './useScrimPress'

/** Where a report is sent (2.1-Q279): Canopi sends nothing itself. */
const PROBLEM_REPORT_ISSUES_URL = 'https://github.com/opencanopi/canopi/issues'

/** Each section's line in the dialog, one per `REPORT_SECTIONS` row (2.1-Q280); en.json holds the table's English. */
const SECTION_LINES: { readonly [S in ReportSectionId]: LocaleKey } = {
  originating_failure: 'problemReport.section.originatingFailure',
  description: 'problemReport.section.description',
  build: 'problemReport.section.build',
  health: 'problemReport.section.health',
  queues: 'problemReport.section.queues',
  native_settlements: 'problemReport.section.nativeSettlements',
  frontend_ring: 'problemReport.section.frontendRing',
  jobs: 'problemReport.section.jobs',
  library_disk: 'problemReport.section.libraryDisk',
  log_tail: 'problemReport.section.logTail',
  settings_summary: 'problemReport.section.settingsSummary',
  design: 'problemReport.section.design',
}

type ConsentKind = Exclude<ReportConsent, 'always'>

/** The checkbox each consent kind draws; a new kind fails typecheck until it has one (2.1-Q280). */
const CONSENT_CHECKBOXES: { readonly [K in ConsentKind]: { readonly label: LocaleKey, readonly checked: () => boolean, readonly set: (on: boolean) => void } } = {
  current_design: {
    label: 'problemReport.includeCurrentDesign',
    checked: () => problemReportSubmission.includeCurrentDesign.value,
    set: (on) => problemReportSubmission.setIncludeCurrentDesign(on),
  },
}

/** Whether the edition puts a section in its report: the frontend's own always, an edition's unless it lacks it. */
function editionHas(sections: EditionSections | undefined, id: ReportSectionId): boolean {
  const reader: unknown = sections ? (sections as Partial<Record<ReportSectionId, unknown>>)[id] : undefined
  return reader !== 'not_on_this_edition'
}

/**
 * Opens the problem report from a failure's Report a problem (a notice, a boundary), which the report lists first: the
 * Desktop root's fallback offers it even after the app below has failed.
 */
export function openProblemReport(origin: ReportOrigin | null = null): void {
  problemReportSubmission.open(origin)
}

export function ProblemReportDialog() {
  if (!problemReportDialogOpen.value) return null
  return <SurfaceBoundary surface="problem-report" onClose={() => problemReportSubmission.close()}><ProblemReportDialogContent /></SurfaceBoundary>
}

function ProblemReportDialogContent() {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const successCloseRef = useRef<HTMLButtonElement>(null)
  const createRef = useRef<HTMLButtonElement>(null)
  useModalLayer()
  const scrim = useScrimPress(closeDialog)
  const description = problemReportSubmission.description.value
  const submitting = problemReportSubmission.submitting.value
  const result = problemReportSubmission.result.value
  const error = problemReportSubmission.error.value
  const showFolderState = problemReportSubmission.showFolderState.value
  const port = problemReportSubmission.port.value
  // Web's report is a download: with no folder to show, Show again is left out, never drawn dead.
  const canReveal = port?.reveal !== undefined
  const listed = REPORT_SECTIONS.filter((row) => row.consent === 'always' && editionHas(port?.sections, row.id))
  const consentRows = REPORT_SECTIONS.flatMap((row) => row.consent === 'always' ? [] : [{ ...row, consent: row.consent }])

  // Focus goes in as the dialog commits, with its modal layer, so an Esc at once is the dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // A view swap (writing, created, failed) must not drop focus to <body>, outside the dialog's Esc handler
  // (canopi-f47t.52.36): focus left on nothing, a disabled button or the dialog itself moves to the view's control:
  // Close once created (Show again is disabled while the first showing runs), Create again after a failure, and the
  // dialog itself while the write runs; Show again, disabled while it shows, hands focus to Close.
  const view = result ? 'created' : submitting ? 'writing' : 'form'
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const active = document.activeElement
    const lost = active === null || active === dialog || !dialog.contains(active) || (active as HTMLButtonElement).disabled === true
    if (!lost) return
    const target = view === 'created' ? successCloseRef.current : view === 'form' ? createRef.current : null
    ;(target ?? dialog).focus()
  }, [view, showFolderState])

  function closeDialog(): void {
    problemReportSubmission.close()
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault()
    await problemReportSubmission.submit()
  }

  async function showFolder(): Promise<void> {
    await problemReportSubmission.showFolder()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeDialog()
    }
  }

  return (
    <div className={styles.overlay} {...scrim}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="problem-report-title"
        data-preserve-overlays="true"
        onKeyDown={onKeyDown}
      >
        <header className={styles.header}>
          <div>
            <h2 id="problem-report-title" className={styles.title}>
              {t('problemReport.title')}
            </h2>
            <p className={styles.intro}>{t('problemReport.intro')}</p>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            onClick={closeDialog}
            aria-label={t('problemReport.close')}
          >
            <ControlIcon name="close" size={18} />
          </button>
        </header>

        {result ? (
          <div className={styles.success}>
            <h3 className={styles.sectionTitle}>{t('problemReport.successTitle')}</h3>
            {canReveal ? (
              <>
                {showFolderState === 'failed'
                  ? <p className={styles.errorText}>{t('problemReport.showFolderFailed')}</p>
                  : <p className={styles.body}>{t('problemReport.successText')}</p>}
                <dl className={styles.paths}>
                  <div>
                    <dt>{t('problemReport.bundleFile')}</dt>
                    <dd>{result.file_name}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className={styles.body}>{t('problemReport.downloadedText')}</p>
            )}
            <SendTo />
            <div className={styles.footer}>
              <button type="button" ref={successCloseRef} className={styles.secondaryButton} onClick={closeDialog}>
                {t('problemReport.close')}
              </button>
              {canReveal && (
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => void showFolder()}
                  disabled={showFolderState === 'showing'}
                >
                  {t(showFolderState === 'showing' ? 'problemReport.showingFolder' : 'problemReport.showAgain')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <form className={styles.form} onSubmit={(event) => void submit(event)}>
            <label className={styles.label} htmlFor="problem-report-description">
              {t('problemReport.descriptionLabel')}
            </label>
            <textarea
              id="problem-report-description"
              ref={textareaRef}
              className={styles.textarea}
              value={description}
              placeholder={t('problemReport.descriptionPlaceholder')}
              onInput={(event) =>
                problemReportSubmission.setDescription((event.target as HTMLTextAreaElement).value)
              }
            />
            <fieldset className={styles.attachments}>
              <legend>{t('problemReport.contentsTitle')}</legend>
              <ul className={styles.sectionList}>
                {listed.map((row) => <li key={row.id} className={styles.sectionRow} data-report-section={row.id}>{t(SECTION_LINES[row.id])}</li>)}
              </ul>
              {consentRows.map((row) => {
                const checkbox = CONSENT_CHECKBOXES[row.consent]
                return (
                  <label key={row.id} className={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      name={row.consent}
                      checked={checkbox.checked()}
                      onChange={(event) => checkbox.set((event.target as HTMLInputElement).checked)}
                    />
                    <span className={styles.checkboxText}>
                      <span className={styles.checkboxTitle}>{t(checkbox.label)}</span>
                      <span className={styles.checkboxDescription}>{t(SECTION_LINES[row.id])}</span>
                    </span>
                  </label>
                )
              })}
            </fieldset>
            <SendTo />
            {error && (
              <div className={styles.errorBox} role="alert">
                <strong>{t('problemReport.errorTitle')}</strong>
                <span>{error}</span>
              </div>
            )}
            <div className={styles.footer}>
              <button type="button" className={styles.secondaryButton} onClick={closeDialog}>
                {t('problemReport.cancel')}
              </button>
              <button type="submit" ref={createRef} className={styles.primaryButton} disabled={submitting}>
                {t(submitting ? 'problemReport.creating' : 'problemReport.create')}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  )
}

/** Where to send the report and what to attach, with the issues page's link (2.1-Q279). */
function SendTo() {
  return (
    <p className={styles.body}>
      {t('problemReport.sendText')}{' '}
      <a className={styles.link} href={PROBLEM_REPORT_ISSUES_URL} target="_blank" rel="noopener noreferrer">{t('problemReport.issuesLink')}</a>
    </p>
  )
}
