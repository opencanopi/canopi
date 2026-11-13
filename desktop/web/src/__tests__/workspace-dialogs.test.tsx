// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locale, singleKeyShortcuts, theme, toolNamesVisible, usedCanvasTools } from '../app/settings/state'
import {
  closeKeyboardShortcutsDialog,
  closeSettingsDialog,
  keyboardShortcutsDialogOpen,
  openKeyboardShortcutsDialog,
  openSettingsDialog,
  settingsDialogOpen,
} from '../app/shell/dialogs'
import { createWorkspaceShellCapabilities } from '../app/workspace-commands/capabilities'
import { mapLayers, createDefaultMapLayers, mapBackgroundOf } from '../app/map-layers/state'
import { aboutCanopiDialogOpen } from '../app/about/state'
import { designRenameRequest } from '../app/shell/requests'
import { sidePanel } from '../app/shell/state'
import type { MenuDefinition } from '../app/shell-commands/menus'
import { SettingsDialog } from '../components/shared/SettingsDialog'
import { KeyboardShortcutsDialog } from '../components/shared/KeyboardShortcutsDialog'
import { t } from '../i18n'
import { setShortcutPlatform } from '../app/shell-commands/shortcut-text'

describe('Settings dialog', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    locale.value = 'en'
    theme.value = 'light'
    usedCanvasTools.value = []
    toolNamesVisible.value = null
  })

  afterEach(() => {
    closeSettingsDialog()
    render(null, container)
    container.remove()
    locale.value = 'en'
    theme.value = 'light'
    toolNamesVisible.value = null
  })

  it('opens as a modal with Appearance: theme, language and tool names', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    await act(async () => { render(<SettingsDialog />, container) })
    expect(container.innerHTML).toBe('')

    await act(async () => { openSettingsDialog() })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.textContent).toContain('Settings')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close')

    const dark = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => radio.textContent === 'Dark')!
    await act(async () => { dark.click() })
    expect(theme.value).toBe('dark')

    const toolNames = dialog.querySelector<HTMLInputElement>('input[role="switch"]')!
    expect(toolNames.checked).toBe(true)
    await act(async () => { toolNames.click() })
    expect(toolNamesVisible.value).toBe(false)

    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click()
    })
    const francais = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent === 'Français')!
    await act(async () => { francais.click() })
    expect(locale.value).toBe('fr')
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('Réglages')

    await act(async () => {
      container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(settingsDialogOpen.value).toBe(false)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('the single-key hint names N, Shift L and Shift 2 (no Shift R), says Shift N always resets north and + and − stay on the map, and names the mod key', () => {
    expect(t('settings.singleKeyShortcutsHint', { mod: 'Cmd' })).toBe(
      'Tool keys such as V, P and Z, N to reset north, brackets and Shift G, S, L, 2. Shift N always resets north. '
      + 'Off keeps Cmd shortcuts, Delete, Esc, arrows, F keys, and + and − on the map.',
    )
    // Every language names Shift 2 and the map's + and −, and no longer Shift R.
    for (const [code, messages] of Object.entries(import.meta.glob<{ settings: { singleKeyShortcutsHint: string } }>('../i18n/*.json', { eager: true }))) {
      const hint = messages.settings.singleKeyShortcutsHint
      expect(hint, code).toMatch(/L, 2|L・2|L、2/)
      expect(hint, code).toContain('+')
      expect(hint, code).toContain('−')
      expect(hint, code).not.toMatch(/S, R|S・R|S、R/)
    }
  })

  it('fills the single-key hint with the platform mod key', async () => {
    await act(async () => { render(<SettingsDialog />, container) })
    await act(async () => { openSettingsDialog() })
    await act(async () => { container.querySelector<HTMLElement>('[data-settings-section="keyboard"]')!.click() })
    const text = container.querySelector('[role="dialog"]')!.textContent!
    expect(text).toContain('Off keeps Ctrl shortcuts')
    expect(text).not.toContain('{{mod}}')
  })

  it('keeps Tab inside the dialog and closes on a backdrop press', async () => {
    await act(async () => { render(<SettingsDialog />, container) })
    await act(async () => { openSettingsDialog() })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')]
    focusable.at(-1)!.focus()
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(focusable[0])
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(focusable.at(-1))

    const overlay = dialog.parentElement!
    await act(async () => { overlay.dispatchEvent(new Event('pointerup', { bubbles: true })) })
    expect(settingsDialogOpen.value).toBe(false)
  })

  it('stays open when a press inside the dialog is released on the backdrop', async () => {
    await act(async () => { render(<SettingsDialog />, container) })
    await act(async () => { openSettingsDialog() })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const overlay = dialog.parentElement!
    // A drag that starts in a field (selecting its text) and ends on the backdrop.
    await act(async () => {
      dialog.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      overlay.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(settingsDialogOpen.value).toBe(true)
    // A press that starts and ends on the backdrop closes.
    await act(async () => {
      overlay.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      overlay.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(settingsDialogOpen.value).toBe(false)
  })
})

describe('Keyboard shortcuts dialog', () => {
  let container: HTMLDivElement
  const menus: MenuDefinition[] = [
    {
      id: 'tools',
      label: 'Tools',
      items: [{ type: 'action', id: 'select', label: 'Select', shortcut: 'V', disabled: false, action: vi.fn() }],
    },
    {
      id: 'file',
      label: 'File',
      items: [
        { type: 'action', id: 'new', label: 'New Design', shortcut: 'Ctrl N', disabled: false, action: vi.fn() },
        { type: 'action', id: 'revert', label: 'Revert…', disabled: false, action: vi.fn() },
      ],
    },
    { id: 'help', label: 'Help', items: [{ type: 'action', id: 'about', label: 'About', disabled: false, action: vi.fn() }] },
  ]
  /** The View menu as composeWorkspaceMenus builds it: its rotation rows come from the canvas commands. */
  const viewMenu: MenuDefinition = {
    id: 'view',
    label: 'View',
    items: [
      { type: 'action', id: 'view.fitToDesign', label: 'Fit to Design', shortcut: 'Shift F', disabled: false, action: vi.fn() },
      { type: 'action', id: 'view.resetNorth', label: 'Reset north', shortcut: 'N', disabled: false, action: vi.fn() },
      { type: 'action', id: 'view.turnViewLeft', label: 'Turn view left 15°', shortcut: 'Shift ←', disabled: false, action: vi.fn() },
      { type: 'action', id: 'view.turnViewRight', label: 'Turn view right 15°', shortcut: 'Shift →', disabled: false, action: vi.fn() },
      { type: 'action', id: 'canvas.toggleGrid', label: 'Grid', shortcut: 'Shift G', disabled: false, action: vi.fn() },
    ],
  }

  beforeEach(() => {
    locale.value = 'en'
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    closeKeyboardShortcutsDialog()
    render(null, container)
    container.remove()
  })

  it('lists every menu command that has a shortcut, grouped by menu, from the menus themselves', async () => {
    await act(async () => { render(<KeyboardShortcutsDialog menus={menus} />, container) })
    expect(container.innerHTML).toBe('')
    await act(async () => { openKeyboardShortcutsDialog() })

    const sections = [...container.querySelectorAll('section section')]
    expect(sections.map((section) => section.querySelector('h3')?.textContent)).toEqual([
      'Tools (anywhere except text fields)',
      'File',
      'Mouse, trackpad and pen',
      'Touch',
      'Map and workspace',
    ])
    expect(sections[1]!.textContent).toBe('FileNew DesignCtrl N')
    // Keys that are not menu commands: regions, nudges, map pans and turning a stamp.
    expect([...sections[4]!.querySelectorAll('dt')].map((row) => row.textContent)).toEqual([
      'Next area: title bar, tools, map, panel',
      'Previous area',
      'Nudge the selection 10 cm in the arrow\'s direction on screen',
      'Nudge the selection 1 m',
      'Pan the map when nothing is selected',
      'Pan the map farther when nothing is selected',
      'Turn the stamp you are placing by 15°',
    ])
    expect([...sections[4]!.querySelectorAll('dd')].map((row) => row.textContent)).toEqual([
      'F6', 'Shift F6', 'Arrow keys', 'Ctrl Arrow keys', 'Arrow keys', 'Ctrl Arrow keys', '[ ]',
    ])
    expect(container.textContent).toContain('Esc does one thing at a time')
    expect(document.activeElement?.textContent).toBe('Close')

    await act(async () => { (document.activeElement as HTMLButtonElement).click() })
    expect(keyboardShortcutsDialogOpen.value).toBe(false)
  })

  it('lists Pan once, under Tools, though View lists it too', async () => {
    const pan = { type: 'action' as const, id: 'canvas.tool.hand', label: 'Pan', shortcut: 'H', disabled: false, action: vi.fn() }
    const withPan: MenuDefinition[] = [
      { ...viewMenu, items: [...viewMenu.items, pan] },
      { id: 'tools', label: 'Tools', items: [...menus[0]!.items, pan] },
    ]
    await act(async () => { render(<KeyboardShortcutsDialog menus={withPan} />, container) })
    await act(async () => { openKeyboardShortcutsDialog() })
    const rows = [...container.querySelectorAll('section section')].map((section) => [
      section.querySelector('h3')!.textContent,
      [...section.querySelectorAll('dt')].map((row) => row.textContent),
    ])
    expect(rows.filter(([, labels]) => (labels as string[]).includes('Pan')).map(([heading]) => heading))
      .toEqual(['Tools (anywhere except text fields)'])
  })

  it('shows static rotation, zoom-step and fit rows in View instead of the menu\'s, and that Shift N always resets north', async () => {
    await act(async () => { render(<KeyboardShortcutsDialog menus={[...menus, viewMenu]} />, container) })
    await act(async () => { openKeyboardShortcutsDialog() })
    const viewRows = () => {
      const section = [...container.querySelectorAll('section section')].find((candidate) => candidate.querySelector('h3')?.textContent === 'View')!
      return [...section.querySelectorAll('dl > div')].map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent])
    }

    expect(viewRows()).toEqual([
      ['Zoom in or out one step', '+ · −'],
      ['Fit the Design', 'Home · Shift F · Ctrl 0'],
      ['Turn the view 15°', 'Shift ← · Shift →'],
      ['Reset north', 'N · Shift N · Shift ↑'],
      ['Grid', 'Shift G'],
    ])
    const footnote = () => container.querySelector('[data-single-key-shortcuts]')!.textContent
    expect(footnote()).toContain('Shift N works even when single-key shortcuts are off.')
    // With the switch off, N is gone from the menus and from the static row; the note stays.
    await act(async () => { singleKeyShortcuts.value = false })
    try {
      expect(viewRows()).toContainEqual(['Reset north', 'Shift N · Shift ↑'])
      expect(viewRows()).toContainEqual(['Fit the Design', 'Home · Ctrl 0'])
      expect(footnote()).toContain('Shift N works even when single-key shortcuts are off.')
    } finally {
      singleKeyShortcuts.value = true
    }
  })

  const gestureRows = () => {
    const section = [...container.querySelectorAll('section section')].find((candidate) => candidate.querySelector('h3')?.textContent === 'Mouse, trackpad and pen')!
    return [...section.querySelectorAll('dl > div')].map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent])
  }

  it('the gesture rows match the static list, with each platform\'s note', async () => {
    await act(async () => { render(<KeyboardShortcutsDialog menus={menus} platform={{ os: 'windows', gestureEvents: false }} />, container) })
    await act(async () => { openKeyboardShortcutsDialog() })
    expect(gestureRows()).toEqual([
      ['Pan the map', 'Right-drag, middle-drag or Space + drag'],
      ['Turn the view; add Ctrl for 15° steps', 'Shift + right-drag or Shift + middle-drag'],
      ['Click to reset north, drag to turn the view', 'Compass'],
      ['Open the menu', 'Right-click'],
      ['Zoom', 'Pinch or Ctrl + wheel'],
      ['Remove from the selection', 'Alt + click'],
      // The pen note: its side button drags to pan and taps for the menu.
      ['Pan the map · Open the menu', 'Pen side button: drag or tap'],
    ])
    await act(async () => { closeKeyboardShortcutsDialog() })
    render(null, container)

    // A Mac adds Control-click and turns the view only by the trackpad twist, where WebKit delivers it: the button drags
    // are unchecked on real Macs (canopi-pqxl), and the twist never steps.
    setShortcutPlatform({ os: 'mac' })
    try {
      await act(async () => { render(<KeyboardShortcutsDialog menus={menus} platform={{ os: 'mac', gestureEvents: true }} />, container) })
      await act(async () => { openKeyboardShortcutsDialog() })
      expect(gestureRows()).toContainEqual(['Turn the view', 'Twist two fingers on the trackpad'])
      expect(gestureRows()).toContainEqual(['Open the menu', 'Right-click · Control-click'])
      await act(async () => { closeKeyboardShortcutsDialog() })
      render(null, container)
      await act(async () => { render(<KeyboardShortcutsDialog menus={menus} platform={{ os: 'mac', gestureEvents: false }} />, container) })
      await act(async () => { openKeyboardShortcutsDialog() })
      expect(gestureRows().map(([label]) => label)).not.toContain('Turn the view')
      expect(gestureRows().flat().join(' ')).not.toContain('right-drag')
    } finally {
      setShortcutPlatform({ os: 'linux' })
    }
  })

  it('a Touch section after the mouse gestures names one finger, two fingers and press and hold, on every platform', async () => {
    for (const platform of [{ os: 'windows', gestureEvents: false }, { os: 'ios', gestureEvents: true }] as const) {
      await act(async () => { render(<KeyboardShortcutsDialog menus={menus} platform={platform} />, container) })
      await act(async () => { openKeyboardShortcutsDialog() })
      const sections = [...container.querySelectorAll('section section')]
      const touch = sections.find((candidate) => candidate.querySelector('h3')?.textContent === 'Touch')!
      expect(sections.indexOf(touch)).toBe(sections.findIndex((candidate) => candidate.querySelector('h3')?.textContent === 'Mouse, trackpad and pen') + 1)
      expect([...touch.querySelectorAll('dl > div')].map((row) => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent])).toEqual([
        ['Select or draw; with the Pan tool, pan', 'One finger'],
        ['Pan, zoom and turn the view', 'Two fingers'],
        ['Open the menu', 'Press and hold'],
      ])
      await act(async () => { closeKeyboardShortcutsDialog() })
      render(null, container)
    }
  })

  it('the Linux pinch note shows on Linux', async () => {
    const note = 'On Linux, trackpad pinch is not supported yet. Use Ctrl + scroll to zoom.'
    await act(async () => { render(<KeyboardShortcutsDialog menus={menus} platform={{ os: 'linux', gestureEvents: false }} linuxPinchNote />, container) })
    await act(async () => { openKeyboardShortcutsDialog() })
    expect(container.textContent).toContain(note)
    await act(async () => { render(<KeyboardShortcutsDialog menus={menus} platform={{ os: 'linux', gestureEvents: false }} linuxPinchNote={false} />, container) })
    expect(container.textContent).not.toContain(note)
  })

  it('says where single-key shortcuts are turned off, and that they are off', async () => {
    await act(async () => { render(<KeyboardShortcutsDialog menus={menus} />, container) })
    await act(async () => { openKeyboardShortcutsDialog() })
    const footnote = () => container.querySelector('[data-single-key-shortcuts]')!
    expect(footnote().textContent).toBe('Tool keys work anywhere except text fields. Single-key shortcuts can be turned off in Settings › Keyboard. Shift N works even when single-key shortcuts are off.')
    await act(async () => { singleKeyShortcuts.value = false })
    try {
      expect(footnote().getAttribute('data-single-key-shortcuts')).toBe('off')
      expect(footnote().textContent).toBe('Single-key shortcuts are off. Turn them on in Settings › Keyboard. Shift N works even when single-key shortcuts are off.')
    } finally {
      singleKeyShortcuts.value = true
    }
  })
})

describe('Workspace shell capabilities', () => {
  beforeEach(() => {
    mapLayers.value = createDefaultMapLayers()
    theme.value = 'light'
  })

  it('switches the map background, theme, dialogs and rename through app state only', async () => {
    const capabilities = createWorkspaceShellCapabilities()

    capabilities.showSatellite.execute()
    expect(mapBackgroundOf(mapLayers.value)).toBe('satellite')
    expect(capabilities.showSatellite.isChecked()).toBe(true)
    expect(capabilities.showMap.isChecked()).toBe(false)
    capabilities.showNoBackground.execute()
    expect(mapBackgroundOf(mapLayers.value)).toBe('none')
    capabilities.showMap.execute()
    expect(mapBackgroundOf(mapLayers.value)).toBe('basemap')
    expect(capabilities.showNoBackground.isChecked()).toBe(false)

    capabilities.toggleTheme.execute()
    expect(theme.value).toBe('dark')
    expect(capabilities.toggleTheme.isChecked()).toBe(true)

    capabilities.aboutCanopi.execute()
    expect(aboutCanopiDialogOpen.value).toBe(true)
    aboutCanopiDialogOpen.value = false

    const rename = designRenameRequest.value
    expect(capabilities.renameDesign.isExecutionDisabled({ hasDesign: false, revertAvailable: false, activePanel: 'canvas', sidePanel: null })).toBe(true)
    capabilities.renameDesign.execute()
    expect(designRenameRequest.value).toBe(rename + 1)

    sidePanel.value = null
    capabilities.findPlants.execute()
    expect(sidePanel.value).toBe('plant-db')
    // Find plants focuses the catalog's finder on the next frame; let that frame run here.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    sidePanel.value = null
  })
})
