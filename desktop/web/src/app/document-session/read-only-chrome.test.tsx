// @vitest-environment jsdom

// The read-only Design in the save-status slot (2.1-Q317, M478; canopi-f47t.52.270): it says a newer Canopi saved it,
// explains why it cannot change in the label's popover, and offers Update (Desktop checks for updates in About, the Web
// reloads). The Design name is shown, not offered for renaming. Read through the real SaveStatusLabel, the real Web
// frame and the real Desktop title bar.
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
  version: 9,
  name: 'Orchard 2.1',
  description: null,
  plant_species_colors: {},
  plant_species_symbols: {},
  layers: [],
  plants: [],
  zones: [],
  annotations: [],
  measurement_guides: [],
  groups: [],
  consortiums: [],
  timeline: [],
  budget: [],
  budget_currency: 'EUR',
  views: [],
  stories: [],
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  extra: {},
}

const STATUS = 'Read-only: saved by a newer Canopi'

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

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent === text)
}

describe('R1 canopi-f47t.52.270: the read-only Design in the save-status slot', () => {
  it('says a newer Canopi saved it, explains it in the popover and runs Update', async () => {
    const onUpdate = vi.fn()
    await act(async () => {
      render(
        <SaveStatusLabel
          status="read-only"
          draftLabel="Draft"
          draftAction={{ label: 'Save as…', style: 'button', run: vi.fn() }}
          saveElsewhere={{ label: 'Save as…', run: vi.fn() }}
          onRetry={vi.fn()}
          onUpdate={onUpdate}
        />,
        container,
      )
    })
    expect(container.querySelector('[data-save-status="read-only"]')).not.toBeNull()
    const trigger = button(STATUS)
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog')

    await act(async () => { trigger!.click() })
    const popover = container.querySelector('[role="dialog"]')
    expect(popover?.textContent).toContain('This Design was saved by a newer Canopi.')

    await act(async () => { popover!.querySelector('button')!.click() })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    await act(async () => { button('Update')!.click() })
    expect(onUpdate).toHaveBeenCalledTimes(2)
  })

  it('Web: the frame shows the status, the name as text, and Update reloads', async () => {
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
          designIdentity={{ name: 'Orchard 2.1', saveStatus: 'read-only', saveFailureReason: null }}
          onUpdate={onUpdate}
        />,
        container,
      )
    })
    expect(button(STATUS)).toBeDefined()
    expect(container.querySelector('[aria-keyshortcuts="F2"]')).toBeNull()
    expect(container.textContent).toContain('Orchard 2.1')
    await act(async () => { button('Update')!.click() })
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('Desktop: the title bar shows the status, the name as text, and Update opens About to check for updates', async () => {
    designSessionStore.replaceCurrentDesignState(SHOWN, null, SHOWN.name, {
      kind: 'read-only',
      origin: 'newer-version',
      savedByVersion: 10,
    })
    await act(async () => { render(<TitleBar />, container) })
    expect(button(STATUS)).toBeDefined()
    expect(container.querySelector('[aria-keyshortcuts="F2"]')).toBeNull()
    expect(container.textContent).toContain('Orchard 2.1')
    await act(async () => { button('Update')!.click() })
    expect(aboutCanopiDialogOpen.value).toBe(true)
  })
})
