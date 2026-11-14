import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals'
import type { ProblemReportResult } from '../../generated/contracts'
import type { ProblemReportPort } from '../../platform/problem-report'
import { reportFailure, reportInline, type ReportOrigin } from '../../failures/report'
import { t } from '../../i18n'
import { buildProblemReport } from './builder'
import { designSessionStore } from '../document-session/store'
import { recentFrontendDiagnostics } from './diagnostics'
import { problemReportDialogOpen } from './state'

/** The op a report's failure is recorded under. */
const REPORT_SOURCE = 'problem_report.create'

type ProblemReportShowFolderState = 'idle' | 'showing' | 'failed'

/** A sent write's outcome belongs to its own Create; the next one only waits for it to settle. */
function noop(): void {}

export interface ProblemReportSubmissionDeps {
  readonly setDialogOpen: (open: boolean) => void
}

export interface ProblemReportSubmission {
  readonly description: Signal<string>
  readonly includeCurrentDesign: Signal<boolean>
  /** Whether the Design row is offered: never for a newer Canopi's read view (2.1-M479, canopi-v4kj). */
  readonly currentDesignOffered: ReadonlySignal<boolean>
  readonly submitting: Signal<boolean>
  readonly result: Signal<ProblemReportResult | null>
  readonly error: Signal<string | null>
  readonly showFolderState: Signal<ProblemReportShowFolderState>
  /** The installed writer, which says what the edition fills and whether it can show a saved report. */
  readonly port: ReadonlySignal<ProblemReportPort | null>
  /** Opens the dialog afresh; a report opened from a failure lists it first (contracts §13). */
  open(origin?: ReportOrigin | null): void
  close(): void
  setDescription(description: string): void
  setIncludeCurrentDesign(include: boolean): void
  submit(): Promise<void>
  /** Shows the saved report in the file manager; nothing on an edition whose writer has no `reveal`. */
  showFolder(): Promise<void>
  /** The edition's problemReport writer (contracts §22), the one way to set it; returns the uninstall. */
  installPort(port: ProblemReportPort): () => void
}

const DEFAULT_DEPS: ProblemReportSubmissionDeps = {
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
  const currentDesignOffered = computed(() => !designSessionStore.holdsNewerReadView())
  const submitting = signal(false)
  const result = signal<ProblemReportResult | null>(null)
  const error = signal<string | null>(null)
  const showFolderState = signal<ProblemReportShowFolderState>('idle')
  // `generation` names the report the user still wants: an open, a close or a new Create moves it on, so a write that
  // settles for an older one shows nothing. `writing` settles when the last sent write settles and outlives an open: a
  // write cannot be stopped once sent, so a Create while one runs waits for it, then writes its own report, the one
  // the user just entered, unless the user has moved on by then (canopi-f47t.52.36).
  let generation = 0
  let writing: Promise<void> | null = null
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
    currentDesignOffered,
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
        // A tick left from before a newer Design opened goes with its row, never blocking the report (canopi-v4kj).
        if (includeCurrentDesign.value && currentDesignOffered.value) {
          currentDesign = writer.currentDesign()
          if (!currentDesign) {
            error.value = t('problemReport.currentDesignUnavailable')
            return
          }
        }

        // The one builder fills the frontend's sections, redacted; Desktop's command adds the native ones (2.1-M421).
        const report = buildProblemReport({
          createdAt: new Date(),
          description: description.value,
          ring: recentFrontendDiagnostics(),
          origin,
          design: currentDesign,
          sections: writer.sections,
        })
        if (writing) {
          await writing
          if (submitGeneration !== generation) return
        }
        const write = writer.write(report)
        const settled: Promise<void> = write.then(noop, noop).then(() => {
          if (writing === settled) writing = null
        })
        writing = settled
        const nextResult = await write
        if (submitGeneration !== generation) return
        result.value = nextResult
        // Shown selected once, here and only while the user still wants it: the write itself shows nothing (2.1-Q276).
        if (writer.reveal) await reveal(writer.reveal, nextResult.file_name, submitGeneration)
        else showFolderState.value = 'idle'
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
      const show = port.peek()?.reveal
      if (!result.value || !show) return
      await reveal(show, result.value.file_name, generation)
    },
  }

  /** Shows a saved report in the file manager; its outcome is told only to the dialog that still shows the report. */
  async function reveal(show: (fileName: string) => Promise<void>, fileName: string, wanted: number): Promise<void> {
    showFolderState.value = 'showing'
    try {
      await show(fileName)
      if (wanted === generation) showFolderState.value = 'idle'
    } catch {
      if (wanted === generation) showFolderState.value = 'failed'
    }
  }
}
