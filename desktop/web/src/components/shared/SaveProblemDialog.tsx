import { useEffect, useRef } from 'preact/hooks'
import {
  answerSaveProblem,
  saveProblem,
  type SaveProblemChoice,
  type SaveProblemRequest,
} from '../../app/document-session/save-problem'
import { t } from '../../i18n'
import { useModalLayer } from './useModalLayer'
import styles from './save-problem-dialog.module.css'

interface DialogAction {
  readonly choice: SaveProblemChoice
  readonly label: string
  readonly tone: 'primary' | 'danger' | 'neutral'
}

/** The single continuous-save dialog, shared by the Desktop and Web shells. */
export function SaveProblemDialog() {
  const request = saveProblem.value
  if (!request) return null
  return <SaveProblemDialogContent request={request} />
}

function SaveProblemDialogContent({ request }: { readonly request: SaveProblemRequest }) {
  const firstActionRef = useRef<HTMLButtonElement>(null)
  useModalLayer()
  useEffect(() => {
    firstActionRef.current?.focus()
  }, [request])
  const { title, message, actions } = describe(request)

  return (
    <div
      className={styles.overlay}
      data-save-problem-overlay
      // The dialog is modal: pressing the backdrop must not move focus to
      // the canvas, where keys would edit the Design behind it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault()
      }}
    >
      <section
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="save-problem-title"
        aria-describedby="save-problem-message"
        data-preserve-overlays="true"
        data-save-problem={request.kind}
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            trapTab(event)
            return
          }
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          answerSaveProblem('cancel')
        }}
      >
        <h2 id="save-problem-title" className={styles.title}>{title}</h2>
        <p id="save-problem-message" className={styles.message}>{message}</p>
        <footer className={styles.footer}>
          {actions.map((action, index) => (
            <button
              key={action.choice}
              ref={index === 0 ? firstActionRef : undefined}
              type="button"
              className={`${styles.button} ${styles[action.tone]}`}
              data-save-problem-choice={action.choice}
              onClick={() => answerSaveProblem(action.choice)}
            >
              {action.label}
            </button>
          ))}
        </footer>
      </section>
    </div>
  )
}

function describe(request: SaveProblemRequest): {
  readonly title: string
  readonly message: string
  readonly actions: readonly DialogAction[]
} {
  const cancel: DialogAction = { choice: 'cancel', label: t('canvas.file.cancel'), tone: 'neutral' }
  if (request.kind === 'revert') {
    // Cancel first: it takes focus, so Enter never discards changes by accident.
    return {
      title: t('saveProblem.revertTitle'),
      message: t('saveProblem.revertMessage'),
      actions: [cancel, { choice: 'revert', label: t('saveProblem.revertConfirm'), tone: 'danger' }],
    }
  }
  if (request.kind === 'settings-failed') {
    // The Design is already written; Escape (cancel) keeps the window open.
    return {
      title: t('saveProblem.settingsFailedTitle'),
      message: t('saveProblem.settingsFailedMessage'),
      actions: [
        { choice: 'retry', label: t('saveProblem.retry'), tone: 'primary' },
        { choice: 'discard', label: t('saveProblem.settingsCloseAnyway'), tone: 'danger' },
      ],
    }
  }
  if (request.kind === 'flush-failed') {
    const discard: DialogAction = {
      choice: 'discard',
      label: t(request.purpose === 'close' ? 'saveProblem.closeWithoutSaving' : 'saveProblem.discard'),
      tone: 'danger',
    }
    if (request.conflict) {
      return {
        title: t('saveProblem.flushFailedTitle'),
        message: t(request.where === 'another-tab'
          ? 'saveProblem.tabConflictPendingMessage'
          : 'saveProblem.conflictPendingMessage'),
        actions: [cancel, discard],
      }
    }
    return {
      title: t('saveProblem.flushFailedTitle'),
      message: t(request.purpose === 'close'
        ? 'saveProblem.flushFailedCloseMessage'
        : 'saveProblem.flushFailedMessage'),
      actions: [{ choice: 'retry', label: t('saveProblem.retry'), tone: 'primary' }, discard, cancel],
    }
  }
  if (request.where === 'another-tab') {
    // A browser Draft another tab wrote: keep this tab's version or reload that one.
    return {
      title: t('saveProblem.tabConflictTitle'),
      message: t('saveProblem.tabConflictMessage'),
      actions: [
        { choice: 'keep-mine', label: t('saveProblem.keepMine'), tone: 'primary' },
        { choice: 'use-file', label: t('saveProblem.useOtherTab'), tone: 'danger' },
        cancel,
      ],
    }
  }
  if (request.fileGone) {
    return {
      title: t('saveProblem.fileGoneTitle'),
      message: t('saveProblem.fileGoneMessage'),
      actions: [
        { choice: 'save-copy', label: t('saveProblem.saveElsewhere'), tone: 'primary' },
        { choice: 'keep-mine', label: t('saveProblem.keepMine'), tone: 'neutral' },
        cancel,
      ],
    }
  }
  return {
    title: t('saveProblem.conflictTitle'),
    message: t('saveProblem.conflictMessage'),
    actions: [
      { choice: 'keep-mine', label: t('saveProblem.keepMine'), tone: 'primary' },
      { choice: 'use-file', label: t('saveProblem.useFile'), tone: 'danger' },
      { choice: 'save-copy', label: t('saveProblem.saveCopy'), tone: 'neutral' },
      cancel,
    ],
  }
}

/** Tab and Shift+Tab cycle through the dialog's own buttons. */
function trapTab(event: KeyboardEvent): void {
  const dialog = event.currentTarget as HTMLElement
  const focusable = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
  if (focusable.length === 0) return
  const index = focusable.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.shiftKey
    ? (index <= 0 ? focusable.length - 1 : index - 1)
    : (index === focusable.length - 1 ? 0 : index + 1)
  event.preventDefault()
  focusable[next]!.focus()
}
