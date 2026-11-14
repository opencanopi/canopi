// @vitest-environment jsdom
// The Web root (ADR 0022, contracts §22, 2.1-Q283): its problem report writer outlives the app below it, so the root
// fallback's Report a problem opens the report and downloads it, the open Design attached when ticked; with none open,
// the report says so and downloads nothing. Through the real root boundary, dialog, submission, builder and writer.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { problemReportSubmission } from '../app/problem-report/submission'
import { createDesignSessionStore } from '../app/document-session/store'
import { resetFrontendDiagnosticsForTests } from '../failures/ring'
import en from '../i18n/en.json'
import type { CanopiFile } from '../types/design'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from './browser-app-data'
import { createBrowserDesignSessionController } from './browser-design-session'
import { installWebProblemReport, WebRootBoundary } from './WebRoot'

const DESIGN = '{\n  "name": "Hazel walk",\n  "plant_species_colors": { "Corylus avellana": "CAV" }\n}\n'

let container: HTMLDivElement
let uninstall: () => void
let downloads: Blob[]

function Broken(): never {
  throw new Error('workspace render failed')
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
  expect(found, label).toBeDefined()
  return found!
}

function memoryStorage(): BrowserStorageAdapter {
  const values = new Map<string, string>()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value), removeItem: (key) => void values.delete(key) }
}

function makeFile(name: string): CanopiFile {
  return {
    version: 9, name, description: null, plant_species_colors: {}, plant_species_symbols: {}, layers: [], plants: [], zones: [],
    annotations: [], measurement_guides: [], groups: [], consortiums: [], timeline: [], budget: [], budget_currency: 'EUR',
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  }
}

/** A real Web Design session opened on `text` through a stub format core reading any newer file as `view`. */
async function openedSession(text: string, view: CanopiFile) {
  const store = createDesignSessionStore()
  const controller = createBrowserDesignSessionController({
    store,
    appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
    fileAdapter: { openCanopiFile: vi.fn(async () => ({ fileName: 'orchard.canopi', text })), downloadCanopiFile: vi.fn(async () => undefined) },
  })
  controller.installFormatCore({ readNewerDesign: vi.fn(async () => ({ view, saved_by_version: 10 })) })
  await expect(controller.openCanopi()).resolves.toBe(true)
  return { controller, store }
}

async function showRootFallback(currentDesignText: () => string | null): Promise<void> {
  uninstall = installWebProblemReport({ currentDesignText, readDesignIdentity: () => null })
  const session = { reloadForRelease: vi.fn(async () => true) }
  await act(async () => render(<WebRootBoundary session={session}><Broken /></WebRootBoundary>, container))
}

async function createReport(includeDesign: boolean): Promise<void> {
  await act(async () => button(en.boundary.reportProblem).click())
  if (includeDesign) {
    const checkbox = container.querySelector<HTMLInputElement>('input[name="current_design"]')!
    await act(async () => {
      checkbox.checked = true
      checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  downloads = []
  URL.createObjectURL = vi.fn((blob: Blob) => {
    downloads.push(blob)
    return 'blob:report'
  })
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  resetFrontendDiagnosticsForTests()
})

afterEach(() => {
  render(null, container)
  container.remove()
  problemReportSubmission.close()
  uninstall()
  vi.restoreAllMocks()
})

describe('Web root', () => {
  it('[canopi-f47t.52.36] the root fallback\'s Report a problem downloads the report, with the open Design when ticked', async () => {
    await showRootFallback(() => DESIGN)
    await createReport(true)

    expect(downloads).toHaveLength(1)
    // The zip stores its files uncompressed, so their names and text read from its bytes.
    const zip = new TextDecoder().decode(await downloads[0]!.arrayBuffer())
    expect(zip).toContain('design.canopi')
    expect(zip).toContain('"Corylus avellana": "CAV"')
    expect(zip).toContain('"op": "root.web"')
    expect(container.textContent).toContain(en.problemReport.downloadedText)
  })

  it('[canopi-f47t.52.36] Web consent on with no Design open: the unavailable message, and nothing is downloaded', async () => {
    await showRootFallback(() => null)
    await createReport(true)

    expect(downloads).toEqual([])
    expect(container.textContent).toContain(en.problemReport.currentDesignUnavailable)
  })

  it('canopi-v4kj: the Web writer attaches no Design for one a newer Canopi saved, open read-only, and the open Design otherwise', async () => {
    const newer = await openedSession(JSON.stringify({ ...makeFile('Orchard 2.1'), version: 10 }), makeFile('Orchard 2.1'))
    expect(newer.store.sessionKind.value).toEqual({ kind: 'read-only', origin: 'newer-version', savedByVersion: 10 })
    uninstall = installWebProblemReport(newer.controller)
    expect(problemReportSubmission.port.value!.currentDesign()).toBeNull()
    uninstall()

    const editing = await openedSession(JSON.stringify(makeFile('Orchard')), makeFile('unused'))
    expect(editing.store.sessionKind.value).toEqual({ kind: 'editing' })
    uninstall = installWebProblemReport(editing.controller)
    expect(problemReportSubmission.port.value!.currentDesign()).toContain('"name": "Orchard"')
  })
})
