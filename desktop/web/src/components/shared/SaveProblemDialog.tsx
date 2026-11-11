import { SurfaceBoundary } from './SurfaceBoundary'
import type { RefObject } from 'preact'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import {
  answerSaveProblem,
  saveProblem,
  type SaveProblemChoice,
  type SaveProblemRequest,
} from '../../app/document-session/save-problem'
import { t } from '../../i18n'
import { trapTabWithToasts, useModalLayer } from './useModalLayer'
import styles from './save-problem-dialog.module.css'

interface DialogAction {
  readonly choice: SaveProblemChoice
  readonly label: string
  readonly tone: 'primary' | 'danger' | 'neutral'
}

/** The single continuous-save dialog, shared by the Desktop and Web shells. */
export function SaveProblemDialog() {
  const lastFocused = useLastFocusedOutside()
  const request = saveProblem.value
  if (!request) return null
  return <SurfaceBoundary surface="save-problem" onClose={() => answerSaveProblem('cancel')}><SaveProblemDialogContent request={request} lastFocused={lastFocused} /></SurfaceBoundary>
}

/** Tries, a frame apart, to give focus back to an opener that the flow re-enables after the answer. */
const FOCUS_RETURN_ATTEMPTS = 10

/** The element last focused outside the dialog, tracked while the app runs so an opener disabled by its work is known. */
function useLastFocusedOutside(): RefObject<HTMLElement | null> {
  const lastFocused = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const track = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && !target.closest('[data-save-problem-overlay]')) lastFocused.current = target
    }
    document.addEventListener('focusin', track)
    return () => document.removeEventListener('focusin', track)
  }, [])
  return lastFocused
}

/**
 * Closing returns focus to the control that opened the dialog (canopi-eon8.15), which the modal layer alone misses
 * when that control was disabled while it worked: New version: Reload reads Saving… and is disabled, so the browser
 * drops its focus before the dialog opens, and it is enabled again only after the answer is handled. The opener is the
 * focused element, else the last one focused outside the dialog if it is now disabled (it lost focus that way, not
 * minutes ago); focus returns only while nothing else holds it. Called before the dialog takes focus, so it reads the
 * opener, not the dialog's own first action.
 */
function useOpenerFocusReturn(lastFocused: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const active = document.activeElement
    const blurredByDisabling = (lastFocused.current as HTMLButtonElement | null)?.disabled === true
    const opener = active instanceof HTMLElement && active !== document.body
      ? active
      : blurredByDisabling ? lastFocused.current : null
    return () => {
      if (!opener) return
      let attempts = 0
      const giveBack = () => {
        if (!opener.isConnected) return
        const holder = document.activeElement
        if (holder === opener || (holder !== null && holder !== document.body)) return
        if ((opener as HTMLButtonElement).disabled && ++attempts < FOCUS_RETURN_ATTEMPTS) {
          window.setTimeout(giveBack, 16)
          return
        }
        opener.focus()
      }
      window.setTimeout(giveBack, 0)
    }
  }, [])
}

function SaveProblemDialogContent({ request, lastFocused }: {
  readonly request: SaveProblemRequest
  readonly lastFocused: RefObject<HTMLElement | null>
}) {
  const firstActionRef = useRef<HTMLButtonElement>(null)
  useOpenerFocusReturn(lastFocused)
  const dialog = useRef<HTMLElement>(null)
  // Tab wraps through the actions and the window's toasts; Escape in a toast cancels, like Escape here.
  const tabStops = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])
  useModalLayer({ root: dialog, tabStops, escape: () => answerSaveProblem('cancel') })
  // Focus goes in as the dialog commits, after the opener and the modal layer have read where it was, so an Esc at
  // once is the dialog's (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
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
        ref={dialog}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="save-problem-title"
        aria-describedby="save-problem-message"
        data-preserve-overlays="true"
        data-save-problem={request.kind}
        onKeyDown={(event) => {
          if (event.key === 'Tab') trapTabWithToasts(tabStops(), event)
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
    // Only a written Design is called saved; Cancel, like Escape, keeps the window open.
    const reload = request.purpose === 'reload'
    const message = request.designSaved
      ? (reload ? 'saveProblem.settingsFailedReloadMessage' : 'saveProblem.settingsFailedMessage')
      : (reload ? 'saveProblem.settingsFailedDesignUnsavedReloadMessage' : 'saveProblem.settingsFailedDesignUnsavedMessage')
    return {
      title: t('saveProblem.settingsFailedTitle'),
      message: t(message),
      actions: [
        { choice: 'retry', label: t('saveProblem.retry'), tone: 'primary' },
        { choice: 'discard', label: t(reload ? 'saveProblem.settingsReloadAnyway' : 'saveProblem.settingsCloseAnyway'), tone: 'danger' },
        cancel,
      ],
    }
  }
  if (request.kind === 'flush-failed' && request.purpose === 'reload') {
    // A Web release reload (2.1-Q83, Q188): Download a copy keeps the unwritten Design before the page reloads.
    const saveCopy: DialogAction = { choice: 'save-copy', label: t('webShell.downloadCopy'), tone: request.conflict ? 'primary' : 'neutral' }
    const discard: DialogAction = { choice: 'discard', label: t('saveProblem.discardAndReload'), tone: 'danger' }
    return request.conflict
      ? {
        title: t('saveProblem.flushFailedTitle'),
        message: t('saveProblem.tabConflictReloadMessage'),
        actions: [saveCopy, discard, cancel],
      }
      : {
        title: t('saveProblem.flushFailedTitle'),
        message: t('saveProblem.flushFailedReloadMessage'),
        actions: [{ choice: 'retry', label: t('saveProblem.retry'), tone: 'primary' }, saveCopy, discard, cancel],
      }
  }
  if (request.kind === 'flush-failed') {
    const discard: DialogAction = {
      choice: 'discard',
      label: t(request.purpose === 'close' ? 'saveProblem.closeWithoutSaving'
        : request.purpose === 'app-reload' ? 'saveProblem.discardAndReload' : 'saveProblem.discard'),
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
      message: t(request.purpose === 'close' ? 'saveProblem.flushFailedCloseMessage'
        : request.purpose === 'app-reload' ? 'saveProblem.flushFailedAppReloadMessage' : 'saveProblem.flushFailedMessage'),
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
