// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanopiFile } from '../types/design'

const windowMocks = vi.hoisted(() => ({
  startDragging: vi.fn(),
  toggleMaximize: vi.fn(),
  minimize: vi.fn(),
  close: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMocks,
}))


import { locale, theme } from '../app/settings/state'
import { requestDesignRename } from '../app/shell/requests'
import { settingsDialogOpen, keyboardShortcutsDialogOpen } from '../app/shell/dialogs'
import {
  designSessionFixture,
  currentDesign,
  designDirty,
  designName,
  replaceCurrentDesignState,
  resetDirtyBaselines,
} from './support/design-session-state'
import { TitleBar } from '../components/shared/TitleBar'

function makeDesign(name: string): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-06-20T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
    extra: {},
  }
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('TitleBar', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    theme.value = 'light'
    replaceCurrentDesignState(makeDesign('Untitled'), '/designs/untitled.canopi', 'Untitled')
    resetDirtyBaselines()
    windowMocks.startDragging.mockClear()
    windowMocks.toggleMaximize.mockClear()
    windowMocks.minimize.mockClear()
    windowMocks.close.mockClear()
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  it('shows menus, Help and Settings on the start screen without a Design name or place search', async () => {
    designSessionFixture.file = null
    designSessionFixture.name = 'Untitled'

    await act(async () => {
      render(<TitleBar />, container)
      await flushEffects()
    })

    const menubar = container.querySelector('[role="menubar"]')!
    expect([...menubar.querySelectorAll('button[data-menu-id]')].map((button) => button.textContent)).toEqual([
      'File', 'Edit', 'View', 'Tools', 'Help',
    ])
    // The narrow-window "Menu" button carries every menu; CSS shows one or the other.
    expect(menubar.querySelector('button[aria-label="Menu"]')?.getAttribute('aria-haspopup')).toBe('menu')
    expect(container.textContent).not.toContain('Untitled Design')
    expect(container.querySelector('button[aria-label^="Rename Design"]')).toBeNull()
    expect(container.querySelector('input[role="combobox"]')).toBeNull()

    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Settings…"]')!.click() })
    expect(settingsDialogOpen.value).toBe(true)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Keyboard shortcuts"]')!.click() })
    expect(keyboardShortcutsDialogOpen.value).toBe(true)
    expect(container.querySelector('button[aria-label="Keyboard shortcuts"]')!.getAttribute('aria-keyshortcuts')).toBe('F1')
    settingsDialogOpen.value = false
    keyboardShortcutsDialogOpen.value = false
  })

  it('shows the save status and the place field while a Design is open', async () => {
    await act(async () => {
      render(<TitleBar />, container)
      await flushEffects()
    })

    // With no continuous-save session in this fixture, the Design reads as saved.
    expect(container.querySelector('[data-save-status] [role="status"]')?.textContent).toBe('Saved')
    expect(container.querySelector('input[role="combobox"]')?.getAttribute('placeholder')).toBe('Place or coordinates')
  })

  it('renames the Design with one click or F2 without persisting unchanged fallback text', async () => {
    await act(async () => {
      render(<TitleBar />, container)
      await flushEffects()
    })

    const nameButton = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Rename Design: "]')
    expect(nameButton()?.textContent).toBe('Untitled Design')
    expect(nameButton()?.getAttribute('aria-label')).toBe('Rename Design: Untitled Design')
    expect(nameButton()?.getAttribute('aria-keyshortcuts')).toBe('F2')

    await act(async () => {
      nameButton()!.click()
      await flushEffects()
    })

    let input = container.querySelector<HTMLInputElement>('input[aria-label="Design name"]')
    expect(input).toBeTruthy()
    expect(document.activeElement).toBe(input)
    expect(input?.value).toBe('Untitled Design')
    expect(input?.selectionStart).toBe(0)
    expect(input?.selectionEnd).toBe('Untitled Design'.length)
    expect(windowMocks.toggleMaximize).not.toHaveBeenCalled()
    expect(windowMocks.startDragging).not.toHaveBeenCalled()

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
      await flushEffects()
    })

    expect(designName.value).toBe('Untitled')
    expect(currentDesign.value?.name).toBe('Untitled')
    expect(designDirty.value).toBe(false)

    await act(async () => {
      requestDesignRename()
      await flushEffects()
    })
    input = container.querySelector<HTMLInputElement>('input[aria-label="Design name"]')
    expect(document.activeElement).toBe(input)

    await act(async () => {
      input!.value = 'Scrap'
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      input!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
      await flushEffects()
    })
    expect(designName.value).toBe('Untitled')

    await act(async () => {
      requestDesignRename()
      await flushEffects()
    })
    input = container.querySelector<HTMLInputElement>('input[aria-label="Design name"]')
    await act(async () => {
      input!.value = 'Forest Edge'
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      await flushEffects()
    })
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
      await flushEffects()
    })

    expect(designName.value).toBe('Forest Edge')
    expect(currentDesign.value?.name).toBe('Forest Edge')
    expect(designDirty.value).toBe(true)
    expect(nameButton()?.textContent).toBe('Forest Edge')
  })

  it('drags the frameless window from empty title-bar space and maximizes on a double press', async () => {
    await act(async () => {
      render(<TitleBar />, container)
      await flushEffects()
    })
    const bar = container.querySelector<HTMLElement>('[data-workspace-title-bar]')!
    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1, detail: 1 }))
    expect(windowMocks.startDragging).toHaveBeenCalledOnce()
    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1, detail: 2 }))
    expect(windowMocks.toggleMaximize).toHaveBeenCalledOnce()
    container.querySelector('[role="menubar"] button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1, detail: 1 }))
    expect(windowMocks.startDragging).toHaveBeenCalledOnce()
  })

  it('shows the Open a .canopi file button and runs file.open when clicked (2.1-Q128)', async () => {
    const { appCommandGraphChromeProjection } = await import('../commands/registry')
    const spy = vi.spyOn(appCommandGraphChromeProjection.value.titleBar.openDesign, 'action').mockImplementation(() => {})
    try {
      await act(async () => {
        render(<TitleBar />, container)
        await flushEffects()
      })
      const openButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open a .canopi file"]')
      expect(openButton).not.toBeNull()
      await act(async () => { openButton!.click() })
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
})
