import type { ComponentChildren, RefObject } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { DesignSaveStatus } from '../../app/document-session/live-core'
import { saveProblem, type SaveConflictSource } from '../../app/document-session/save-problem'
import type { ReadOnlyOrigin } from '../../app/document-session/store'
import { t } from '../../i18n'
import { ControlIcon } from './ControlIcon'
import styles from './save-status-label.module.css'

interface SaveStatusAction {
  readonly label: string
  run(): void
}

interface DraftWarning {
  readonly label: string
  /** The popover's line: the reason while Keep my Drafts is offered, else what may happen. */
  readonly details: string
  /** `data-notice` of the details line. */
  readonly detailsId?: string
  /** Keep my Drafts: its click makes the request (2.1-Q198). */
  readonly keep?: SaveStatusAction | null
  /** Runs while the popover shows its details; returns the cleanup. */
  readonly whileShown?: () => () => void
  /**
   * Phones: the warning is plain text, not a control, as the phone bar's status leaves its action to File (P3-6);
   * File's row opens the popover by bumping `openRequest`, and closing returns focus where it was when it opened.
   */
  readonly asText?: boolean
  readonly openRequest?: number
}

interface SaveStatusLabelProps {
  readonly status: DesignSaveStatus
  /** The writer's reason for the last failure, shown in Details…. */
  readonly failureReason?: string | null
  /** "Draft" on Desktop, "Saved in this browser" on the Web. */
  readonly draftLabel: string
  /** The one action a Draft offers: Save as… (Desktop) or Download a copy (Web). */
  readonly draftAction: SaveStatusAction & { readonly style: 'button' | 'link' }
  /**
   * Replaces the Draft label when the Draft may be lost (Web: the browser may clear it, 2.1-Q82): muted text with an
   * alert icon, never red, which stays the write-failure signal (Q194). It opens a popover with the details, the
   * Draft action and, when offered, Keep my Drafts (2.1-Q198). Desktop passes none.
   */
  readonly draftWarning?: DraftWarning | null
  /**
   * Keeps the work somewhere else: when writing failed, and in a storage-unchecked read-only Design's popover (the Web's
   * Download a copy, 2.1-Q334).
   */
  readonly saveElsewhere: SaveStatusAction
  /** Where a conflicting change came from; omitted: outside Canopi. */
  readonly conflictSource?: SaveConflictSource
  onRetry(): void
  onResolveConflict?(): void
  /** Why the read-only status is read-only; its popover says so. Absent: a newer Canopi saved it. */
  readonly readOnlyOrigin?: ReadOnlyOrigin | undefined
  /**
   * Update, in the read-only status's popover while a newer Canopi's Design is shown (2.1-Q317, Q336): Desktop checks
   * for updates, the Web reloads. Absent, or storage not checked: the popover has no action.
   */
  onUpdate?(): void
}

/**
 * Continuous-save status beside the Design name, with its one action. Saving
 * is never announced; failures are alerts and open an explanation.
 */
export function SaveStatusLabel({
  status,
  failureReason = null,
  draftLabel,
  draftAction,
  draftWarning = null,
  saveElsewhere,
  conflictSource,
  onRetry,
  onResolveConflict,
  readOnlyOrigin = 'newer-version',
  onUpdate,
}: SaveStatusLabelProps) {
  // Web (a link-style Draft action) can focus the status itself when its warning leaves under focus.
  const statusRef = useRef<HTMLSpanElement>(null)
  return (
    <span ref={statusRef} className={styles.status} data-save-status={status} tabIndex={draftAction.style === 'link' ? -1 : undefined}>
      {(status === 'saved' || status === 'saving') && (
        <span className={styles.text} role="status">
          <ControlIcon name={status === 'saved' ? 'check' : 'clock'} />
          <span className={styles.label} aria-hidden={status === 'saving' ? 'true' : undefined}>
            {t(status === 'saved' ? 'saveStatus.saved' : 'saveStatus.saving')}
          </span>
        </span>
      )}
      {status === 'draft' && (
        <>
          {draftWarning ? (
            <DraftWarningDetails warning={draftWarning} draftAction={draftAction} fallbackFocus={statusRef} />
          ) : (
            <span className={styles.text} role="status"><ControlIcon name={draftAction.style === 'link' ? 'check' : 'draft'} /><span className={styles.label}>{draftLabel}</span></span>
          )}
          <button
            type="button"
            className={draftAction.style === 'link' ? styles.link : styles.action}
            onClick={draftAction.run}
          >
            {draftAction.label}
          </button>
        </>
      )}
      {status === 'error' && (
        <>
          <span className={styles.errorText} role="alert"><ControlIcon name="alert" /><span className={styles.label}>{t('saveStatus.error')}</span></span>
          <SaveFailureDetails reason={failureReason} onRetry={onRetry} saveElsewhere={saveElsewhere} />
        </>
      )}
      {status === 'read-only' && <ReadOnlyDesignDetails origin={readOnlyOrigin} onUpdate={onUpdate} keepCopy={saveElsewhere} />}
      {status === 'conflict' && (
        <>
          <span className={styles.errorText} role="alert"><ControlIcon name="alert" /><span className={styles.label}>{t(conflictSource === 'another-tab' ? 'saveStatus.conflictAnotherTab' : 'saveStatus.conflict')}</span></span>
          {onResolveConflict && (
            <button type="button" className={styles.action} onClick={onResolveConflict}>
              {t('saveStatus.resolve')}
            </button>
          )}
        </>
      )}
    </span>
  )
}

/** The may-be-cleared warning as a trigger and its popover, on the Details… pattern (2.1-Q198). */
function StatusPopover({
  popover,
  titleId,
  descriptionId,
  title,
  onClose,
  dataAttr,
  children,
}: {
  readonly popover: RefObject<HTMLDivElement | null>
  readonly titleId: string
  readonly descriptionId: string
  readonly title: string
  onClose(): void
  readonly dataAttr?: boolean
  readonly children: ComponentChildren
}) {
  return (
    <div
      ref={popover}
      className={styles.popover}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      {...(dataAttr ? { 'data-draft-warning-popover': true } : {})}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <h2 className={styles.popoverTitle} id={titleId}>{title}</h2>
      {children}
    </div>
  )
}

function DraftWarningDetails({ warning, draftAction, fallbackFocus }: {
  readonly warning: DraftWarning
  readonly draftAction: SaveStatusAction
  readonly fallbackFocus: RefObject<HTMLElement | null>
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  usePopover(trigger, popover, open, setOpen)
  const { whileShown, openRequest = 0 } = warning
  useEffect(() => (open ? whileShown?.() : undefined), [open, whileShown])
  const seenRequest = useRef(openRequest)
  useEffect(() => {
    if (openRequest === seenRequest.current) return
    seenRequest.current = openRequest
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen(true)
  }, [openRequest])

  // Granted, the warning leaves: focus that was on it stays in the status instead of dropping to the page. A layout
  // effect, so the cleanup reads focus while the trigger is still in the page (Preact 11 runs useEffect cleanups
  // after paint).
  useLayoutEffect(() => {
    const button = trigger.current
    return () => {
      const focused = document.activeElement
      if (focused && button?.contains(focused)) {
        queueMicrotask(() => {
          if (!document.activeElement || document.activeElement === document.body) fallbackFocus.current?.focus()
        })
      }
    }
  }, [fallbackFocus])

  function close(): void {
    setOpen(false)
    if (warning.asText) {
      if (opener.current?.isConnected) opener.current.focus()
      else fallbackFocus.current?.focus()
    } else {
      trigger.current?.focus()
    }
  }

  return (
    <span className={styles.detailsAnchor} data-preserve-overlays="true">
      <span className={styles.warningStatus} role="status">
        {warning.asText ? (
          <span className={styles.warningText} data-draft-warning><ControlIcon name="alert" /><span className={styles.label}>{warning.label}</span></span>
        ) : <button
          ref={trigger}
          type="button"
          className={styles.warningTrigger}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-draft-warning
          onClick={() => setOpen(!open)}
        >
          <ControlIcon name="alert" /><span className={styles.label}>{warning.label}</span>
        </button>}
      </span>
      {open && (
        <StatusPopover popover={popover} titleId={titleId} descriptionId={descriptionId} title={warning.label} onClose={close} dataAttr>
          <p className={styles.popoverText} id={descriptionId} data-notice={warning.detailsId}>{warning.details}</p>
          <div className={styles.popoverActions}>
            <button type="button" className={styles.action} onClick={() => { close(); draftAction.run() }}>
              {draftAction.label}
            </button>
            {warning.keep && (
              <button type="button" className={styles.primary} onClick={() => { warning.keep!.run(); close() }}>
                {warning.keep.label}
              </button>
            )}
          </div>
        </StatusPopover>
      )}
    </span>
  )
}

/**
 * A read-only Design (2.1-Q317, M478, Q336): muted, never red, as nothing failed. The bar shows only its icon and
 * "Read-only"; the label opens a popover that says why by origin: a newer Canopi saved it, with Update, or the browser's
 * storage could not be checked (Q334), where updating does not help and it offers File's Download a copy instead.
 */
function useDetailsPopover() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  usePopover(trigger, popover, open, setOpen)
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  return [open, setOpen, trigger, popover, titleId, descriptionId, close] as const
}

function ReadOnlyDesignDetails({ origin, onUpdate, keepCopy }: {
  readonly origin: ReadOnlyOrigin
  readonly onUpdate: (() => void) | undefined
  readonly keepCopy: SaveStatusAction
}) {
  const [open, setOpen, trigger, popover, titleId, descriptionId, close] = useDetailsPopover()
  const action = origin === 'newer-version'
    ? (onUpdate ? { label: t('readOnlyDesign.update'), run: onUpdate } : null)
    : keepCopy

  return (
    <span className={styles.detailsAnchor} data-preserve-overlays="true">
      <span className={styles.warningStatus} role="status">
        <button
          ref={trigger}
          type="button"
          className={styles.warningTrigger}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ControlIcon name="info" /><span className={styles.label}>{t('readOnlyDesign.label')}</span>
        </button>
      </span>
      {open && (
        <StatusPopover
          popover={popover}
          titleId={titleId}
          descriptionId={descriptionId}
          title={t(origin === 'newer-version' ? 'readOnlyDesign.status' : 'readOnlyDesign.label')}
          onClose={close}
        >
          <p className={styles.popoverText} id={descriptionId}>
            {t(origin === 'newer-version' ? 'readOnlyDesign.details' : 'webStorage.uncheckedReadOnly')}
          </p>
          {action && (
            <div className={styles.popoverActions}>
              <button type="button" className={styles.primary} onClick={() => { close(); action.run() }}>
                {action.label}
              </button>
            </div>
          )}
        </StatusPopover>
      )}
    </span>
  )
}

function SaveFailureDetails({ reason, onRetry, saveElsewhere }: {
  readonly reason: string | null
  onRetry(): void
  readonly saveElsewhere: SaveStatusAction
}) {
  const [open, setOpen, trigger, popover, titleId, descriptionId, close] = useDetailsPopover()

  return (
    <span className={styles.detailsAnchor} data-preserve-overlays="true">
      <button
        ref={trigger}
        type="button"
        className={styles.action}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t('saveStatus.details')}
      </button>
      {open && (
        <StatusPopover popover={popover} titleId={titleId} descriptionId={descriptionId} title={t('saveStatus.detailsTitle')} onClose={close}>
          <div className={styles.popoverDescription} id={descriptionId}>
            <p className={styles.popoverText}>
              {reason ? t('saveStatus.detailsReason', { reason }) : t('saveStatus.detailsUnknown')}
            </p>
            <p className={styles.popoverText}>{t('saveStatus.detailsSafe')}</p>
          </div>
          <div className={styles.popoverActions}>
            <button type="button" className={styles.action} onClick={() => { close(); saveElsewhere.run() }}>
              {saveElsewhere.label}
            </button>
            <button type="button" className={styles.primary} onClick={() => { close(); onRetry() }}>
              {t('saveStatus.retry')}
            </button>
          </div>
        </StatusPopover>
      )}
    </span>
  )
}

/**
 * An open popover takes focus on its first button and stays on screen. It closes on a pointer release outside it, when
 * focus moves outside it and its trigger (Tab on to the shell's notice; focus going nowhere, as on a window switch,
 * keeps it), and when a save problem dialog asks, so that modal dialog never sits over it (canopi-eon8.15). A layout
 * effect: focus is in, so its Esc handler hears the key, from the first painted frame (canopi-f47t.52.228.20).
 */
function usePopover(
  trigger: RefObject<HTMLElement | null>,
  popover: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
): void {
  useKeptOnScreen(popover, open)
  useLayoutEffect(() => {
    if (!open) return
    const element = popover.current
    element?.querySelector<HTMLButtonElement>('button')?.focus()
    const inside = (target: Node) => Boolean(popover.current?.contains(target) || trigger.current?.contains(target))
    const outside = (event: Event) => {
      const target = event.target as Node | null
      if (target && !inside(target)) setOpen(false)
    }
    const focusLeft = (event: Event) => {
      const next = (event as FocusEvent).relatedTarget as Node | null
      if (next && !inside(next)) setOpen(false)
    }
    const triggerElement = trigger.current
    document.addEventListener('pointerup', outside)
    element?.addEventListener('focusout', focusLeft)
    triggerElement?.addEventListener('focusout', focusLeft)
    const stopSaveProblem = saveProblem.subscribe((request) => { if (request) setOpen(false) })
    return () => {
      document.removeEventListener('pointerup', outside)
      element?.removeEventListener('focusout', focusLeft)
      triggerElement?.removeEventListener('focusout', focusLeft)
      stopSaveProblem()
    }
  }, [trigger, popover, open, setOpen])
}

/**
 * Moves an open popover left by what it overflows the window's right edge, keeping a margin: anchored at the save
 * status, it would leave narrow windows and phones (2.1-Q198 neighbour matrix at 360 and 390 px).
 */
function useKeptOnScreen(popover: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const element = popover.current
    if (!open || !element) return
    element.style.removeProperty('left')
    const margin = 8
    const box = element.getBoundingClientRect()
    const shift = Math.max(0, box.right - (window.innerWidth - margin))
    const left = Math.max(margin - box.left, -shift)
    if (left !== 0) element.style.left = `${left}px`
  }, [popover, open])
}
