/**
 * components/shared/SurfaceBoundary.tsx: Owner of the surface and root error boundaries (APP-03, contracts §2, ADR 0025,
 * 2.1-Q291). Invariant: every L4 surface (each WorkspaceSurfaces entry, the Data dialogs host, each useModalLayer host
 * and both roots) renders inside one; a catch is one ring entry through `reportFailure`, shown inline. The fallback
 * reads "This panel couldn't load" in place with Try again and Report a problem; a dialog host's fallback (`onClose`)
 * is itself a modal dialog, so Esc and focus work and the host's inert region is released with it. Try again bumps the
 * retry generation, under which a failed lazy chunk loads afresh (failures/lazy.ts); a chunk that failed to load also
 * offers Reload, since a chunk gone after a Web deploy never loads again in this page. The root fallback offers Reload
 * and Report a problem, never the raw stack.
 */
import { createContext, type ComponentChildren } from 'preact'
import { useContext, useErrorBoundary, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { isChunkLoadFailure, RetryGeneration } from '../../failures/lazy'
import { reportFailure } from '../../failures/report'
import { t } from '../../i18n'
import { useModalLayer } from './useModalLayer'
import styles from './SurfaceBoundary.module.css'

/** The surfaces wrapped in a boundary, each its ring source `surface.<name>` (every-l4-surface-has-boundary). */
export type BoundedSurface =
  | 'workspace-primary'
  | 'workspace-side'
  | 'data-dialogs'
  | 'command-palette'
  | 'save-problem'
  | 'about'
  | 'workspace-dialog'
  | 'problem-report'
  | 'story-presenter'
  | 'canvas-pdf'

/** Opens the edition's problem report; null where the edition has none (the Web Edition until its report lands). */
const ProblemReportOpener = createContext<(() => void) | null>(null)

/**
 * Catches its surface's faults and shows "This panel couldn't load" in place, with Try again and Report a problem.
 * `onClose` marks a dialog host: the fallback is then a modal dialog that Esc closes.
 */
export function SurfaceBoundary({ surface, onClose, children }: {
  readonly surface: BoundedSurface
  readonly onClose?: () => void
  readonly children: ComponentChildren
}) {
  const [generation, setGeneration] = useState(0)
  const [error, resetError] = useErrorBoundary((caught: unknown) => {
    reportFailure(caught, { shown: 'inline', source: `surface.${surface}` })
  })
  if (error) {
    const retry = () => {
      setGeneration((value) => value + 1)
      resetError()
    }
    const reload = isChunkLoadFailure(error)
    return onClose
      ? <DialogFallback surface={surface} reload={reload} onRetry={retry} onClose={onClose} />
      : <SurfaceFallback surface={surface} reload={reload} onRetry={retry} />
  }
  return <RetryGeneration.Provider value={generation}>{children}</RetryGeneration.Provider>
}

function SurfaceFallback({ surface, reload, onRetry, focus = false }: {
  readonly surface: BoundedSurface
  /** The fault is a chunk that could not load: Reload is offered, since Try again may never fetch it. */
  readonly reload: boolean
  onRetry(): void
  readonly focus?: boolean
}) {
  // The problem report's own fallback offers none: opening it again could only show this fallback.
  const opener = useContext(ProblemReportOpener)
  const report = surface === 'problem-report' ? null : opener
  const retryRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (focus) retryRef.current?.focus()
  }, [focus])
  return (
    <div className={styles.surface} role="alert" data-surface-fallback={surface}>
      <p className={styles.message}>{t('boundary.panelFailed')}</p>
      <div className={styles.actions}>
        <button ref={retryRef} type="button" className={styles.primary} onClick={onRetry}>{t('boundary.tryAgain')}</button>
        {reload && <button type="button" className={styles.secondary} onClick={() => location.reload()}>{t('boundary.reload')}</button>}
        {report && <button type="button" className={styles.secondary} onClick={report}>{t('boundary.reportProblem')}</button>}
      </div>
    </div>
  )
}

/** A dialog host's fallback: modal like its host, Esc closes it, focus starts on Try again. */
function DialogFallback({ surface, reload, onRetry, onClose }: {
  readonly surface: BoundedSurface
  readonly reload: boolean
  onRetry(): void
  onClose(): void
}) {
  useModalLayer()
  return (
    <div className={styles.overlay}>
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('boundary.panelFailed')}
        data-preserve-overlays="true"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        <SurfaceFallback surface={surface} reload={reload} onRetry={onRetry} focus />
      </section>
    </div>
  )
}

/**
 * Catches what no surface did, for an edition root: Reload and, where the edition has one, Report a problem with its
 * dialog (`reportDialog`, rendered in the fallback since the app below is gone). Surfaces below read `onReport`.
 */
export function RootBoundary({ source, onReport, reportDialog, children }: {
  /** The ring source of a root fault: `root.<edition>`. */
  readonly source: `root.${string}`
  readonly onReport?: () => void
  readonly reportDialog?: ComponentChildren
  readonly children: ComponentChildren
}) {
  const [error] = useErrorBoundary((caught: unknown) => {
    reportFailure(caught, { shown: 'inline', source })
  })
  const report = onReport ?? null
  if (error) {
    return (
      <>
        <div className={styles.root} role="alert">
          <h1 className={styles.title}>{t('boundary.rootTitle')}</h1>
          <p className={styles.message}>{t('boundary.rootMessage')}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => location.reload()}>{t('boundary.reload')}</button>
            {report && <button type="button" className={styles.secondary} onClick={report}>{t('boundary.reportProblem')}</button>}
          </div>
        </div>
        {reportDialog}
      </>
    )
  }
  return <ProblemReportOpener.Provider value={report}>{children}</ProblemReportOpener.Provider>
}
