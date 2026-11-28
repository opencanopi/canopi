// @vitest-environment jsdom

// The read-only Design in the save-status slot (2.1-Q317, M478, Q336; canopi-f47t.52.270): the bar shows its icon and
// "Read-only", never a sentence or an inline action; its popover says why by origin (a newer Canopi saved it, with
// Update: Desktop checks for updates in About, the Web reloads; or the browser's storage could not be checked, Q334,
// with no Update, as updating does not help). The Design name is shown, not offered for renaming. Read through the real
// SaveStatusLabel, the real Web frame and the real Desktop title bar.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAboutCanopiDialog } from '../about/state'
import { locale } from '../settings/state'
import { SaveStatusLabel } from '../../components/shared/SaveStatusLabel'
import { BrowserAppShell } from '../../editions/web/BrowserAppShell'
import { projectBrowserShellForTest } from '../../__tests__/support/browser-shell-projection'
import { createTestSessionCore, type TestSessionCoreHandle } from '../../__tests__/support/session-core-fixture'
import type { CanopiFile } from '../../types/design'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), startDragging: vi.fn() }),
}))

let sessionHandle: TestSessionCoreHandle | null = null

const SHOWN: CanopiFile = {
  version: 9, name: 'Orchard 2.1', description: null, plant_species_colors: {}, plant_species_symbols: {}, layers: [],
  plants: [], zones: [], annotations: [], measurement_guides: [], groups: [], consortiums: [], timeline: [], budget: [],
  budget_currency: 'EUR', views: [], stories: [], created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z', extra: {},
}

const LABEL = 'Read-only'

let container: HTMLDivElement

beforeEach(() => {
  locale.value = 'en'
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  closeAboutCanopiDialog()
  sessionHandle?.dispose()
  sessionHandle = null
})

function button(text: string, root: ParentNode = container): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((candidate) => candidate.textContent === text)
}

function bar(): Element {
  return container.querySelector('[data-save-status="read-only"]')!
}

async function openPopover(): Promise<Element> {
  const trigger = button(LABEL, bar())
  expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog')
  await act(async () => { trigger!.click() })
  return container.querySelector('[role="dialog"]')!
}

/** The status's own controls outside its popover: the trigger only, never an inline Update (2.1-Q336). */
function inlineButtons(): string[] {
  return Array.from(bar().querySelectorAll('button'))
    .filter((candidate) => !candidate.closest('[role="dialog"]'))
    .map((candidate) => candidate.textContent ?? '')
}

function label(props: {
  readonly onDownload?: () => void
}) {
  return (
    <SaveStatusLabel
      status="read-only"
      draftLabel="Draft"
      draftAction={{ label: 'Save as…', style: 'button', run: vi.fn() }}
      saveElsewhere={{ label: 'Download a copy', run: props.onDownload ?? vi.fn() }}
      onRetry={vi.fn()}
    />
  )
}

describe('R1 canopi-f47t.52.270: the read-only Design in the save-status slot (2.1-Q336)', () => {
  it('storage not checked (2.1-Q334): the popover says the browser storage could not be checked and offers Download a copy, not Update', async () => {
    const onDownload = vi.fn()
    await act(async () => { render(label({ onDownload }), container) })
    expect(inlineButtons()).toEqual([LABEL])

    const popover = await openPopover()
    expect(popover.textContent).toContain('Canopi couldn’t check this browser’s storage, so this Draft may be out of date.')
    expect(popover.textContent).not.toContain('newer Canopi')
    expect(button('Update', popover)).toBeUndefined()
    expect(document.activeElement, 'focus starts on its action').toBe(button('Download a copy', popover))
    await act(async () => { button('Download a copy', popover)!.click() })
    expect(onDownload).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]'), 'the popover closes').toBeNull()
  })

  it('Web: a Draft opened while storage could not be checked says so in the frame\'s popover, whose Download a copy runs File\'s', async () => {
    // File › Download a copy is on for this origin only (2.1-Q334): the session says which.
    sessionHandle = createTestSessionCore({ file: SHOWN, name: 'Pond', kind: { kind: 'read-only', origin: 'storage-unchecked' } })
    const run = vi.fn()
    const downloadCanopi = vi.fn()
    await act(async () => {
      render(
        <BrowserAppShell
          commandProjection={projectBrowserShellForTest({
            capabilities: {
              newDesign: run, openCanopi: run, downloadCanopi, revertDesign: run, importGeoJson: run,
              exportGeoJson: run, exportBudgetCsv: run, closeDesign: run, navigate: run,
            },
          })}
          designIdentity={{ name: 'Pond', saveStatus: 'read-only', saveFailureReason: null, readOnlyOrigin: 'storage-unchecked' }}
        />,
        container,
      )
    })
    const popover = await openPopover()
    expect(popover.textContent).toContain('Canopi couldn’t check this browser’s storage')
    expect(button('Update', popover)).toBeUndefined()
    await act(async () => { button('Download a copy', popover)!.click() })
    expect(downloadCanopi).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })
})
