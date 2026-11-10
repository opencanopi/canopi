import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProblemReportSubmission as createSubmission,
  type ProblemReportSubmissionDeps,
} from '../app/problem-report/submission'
import type { ProblemReportResult } from '../generated/contracts'
import type { EditionSections, ProblemReport, ProblemReportPort } from '../platform/problem-report'

const NATIVE: EditionSections = {
  build: 'native',
  health: 'native',
  queues: 'native',
  native_settlements: 'native',
  jobs: 'native',
  library_disk: 'native',
  log_tail: 'native',
  settings_summary: 'native',
}

/** The edition's writer: each test reads the report it is given. */
const port = {
  sections: NATIVE,
  currentDesign: vi.fn<() => string | null>(),
  write: vi.fn<(report: ProblemReport) => Promise<ProblemReportResult>>(),
  reveal: vi.fn<(fileName: string) => Promise<void>>(),
} satisfies ProblemReportPort

beforeEach(() => {
  port.write.mockReset()
  port.reveal.mockReset()
  port.currentDesign.mockReset()
  port.currentDesign.mockReturnValue('current design json')
  port.reveal.mockResolvedValue(undefined)
  port.write.mockResolvedValue({ file_name: 'canopi-report-20261107-101500.zip', revealed: true })
})

function createProblemReportSubmission(deps: ProblemReportSubmissionDeps) {
  const submission = createSubmission(deps)
  submission.installPort(port)
  return submission
}

/** The text of a section the writer was given, or undefined when it is absent or marked empty. */
function written(id: string): string | undefined {
  const entry = port.write.mock.calls[0]?.[0].entries.find((candidate) => candidate.section === id)
  return entry && entry.status === 'included' ? entry.text ?? undefined : undefined
}

function createDeps(overrides: Partial<ProblemReportSubmissionDeps> = {}): ProblemReportSubmissionDeps {
  return {
    readFrontendDiagnostics: vi.fn(() => [
      {
        level: 'error' as const,
        source: 'command:Open design',
        message: 'disk failed at <path>',
        timestamp_ms: 1,
      },
    ]),
    currentDesignUnavailableMessage: () => 'Current Design is unavailable',
    setDialogOpen: vi.fn(),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Problem Report submission module', () => {
  it('sends the description and the frontend ring as sections and excludes current Design contents by default', async () => {
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    submission.setDescription('Canvas froze after placing a species')
    await submission.submit()

    const included = port.write.mock.calls[0]![0].entries.filter((entry) => entry.status === 'included')
    expect(included.map((entry) => entry.section)).toEqual(['description', 'frontend_ring'])
    expect(written('description')).toBe('Canvas froze after placing a species')
    expect(written('frontend_ring')).toContain('disk failed at <path>')
    expect(written('design')).toBeUndefined()
    expect(port.currentDesign).not.toHaveBeenCalled()
    expect(submission.result.value?.file_name).toBe('canopi-report-20261107-101500.zip')
    expect(submission.error.value).toBeNull()
  })

  it('redacts a home path the user typed before the description leaves the frontend', async () => {
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    submission.setDescription('It failed opening /home/alice/designs/orchard.canopi')
    await submission.submit()

    expect(written('description')).not.toContain('alice')
  })

  it('includes current Design contents only after explicit opt-in', async () => {
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    submission.setIncludeCurrentDesign(true)
    await submission.submit()

    expect(port.currentDesign).toHaveBeenCalledOnce()
    expect(written('design')).toBe('current design json')
  })

  it('blocks submission when current Design is selected but unavailable', async () => {
    port.currentDesign.mockReturnValue(null)
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    submission.setIncludeCurrentDesign(true)
    await submission.submit()

    expect(port.write).not.toHaveBeenCalled()
    expect(submission.error.value).toBe('Current Design is unavailable')
    expect(submission.submitting.value).toBe(false)
  })

  it('shows the saved zip by its file name, never a path', async () => {
    const submissionDeps = createDeps()
    const submission = createProblemReportSubmission(submissionDeps)

    await submission.submit()
    await submission.showFolder()

    expect(port.reveal).toHaveBeenCalledWith('canopi-report-20261107-101500.zip')
    expect(submission.showFolderState.value).toBe('idle')
  })

  it('closes and resets dialog state through the module', async () => {
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    submission.open()
    submission.setDescription('Canvas froze')
    submission.setIncludeCurrentDesign(true)
    await submission.submit()
    submission.close()

    expect(deps.setDialogOpen).toHaveBeenLastCalledWith(false)
    expect(submission.description.value).toBe('')
    expect(submission.includeCurrentDesign.value).toBe(false)
    expect(submission.result.value).toBeNull()
  })

  it('ignores stale success after the dialog is closed and reopened', async () => {
    const pending = deferred<ProblemReportResult>()
    port.write.mockImplementation(() => pending.promise)
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    submission.open()
    submission.setDescription('Old report')
    const oldSubmit = submission.submit()
    submission.close()
    submission.open()
    submission.setDescription('Fresh report')

    pending.resolve({ file_name: 'canopi-report-20261107-101400.zip', revealed: true })
    await oldSubmit

    expect(submission.description.value).toBe('Fresh report')
    expect(submission.result.value).toBeNull()
    expect(submission.error.value).toBeNull()
    expect(submission.submitting.value).toBe(false)
  })

  it('ignores stale failure after the dialog is closed and reopened', async () => {
    const pending = deferred<ProblemReportResult>()
    port.write.mockImplementation(() => pending.promise)
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    submission.open()
    const oldSubmit = submission.submit()
    submission.close()
    submission.open()
    submission.setDescription('Fresh report')

    pending.reject(new Error('old request failed'))
    await oldSubmit

    expect(submission.description.value).toBe('Fresh report')
    expect(submission.result.value).toBeNull()
    expect(submission.error.value).toBeNull()
    expect(submission.submitting.value).toBe(false)
  })
})
