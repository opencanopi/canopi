// @vitest-environment jsdom

import { render } from 'preact'
import { act, setupRerender, teardown } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale, theme } from '../app/settings/state'
import {
  closeKeyboardShortcutsDialog,
  closeSettingsDialog,
  keyboardShortcutsDialogOpen,
  openKeyboardShortcutsDialog,
  openSettingsDialog,
} from '../app/shell/dialogs'
import { ESCAPE_PRIORITY, registerEscapeLayer } from '../app/keyboard/escape-chain'
import { focusOwner } from '../app/keyboard/focus-owner'
import { modalLayerOpen } from '../app/shell/modal-layer'
import { registerPlantFinder } from '../app/plant-finder/focus'
import { sidePanel, activePanel } from '../app/shell/state'
import { closeSaveViewDialog, openSaveViewDialog } from '../app/saved-views'
import { aboutCanopiDialogOpen, closeAboutCanopiDialog, openAboutCanopiDialog } from '../app/about/state'
import { answerSaveProblem, requestSaveProblemDecision, saveProblem } from '../app/document-session/save-problem'
import { AboutCanopiDialog } from '../components/shared/AboutCanopiDialog'
import { SaveProblemDialog } from '../components/shared/SaveProblemDialog'
import type { MenuDefinition } from '../app/shell-commands/menus'
import { setCurrentCanvasSession } from '../canvas/session'
import { createSessionPlane } from '../canvas/session-plane'
import { commandPaletteOpen } from '../commands/registry'
import type { KeyRouterHandle } from '../app/keyboard/key-router'
import { installDesktopKeys } from './support/desktop-key-router'
import { pressKey } from './support/key-router'
import { CommandPalette } from '../components/shared/CommandPalette'
import { KeyboardShortcutsDialog } from '../components/shared/KeyboardShortcutsDialog'
import { PanelRail } from '../components/shared/PanelRail'
import { SavedViewDialogs } from '../components/shared/SavedViewDialogs'
import { SettingsDialog } from '../components/shared/SettingsDialog'
import { WorkspaceDialog } from '../components/shared/WorkspaceDialog'
import { WorkspaceTitleBar } from '../components/shared/WorkspaceTitleBar'
import type { CanopiFile } from '../types/design'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { replaceCurrentDesignState } from './support/design-session-state'
import { TEST_GEO_ORIGIN } from './support/geo-design'
import { beforePaint, holdAfterPaint } from './support/before-paint'

const MENUS: readonly MenuDefinition[] = [
  { id: 'file', label: 'File', items: [{ type: 'action', id: 'file.new', label: 'New', disabled: false, action: vi.fn() }] },
  { id: 'view', label: 'View', items: [{ type: 'action', id: 'view.fit', label: 'Fit', disabled: false, action: vi.fn() }] },
]

const COMMAND = { label: 'Command', action: vi.fn() }

function design(): CanopiFile {
  return {
    version: 9,
    name: 'Orchard',
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
    views: [],
    stories: [],
    created_at: '',
    updated_at: '',
    extra: {},
  }
}

function Workspace() {
  return (
    <>
      <WorkspaceTitleBar menus={MENUS} help={COMMAND} settings={COMMAND} />
      <PanelRail label="Panels" groups={[[{ panel: 'layers', label: 'Layers', disabled: false, action: vi.fn() }]]} />
      <SettingsDialog />
      {keyboardShortcutsDialogOpen.value && <KeyboardShortcutsDialog menus={MENUS} />}
      <SavedViewDialogs />
      <AboutCanopiDialog />
      <SaveProblemDialog />
    </>
  )
}

const DIALOGS = [
  { name: 'Settings', open: openSettingsDialog, close: closeSettingsDialog },
  { name: 'Keyboard shortcuts', open: openKeyboardShortcutsDialog, close: closeKeyboardShortcutsDialog },
  { name: 'Save current view', open: openSaveViewDialog, close: closeSaveViewDialog },
  { name: 'About Canopi', open: openAboutCanopiDialog, close: closeAboutCanopiDialog },
  { name: 'the save problem dialog', open: () => { void requestSaveProblemDecision({ kind: 'revert' }) }, close: () => answerSaveProblem('cancel') },
] as const

describe('Modal layer', () => {
  let container: HTMLDivElement
  let keys: KeyRouterHandle

  beforeEach(() => {
    keys = installDesktopKeys()
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    theme.value = 'light'
    activePanel.value = 'canvas'
    sidePanel.value = null
    replaceCurrentDesignState(design(), null, 'Orchard')
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({ sessionPlane: createSessionPlane(TEST_GEO_ORIGIN) }),
    }))
  })

  afterEach(() => {
    keys.dispose()
    for (const dialog of DIALOGS) dialog.close()
    commandPaletteOpen.value = false
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
  })

  for (const dialog of DIALOGS) {
    it(`makes the title bar and rails inert behind ${dialog.name}, then gives focus back`, async () => {
      await act(async () => { render(<Workspace />, container) })
      const titleBar = container.querySelector<HTMLElement>('[data-workspace-title-bar]')!
      const rail = container.querySelector<HTMLElement>('[data-panel-rail]')!
      const view = titleBar.querySelector<HTMLButtonElement>('button[data-menu-id="view"]')!
      expect(titleBar.hasAttribute('inert')).toBe(false)
      expect(modalLayerOpen.value).toBe(false)

      view.focus()
      await act(async () => { dialog.open() })
      const modal = container.querySelector('[aria-modal="true"]')!
      expect(modal).not.toBeNull()
      expect(modalLayerOpen.value).toBe(true)
      expect(titleBar.hasAttribute('inert')).toBe(true)
      expect(rail.hasAttribute('inert')).toBe(true)
      expect(modal.closest('[inert]')).toBeNull()

      // Neither a press nor the menubar's keys open a menu under the dialog.
      await act(async () => { view.click() })
      expect(container.querySelector('[role="menu"]')).toBeNull()
      for (const key of ['Enter', 'ArrowDown', 'ArrowUp', ' ']) {
        await act(async () => {
          view.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        })
      }
      expect(container.querySelector('[role="menu"]')).toBeNull()
      expect(view.getAttribute('aria-expanded')).toBe('false')

      // Nor does a workspace shortcut reach the Design under it.
      expect(pressKey({ key: '3', ctrlKey: true }).defaultPrevented).toBe(false)
      expect(sidePanel.value).toBeNull()

      await act(async () => { dialog.close() })
      expect(modalLayerOpen.value).toBe(false)
      expect(titleBar.hasAttribute('inert')).toBe(false)
      expect(rail.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(view)

      await act(async () => { view.click() })
      expect(container.querySelector('[role="menu"]')).not.toBeNull()
    })
  }

  // canopi-f47t.52.228.20: the palette held the modal layer from its commit but took focus after paint (Preact 11
  // useEffect), so Ctrl+K then Esc at once went nowhere and the palette stayed open.
  it('canopi-f47t.52.228.20: the command palette has focus as it commits, so an Esc at once closes it', async () => {
    commandPaletteOpen.value = true
    // A bare render commits and runs layout effects; after-paint work stays queued.
    render(<CommandPalette />, container)
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
    expect(document.activeElement, 'focus is in the palette as it first shows').toBe(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(commandPaletteOpen.value, 'Esc closed it').toBe(false)
  })

  // canopi-f47t.52.228.20: these dialogs held the modal layer from their commit but took focus after paint (Preact 11
  // useEffect). WebKit leaves a clicked menu item unfocused, so an Esc in that gap was heard by nobody.
  it('canopi-f47t.52.228.20: a workspace dialog has focus as it shows, so an Esc at once closes it', async () => {
    const release = holdAfterPaint()
    try {
      const onClose = vi.fn()
      render(<WorkspaceDialog title="Rename" onClose={onClose}><input data-dialog-initial-focus /></WorkspaceDialog>, container)
      await beforePaint()
      const field = container.querySelector('input')!
      expect(document.activeElement, 'focus is in the dialog as it first shows').toBe(field)
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(onClose, 'Esc closed it').toHaveBeenCalledTimes(1)
    } finally {
      release()
    }
  })

  for (const dialog of [
    { name: 'About Canopi', view: () => <AboutCanopiDialog />, open: openAboutCanopiDialog, isOpen: () => aboutCanopiDialogOpen.value },
    {
      name: 'the save problem dialog',
      view: () => <SaveProblemDialog />,
      open: () => { void requestSaveProblemDecision({ kind: 'revert' }) },
      isOpen: () => saveProblem.value !== null,
    },
  ]) {
    it(`canopi-f47t.52.228.20: ${dialog.name} has focus as it shows, so an Esc at once closes it`, async () => {
      const release = holdAfterPaint()
      try {
        dialog.open()
        render(dialog.view(), container)
        await beforePaint()
        const modal = container.querySelector('[aria-modal="true"]')!
        expect(modal.contains(document.activeElement), 'focus is in the dialog as it first shows').toBe(true)
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        expect(dialog.isOpen(), 'Esc closed it').toBe(false)
      } finally {
        release()
      }
    })
  }

  it('makes the command palette modal: chrome inert, shortcuts stand down, focus returns', async () => {
    await act(async () => { render(<><Workspace /><CommandPalette /></>, container) })
    const titleBar = container.querySelector<HTMLElement>('[data-workspace-title-bar]')!
    const view = titleBar.querySelector<HTMLButtonElement>('button[data-menu-id="view"]')!
    const toggle = (): boolean => pressKey({ key: 'P', ctrlKey: true, shiftKey: true }).defaultPrevented

    view.focus()
    await act(async () => { expect(toggle()).toBe(true) })
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
    expect(commandPaletteOpen.value).toBe(true)
    expect(modalLayerOpen.value).toBe(true)
    expect(titleBar.hasAttribute('inert')).toBe(true)
    expect(input.closest('[inert]')).toBeNull()
    expect(document.activeElement).toBe(input)

    // A shell shortcut typed into the palette does not reach the Design.
    expect(pressKey({ key: '3', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(sidePanel.value).toBeNull()
    // F6 stays inside the palette.
    expect(focusOwner.cycleRegion(1)).toBe(false)

    // The toggle still closes it, and focus goes back to the control that opened it.
    await act(async () => { expect(toggle()).toBe(true) })
    expect(commandPaletteOpen.value).toBe(false)
    expect(modalLayerOpen.value).toBe(false)
    expect(titleBar.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(view)

    // Escape from the palette's field closes it the same way.
    await act(async () => { toggle() })
    await act(async () => {
      container.querySelector<HTMLInputElement>('[role="combobox"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(commandPaletteOpen.value).toBe(false)
    expect(document.activeElement).toBe(view)
  })

  it('one Esc in the palette closes only the palette, not a popover or the profile under it', async () => {
    await act(async () => { render(<><Workspace /><CommandPalette /></>, container) })
    const popover = vi.fn(() => true)
    const profile = vi.fn(() => true)
    const releasePopover = registerEscapeLayer({ priority: ESCAPE_PRIORITY.popover, isActive: () => true, escape: popover })
    const releaseProfile = registerEscapeLayer({ priority: ESCAPE_PRIORITY.profile, isActive: () => true, escape: profile })
    try {
      await act(async () => { commandPaletteOpen.value = true })
      const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
      // A browser renders at the microtask checkpoint after the field's handler, before the window's bubble listener:
      // the palette has unmounted and released the modal layer by the time the key router sees the Esc.
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => {
        const rerender = setupRerender()
        const checkpoint = () => rerender()
        document.addEventListener('keydown', checkpoint)
        try {
          input.dispatchEvent(escape)
        } finally {
          document.removeEventListener('keydown', checkpoint)
          teardown()
        }
      })
      expect(commandPaletteOpen.value).toBe(false)
      expect(modalLayerOpen.value).toBe(false)
      expect(escape.defaultPrevented).toBe(true)
      expect(popover).not.toHaveBeenCalled()
      expect(profile).not.toHaveBeenCalled()
    } finally {
      releasePopover()
      releaseProfile()
    }
  })

  it('runs a palette command after the chrome is live again, so Find plants focuses the finder', async () => {
    await act(async () => { render(<><Workspace /><CommandPalette /></>, container) })
    const rail = container.querySelector<HTMLElement>('[data-panel-rail]')!
    const view = container.querySelector<HTMLButtonElement>('button[data-menu-id="view"]')!
    // A finder in chrome that the palette makes inert while it holds the layer.
    const finder = document.createElement('input')
    rail.appendChild(finder)
    let layerOpenWhenFocused: boolean | null = null
    const unregister = registerPlantFinder(() => {
      layerOpenWhenFocused = modalLayerOpen.peek()
      finder.focus()
    })
    try {
      view.focus()
      await act(async () => { commandPaletteOpen.value = true })
      const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
      await act(async () => {
        input.value = 'Find plants'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(commandPaletteOpen.value).toBe(false)
      expect(layerOpenWhenFocused).toBe(false)
      expect(rail.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(finder)
    } finally {
      unregister()
      finder.remove()
    }
  })

  it('closes an open menu when a dialog opens over it', async () => {
    await act(async () => { render(<Workspace />, container) })
    const view = container.querySelector<HTMLButtonElement>('button[data-menu-id="view"]')!
    await act(async () => { view.click() })
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => { openSettingsDialog() })
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('stays open while a second dialog is still open', async () => {
    await act(async () => { render(<Workspace />, container) })
    const titleBar = container.querySelector<HTMLElement>('[data-workspace-title-bar]')!
    await act(async () => { openSettingsDialog(); openKeyboardShortcutsDialog() })
    await act(async () => { closeSettingsDialog() })
    expect(titleBar.hasAttribute('inert')).toBe(true)
    await act(async () => { closeKeyboardShortcutsDialog() })
    expect(titleBar.hasAttribute('inert')).toBe(false)
  })
})
