import { signal, type Signal } from '@preact/signals'
import { showProblemReportFolder } from '../../ipc/problem-report'
import type { ProblemReportResult } from '../../generated/contracts'
import type { ProblemReportPort } from '../../platform/problem-report'
import { reportInline, type ReportOrigin } from '../../failures/report'
import { t } from '../../i18n'
import { buildProblemReport } from './builder'
import { recentFrontendDiagnostics } from './diagnostics'
import { buildCurrentDesignProblemReportAttachment } from './attachments'
import { problemReportDialogOpen } from './state'

type ProblemReportCopyState = 'idle' | 'copied' | 'failed'
type ProblemReportShowFolderState = 'idle' | 'showing' | 'failed'

export interface ProblemReportSubmissionDeps {
  readonly showProblemReportFolder: (folderPath: string) => Promise<void>
  readonly readFrontendDiagnostics: typeof recentFrontendDiagnostics
  readonly buildCurrentDesignAttachment: () => string | null
  readonly writeClipboardText: (text: string) => Promise<void>
  readonly currentDesignUnavailableMessage: () => string
  readonly setDialogOpen: (open: boolean) => void
}

export interface ProblemReportSubmission {
  readonly description: Signal<string>
  readonly includeCurrentDesign: Signal<boolean>
  readonly submitting: Signal<boolean>
  readonly result: Signal<ProblemReportResult | null>
  readonly error: Signal<string | null>
  readonly copyState: Signal<ProblemReportCopyState>
  readonly showFolderState: Signal<ProblemReportShowFolderState>
  /** Opens the dialog afresh; a report opened from a failure lists it first (contracts §13). */
  open(origin?: ReportOrigin | null): void
  close(): void
  reset(): void
  setDescription(description: string): void
  setIncludeCurrentDesign(include: boolean): void
  submit(): Promise<void>
  copySummary(): Promise<void>
  showFolder(): Promise<void>
  /** The edition's problemReport writer (contracts §22), the one way to set it; returns the uninstall. */
  installPort(port: ProblemReportPort): () => void
}

const DEFAULT_DEPS: ProblemReportSubmissionDeps = {
  showProblemReportFolder,
  readFrontendDiagnostics: recentFrontendDiagnostics,
  buildCurrentDesignAttachment: buildCurrentDesignProblemReportAttachment,
  writeClipboardText: async (text) => {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard is not available')
    await navigator.clipboard.writeText(text)
  },
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
  const copyState = signal<ProblemReportCopyState>('idle')
  const showFolderState = signal<ProblemReportShowFolderState>('idle')
  let generation = 0
  let origin: ReportOrigin | null = null
  let port: ProblemReportPort | null = null

  function reset(): void {
    generation += 1
    origin = null
    description.value = ''
    includeCurrentDesign.value = false
    submitting.value = false
    result.value = null
    error.value = null
    copyState.value = 'idle'
    showFolderState.value = 'idle'
  }

  return {
    description,
    includeCurrentDesign,
    submitting,
    result,
    error,
    copyState,
    showFolderState,
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
      copyState.value = 'idle'

      try {
        let currentDesign: string | null = null
        if (includeCurrentDesign.value) {
          currentDesign = deps.buildCurrentDesignAttachment()
          if (!currentDesign) {
            if (submitGeneration === generation) {
              error.value = deps.currentDesignUnavailableMessage()
            }
            return
          }
        }

        // The one builder fills the frontend's sections, redacted; Desktop's command adds the native ones (2.1-M421).
        const writer = port
        if (!writer) throw new Error('No problem report writer is installed for this edition')
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
        // A typed failure (busy, io) reads its catalogue message; an untyped one keeps its text until the pre-port
        // suite asserting it is retired (canopi-f47t.52.117 via 1b-c5's file request).
        const message = reportInline(caught, 'problem_report.create')
        error.value = message ? t(message) : caught instanceof Error ? caught.message : String(caught)
      } finally {
        if (submitGeneration === generation) {
          submitting.value = false
        }
      }
    },
    async copySummary() {
      if (!result.value) return
      try {
        await deps.writeClipboardText(result.value.file_name)
        copyState.value = 'copied'
      } catch {
        copyState.value = 'failed'
      }
    },
    installPort(next) {
      port = next
      return () => {
        if (port === next) port = null
      }
    },
    async showFolder() {
      if (!result.value) return
      showFolderState.value = 'showing'
      try {
        await deps.showProblemReportFolder(result.value.file_name)
        showFolderState.value = 'idle'
      } catch {
        showFolderState.value = 'failed'
      }
    },
  }
}
