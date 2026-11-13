// @vitest-environment jsdom

// The read-only Design in the save-status slot (2.1-Q317, M478, Q336; canopi-f47t.52.270): the bar shows its icon and
// "Read-only", never a sentence or an inline action; its popover says why by origin (a newer Canopi saved it, with
// Update: Desktop checks for updates in About, the Web reloads; or the browser's storage could not be checked, Q334,
// with no Update, as updating does not help). The Design name is shown, not offered for renaming. Read through the real
// SaveStatusLabel, the real Web frame and the real Desktop title bar.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aboutCanopiDialogOpen, closeAboutCanopiDialog } from '../about/state'
import { locale } from '../settings/state'
import { SaveStatusLabel } from '../../components/shared/SaveStatusLabel'
import { TitleBar } from '../../components/shared/TitleBar'
import { BrowserAppShell } from '../../web/BrowserAppShell'
import { projectBrowserShellForTest } from '../../__tests__/support/browser-shell-projection'
import { createDesignSessionStoreTestFixture, designSessionStore } from './store'
import type { CanopiFile } from '../../types/design'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), startDragging: vi.fn() }),
}))

const fixture = createDesignSessionStoreTestFixture(designSessionStore)

const SHOWN: CanopiFile = {
  version: 9, name: 'Orchard 2.1', description: null, plant_species_colors: {}, plant_species_symbols: {}, layers: [],
  plants: [], zones: [], annotations: [], measurement_guides: [], groups: [], consortiums: [], timeline: [], budget: [],
  budget_currency: 'EUR', views: [], stories: [], created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z', extra: {},
}

const LABEL = 'Read-only'
const NEWER = 'Read-only: saved by a newer Canopi'

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
  fixture.reset()
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
  readonly origin: 'newer-version' | 'storage-unchecked'
  readonly onUpdate: () => void
  readonly onDownload?: () => void
}) {
  return (
    <SaveStatusLabel
      status="read-only"
      readOnlyOrigin={props.origin}
      draftLabel="Draft"
      draftAction={{ label: 'Save as…', style: 'button', run: vi.fn() }}
      saveElsewhere={{ label: 'Download a copy', run: props.onDownload ?? vi.fn() }}
      onRetry={vi.fn()}
      onUpdate={props.onUpdate}
    />
  )
}

describe('R1 canopi-f47t.52.270: the read-only Design in the save-status slot (2.1-Q336)', () => {
  it('shows "Read-only" alone in the bar; its popover says a newer Canopi saved it and runs Update', async () => {
    const onUpdate = vi.fn()
    await act(async () => { render(label({ origin: 'newer-version', onUpdate }), container) })
    expect(inlineButtons()).toEqual([LABEL])

    const popover = await openPopover()
    expect(popover.textContent).toContain(NEWER)
    expect(popover.textContent).toContain('This Design was saved by a newer Canopi.')
    expect(button('Download a copy', popover), 'a newer Canopi\'s Design is never re-encoded').toBeUndefined()
    await act(async () => { button('Update', popover)!.click() })
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('storage not checked (2.1-Q334): the popover says the browser storage could not be checked and offers Download a copy, not Update', async () => {
    const onUpdate = vi.fn()
    const onDownload = vi.fn()
    await act(async () => { render(label({ origin: 'storage-unchecked', onUpdate, onDownload }), container) })
    expect(inlineButtons()).toEqual([LABEL])

    const popover = await openPopover()
    expect(popover.textContent).toContain('Canopi couldn’t check this browser’s storage, so this Draft may be out of date.')
    expect(popover.textContent).not.toContain('newer Canopi')
    expect(button('Update', popover)).toBeUndefined()
    expect(document.activeElement, 'focus starts on its action').toBe(button('Download a copy', popover))
    await act(async () => { button('Download a copy', popover)!.click() })
    expect(onDownload).toHaveBeenCalledTimes(1)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]'), 'the popover closes').toBeNull()
  })

  it('Web: the frame shows "Read-only", the name as text, and the popover\'s Update reloads', async () => {
    const onUpdate = vi.fn()
    const run = vi.fn()
    await act(async () => {
      render(
        <BrowserAppShell
          commandProjection={projectBrowserShellForTest({
            capabilities: {
              newDesign: run, openCanopi: run, downloadCanopi: run, revertDesign: run, importGeoJson: run,
              exportGeoJson: run, exportBudgetCsv: run, closeDesign: run, navigate: run,
            },
          })}
          designIdentity={{ name: 'Orchard 2.1', saveStatus: 'read-only', saveFailureReason: null, readOnlyOrigin: 'newer-version' }}
          onUpdate={onUpdate}
        />,
        container,
      )
    })
    expect(inlineButtons()).toEqual([LABEL])
    expect(container.querySelector('[aria-keyshortcuts="F2"]')).toBeNull()
    expect(container.textContent).toContain('Orchard 2.1')
    const popover = await openPopover()
    await act(async () => { button('Update', popover)!.click() })
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('Web: a Draft opened while storage could not be checked says so in the frame\'s popover, whose Download a copy runs File\'s', async () => {
    // File › Download a copy is on for this origin only (2.1-Q334): the session says which.
    designSessionStore.replaceCurrentDesignState(SHOWN, null, 'Pond', { kind: 'read-only', origin: 'storage-unchecked' })
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
          onUpdate={vi.fn()}
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

  it('Desktop: the title bar shows "Read-only", the name as text, and the popover\'s Update opens About to check for updates', async () => {
    designSessionStore.replaceCurrentDesignState(SHOWN, null, SHOWN.name, {
      kind: 'read-only',
      origin: 'newer-version',
      savedByVersion: 10,
    })
    await act(async () => { render(<TitleBar />, container) })
    expect(inlineButtons()).toEqual([LABEL])
    expect(container.querySelector('[aria-keyshortcuts="F2"]')).toBeNull()
    expect(container.textContent).toContain('Orchard 2.1')
    const popover = await openPopover()
    expect(popover.textContent).toContain(NEWER)
    await act(async () => { button('Update', popover)!.click() })
    expect(aboutCanopiDialogOpen.value).toBe(true)
  })
})
