/**
 * components/shared/SurfaceBoundary.tsx: the surface and root error boundaries (APP-03, contracts §2, ADR 0025,
 * 2.1-Q291). Invariant: every L4 surface (each WorkspaceSurfaces entry, the Data dialogs host, each useModalLayer host
 * and both roots) renders inside one; a catch is one ring entry through `reportFailure`, shown inline. The fallback
 * reads "This panel couldn't load" in place with Try again and Report a problem; a dialog host's fallback (`onClose`)
 * is itself a modal dialog, so Esc and focus work and the host's inert region is released with it. Try again bumps the
 * retry generation, under which a failed lazy chunk loads afresh (failures/lazy.ts); a chunk that failed to load also
 * offers Reload, since a chunk gone after a Web deploy never loads again in this page. The root fallback offers Reload
 * and Report a problem, never the raw stack. Every Reload is the edition's (`RootBoundary`'s `onReload`), which writes
 * the Design first and asks the save question when it cannot (on Web, the release's reload, which also reopens the
 * tab's own Draft; 2.1-Q189), never a bare page reload.
 */
import { createContext, type ComponentChildren } from 'preact'
import { useContext, useErrorBoundary, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { isChunkLoadFailure, RetryGeneration } from '../../failures/lazy'
import { reportFailure, reportOriginOf, type ReportOrigin } from '../../failures/report'
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

/**
 * Opens the edition's problem report from a fault, which the report lists first; null outside a root (a test or
 * gallery surface).
 */
const ProblemReportOpener = createContext<((origin: ReportOrigin | null) => void) | null>(null)

/** The edition's reload, which saves first; a page reload outside a root (a test or gallery surface). */
const EditionReload = createContext<() => void>(() => location.reload())

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
    // Report a problem opens the report from this fault, by the ring entry the catch recorded.
    const origin = reportOriginOf(error)
    return onClose
      ? <DialogFallback surface={surface} reload={reload} origin={origin} onRetry={retry} onClose={onClose} />
      : <SurfaceFallback surface={surface} reload={reload} origin={origin} onRetry={retry} />
  }
  return <RetryGeneration.Provider value={generation}>{children}</RetryGeneration.Provider>
}

function SurfaceFallback({ surface, reload, origin, onRetry, focus = false }: {
  readonly surface: BoundedSurface
  /** The fault is a chunk that could not load: Reload is offered, since Try again may never fetch it. */
  readonly reload: boolean
  readonly origin: ReportOrigin | null
  onRetry(): void
  readonly focus?: boolean
}) {
  // The problem report's own fallback offers none: opening it again could only show this fallback.
  const opener = useContext(ProblemReportOpener)
  const editionReload = useContext(EditionReload)
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
        {reload && <button type="button" className={styles.secondary} onClick={editionReload}>{t('boundary.reload')}</button>}
        {report && <button type="button" className={styles.secondary} onClick={() => report(origin)}>{t('boundary.reportProblem')}</button>}
      </div>
    </div>
  )
}

/** A dialog host's fallback: modal like its host, Esc closes it, focus starts on Try again. */
function DialogFallback({ surface, reload, origin, onRetry, onClose }: {
  readonly surface: BoundedSurface
  readonly reload: boolean
  readonly origin: ReportOrigin | null
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
        <SurfaceFallback surface={surface} reload={reload} origin={origin} onRetry={onRetry} focus />
      </section>
    </div>
  )
}

/**
 * Catches what no surface did, for an edition root: Reload (`onReload`) and, where the edition has one, Report a
 * problem. `dialogs` are those the two may open (the problem report, the save question), rendered in the fallback
 * since the app below is gone. Surfaces below read `onReport` and `onReload`.
 */
export function RootBoundary({ source, onReport, onReload, dialogs, children }: {
  /** The ring source of a root fault: `root.<edition>`. */
  readonly source: `root.${string}`
  /** Opens the edition's problem report from a fault (null when none is known), which the report lists first. */
  readonly onReport?: (origin: ReportOrigin | null) => void
  /** The edition's reload, writing the Design first; a page reload when omitted. */
  readonly onReload?: () => void
  readonly dialogs?: ComponentChildren
  readonly children: ComponentChildren
}) {
  const [error] = useErrorBoundary((caught: unknown) => {
    reportFailure(caught, { shown: 'inline', source })
  })
  const report = onReport ?? null
  const reload = onReload ?? (() => location.reload())
  if (error) {
    return (
      <>
        <div className={styles.root} role="alert">
          <h1 className={styles.title}>{t('boundary.rootTitle')}</h1>
          <p className={styles.message}>{t('boundary.rootMessage')}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={reload}>{t('boundary.reload')}</button>
            {report && <button type="button" className={styles.secondary} onClick={() => report(reportOriginOf(error))}>{t('boundary.reportProblem')}</button>}
          </div>
        </div>
        {dialogs}
      </>
    )
  }
  return (
    <ProblemReportOpener.Provider value={report}>
      <EditionReload.Provider value={reload}>{children}</EditionReload.Provider>
    </ProblemReportOpener.Provider>
  )
}
