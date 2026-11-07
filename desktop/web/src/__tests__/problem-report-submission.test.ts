import { describe, expect, it, vi } from 'vitest'
import {
  createProblemReportSubmission,
  type ProblemReportSubmissionDeps,
} from '../app/problem-report/submission'
import type { ProblemReportResult } from '../ipc/problem-report'

function createDeps(overrides: Partial<ProblemReportSubmissionDeps> = {}): ProblemReportSubmissionDeps {
  return {
    createProblemReport: vi.fn().mockResolvedValue({
      file_name: 'canopi-report-20261107-101500.zip',
      revealed: true,
    } satisfies ProblemReportResult),
    showProblemReportFolder: vi.fn().mockResolvedValue(undefined),
    readFrontendDiagnostics: vi.fn(() => [
      {
        level: 'error' as const,
        source: 'command:Open design',
        message: 'disk failed at <path>',
        timestamp_ms: 1,
      },
    ]),
    buildCurrentDesignAttachment: vi.fn(() => 'current design json'),
    writeClipboardText: vi.fn().mockResolvedValue(undefined),
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

    const request = vi.mocked(deps.createProblemReport).mock.calls[0]?.[0]
    expect(request?.sections.map((section) => section.id)).toEqual(['description', 'frontend_ring'])
    expect(request?.sections[0]?.text).toBe('Canvas froze after placing a species')
    expect(request?.sections[1]?.text).toContain('disk failed at <path>')
    expect(request?.current_design).toBeNull()
    expect(deps.buildCurrentDesignAttachment).not.toHaveBeenCalled()
    expect(submission.result.value?.file_name).toBe('canopi-report-20261107-101500.zip')
    expect(submission.error.value).toBeNull()
  })

  it('redacts a home path the user typed before the description leaves the frontend', async () => {
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    submission.setDescription('It failed opening /home/alice/designs/orchard.canopi')
    await submission.submit()

    const request = vi.mocked(deps.createProblemReport).mock.calls[0]?.[0]
    expect(request?.sections[0]?.text).not.toContain('alice')
  })

  it('includes current Design contents only after explicit opt-in', async () => {
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    submission.setIncludeCurrentDesign(true)
    await submission.submit()

    expect(deps.buildCurrentDesignAttachment).toHaveBeenCalledOnce()
    expect(deps.createProblemReport).toHaveBeenCalledWith(expect.objectContaining({
      current_design: 'current design json',
    }))
  })

  it('blocks submission when current Design is selected but unavailable', async () => {
    const deps = createDeps({
      buildCurrentDesignAttachment: vi.fn(() => null),
    })
    const submission = createProblemReportSubmission(deps)

    submission.setIncludeCurrentDesign(true)
    await submission.submit()

    expect(deps.createProblemReport).not.toHaveBeenCalled()
    expect(submission.error.value).toBe('Current Design is unavailable')
    expect(submission.submitting.value).toBe(false)
  })

  it('shows errors from the active submission', async () => {
    const deps = createDeps({
      createProblemReport: vi.fn().mockRejectedValue(new Error('disk full')),
    })
    const submission = createProblemReportSubmission(deps)

    await submission.submit()

    expect(submission.error.value).toBe('disk full')
    expect(submission.result.value).toBeNull()
    expect(submission.submitting.value).toBe(false)
  })

  it('copies the saved file name and shows the saved zip by its file name, never a path', async () => {
    const deps = createDeps()
    const submission = createProblemReportSubmission(deps)

    await submission.submit()
    await submission.copySummary()
    await submission.showFolder()

    expect(deps.writeClipboardText).toHaveBeenCalledWith('canopi-report-20261107-101500.zip')
    expect(submission.copyState.value).toBe('copied')
    expect(deps.showProblemReportFolder).toHaveBeenCalledWith('canopi-report-20261107-101500.zip')
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
    const deps = createDeps({
      createProblemReport: vi.fn(() => pending.promise),
    })
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
    const deps = createDeps({
      createProblemReport: vi.fn(() => pending.promise),
    })
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
