// @vitest-environment jsdom
//
// 2.1-Q87 & 2.1-Q360: one rename rule and inline rename field across editions.
// Enter and click-away keep the new name, Escape cancels, and a refused rename
// keeps/reopens the field with the error while preserving the typed name.

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    startDragging: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    minimize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  }),
}))

import { DesignNameField } from '../components/shared/DesignNameField'
import { InlineRenameField } from '../components/shared/InlineRenameField'
import { TitleBar } from '../components/shared/TitleBar'
import { BrowserAppShell } from '../editions/web/BrowserAppShell'
import { createBrowserShellCapabilities, createBrowserShellCatalog, createBrowserShellCommandProjection } from '../editions/web/browser-shell-commands'
import { workspaceCanvasCommandProjection } from '../app/workspace-commands/canvas-actions'
import { clearCurrentDesignState, replaceCurrentDesignState } from './support/design-session-state'
import { CURRENT_CANOPI_FILE_VERSION } from '../generated/canopi-design-format'
import type { CanopiFile } from '../types/design'
import { normaliseObjectName } from '../app/design-edit/object-name'
import { designSessionStore } from '../app/document-session/store'

const container = document.createElement('div')

function sampleDesign(name: string): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '',
    updated_at: '',
    extra: {},
  }
}

afterEach(() => {
  render(null, container)
  container.remove()
  clearCurrentDesignState()
})

describe('shared rename rule and inline field (2.1-Q87, 2.1-Q360)', () => {
  it('normaliseObjectName trims whitespace, collapses line breaks, and rejects empty names', () => {
    expect(normaliseObjectName('  South\nOrchard  ')).toEqual({ ok: true, name: 'South Orchard' })
    expect(normaliseObjectName('   \t\n ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('Desktop TitleBar and Web BrowserAppShell share the same click-away commit and Escape cancel rename path (2.1-Q87)', async () => {
    document.body.appendChild(container)

    // 1. Desktop TitleBar path
    replaceCurrentDesignState(sampleDesign('North field'), null, 'North field')
    await act(async () => { render(<TitleBar />, container) })
    const desktopButton = container.querySelector<HTMLButtonElement>('button[aria-label*="North field"]')!
    expect(desktopButton).not.toBeNull()
    await act(async () => { desktopButton.click() })
    const desktopInput = container.querySelector<HTMLInputElement>('input')!
    expect(desktopInput).not.toBeNull()
    desktopInput.value = '  South field '
    await act(async () => { desktopInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(designSessionStore.currentDesign.peek()?.name).toBe('South field')

    // Escape cancels on Desktop
    render(null, container)
    await act(async () => { render(<TitleBar />, container) })
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label*="South field"]')!.click() })
    const desktopEscInput = container.querySelector<HTMLInputElement>('input')!
    desktopEscInput.value = 'Discarded'
    await act(async () => { desktopEscInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(designSessionStore.currentDesign.peek()?.name).toBe('South field')

    // 2. Web BrowserAppShell path
    render(null, container)
    const onWebRename = vi.fn()
    const catalog = createBrowserShellCatalog(
      createBrowserShellCapabilities({
        newDesign: async () => {},
        openCanopi: async () => true,
        downloadCanopi: async () => {},
        revertDesign: async () => {},
        closeDesign: async () => {},
      }, () => {}, {
        importGeoJson: async () => ({ status: 'cancelled' as const }),
        exportGeoJson: async () => ({ status: 'cancelled' as const }),
      }),
      { canvasReady: () => true },
    )
    const projection = createBrowserShellCommandProjection({
      catalog,
      state: { hasDesign: true, revertAvailable: false, activePanel: 'canvas', sidePanel: null },
      canvas: workspaceCanvasCommandProjection.peek(),
    })
    await act(async () => {
      render(
        <BrowserAppShell
          commandProjection={projection}
          designIdentity={{ name: 'North field', saveStatus: 'draft', saveFailureReason: null }}
          onRenameDesign={onWebRename}
        >
          <div />
        </BrowserAppShell>,
        container,
      )
    })
    const webButton = container.querySelector<HTMLButtonElement>('button[aria-label*="North field"]')!
    expect(webButton).not.toBeNull()
    await act(async () => { webButton.click() })
    const webInput = container.querySelector<HTMLInputElement>('input')!
    webInput.value = '  South field '
    await act(async () => { webInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(onWebRename).toHaveBeenCalledWith('South field')
  })

  it('reopens/keeps the field open with the error and typed name when a rename is refused or throws (2.1-Q360)', async () => {
    document.body.appendChild(container)
    const onRename = vi.fn(async () => ({ error: 'Name is already taken' }))
    await act(async () => {
      render(<DesignNameField name="Orchard" onRename={onRename} />, container)
    })

    await act(async () => { container.querySelector('button')!.click() })
    const input = container.querySelector('input')!
    input.value = 'Duplicate name'
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })

    expect(onRename).toHaveBeenCalledWith('Duplicate name')
    const reopened = container.querySelector('input')
    expect(reopened).not.toBeNull()
    expect(reopened!.value).toBe('Duplicate name')
    expect(reopened!.getAttribute('aria-invalid')).toBe('true')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Name is already taken')

    // Synchronous throw also keeps the field open and Esc remains usable
    render(null, container)
    const onCancel = vi.fn()
    await act(async () => {
      render(
        <InlineRenameField
          value="Orchard"
          ariaLabel="Rename"
          onCommit={() => { throw new Error('Read-only store') }}
          onCancel={onCancel}
        />,
        container,
      )
    })
    const throwInput = container.querySelector('input')!
    throwInput.value = 'Blocked name'
    await act(async () => { throwInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Read-only store')
    await act(async () => { throwInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
