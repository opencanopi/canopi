// @vitest-environment jsdom
// The problem report submission over the one builder and the edition's port (contracts §13, §22, 2.1-M421): a report
// opened from a failure carries its code (plan Real-environment checks), through the real boundary, ring, builder and
// submission; none written when consent finds no Design; one press makes one report; a saved report is shown in the
// file manager only while the user still wants it, and a reopened dialog's report is written after one still in flight.
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

type Write = (report: ProblemReport) => Promise<ProblemReportResult>

const SAVED: ProblemReportResult = { file_name: 'canopi-report-20261108-090503.zip' }

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

function deps(): ProblemReportSubmissionDeps {
  return { setDialogOpen: vi.fn() }
}

/** A submission writing through a port whose write is `write`. */
function submissionWith(write: Write = vi.fn<Write>().mockResolvedValue(SAVED), submissionDeps = deps()) {
  const port: ProblemReportPort = { sections: NATIVE, currentDesign: () => null, write: vi.fn(write) }
  const submission = createProblemReportSubmission(submissionDeps)
  submission.installPort(port)
  return { submission, port, submissionDeps }
}

/** A Desktop-like submission whose writer can show a saved report; `reveal` resolves unless given. */
function revealingSubmission(write: Write, reveal: (fileName: string) => Promise<void> = () => Promise.resolve()) {
  const port = { sections: NATIVE, currentDesign: () => null, write: vi.fn(write), reveal: vi.fn(reveal) } satisfies ProblemReportPort
  const submission = createProblemReportSubmission(deps())
  submission.installPort(port)
  return { submission, port }
}

/** A write that settles when the test says. */
function deferredWrite() {
  let resolve!: (result: ProblemReportResult) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<ProblemReportResult>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { write: () => promise, resolve, reject }
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
    const writer = createBrowserProblemReportWriter({ build: () => ({}), health: () => ({}), settings: () => ({}), currentDesign: () => null })
    const write = vi.spyOn(writer, 'write')
    const submission = createProblemReportSubmission(deps())
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

  it('a saved report is shown selected in the file manager once; a reveal that fails says the zip is kept (2.1-Q276)', async () => {
    const { submission, port } = revealingSubmission(vi.fn<Write>().mockResolvedValue(SAVED))
    submission.open()
    await submission.submit()
    expect(port.reveal).toHaveBeenCalledOnce()
    expect(port.reveal).toHaveBeenCalledWith(SAVED.file_name)
    expect(submission.result.value).toEqual(SAVED)
    expect(submission.showFolderState.value).toBe('idle')

    const refused = revealingSubmission(vi.fn<Write>().mockResolvedValue(SAVED), () => Promise.reject(new Error('xdg-open missing')))
    refused.submission.open()
    await refused.submission.submit()
    expect(refused.submission.result.value).toEqual(SAVED)
    expect(refused.submission.showFolderState.value).toBe('failed')
    expect(refused.submission.error.value).toBeNull()
  })

  it('[canopi-f47t.52.36] a report closed while it is written shows nothing: no file manager, no result, no error', async () => {
    for (const settle of ['written', 'failed'] as const) {
      resetFrontendDiagnosticsForTests()
      const write = deferredWrite()
      const { submission, port } = revealingSubmission(write.write)
      submission.open()
      const pending = submission.submit()
      submission.close()
      if (settle === 'written') write.resolve(SAVED)
      else write.reject(new Error('SecurityError at /home/ana/Downloads'))
      await pending
      expect(port.reveal, settle).not.toHaveBeenCalled()
      expect(submission.result.value, settle).toBeNull()
      expect(submission.error.value, settle).toBeNull()
      expect(submission.submitting.value, settle).toBe(false)
    }
  })

  it('[canopi-f47t.52.36] a report reopened while the first write is in flight is written after it, with what the user entered since', async () => {
    const first = deferredWrite()
    const SECOND: ProblemReportResult = { file_name: 'canopi-report-20261108-090509.zip' }
    const writes = [first.write, () => Promise.resolve(SECOND)]
    const port = {
      sections: NATIVE,
      currentDesign: () => '{"name":"Orchard"}\n',
      write: vi.fn<Write>(() => writes.shift()!()),
      reveal: vi.fn(() => Promise.resolve()),
    } satisfies ProblemReportPort
    const submission = createProblemReportSubmission(deps())
    submission.installPort(port)
    submission.open()
    const old = submission.submit()
    submission.close()
    submission.open()
    submission.setDescription('Second try')
    submission.setIncludeCurrentDesign(true)
    const fresh = submission.submit()
    expect(submission.submitting.value).toBe(true)
    // A sent write cannot be stopped, so the next one waits for it: never two at once.
    expect(port.write).toHaveBeenCalledTimes(1)
    first.resolve(SAVED)
    await Promise.all([old, fresh])
    expect(port.write).toHaveBeenCalledTimes(2)
    const report = vi.mocked(port.write).mock.calls[1]![0]
    expect(section(report, 'description')).toContain('Second try')
    expect(section(report, 'design')).toContain('Orchard')
    expect(submission.result.value).toEqual(SECOND)
    expect(port.reveal).toHaveBeenCalledOnce()
    expect(port.reveal).toHaveBeenCalledWith(SECOND.file_name)
    expect(submission.error.value).toBeNull()
  })

  it('[canopi-f47t.52.36] a reopened report asking for a Design with none open says so while the earlier write runs', async () => {
    const write = deferredWrite()
    const { submission, port } = revealingSubmission(write.write)
    submission.open()
    const old = submission.submit()
    submission.close()
    submission.open()
    submission.setIncludeCurrentDesign(true)
    await submission.submit()
    expect(submission.error.value).toBe(t('problemReport.currentDesignUnavailable'))
    expect(submission.submitting.value).toBe(false)
    write.resolve(SAVED)
    await old
    expect(port.write).toHaveBeenCalledTimes(1)
    expect(submission.result.value).toBeNull()
    expect(port.reveal).not.toHaveBeenCalled()
  })

  it('[canopi-f47t.52.36] a reopened report closed while it waits for the earlier write is never written', async () => {
    const write = deferredWrite()
    const { submission, port } = revealingSubmission(write.write)
    submission.open()
    const old = submission.submit()
    submission.close()
    submission.open()
    const waiting = submission.submit()
    submission.close()
    write.resolve(SAVED)
    await Promise.all([old, waiting])
    expect(port.write).toHaveBeenCalledTimes(1)
    expect(port.reveal).not.toHaveBeenCalled()
    expect(submission.result.value).toBeNull()
    expect(submission.submitting.value).toBe(false)
  })

  it('[canopi-f47t.52.36] a report created while the file manager still opens for a written one is a new write', async () => {
    // The file manager is slow to open: every reveal stays pending until the test ends it.
    const opening: (() => void)[] = []
    const SECOND: ProblemReportResult = { file_name: 'canopi-report-20261108-090509.zip' }
    const { submission, port } = revealingSubmission(
      vi.fn<Write>().mockResolvedValueOnce(SAVED).mockResolvedValueOnce(SECOND),
      () => new Promise<void>((done) => { opening.push(done) }),
    )
    submission.open()
    const old = submission.submit()
    await vi.waitFor(() => expect(port.reveal).toHaveBeenCalledOnce())
    submission.close()
    submission.open()
    submission.setDescription('Another problem')
    const fresh = submission.submit()
    await vi.waitFor(() => expect(port.write).toHaveBeenCalledTimes(2))
    expect(section(vi.mocked(port.write).mock.calls[1]![0], 'description')).toContain('Another problem')
    await vi.waitFor(() => expect(port.reveal).toHaveBeenCalledTimes(2))
    expect(port.reveal).toHaveBeenLastCalledWith(SECOND.file_name)
    for (const done of opening) done()
    await Promise.all([old, fresh])
    expect(submission.result.value).toEqual(SECOND)
  })

  it('sends what the user wrote, redacted, and the app failures ring, and reads no Design unless ticked', async () => {
    reportFailure(new Error('disk failed at /home/ana/Designs/orchard.canopi'), { shown: 'none', source: 'command:Open design' })
    const currentDesign = vi.fn(() => '{"name":"Orchard"}\n')
    const port: ProblemReportPort = { sections: NATIVE, currentDesign, write: vi.fn<Write>().mockResolvedValue(SAVED) }
    const submission = createProblemReportSubmission(deps())
    submission.installPort(port)
    submission.open()
    submission.setDescription('It failed opening /home/ana/Designs/orchard.canopi')
    await submission.submit()

    const report = sent(port)
    expect(report.entries.filter((entry) => entry.status === 'included').map((entry) => entry.section))
      .toEqual(['description', 'frontend_ring'])
    expect(section(report, 'description')).toContain('It failed opening')
    expect(section(report, 'frontend_ring')).toContain('disk failed at')
    expect(JSON.stringify(report.entries)).not.toContain('/home/ana')
    expect(currentDesign).not.toHaveBeenCalled()
    expect(report.entries.some((entry) => entry.section === 'design')).toBe(false)
  })

  it('closing resets the dialog: no description, no consent, no result, and the dialog is closed', async () => {
    const { submission, submissionDeps } = submissionWith()
    submission.open()
    submission.setDescription('Canvas froze')
    await submission.submit()
    submission.setIncludeCurrentDesign(true)
    submission.close()

    expect(submissionDeps.setDialogOpen).toHaveBeenLastCalledWith(false)
    expect(submission.description.value).toBe('')
    expect(submission.includeCurrentDesign.value).toBe(false)
    expect(submission.result.value).toBeNull()
    expect(submission.error.value).toBeNull()
  })

  it('a report closed and reopened before its write settles shows nothing of it in the new dialog', async () => {
    for (const settle of ['written', 'failed'] as const) {
      const write = deferredWrite()
      const { submission } = revealingSubmission(write.write)
      submission.open()
      const old = submission.submit()
      submission.close()
      submission.open()
      submission.setDescription('Fresh report')
      if (settle === 'written') write.resolve(SAVED)
      else write.reject(new Error('old request failed'))
      await old
      expect(submission.description.value, settle).toBe('Fresh report')
      expect(submission.result.value, settle).toBeNull()
      expect(submission.error.value, settle).toBeNull()
      expect(submission.submitting.value, settle).toBe(false)
    }
  })

  it('with no writer installed, a report fails and writes nothing', async () => {
    const submission = createProblemReportSubmission(deps())
    const port: ProblemReportPort = { sections: NATIVE, currentDesign: () => null, write: vi.fn<Write>().mockResolvedValue(SAVED) }
    const uninstall = submission.installPort(port)
    uninstall()
    await submission.submit()
    expect(port.write).not.toHaveBeenCalled()
    expect(submission.result.value).toBeNull()
    expect(submission.error.value).not.toBeNull()
  })
})
