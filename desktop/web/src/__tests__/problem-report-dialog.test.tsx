// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFrontendDiagnosticsForTests } from '../app/problem-report/diagnostics'
import {
  openProblemReportDialog,
  problemReportSubmission,
} from '../app/problem-report/submission'
import { problemReportDialogOpen } from '../app/problem-report/state'
import { beforePaint, holdAfterPaint } from './support/before-paint'
import { replaceCurrentDesignState } from './support/design-session-state'
import { ProblemReportDialog } from '../components/shared/ProblemReportDialog'
import type { CanopiFile } from '../types/design'

const mocks = vi.hoisted(() => ({
  createProblemReport: vi.fn(),
  showProblemReportFolder: vi.fn(),
}))

vi.mock('../ipc/problem-report', () => ({
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

describe('ProblemReportDialog', () => {
  let container: HTMLDivElement
  let clipboardWrite: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.textContent = ''
    document.body.appendChild(container)
    openProblemReportDialog()
    mocks.createProblemReport.mockReset()
    mocks.showProblemReportFolder.mockReset()
    resetFrontendDiagnosticsForTests()
    replaceCurrentDesignState(makeDesign(), null, 'Secret Orchard')
    clipboardWrite = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
    problemReportSubmission.close()
    vi.restoreAllMocks()
  })

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

  it('creates a Problem Report and makes the summary easy to copy', async () => {
    mocks.createProblemReport.mockResolvedValue({
      folder_path: '/Users/alice/Desktop/Canopi Problem Report 2026-06-01 10-30-00',
      summary_path: '/Users/alice/Desktop/Canopi Problem Report 2026-06-01 10-30-00/Report Summary.txt',
      bundle_path: '/Users/alice/Desktop/Canopi Problem Report 2026-06-01 10-30-00/Diagnostic Bundle.zip',
      report_summary: 'Canopi Problem Report\nWhat happened:\nCanvas froze',
    })

    await act(async () => {
      render(<ProblemReportDialog />, container)
    })

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('Report a problem')

    const description = container.querySelector('textarea') as HTMLTextAreaElement
    const currentDesignAttachment = container.querySelector(
      'input[name="include-current-design"]',
    ) as HTMLInputElement | null
    expect(currentDesignAttachment).not.toBeNull()
    expect(currentDesignAttachment!.checked).toBe(false)
    expect(container.textContent).toContain('Include current Design')

    await act(async () => {
      description.value = 'Canvas froze after placing a species'
      description.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new SubmitEvent('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.createProblemReport).toHaveBeenCalledWith({
      description: 'Canvas froze after placing a species',
      frontend_diagnostics: [],
      sensitive_attachments: {},
    })
    expect(container.textContent).toContain('Report Summary.txt')
    expect(container.textContent).toContain('Diagnostic Bundle.zip')
    expect(container.textContent).toContain('/Users/alice/Desktop/Canopi Problem Report')

    await act(async () => {
      const copyButton = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Copy summary'))!
      copyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(clipboardWrite).toHaveBeenCalledWith('Canopi Problem Report\nWhat happened:\nCanvas froze')
  })

  it('includes the current Design attachment only after explicit opt-in', async () => {
    mocks.createProblemReport.mockResolvedValue({
      folder_path: '/Users/alice/Desktop/Canopi Problem Report 2026-06-01 10-30-00',
      summary_path: '/Users/alice/Desktop/Canopi Problem Report 2026-06-01 10-30-00/Report Summary.txt',
      bundle_path: '/Users/alice/Desktop/Canopi Problem Report 2026-06-01 10-30-00/Diagnostic Bundle.zip',
      report_summary: 'Canopi Problem Report\nWhat happened:\nCanvas froze',
    })

    await act(async () => {
      render(<ProblemReportDialog />, container)
    })

    const checkbox = container.querySelector(
      'input[name="include-current-design"]',
    ) as HTMLInputElement
    await act(async () => {
      checkbox.checked = true
      checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new SubmitEvent('submit', { bubbles: true, cancelable: true }),
      )
    })

    const request = mocks.createProblemReport.mock.calls[0]![0]
    expect(request.sensitive_attachments.current_design).toContain('"name": "Secret Orchard"')
    const attached = JSON.parse(request.sensitive_attachments.current_design) as Record<string, unknown>
    expect((attached.plants as Array<{ position: unknown }>)[0]!.position).toEqual({ lon: 2.3522, lat: 48.8566 })
    expect(attached.future_top_level).toEqual({ keep: true })
    expect(attached).not.toHaveProperty('extra')
  })

  it('shows the generated Problem Report folder and keeps the path visible when opening fails', async () => {
    const folderPath = '/Users/alice/Desktop/Canopi Problem Report 2026-06-01 10-30-00'
    mocks.createProblemReport.mockResolvedValue({
      folder_path: folderPath,
      summary_path: `${folderPath}/Report Summary.txt`,
      bundle_path: `${folderPath}/Diagnostic Bundle.zip`,
      report_summary: 'Canopi Problem Report\nWhat happened:\nCanvas froze',
    })
    mocks.showProblemReportFolder.mockRejectedValue(new Error('xdg-open unavailable'))

    await act(async () => {
      render(<ProblemReportDialog />, container)
    })

    await act(async () => {
      container.querySelector('form')!.dispatchEvent(
        new SubmitEvent('submit', { bubbles: true, cancelable: true }),
      )
    })

    const showButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Show folder'),
    )
    expect(showButton).toBeDefined()

    await act(async () => {
      showButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.showProblemReportFolder).toHaveBeenCalledWith(folderPath)
    expect(container.textContent).toContain('Could not show the folder')
    expect(container.textContent).toContain(folderPath)
  })
})
