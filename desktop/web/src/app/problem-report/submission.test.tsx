// @vitest-environment jsdom
// The problem report submission over the one builder (contracts §13, 2.1-M421): a report opened from a failure carries
// its code (plan Real-environment checks), through the real boundary, ring, builder and submission; one press makes one
// report; a dialog closed mid-build drops what the build returns.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProblemReportRequest, ProblemReportResult } from '../../generated/contracts'
import { RootBoundary, SurfaceBoundary } from '../../components/shared/SurfaceBoundary'
import { reportFailure, reportOriginOf } from '../../failures/report'
import { resetFrontendDiagnosticsForTests } from '../../failures/ring'
import { createProblemReportSubmission, type ProblemReportSubmissionDeps } from './submission'
import { recentFrontendDiagnostics } from './diagnostics'

const SAVED: ProblemReportResult = { file_name: 'canopi-report-20261108-090503.zip', revealed: true }

function deps(overrides: Partial<ProblemReportSubmissionDeps> = {}): ProblemReportSubmissionDeps {
  return {
    createProblemReport: vi.fn().mockResolvedValue(SAVED),
    showProblemReportFolder: vi.fn().mockResolvedValue(undefined),
    readFrontendDiagnostics: recentFrontendDiagnostics,
    buildCurrentDesignAttachment: () => null,
    writeClipboardText: vi.fn().mockResolvedValue(undefined),
    currentDesignUnavailableMessage: () => 'No current Design is available to attach.',
    setDialogOpen: vi.fn(),
    ...overrides,
  }
}

function sent(submissionDeps: ProblemReportSubmissionDeps): ProblemReportRequest {
  return vi.mocked(submissionDeps.createProblemReport).mock.calls[0]![0]
}

function section(request: ProblemReportRequest, id: string): string | undefined {
  return request.sections.find((candidate) => candidate.id === id)?.text
}

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  resetFrontendDiagnosticsForTests()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  render(null, container)
  container.remove()
  vi.restoreAllMocks()
  resetFrontendDiagnosticsForTests()
})

function Broken(): never {
  throw new Error('panel render failed at /home/ana/Designs')
}

describe('problem report submission', () => {
  it('[canopi-f47t.52.37] a problem report opened from a failure carries its code, from a boundary\'s Report a problem', async () => {
    const submissionDeps = deps()
    const submission = createProblemReportSubmission(submissionDeps)
    await act(async () => render(
      <RootBoundary source="root.desktop" onReport={(origin) => submission.open(origin)}>
        <SurfaceBoundary surface="about"><Broken /></SurfaceBoundary>
      </RootBoundary>,
      container,
    ))
    const report = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Report a problem')!
    await act(async () => report.click())
    await submission.submit()

    const failure = JSON.parse(section(sent(submissionDeps), 'originating_failure')!) as Record<string, unknown>
    expect(failure).toMatchObject({ code: { kind: 'internal' }, op: 'surface.about', operation: null })
    expect(String(failure.detail)).toContain('panel render failed')
    expect(String(failure.detail)).not.toContain('/home/ana')
  })

  it('a report opened from a reported settlement lists its code; one opened from a menu lists none', async () => {
    const settlement = { code: { kind: 'busy', lane: 'library' }, user_may_retry: true, op: 'library.delete_item', operation: null, detail: null }
    reportFailure(settlement, { shown: 'notice' })
    const submissionDeps = deps()
    const submission = createProblemReportSubmission(submissionDeps)
    submission.open(reportOriginOf(settlement))
    await submission.submit()
    expect(JSON.parse(section(sent(submissionDeps), 'originating_failure')!)).toMatchObject({
      code: { kind: 'busy', lane: 'library' },
      op: 'library.delete_item',
    })

    const plainDeps = deps()
    const plain = createProblemReportSubmission(plainDeps)
    plain.open()
    await plain.submit()
    expect(section(sent(plainDeps), 'originating_failure')).toBeUndefined()
  })

  it('a second press while the report is being made makes one report', async () => {
    let resolve!: (result: ProblemReportResult) => void
    const submissionDeps = deps({ createProblemReport: vi.fn(() => new Promise<ProblemReportResult>((done) => { resolve = done })) })
    const submission = createProblemReportSubmission(submissionDeps)
    submission.open()
    const first = submission.submit()
    const second = submission.submit()
    resolve(SAVED)
    await Promise.all([first, second])
    expect(submissionDeps.createProblemReport).toHaveBeenCalledTimes(1)
    expect(submission.result.value).toEqual(SAVED)
  })

  it('a dialog closed while the report is being made shows nothing it returns', async () => {
    let resolve!: (result: ProblemReportResult) => void
    const submissionDeps = deps({ createProblemReport: vi.fn(() => new Promise<ProblemReportResult>((done) => { resolve = done })) })
    const submission = createProblemReportSubmission(submissionDeps)
    submission.open()
    const pending = submission.submit()
    submission.close()
    resolve(SAVED)
    await pending
    expect(submission.result.value).toBeNull()
    expect(submission.submitting.value).toBe(false)
  })
})
