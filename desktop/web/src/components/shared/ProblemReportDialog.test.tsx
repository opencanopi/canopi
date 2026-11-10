// @vitest-environment jsdom
// The problem report dialog (2.1-Q276, Q279, Q280, Q283): the sections the edition's report holds, listed from
// REPORT_SECTIONS, with a checkbox per consent kind; where to send the zip; Desktop's saved zip with Show again, and
// Web's download with no folder to show. Through the real submission, builder and each edition's writer.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPORT_SECTIONS } from '../../generated/contracts'
import { resetFrontendDiagnosticsForTests, ringEntries } from '../../failures/ring'
import { openProblemReportDialog, problemReportSubmission } from '../../app/problem-report/submission'
import { problemReportDialogOpen } from '../../app/problem-report/state'
import { beforePaint, holdAfterPaint } from '../../__tests__/support/before-paint'
import { replaceCurrentDesignState } from '../../__tests__/support/design-session-state'
import { desktopProblemReport } from '../../platform/problem-report.desktop'
import { createBrowserProblemReportWriter, type BrowserProblemReportWriter } from '../../platform/problem-report.browser'
import en from '../../i18n/en.json'
import type { CanopiFile } from '../../types/design'
import { ProblemReportDialog, PROBLEM_REPORT_ISSUES_URL, SECTION_LINES } from './ProblemReportDialog'

const mocks = vi.hoisted(() => ({
  createProblemReport: vi.fn(),
  showProblemReportFolder: vi.fn(),
}))

vi.mock('../../ipc/problem-report', () => ({
  createProblemReport: mocks.createProblemReport,
  showProblemReportFolder: mocks.showProblemReportFolder,
}))

function makeDesign(): CanopiFile {
  return {
    version: 9,
    name: 'Secret Orchard',
    description: 'Private notes',
    plant_species_colors: {},
    layers: [],
    plants: [{
      id: 'plant-1',
      canonical_name: 'Malus domestica',
      common_name: null,
      color: null,
      position: { lon: 2.3522, lat: 48.8566 },
      rotation: null,
      scale: null,
      notes: null,
      planted_date: null,
      quantity: 1,
      locked: false,
    }],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-13T00:00:00.000Z',
    updated_at: '2026-04-13T00:00:00.000Z',
    extra: {
      future_top_level: { keep: true },
    },
  }
}

const REPORT_FILE = 'canopi-report-20260601-103000.zip'

let container: HTMLDivElement
let uninstallPort: () => void
let webWriter: BrowserProblemReportWriter | null

/** The Web writer, installed in place of Desktop's; its download is stubbed. */
function installWebWriter(): void {
  uninstallPort()
  URL.createObjectURL = vi.fn(() => 'blob:report')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  webWriter = createBrowserProblemReportWriter({
    build: () => ({ app: 'Canopi' }),
    health: () => ({}),
    settings: () => ({}),
    currentDesign: () => null,
  })
  uninstallPort = problemReportSubmission.installPort(webWriter)
}

async function show(): Promise<void> {
  await act(async () => {
    render(<ProblemReportDialog />, container)
  })
}

async function send(): Promise<void> {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
  })
}

function buttons(): string[] {
  return [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')
}

function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.textContent = ''
  document.body.appendChild(container)
  webWriter = null
  uninstallPort = problemReportSubmission.installPort(desktopProblemReport)
  openProblemReportDialog()
  mocks.createProblemReport.mockReset()
  mocks.showProblemReportFolder.mockReset()
  mocks.createProblemReport.mockResolvedValue({ file_name: REPORT_FILE })
  mocks.showProblemReportFolder.mockResolvedValue(undefined)
  resetFrontendDiagnosticsForTests()
  replaceCurrentDesignState(makeDesign(), null, 'Secret Orchard')
})

afterEach(() => {
  render(null, container)
  container.remove()
  problemReportSubmission.close()
  uninstallPort()
  webWriter?.dispose()
  vi.restoreAllMocks()
})

describe('ProblemReportDialog', () => {
  // canopi-f47t.52.228.20: the dialog held the modal layer from its commit but focused its field after paint (Preact 11
  // useEffect), so an Esc pressed as it first showed was heard by nobody and the dialog stayed open.
  it('canopi-f47t.52.228.20: the description has focus as the dialog shows, so an Esc at once closes it', async () => {
    const release = holdAfterPaint()
    try {
      render(<ProblemReportDialog />, container)
      await beforePaint()
      const field = container.querySelector('textarea')!
      expect(document.activeElement, 'focus is in the dialog as it first shows').toBe(field)
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(problemReportDialogOpen.value, 'Esc closed it').toBe(false)
    } finally {
      release()
    }
  })

  it('the dialog\'s checkboxes match the consent kinds of REPORT_SECTIONS', async () => {
    await show()
    const kinds = new Set(REPORT_SECTIONS.map((row) => row.consent).filter((consent) => consent !== 'always'))
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.map((box) => box.name).sort()).toEqual([...kinds].sort())
    expect(boxes.every((box) => !box.checked)).toBe(true)
  })

  it('lists the sections the edition\'s report holds, from REPORT_SECTIONS, and leaves out those it lacks (2.1-Q280)', async () => {
    await show()
    const always = REPORT_SECTIONS.filter((row) => row.consent === 'always').map((row) => row.id)
    const listed = () => [...container.querySelectorAll('[data-report-section]')].map((item) => item.getAttribute('data-report-section'))
    expect(listed()).toEqual(always)

    render(null, container)
    installWebWriter()
    await show()
    expect(listed()).toEqual(always.filter((id) => !['queues', 'native_settlements', 'jobs', 'library_disk', 'log_tail'].includes(id)))
    expect(container.textContent).toContain(en.problemReport.section.build)
  })

  it('each section reads its REPORT_SECTIONS line in English', () => {
    for (const row of REPORT_SECTIONS) {
      const key = SECTION_LINES[row.id].split('.').at(-1) as keyof typeof en.problemReport.section
      expect(en.problemReport.section[key].replaceAll('’', '\'')).toBe(row.privacy)
    }
  })

  it('names the GitHub issues page with a link and says what to attach (2.1-Q279)', async () => {
    await show()
    const link = container.querySelector<HTMLAnchorElement>(`a[href="${PROBLEM_REPORT_ISSUES_URL}"]`)
    expect(link?.textContent).toBe('Open the GitHub issues page')
    expect(link?.rel).toContain('noopener')
    expect(container.textContent).toContain(en.problemReport.sendText)
  })

  it('creates a report from what the user wrote, then names the saved zip and offers no Copy summary (2.1-Q276)', async () => {
    await show()
    const description = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      description.value = 'Canvas froze after placing a species'
      description.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    await send()

    // The frontend sends its own sections; the report is one zip with no summary file (2.1-Q277).
    expect(mocks.createProblemReport).toHaveBeenCalledWith({
      sections: [
        { id: 'description', text: 'Canvas froze after placing a species' },
        { id: 'frontend_ring', text: '[]' },
      ],
      current_design: null,
    })
    expect(container.textContent).toContain(REPORT_FILE)
    expect(container.textContent).toContain(en.problemReport.successText)
    // Shown selected in the file manager once, by its file name (2.1-Q276).
    expect(mocks.showProblemReportFolder.mock.calls).toEqual([[REPORT_FILE]])
    expect(buttons()).toEqual(['', 'Close', 'Show again'])
    expect(container.querySelector(`a[href="${PROBLEM_REPORT_ISSUES_URL}"]`)).not.toBeNull()
  })

  it('includes the current Design attachment only after explicit opt-in', async () => {
    await show()
    const checkbox = container.querySelector('input[name="current_design"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    expect(container.textContent).toContain('Include current Design')
    await act(async () => {
      checkbox.checked = true
      checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await send()

    const request = mocks.createProblemReport.mock.calls[0]![0]
    expect(request.current_design).toContain('"name": "Secret Orchard"')
    const attached = JSON.parse(request.current_design) as Record<string, unknown>
    expect((attached.plants as Array<{ position: unknown }>)[0]!.position).toEqual({ lon: 2.3522, lat: 48.8566 })
    expect(attached.future_top_level).toEqual({ keep: true })
    expect(attached).not.toHaveProperty('extra')
  })

  it('Show again shows the saved zip by its file name; when the folder cannot be shown, the zip is said to be kept (2.1-Q276)', async () => {
    await show()
    await send()
    mocks.showProblemReportFolder.mockRejectedValue(new Error('xdg-open unavailable'))
    await act(async () => button('Show again').click())

    // Show passes the file name, never a path.
    expect(mocks.showProblemReportFolder).toHaveBeenCalledWith(REPORT_FILE)
    expect(container.textContent).toContain(en.problemReport.showFolderFailed)
    expect(container.textContent).not.toContain(en.problemReport.successText)
    expect(container.textContent).toContain(REPORT_FILE)
  })

  it('a saved report the file manager did not show says the zip is kept and offers Show again (2.1-Q276)', async () => {
    mocks.showProblemReportFolder.mockRejectedValue(new Error('xdg-open unavailable'))
    await show()
    await send()
    expect(container.textContent).toContain(en.problemReport.showFolderFailed)
    expect(container.textContent).toContain(REPORT_FILE)
    expect(buttons()).toContain('Show again')
  })

  it('[canopi-f47t.52.36] a report cancelled while the native write runs never opens the file manager or shows an error', async () => {
    let written!: (result: { file_name: string }) => void
    mocks.createProblemReport.mockReturnValue(new Promise((done) => { written = done }))
    await show()
    await send()
    await act(async () => button('Cancel').click())
    expect(problemReportDialogOpen.value).toBe(false)
    await act(async () => written({ file_name: REPORT_FILE }))

    expect(mocks.createProblemReport).toHaveBeenCalledOnce()
    expect(mocks.showProblemReportFolder).not.toHaveBeenCalled()
    expect(problemReportSubmission.error.value).toBeNull()
    expect(ringEntries()).toEqual([])
  })

  it('a Web report is a download: the dialog offers no Show folder, so no dead action records a failure', async () => {
    installWebWriter()
    await show()
    await send()

    // Nothing was shown in a file manager: no folder to show, so no failed showing either.
    expect(problemReportSubmission.showFolderState.value).toBe('idle')
    expect(container.textContent).toContain('Report downloaded. Attach the file to your message to support.')
    expect(container.textContent).not.toContain(REPORT_FILE)
    expect(buttons()).toEqual(['', 'Close'])
    await act(async () => problemReportSubmission.showFolder())
    expect(mocks.showProblemReportFolder).not.toHaveBeenCalled()
    expect(ringEntries()).toEqual([])
  })
})
