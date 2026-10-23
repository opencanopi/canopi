import { useLayoutEffect, useRef } from 'preact/hooks'
import { problemReportDialogOpen } from '../../app/problem-report/state'
import { problemReportSubmission } from '../../app/problem-report/submission'
import { t } from '../../i18n'
import styles from './ProblemReportDialog.module.css'
import { ControlIcon } from './ControlIcon'
import { useModalLayer } from './useModalLayer'
import { useScrimPress } from './useScrimPress'

export function ProblemReportDialog() {
  if (!problemReportDialogOpen.value) return null
  return <ProblemReportDialogContent />
}

function ProblemReportDialogContent() {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useModalLayer()
  const scrim = useScrimPress(closeDialog)
  const description = problemReportSubmission.description.value
  const includeCurrentDesign = problemReportSubmission.includeCurrentDesign.value
  const submitting = problemReportSubmission.submitting.value
  const result = problemReportSubmission.result.value
  const error = problemReportSubmission.error.value
  const copyState = problemReportSubmission.copyState.value
  const showFolderState = problemReportSubmission.showFolderState.value

  // Focus goes in as the dialog commits, with its modal layer, so an Esc at once is the dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    textareaRef.current?.focus()
  }, [])

  function closeDialog(): void {
    problemReportSubmission.close()
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault()
    await problemReportSubmission.submit()
  }

  async function copySummary(): Promise<void> {
    await problemReportSubmission.copySummary()
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
            <p className={styles.body}>{t('problemReport.successText')}</p>
            <dl className={styles.paths}>
              <div>
                <dt>{t('problemReport.folderPath')}</dt>
                <dd>{result.folder_path}</dd>
              </div>
              <div>
                <dt>{t('problemReport.summaryFile')}</dt>
                <dd>Report Summary.txt</dd>
              </div>
              <div>
                <dt>{t('problemReport.bundleFile')}</dt>
                <dd>Diagnostic Bundle.zip</dd>
              </div>
            </dl>
            <div className={styles.footer}>
              <button type="button" className={styles.secondaryButton} onClick={copySummary}>
                {t(copyState === 'copied' ? 'problemReport.copiedSummary' : 'problemReport.copySummary')}
              </button>
              <button type="button" className={styles.secondaryButton} onClick={closeDialog}>
                {t('problemReport.close')}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void showFolder()}
                disabled={showFolderState === 'showing'}
              >
                {t(showFolderState === 'showing' ? 'problemReport.showingFolder' : 'problemReport.showFolder')}
              </button>
            </div>
            {copyState === 'failed' && (
              <p className={styles.errorText}>{t('problemReport.copyFailed')}</p>
            )}
            {showFolderState === 'failed' && (
              <p className={styles.errorText}>{t('problemReport.showFolderFailed')}</p>
            )}
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
            <p className={styles.privacy}>{t('problemReport.privacyNote')}</p>
            <fieldset className={styles.attachments}>
              <legend>{t('problemReport.optionalAttachments')}</legend>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  name="include-current-design"
                  checked={includeCurrentDesign}
                  onChange={(event) =>
                    problemReportSubmission.setIncludeCurrentDesign((event.target as HTMLInputElement).checked)
                  }
                />
                <span className={styles.checkboxText}>
                  <span className={styles.checkboxTitle}>
                    {t('problemReport.includeCurrentDesign')}
                  </span>
                  <span className={styles.checkboxDescription}>
                    {t('problemReport.includeCurrentDesignDescription')}
                  </span>
                </span>
              </label>
            </fieldset>
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
              <button type="submit" className={styles.primaryButton} disabled={submitting}>
                {t(submitting ? 'problemReport.creating' : 'problemReport.create')}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  )
}
