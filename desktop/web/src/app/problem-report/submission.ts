import { signal, type ReadonlySignal, type Signal } from '@preact/signals'
import type { ProblemReportResult } from '../../generated/contracts'
import type { ProblemReportPort } from '../../platform/problem-report'
import { reportFailure, reportInline, type ReportOrigin } from '../../failures/report'
import { t } from '../../i18n'
import { buildProblemReport } from './builder'
import { recentFrontendDiagnostics } from './diagnostics'
import { problemReportDialogOpen } from './state'

/** The op a report's failure is recorded under. */
const REPORT_SOURCE = 'problem_report.create'

type ProblemReportShowFolderState = 'idle' | 'showing' | 'failed'

export interface ProblemReportSubmissionDeps {
  readonly readFrontendDiagnostics: typeof recentFrontendDiagnostics
  readonly currentDesignUnavailableMessage: () => string
  readonly setDialogOpen: (open: boolean) => void
}

export interface ProblemReportSubmission {
  readonly description: Signal<string>
  readonly includeCurrentDesign: Signal<boolean>
  readonly submitting: Signal<boolean>
  readonly result: Signal<ProblemReportResult | null>
  readonly error: Signal<string | null>
  readonly showFolderState: Signal<ProblemReportShowFolderState>
  /** The installed writer, which says what the edition fills and whether it can show a saved report. */
  readonly port: ReadonlySignal<ProblemReportPort | null>
  /** Opens the dialog afresh; a report opened from a failure lists it first (contracts §13). */
  open(origin?: ReportOrigin | null): void
  close(): void
  reset(): void
  setDescription(description: string): void
  setIncludeCurrentDesign(include: boolean): void
  submit(): Promise<void>
  /** Shows the saved report in the file manager; nothing on an edition whose writer has no `reveal`. */
  showFolder(): Promise<void>
  /** The edition's problemReport writer (contracts §22), the one way to set it; returns the uninstall. */
  installPort(port: ProblemReportPort): () => void
}

const DEFAULT_DEPS: ProblemReportSubmissionDeps = {
  readFrontendDiagnostics: recentFrontendDiagnostics,
  currentDesignUnavailableMessage: () => t('problemReport.currentDesignUnavailable'),
  setDialogOpen: (open) => {
    problemReportDialogOpen.value = open
  },
}

export const problemReportSubmission = createProblemReportSubmission(DEFAULT_DEPS)

/** Installs the edition's problemReport writer for the app's report, at boot (main.tsx); returns the uninstall. */
export function installProblemReportPort(port: ProblemReportPort): () => void {
  return problemReportSubmission.installPort(port)
}

/** Opens the problem report from a menu or a link: no failure leads it. */
export function openProblemReportDialog(): void {
  problemReportSubmission.open(null)
}
export function createProblemReportSubmission(
  deps: ProblemReportSubmissionDeps,
): ProblemReportSubmission {
  const description = signal('')
  const includeCurrentDesign = signal(false)
  const submitting = signal(false)
  const result = signal<ProblemReportResult | null>(null)
  const error = signal<string | null>(null)
  const showFolderState = signal<ProblemReportShowFolderState>('idle')
  let generation = 0
  let origin: ReportOrigin | null = null
  const port = signal<ProblemReportPort | null>(null)

  function reset(): void {
    generation += 1
    origin = null
    description.value = ''
    includeCurrentDesign.value = false
    submitting.value = false
    result.value = null
    error.value = null
    showFolderState.value = 'idle'
  }

  return {
    description,
    includeCurrentDesign,
    submitting,
    result,
    error,
    showFolderState,
    port,
    open(from = null) {
      reset()
      origin = from
      deps.setDialogOpen(true)
    },
    close() {
      deps.setDialogOpen(false)
      reset()
    },
    reset,
    setDescription(nextDescription) {
      description.value = nextDescription
    },
    setIncludeCurrentDesign(include) {
      includeCurrentDesign.value = include
    },
    async submit() {
      // A second press while a report is being made makes no second report.
      if (submitting.value) return
      generation += 1
      const submitGeneration = generation
      submitting.value = true
      error.value = null

      try {
        const writer = port.value
        if (!writer) throw new Error('No problem report writer is installed for this edition')
        let currentDesign: string | null = null
        if (includeCurrentDesign.value) {
          currentDesign = writer.currentDesign()
          if (!currentDesign) {
            if (submitGeneration === generation) {
              error.value = deps.currentDesignUnavailableMessage()
            }
            return
          }
        }

        // The one builder fills the frontend's sections, redacted; Desktop's command adds the native ones (2.1-M421).
        const report = buildProblemReport({
          createdAt: new Date(),
          description: description.value,
          ring: deps.readFrontendDiagnostics(),
          origin,
          design: currentDesign,
          sections: writer.sections,
        })
        const nextResult = await writer.write(report)
        if (submitGeneration !== generation) return
        result.value = nextResult
        showFolderState.value = 'idle'
      } catch (caught) {
        if (submitGeneration !== generation) return
        // A typed failure (busy, io) reads its catalogue message. Anything else (a browser download fault, a build
        // fault) is one internal ring entry and reads the internal message, never its own text (.117).
        const message = reportInline(caught, REPORT_SOURCE)
        if (!message) reportFailure(caught, { shown: 'inline', source: REPORT_SOURCE })
        error.value = t(message ?? 'failure.internal')
      } finally {
        if (submitGeneration === generation) {
          submitting.value = false
        }
      }
    },
    installPort(next) {
      port.value = next
      return () => {
        if (port.peek() === next) port.value = null
      }
    },
    async showFolder() {
      const reveal = port.peek()?.reveal
      if (!result.value || !reveal) return
      showFolderState.value = 'showing'
      try {
        await reveal(result.value.file_name)
        showFolderState.value = 'idle'
      } catch {
        showFolderState.value = 'failed'
      }
    },
  }
}
