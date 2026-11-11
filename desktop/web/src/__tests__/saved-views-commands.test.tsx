// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { appCommandGraphChromeProjection } from '../commands/registry'
import { installDesktopKeys } from './support/desktop-key-router'
import { pressKey } from './support/key-router'
import type { MenuAction, MenuDefinition, MenuEntry } from '../commands/registry'
import {
  closeManageViewsDialog,
  closeSaveViewDialog,
  dismissDeleteViewUndo,
  manageViewsDialogOpen,
  openManageViewsDialog,
  openSaveViewDialog,
  saveViewDialog,
} from '../app/saved-views'
import { currentDesign } from '../app/document-session/store'
import { workspaceCanvasCommandProjection } from '../app/workspace-commands/canvas-actions'
import { setCurrentCanvasSession } from '../canvas/session'
import { createSessionPlane } from '../canvas/session-plane'
import { SavedViewDialogs } from '../components/shared/SavedViewDialogs'
import {
  createBrowserShellCatalog,
  createBrowserShellCommandProjection,
} from '../web/browser-shell-commands'
import type { CanopiFile, SavedView, Story } from '../types/design'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { replaceCurrentDesignState } from './support/design-session-state'
import { TEST_GEO_ORIGIN } from './support/geo-design'

function savedView(id: string, name: string, title: string | null = null): SavedView {
  return {
    id,
    name,
    camera: { lon: 13.001, lat: 23.002, zoom: 17, bearing: 0, ground_size_m: { width: 20, height: 15 } },
    visible_layers: {
      background: { kind: 'basemap', style: 'liberty' },
      terrain: { contours: false, hillshade: false },
      scene_layers: [],
      site_data: [],
    },
    highlighted: { species: [], objects: [] },
    title,
    text: [],
  }
}

const POND = savedView('pond', 'Pond', 'The pond from the south')
const HEDGE = savedView('hedge', 'Hedge')

function design(views: SavedView[], stories: Story[] = []): CanopiFile {
  return {
    version: 9,
    name: 'Views',
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
    views,
    stories,
    created_at: '',
    updated_at: '',
    extra: {},
  }
}

function open(file: CanopiFile): void {
  replaceCurrentDesignState(file, null, file.name)
}

function mountCanvas() {
  const showCamera = vi.fn()
  const commands = createTestCanvasCommandSurface()
  commands.viewport.showCamera = showCamera
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
    commands,
    queries: createTestCanvasQuerySurface({ sessionPlane: createSessionPlane(TEST_GEO_ORIGIN) }),
  }))
  return { showCamera }
}

function viewMenuOf(menus: readonly MenuDefinition[]): readonly MenuEntry[] {
  return menus.find((menu) => menu.id === 'view')!.items
}

function action(entries: readonly MenuEntry[], id: string): MenuAction {
  const entry = entries.find((item) => item.type === 'action' && item.id === id)
  if (entry?.type !== 'action') throw new Error(`View menu has no ${id}`)
  return entry
}

function savedViewsSubmenu(entries: readonly MenuEntry[]) {
  const entry = entries.find((item) => item.type === 'submenu' && item.id === 'view.savedViews')
  if (entry?.type !== 'submenu') throw new Error('View menu has no Saved views submenu')
  return entry
}

function savedViewSection(entries: readonly MenuEntry[]): string[] {
  const start = entries.findIndex((item) => item.type === 'submenu' && item.id === 'view.savedViews')
  return entries.slice(start - 1, start + 3).map((item) => item.type === 'separator' ? '—' : item.id)
}

function desktopViewMenu(): readonly MenuEntry[] {
  return viewMenuOf(appCommandGraphChromeProjection.value.menus)
}

function webViewMenu(): readonly MenuEntry[] {
  const catalog = createBrowserShellCatalog({
    newDesign: () => undefined,
    openCanopi: () => undefined,
    downloadCanopi: () => undefined,
    revertDesign: () => undefined,
    importGeoJson: () => undefined,
    exportGeoJson: () => undefined,
    exportBudgetCsv: () => undefined,
    closeDesign: () => undefined,
    navigate: () => undefined,
  }, { templatesEnabled: false, canvasReady: () => true })
  const projection = createBrowserShellCommandProjection({
    catalog,
    state: { hasDesign: currentDesign.value !== null, revertAvailable: false, activePanel: 'canvas', sidePanel: null },
    canvas: workspaceCanvasCommandProjection.value,
  })
  return viewMenuOf(projection.workspaceMenus)
}

afterEach(() => {
  setCurrentCanvasSession(null)
  closeSaveViewDialog()
  closeManageViewsDialog()
  dismissDeleteViewUndo()
})

describe.each([
  ['Desktop', desktopViewMenu],
  ['Web', webViewMenu],
])('View menu saved views (%s)', (_edition, viewMenu) => {
  it('groups Saved views ▸, Save current view… and Manage views… after the zoom commands', () => {
    open(design([]))
    expect(savedViewSection(viewMenu())).toEqual(['—', 'view.savedViews', 'view.saveCurrentView', 'view.manageViews'])
    expect(savedViewsSubmenu(viewMenu())).toMatchObject({ label: 'Saved views', disabled: true, items: [] })
    expect(action(viewMenu(), 'view.saveCurrentView')).toMatchObject({ label: 'Save current view…', disabled: true })
    expect(action(viewMenu(), 'view.manageViews')).toMatchObject({ label: 'Manage views…', disabled: true })
  })

  it('lists each view, which goes there, and enables the commands once a map shows the Design', () => {
    open(design([POND, HEDGE]))
    const { showCamera } = mountCanvas()

    const submenu = savedViewsSubmenu(viewMenu())
    expect(submenu.disabled).toBe(false)
    expect(submenu.items.map((item) => [item.id, item.label, item.disabled])).toEqual([
      ['view.goToView:pond', 'Pond', false],
      ['view.goToView:hedge', 'Hedge', false],
    ])
    expect(action(viewMenu(), 'view.saveCurrentView').disabled).toBe(false)
    expect(action(viewMenu(), 'view.manageViews').disabled).toBe(false)

    submenu.items[1]!.action()
    expect(showCamera).toHaveBeenCalledWith(
      { center: { lon: 13.001, lat: 23.002 }, zoom: 17, bearingDeg: 0, pitchDeg: 0 },
      expect.objectContaining({ motion: expect.stringMatching(/^(fly|jump)$/) }),
    )
  })

  it('opens the Save and Manage dialogs', () => {
    open(design([POND]))
    mountCanvas()

    action(viewMenu(), 'view.saveCurrentView').action()
    expect(saveViewDialog.value).toEqual({ defaultName: 'View 2' })
    closeSaveViewDialog()

    action(viewMenu(), 'view.manageViews').action()
    expect(manageViewsDialogOpen.value).toBe(true)
  })
})

describe('saved views in the App Command Graph', () => {
  it('offers both commands in the command palette', () => {
    const ids = appCommandGraphChromeProjection.value.paletteCommands.map((command) => command.id)
    expect(ids).toEqual(expect.arrayContaining(['view.saveCurrentView', 'view.manageViews']))
  })

  it('keeps app shortcuts from acting under an open saved-view dialog', () => {
    open(design([POND]))
    mountCanvas()
    const redo = (): boolean => pressKey({ key: 'z', ctrlKey: true, shiftKey: true }).defaultPrevented
    const keys = installDesktopKeys()

    try {
      openSaveViewDialog()
      expect(redo()).toBe(false)
      closeSaveViewDialog()

      openManageViewsDialog()
      expect(redo()).toBe(false)
    } finally {
      keys.dispose()
    }
  })
})

describe('saved view dialogs', () => {
  let container: HTMLDivElement

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      render(<SavedViewDialogs />, container)
    })
  })

  afterEach(() => {
    render(null, container)
    container.remove()
  })

  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')
  const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => (element.getAttribute('aria-label') ?? element.textContent) === name)
  // The window's one toast position, a layer on <body> above the dialog (2.1-Q292).
  const toastLayer = () => document.querySelector<HTMLElement>('[data-toast-layer]')
  const toastButton = (name: string) => [...(toastLayer()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((element) => element.textContent === name)
  const key = (target: Element, init: KeyboardEventInit) =>
    act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
  const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

  it('saves a named view with a title from the keyboard, and Escape cancels', async () => {
    open(design([]))
    mountCanvas()
    await act(async () => { openSaveViewDialog() })

    const [name, title] = [...dialog()!.querySelectorAll<HTMLInputElement>('input')]
    expect(dialog()!.getAttribute('aria-modal')).toBe('true')
    expect(name!.value).toBe('View 1')
    expect(document.activeElement).toBe(name)

    // Tab stays inside the dialog: from the last control it returns to the first.
    const save = button('Save view')!
    save.focus()
    await key(save, { key: 'Tab' })
    expect(dialog()!.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(save)

    await type(name!, 'North hedge')
    await type(title!, 'Where the hedge meets the pond')
    await act(async () => { name!.form!.requestSubmit() })

    expect(dialog()).toBeNull()
    expect(currentDesign.value?.views?.map((view) => [view.name, view.title])).toEqual([
      ['North hedge', 'Where the hedge meets the pond'],
    ])

    await act(async () => { openSaveViewDialog() })
    await key(dialog()!, { key: 'Escape' })
    expect(dialog()).toBeNull()
    expect(currentDesign.value?.views).toHaveLength(1)
  })

  it('disables Save view while the name is blank', async () => {
    open(design([]))
    mountCanvas()
    await act(async () => { openSaveViewDialog() })

    await type(dialog()!.querySelector<HTMLInputElement>('input')!, '   ')

    expect(button('Save view')!.disabled).toBe(true)
  })

  it('renames a view in place: Enter keeps the name, Escape cancels without closing', async () => {
    open(design([POND, HEDGE]))
    await act(async () => { openManageViewsDialog() })
    expect(dialog()!.textContent).toContain('The pond from the south')

    await act(async () => { button('Rename Pond')!.click() })
    const field = container.querySelector<HTMLInputElement>('input[aria-label="New name for Pond"]')!
    expect(document.activeElement).toBe(field)
    await type(field, 'Wildlife pond')
    await act(async () => { field.form!.requestSubmit() })
    expect(currentDesign.value?.views?.map((view) => view.name)).toEqual(['Wildlife pond', 'Hedge'])
    expect(document.activeElement).toBe(button('Rename Wildlife pond'))

    await act(async () => { button('Rename Hedge')!.click() })
    const hedgeField = container.querySelector<HTMLInputElement>('input[aria-label="New name for Hedge"]')!
    await type(hedgeField, 'Discarded')
    await key(hedgeField, { key: 'Escape' })
    expect(dialog()).not.toBeNull()
    expect(currentDesign.value?.views?.map((view) => view.name)).toEqual(['Wildlife pond', 'Hedge'])
  })

  it('deletes an unused view with an Undo toast in the window toast position, above the dialog (2.1-Q292)', async () => {
    open(design([POND, HEDGE]))
    await act(async () => { openManageViewsDialog() })

    await act(async () => { button('Delete Pond')!.click() })

    expect(currentDesign.value?.views?.map((view) => view.id)).toEqual(['hedge'])
    const toast = toastLayer()!.querySelector('[role="status"]')!
    expect(toast.textContent).toContain('Deleted “Pond”')
    expect(dialog()!.contains(toast)).toBe(false)
    expect(dialog()!.contains(document.activeElement)).toBe(true)

    await act(async () => { toastButton('Undo')!.click() })
    expect(currentDesign.value?.views?.map((view) => view.id)).toEqual(['pond', 'hedge'])
    expect(toastLayer()!.querySelector('[role="status"]')).toBeNull()
  })

  it('asks before deleting a view that stories show, naming them', async () => {
    const story: Story = {
      id: 'visit',
      name: 'Client visit',
      steps: [{ id: 'step-1', view_id: 'pond', title: 'Pond', text: [], images: [] }],
    }
    open(design([POND, HEDGE], [story]))
    await act(async () => { openManageViewsDialog() })

    await act(async () => { button('Delete Pond')!.click() })
    const confirmation = container.querySelector('[role="alertdialog"]')!
    expect(confirmation.textContent).toContain('Delete “Pond”?')
    expect(confirmation.textContent).toContain('Client visit')
    expect(document.activeElement).toBe(confirmation.querySelector('button'))
    expect(currentDesign.value?.views).toHaveLength(2)

    await act(async () => { button('Delete view')!.click() })
    expect(currentDesign.value?.views?.map((view) => view.id)).toEqual(['hedge'])
    expect(currentDesign.value?.stories?.[0]?.steps).toEqual([])
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('keeps the Undo toast after the dialog closes', async () => {
    open(design([POND]))
    await act(async () => { openManageViewsDialog() })
    await act(async () => { button('Delete Pond')!.click() })
    expect(dialog()!.textContent).toContain('This Design has no saved views.')

    await act(async () => { button('Done')!.click() })

    expect(dialog()).toBeNull()
    await act(async () => { toastButton('Undo')!.click() })
    expect(currentDesign.value?.views?.map((view) => view.id)).toEqual(['pond'])
  })

  it('goes to a view from the dialog and closes it', async () => {
    open(design([POND]))
    const { showCamera } = mountCanvas()
    await act(async () => { openManageViewsDialog() })

    await act(async () => { button('Go to Pond')!.click() })

    expect(dialog()).toBeNull()
    expect(showCamera).toHaveBeenCalledTimes(1)
  })
})
