// @vitest-environment jsdom
// The problem report submission over the one builder and the edition's port (contracts §13, §22, 2.1-M421): a report
// opened from a failure carries its code (plan Real-environment checks), through the real boundary, ring, builder and
// submission; none written when consent finds no Design; one press makes one report; a dialog closed mid-build drops
// what the build returns.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProblemReportResult } from '../../generated/contracts'
import { RootBoundary, SurfaceBoundary } from '../../components/shared/SurfaceBoundary'
import { reportFailure, reportOriginOf } from '../../failures/report'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../../failures/ring'
import { IpcFailure } from '../../failures/ipc-failure'
import { t } from '../../i18n'
import type { EditionSections, ProblemReport, ProblemReportPort } from '../../platform/problem-report'
import { createBrowserProblemReportWriter } from '../../platform/problem-report.browser'
import { createProblemReportSubmission, type ProblemReportSubmissionDeps } from './submission'
import { recentFrontendDiagnostics } from './diagnostics'

type Write = (report: ProblemReport) => Promise<ProblemReportResult>

const SAVED: ProblemReportResult = { file_name: 'canopi-report-20261108-090503.zip', revealed: true }

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

function deps(overrides: Partial<ProblemReportSubmissionDeps> = {}): ProblemReportSubmissionDeps {
  return {
    readFrontendDiagnostics: recentFrontendDiagnostics,
    buildCurrentDesignAttachment: () => null,
    currentDesignUnavailableMessage: () => 'No current Design is available to attach.',
    setDialogOpen: vi.fn(),
    ...overrides,
  }
}

/** A submission writing through a port whose write is `write`. */
function submissionWith(write: Write = vi.fn<Write>().mockResolvedValue(SAVED), submissionDeps = deps()) {
  const port: ProblemReportPort = { sections: NATIVE, write: vi.fn(write) }
  const submission = createProblemReportSubmission(submissionDeps)
  submission.installPort(port)
  return { submission, port, submissionDeps }
}

function sent(port: ProblemReportPort): ProblemReport {
  return vi.mocked(port.write).mock.calls[0]![0]
}

/** A section's text as written, or undefined when it is marked empty. */
function section(report: ProblemReport, id: string): string | undefined {
  const entry = report.entries.find((candidate) => candidate.section === id)
  return entry && entry.status !== 'empty' ? entry.text ?? undefined : undefined
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
    const { submission, port } = submissionWith()
    await act(async () => render(
      <RootBoundary source="root.desktop" onReport={(origin) => submission.open(origin)}>
        <SurfaceBoundary surface="about"><Broken /></SurfaceBoundary>
      </RootBoundary>,
      container,
    ))
    const report = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Report a problem')!
    await act(async () => report.click())
    await submission.submit()

    const failure = JSON.parse(section(sent(port), 'originating_failure')!) as Record<string, unknown>
    expect(failure).toMatchObject({ code: { kind: 'internal' }, op: 'surface.about', operation: null })
    expect(String(failure.detail)).toContain('panel render failed')
    expect(String(failure.detail)).not.toContain('/home/ana')
  })

  it('a report opened from a reported settlement lists its code; one opened from a menu lists none', async () => {
    const settlement = { code: { kind: 'busy', lane: 'library' }, user_may_retry: true, op: 'library.delete_item', operation: null, detail: null }
    reportFailure(settlement, { shown: 'notice' })
    const { submission, port } = submissionWith()
    submission.open(reportOriginOf(settlement))
    await submission.submit()
    expect(JSON.parse(section(sent(port), 'originating_failure')!)).toMatchObject({
      code: { kind: 'busy', lane: 'library' },
      op: 'library.delete_item',
    })

    const plain = submissionWith()
    plain.submission.open()
    await plain.submission.submit()
    expect(section(sent(plain.port), 'originating_failure')).toBeUndefined()
  })

  it('Web consent on with no Design open: the unavailable message, and nothing is downloaded', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:report')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const writer = createBrowserProblemReportWriter({ build: () => ({}), health: () => ({}), settings: () => ({}) })
    const write = vi.spyOn(writer, 'write')
    const submission = createProblemReportSubmission(deps({ buildCurrentDesignAttachment: () => null }))
    submission.installPort(writer)
    submission.open()
    submission.setIncludeCurrentDesign(true)
    await submission.submit()
    expect(write).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(submission.error.value).toBe('No current Design is available to attach.')
    expect(submission.result.value).toBeNull()
    expect(submission.submitting.value).toBe(false)
    writer.dispose()
  })

  it('a second press while the report is being made makes one report', async () => {
    let resolve!: (result: ProblemReportResult) => void
    const { submission, port } = submissionWith(() => new Promise<ProblemReportResult>((done) => { resolve = done }))
    submission.open()
    const first = submission.submit()
    const second = submission.submit()
    resolve(SAVED)
    await Promise.all([first, second])
    expect(port.write).toHaveBeenCalledTimes(1)
    expect(submission.result.value).toEqual(SAVED)
  })

  it('a busy Desktop command settles as its typed busy failure: its message, never its text, and no report', async () => {
    const busy = new IpcFailure(
      { code: { kind: 'busy', lane: 'local' }, user_may_retry: true, op: 'problem_report.create', operation: null, detail: null },
      'local lane busy: /home/ana/.local/share/canopi',
    )
    const { submission } = submissionWith(() => Promise.reject(busy))
    submission.open()
    await submission.submit()
    expect(submission.result.value).toBeNull()
    expect(submission.error.value).toBe(t('failure.busy'))
    expect(ringEntries().filter((entry) => entry.code.kind === 'busy')).toHaveLength(1)
  })

  it('[canopi-f47t.52.36] an untyped writer error is recorded once and reads the catalogue\'s message, never its text', async () => {
    for (const fault of [new Error('SecurityError at /home/ana/Downloads'), 'quota exceeded']) {
      resetFrontendDiagnosticsForTests()
      const { submission } = submissionWith(() => Promise.reject(fault))
      submission.open()
      await submission.submit()
      expect(submission.result.value).toBeNull()
      expect(submission.error.value).toBe(t('failure.internal'))
      const entries = ringEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ source: 'problem_report.create', code: { kind: 'internal' }, surfaced: true })
      expect(JSON.stringify(entries[0])).not.toContain('/home/ana')
    }
  })

  it('a dialog closed while the report is being made shows nothing it returns', async () => {
    let resolve!: (result: ProblemReportResult) => void
    const { submission } = submissionWith(() => new Promise<ProblemReportResult>((done) => { resolve = done }))
    submission.open()
    const pending = submission.submit()
    submission.close()
    resolve(SAVED)
    await pending
    expect(submission.result.value).toBeNull()
    expect(submission.submitting.value).toBe(false)
  })

  it('with no writer installed, a report fails and writes nothing', async () => {
    const submission = createProblemReportSubmission(deps())
    const port: ProblemReportPort = { sections: NATIVE, write: vi.fn<Write>().mockResolvedValue(SAVED) }
    const uninstall = submission.installPort(port)
    uninstall()
    await submission.submit()
    expect(port.write).not.toHaveBeenCalled()
    expect(submission.result.value).toBeNull()
    expect(submission.error.value).not.toBeNull()
  })
})
