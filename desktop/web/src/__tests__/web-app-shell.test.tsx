// @vitest-environment jsdom

import { projectBrowserShellForTest } from './support/browser-shell-projection'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const workspaceCanvasLifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
}))

vi.mock('../web/WebCanvasWorkspace', async () => {
  const { useEffect, useState } = await import('preact/hooks')
  return {
    WebCanvasWorkspace: () => {
      const [state, setState] = useState('0:none:100')
      useEffect(() => {
        workspaceCanvasLifecycle.mounted()
        return () => { workspaceCanvasLifecycle.unmounted() }
      }, [])
      return <button type="button" data-testid="web-workspace-canvas" onClick={() => setState('1:plant-1:125')}>{state}</button>
    },
  }
})

vi.mock('../components/panels/WorldMapPanel', () => ({
  WorldMapPanel: () => <div data-testid="web-templates-workspace" />,
}))
import { createDesignSessionStore } from '../app/document-session/store'
import { activePanel, navigateTo, sidePanel } from '../app/shell/state'
import { closeSettingsDialog } from '../app/shell/dialogs'
import { locale, theme } from '../app/settings/state'
import {
  installSettingsProjection,
  resetSettingsProjectionForTests,
} from '../app/settings/projection'
import type { Settings } from '../types/settings'
import { createBrowserAppDataStore, type BrowserStorageAdapter } from '../web/browser-app-data'
import { createBrowserDesignSessionController, type BrowserDesignFileAdapter } from '../web/browser-design-session'
import { BrowserAppShell } from '../web/BrowserAppShell'
import { phoneLayout } from '../app/shell/phone-layout'
import { requestPlaceSearchFocus } from '../app/geocoding/place-search-ui'
import { WebApp } from '../web/WebApp'
import { createBrowserDraftPersistence } from '../web/browser-draft-persistence'
import { t } from '../i18n'
import { SettingsDialog } from '../components/shared/SettingsDialog'
import { editDesignSessionForTest } from './support/design-session-edit'

function panelBarCommandIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-panel-rail] [data-command-id]'))
    .map((element) => element.dataset.commandId ?? '')
}

function panelBarLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-panel-rail] [data-command-id]'))
    .map((button) => button.getAttribute('aria-label') ?? '')
}

function panelBarButton(container: HTMLElement, id: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-panel-rail] [data-command-id="${id}"]`)
  if (!button) throw new Error(`Missing panel rail command ${id}`)
  return button
}

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    locale: 'en',
    theme: 'light',
    snap_to_grid: true,
    side_panel_width: null,
    saved_stamps_frame_height: null,
    basemap_style: 'liberty',
    basemap_visible: true,
    basemap_opacity: 1,
    satellite_visible: false,
    satellite_opacity: 1,
    contour_visible: false,
    contour_opacity: 1,
    contour_interval: 0,
    hillshade_visible: false,
    hillshade_opacity: 0.55,
    soften_background: false,
    plant_spacing_interval_m: 0.5,
    last_view: null,
    used_canvas_tools: [],
    tool_names_visible: null,
    single_key_shortcuts: true,
    scroll_wheel: 'zoom',
    new_design_satellite: false,
    new_design_symbol_scale: 1,
    new_design_labels: 'names',
    satellite_source: null,
    ...overrides,
  }
}

function shellCommandProjection({
  templatesEnabled = false,
  downloadCanopiEnabled = true,
}: {
  readonly templatesEnabled?: boolean
  readonly downloadCanopiEnabled?: boolean
} = {}) {
  return projectBrowserShellForTest({
    currentPanel: activePanel.value,
    currentSidePanel: sidePanel.value,
    downloadCanopiEnabled,
    revertAvailable: false,
    geoJsonEnabled: downloadCanopiEnabled,
    templatesEnabled,
    capabilities: {
      newDesign: () => undefined,
      openCanopi: () => undefined,
      downloadCanopi: () => undefined,
      revertDesign: () => undefined,
      importGeoJson: () => undefined,
      exportGeoJson: () => undefined,
      exportBudgetCsv: () => undefined,
      closeDesign: () => undefined,
      navigate: navigateTo,
    },
  })
}

describe('Web Edition Browser App Shell', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    activePanel.value = 'canvas'
    sidePanel.value = null
    locale.value = 'en'
    theme.value = 'light'
    workspaceCanvasLifecycle.mounted.mockClear()
    workspaceCanvasLifecycle.unmounted.mockClear()
  })

  afterEach(() => {
    // A Settings dialog left open would make the next test's shell inert.
    closeSettingsDialog()
    render(null, container)
    container.remove()
    resetSettingsProjectionForTests()
  })

  it('renders the browser command set without desktop-only chrome or commands', async () => {
    await act(async () => {
      render(<WebApp workspace={<div data-testid="stub-workspace" />} />, container)
    })

    expect(container.querySelector('[data-testid="browser-app-shell"]')).not.toBeNull()
    await act(async () => {
      menuTrigger(container, 'file').click()
    })
    expect(openMenuCommandIds(container)).toEqual([
      'file.new',
      'file.openCanopi',
      'file.rename',
      'file.downloadCanopi',
      'file.revert',
      'file.importGeoJson',
      'app.settings',
      'file.close',
    ])
    expect(container.textContent).toContain('Open a .canopi file…')
    expect(container.textContent).toContain('Download a copy')
    expect(container.textContent).not.toContain('Quit')
    expect(container.querySelector('[data-testid="browser-drafts-list"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Open a .canopi file"]')).not.toBeNull()
    expect(panelBarCommandIds(container)).toEqual([
      'nav.layers',
      'nav.speciesKey',
      'nav.plantDb',
      'nav.favorites',
      'nav.calendar',
      'nav.budget',
      'nav.consortium',
      'nav.stories',
    ])
  })

  it('matches desktop title-bar chrome for logo and settings controls', async () => {
    await act(async () => {
      render(<WebApp workspace={<div data-testid="stub-workspace" />} />, container)
    })

    expect(container.querySelector('img[alt="Canopi"]')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('[data-menu-id]')).map((element) => element.textContent)).toEqual([
      'File', 'Edit', 'View', 'Tools', 'Help',
    ])
    expect(container.querySelector('button[aria-label="Keyboard shortcuts"]')?.getAttribute('aria-keyshortcuts')).toBe('F1')
    expect(container.querySelector('button[aria-label="Settings…"]')).not.toBeNull()
  })

  it('groups web-safe top bar commands in desktop-like menus', async () => {
    await act(async () => {
      render(<WebApp workspace={<div data-testid="stub-workspace" />} />, container)
    })

    expect(container.querySelector('[role="menubar"]')).not.toBeNull()
    expect(menuTrigger(container, 'file').textContent).toBe('File')

    await act(async () => {
      menuTrigger(container, 'file').click()
    })

    expect(openMenuCommandIds(container)).toEqual([
      'file.new',
      'file.openCanopi',
      'file.rename',
      'file.downloadCanopi',
      'file.revert',
      'file.importGeoJson',
      'app.settings',
      'file.close',
    ])
  })

  it('dismisses open Web Edition menus on outside pointerup and Escape', async () => {
    await act(async () => {
      render(<BrowserAppShell commandProjection={shellCommandProjection()} />, container)
    })

    await act(async () => {
      menuTrigger(container, 'file').click()
    })
    expect(openMenuCommandIds(container)).toEqual([
      'file.new',
      'file.openCanopi',
      'file.rename',
      'file.downloadCanopi',
      'file.revert',
      'file.importGeoJson',
      'app.settings',
      'file.close',
    ])

    await act(async () => {
      document.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(openMenuCommandIds(container)).toEqual([])

    await act(async () => {
      menuTrigger(container, 'file').click()
    })
    expect(openMenuCommandIds(container)).toContain('file.new')

    await act(async () => {
      menuTrigger(container, 'file').dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Escape',
      }))
    })
    expect(openMenuCommandIds(container)).toEqual([])
  })

  it('shows the templates entry point only when static templates are configured', async () => {
    await act(async () => {
      render(<BrowserAppShell commandProjection={shellCommandProjection({ templatesEnabled: true })} />, container)
    })

    expect(panelBarCommandIds(container)).toContain('nav.templates')

    await act(async () => {
      panelBarButton(container, 'nav.templates').click()
    })

    expect(activePanel.value).toBe('templates')
    expect(sidePanel.value).toBeNull()
  })

  it('renders web-safe panel navigation in a desktop-style right PanelBar', async () => {
    await act(async () => {
      render(<BrowserAppShell commandProjection={shellCommandProjection({ templatesEnabled: true })} />, container)
    })

    expect(container.querySelector('[data-panel-rail]')).not.toBeNull()
    expect(panelBarCommandIds(container)).toEqual([
      'nav.canvas',
      'nav.templates',
      'nav.layers',
      'nav.speciesKey',
      'nav.plantDb',
      'nav.favorites',
      'nav.calendar',
      'nav.budget',
      'nav.consortium',
      'nav.stories',
    ])
    expect(panelBarLabels(container)).toEqual([
      'Design canvas',
      'World map',
      'Layers',
      'Plants in this Design',
      'Plant catalog',
      'Favorites and stamps',
      'Calendar',
      'Budget',
      'Consortium',
      'Stories',
    ])
    await act(async () => {
      panelBarButton(container, 'nav.plantDb').click()
    })

    expect(activePanel.value).toBe('canvas')
    expect(sidePanel.value).toBe('plant-db')
  })

  it('opens switches and closes Web side panels beside the right PanelBar', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      createDraftId: () => 'draft-side-panel-state',
    })

    await act(async () => {
      render(
        <WebApp
          controller={controller}
        />,
        container,
      )
    })

    expect(container.querySelector('[data-workspace-composition]')?.getAttribute('data-workspace-sidebar-open')).toBeNull()

    await act(async () => {
      panelBarButton(container, 'nav.plantDb').click()
    })

    expect(container.querySelector('[data-workspace-composition]')).not.toBeNull()
    expect(container.querySelector('[data-workspace-composition]')?.getAttribute('data-workspace-sidebar-open')).toBe('true')
    expect(container.querySelector('[data-workspace-side-panel="plant-db"]')).not.toBeNull()
    expect(panelBarButton(container, 'nav.plantDb').getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      panelBarButton(container, 'nav.favorites').click()
    })

    expect(container.querySelector('[data-workspace-side-panel="plant-db"]')).toBeNull()
    expect(container.querySelector('[data-workspace-side-panel="favorites"]')).not.toBeNull()
    expect(panelBarButton(container, 'nav.favorites').getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      panelBarButton(container, 'nav.favorites').click()
    })

    expect(container.querySelector('[data-workspace-side-panel]')).toBeNull()
    expect(container.querySelector('[data-workspace-composition]')?.getAttribute('data-workspace-sidebar-open')).toBeNull()
    expect(panelBarButton(container, 'nav.favorites').getAttribute('aria-expanded')).toBe('false')
  })

  it('opens Budget and Consortium in the wider dock and every other panel at the default width', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      createDraftId: () => 'draft-planning-panel-size',
    })
    await act(async () => { render(<WebApp controller={controller} />, container) })
    await clickShellCommand(container, 'file.new')

    await act(async () => { panelBarButton(container, 'nav.budget').click() })
    expect(container.querySelector('[data-workspace-side-panel="budget"]')).not.toBeNull()
    expect(container.querySelector('[data-dock-width]')?.getAttribute('data-dock-width')).toBe('wide')

    await act(async () => { panelBarButton(container, 'nav.plantDb').click() })
    expect(container.querySelector('[data-workspace-side-panel="plant-db"]')).not.toBeNull()
    expect(container.querySelector('[data-dock-width]')?.getAttribute('data-dock-width')).toBe('default')
  })

  it('preserves the canvas across side panels and releases it for the Templates primary route', async () => {
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      createDraftId: () => 'draft-workspace-routing',
    })
    await act(async () => { render(<WebApp controller={controller} templatesEnabled />, container) })
    await clickShellCommand(container, 'file.new')
    const canvas = container.querySelector<HTMLButtonElement>('[data-testid="web-workspace-canvas"]')
    if (!canvas) throw new Error('Missing Web workspace canvas')

    await act(async () => {
      canvas.focus()
      canvas.click()
      panelBarButton(container, 'nav.calendar').click()
    })
    expect(container.querySelector('[data-testid="web-workspace-canvas"]')).toBe(canvas)
    expect(canvas.textContent).toBe('1:plant-1:125')
    expect(workspaceCanvasLifecycle.mounted).toHaveBeenCalledOnce()
    expect(workspaceCanvasLifecycle.unmounted).not.toHaveBeenCalled()

    await act(async () => { panelBarButton(container, 'nav.budget').click() })
    expect(container.querySelector('[data-testid="web-workspace-canvas"]')).toBe(canvas)
    expect(canvas.textContent).toBe('1:plant-1:125')
    expect(workspaceCanvasLifecycle.unmounted).not.toHaveBeenCalled()

    await act(async () => { panelBarButton(container, 'nav.templates').click() })
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="web-templates-workspace"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-testid="web-workspace-canvas"]')).toBeNull()
    expect(sidePanel.value).toBeNull()
    expect(workspaceCanvasLifecycle.unmounted).toHaveBeenCalledOnce()

    await act(async () => { panelBarButton(container, 'nav.canvas').click() })
    expect(container.querySelector('[data-testid="web-workspace-canvas"]')).not.toBeNull()
    expect(workspaceCanvasLifecycle.mounted).toHaveBeenCalledTimes(2)
  })

  it('keeps Location placement and address search out of browser chrome', async () => {
    await act(async () => {
      render(<BrowserAppShell commandProjection={shellCommandProjection()} />, container)
    })

    // Canopi v2 removed the Location tab: Designs are geolocated per object,
    // so the browser shell has no Location entry point and no geocoding.
    expect(panelBarCommandIds(container)).not.toContain('nav.location')
    expect(container.textContent).not.toContain('Design Location')
    expect(container.textContent).not.toContain('Search for a location')
    const emitted = container.innerHTML
    expect(emitted).not.toContain('ipc/geocoding')
    expect(emitted).not.toContain('@tauri-apps')
  })

  it('runs caller-ready shell command projections without local dispatch policy', async () => {
    const capabilities = {
      newDesign: vi.fn(),
      openCanopi: vi.fn(),
      downloadCanopi: vi.fn(),
      revertDesign: vi.fn(),
      importGeoJson: vi.fn(),
      exportGeoJson: vi.fn(),
      exportBudgetCsv: vi.fn(),
      closeDesign: vi.fn(),
      navigate: vi.fn(),
    }
    const commandProjection = projectBrowserShellForTest({
      currentPanel: 'canvas',
      currentSidePanel: null,
      downloadCanopiEnabled: true,
      revertAvailable: false,
      geoJsonEnabled: true,
      templatesEnabled: false,
      capabilities,
    })
    await act(async () => {
      render(<BrowserAppShell commandProjection={commandProjection} />, container)
    })

    await clickShellCommand(container, 'file.new')
    await clickShellCommand(container, 'file.openCanopi')
    await clickShellCommand(container, 'file.downloadCanopi')
    await clickShellCommand(container, 'file.importGeoJson')
    await clickShellCommand(container, 'file.exportGeoJson')
    await act(async () => {
      panelBarButton(container, 'nav.plantDb').click()
      panelBarButton(container, 'nav.favorites').click()
    })

    expect(capabilities.newDesign).toHaveBeenCalledOnce()
    expect(capabilities.openCanopi).toHaveBeenCalledOnce()
    expect(capabilities.downloadCanopi).toHaveBeenCalledOnce()
    expect(capabilities.importGeoJson).toHaveBeenCalledOnce()
    expect(capabilities.exportGeoJson).toHaveBeenCalledOnce()
    expect(capabilities.navigate.mock.calls).toEqual([
      ['plant-db'],
      ['favorites'],
    ])
  })

  it('persists the browser theme command through the Settings Projection', async () => {
    const persistSettings = vi.fn<(settings: Settings) => Promise<void>>().mockResolvedValue(undefined)
    installSettingsProjection({
      load: () => baseSettings(),
      save: persistSettings,
    })

    await act(async () => {
      render(<BrowserAppShell commandProjection={shellCommandProjection()} />, container)
    })
    await clickThemeControl(container)

    expect(persistSettings).toHaveBeenCalledOnce()
    expect(persistSettings).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'en',
      theme: 'dark',
    }))
  })

  it('persists the browser locale command through the Settings Projection', async () => {
    const persistSettings = vi.fn<(settings: Settings) => Promise<void>>().mockResolvedValue(undefined)
    installSettingsProjection({
      load: () => baseSettings(),
      save: persistSettings,
    })

    await act(async () => {
      render(<><BrowserAppShell commandProjection={shellCommandProjection()} /><SettingsDialog /></>, container)
    })
    await selectLocale(container, 'fr')

    expect(persistSettings).toHaveBeenCalledOnce()
    expect(persistSettings).toHaveBeenCalledWith(expect.objectContaining({
      locale: 'fr',
      theme: 'light',
    }))
  })

  it('renames the active Browser Design from the top bar like desktop', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      createDraftId: () => 'draft-rename-state',
    })

    await act(async () => {
      render(
        <WebApp
          controller={controller}
          workspace={<div data-testid="stub-workspace" />}
        />,
        container,
      )
    })
    await clickShellCommand(container, 'file.new')

    await act(async () => {
      const titleButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Rename Design: "]')
      if (!titleButton) throw new Error('Missing rename title button')
      titleButton.click()
    })
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Design name"]')
      if (!input) throw new Error('Missing rename title input')
      input.value = 'Terrace Garden'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Design name"]')
      if (!input) throw new Error('Missing rename title input')
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    expect(store.readDesignName()).toBe('Terrace Garden')
    expect(store.readCurrentDesign()?.name).toBe('Terrace Garden')
    expect(container.querySelector('button[aria-label^="Rename Design: "]')?.textContent).toBe('Terrace Garden')
    await act(async () => {
      await controller.continuousSave.flush()
    })
    expect(appDataStore.listDrafts()[0]?.name).toBe('Terrace Garden')
  })


  it('enables Download .canopi only after a Browser Design is active', async () => {
    const store = createDesignSessionStore()
    const appDataStore = createBrowserAppDataStore({ storage: memoryStorage() })
    const fileAdapter = testFileAdapter()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter,
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      createDraftId: () => 'draft-download-state',
    })

    await act(async () => {
      render(
        <WebApp
          controller={controller}
          workspace={<div data-testid="stub-workspace" />}
        />,
        container,
      )
    })

    await openCommandMenu(container, 'file.downloadCanopi')
    expect(commandButton(container, 'file.downloadCanopi').getAttribute('aria-disabled')).toBe('true')

    await clickShellCommand(container, 'file.new')

    await openCommandMenu(container, 'file.downloadCanopi')
    const download = commandButton(container, 'file.downloadCanopi')
    expect(download.getAttribute('aria-disabled')).toBeNull()

    await act(async () => {
      download.click()
    })

    expect(fileAdapter.downloadCanopiFile).toHaveBeenCalledOnce()
  })

  it('shows the active Browser Design identity and continuous-save status in the top bar', async () => {
    const store = createDesignSessionStore()
    const storage = memoryStorage()
    const appDataStore = createBrowserAppDataStore({ storage })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      createDraftId: () => 'draft-identity-state',
    })

    await act(async () => {
      render(
        <WebApp
          controller={controller}
          workspace={<div data-testid="stub-workspace" />}
        />,
        container,
      )
    })

    expect(container.querySelector('button[aria-label^="Rename Design: "]')).toBeNull()
    expect(container.querySelector('[data-save-status]')).toBeNull()

    await clickShellCommand(container, 'file.new')

    expect(container.querySelector('button[aria-label^="Rename Design: "]')?.textContent).toBe('Untitled Design')
    expect(container.querySelector('[data-save-status] [role="status"]')?.textContent).toBe('Saved in this browser')
    expect(container.querySelector('[data-save-status] button')?.textContent).toBe('Download a copy')

    storage.failWrites = true
    await act(async () => {
      editDesignSessionForTest(store, (design) => ({ ...design, description: 'Browser edit' }))
    })
    expect(container.querySelector('[data-save-status] [role="status"]')?.textContent).toBe('Saved in this browser')

    await act(async () => {
      await controller.continuousSave.flush()
    })
    const status = container.querySelector('[data-save-status]')
    expect(status?.getAttribute('data-save-status')).toBe('error')
    expect(status?.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t save')

    storage.failWrites = false
    await act(async () => {
      status?.querySelector('button')?.click()
      await Promise.resolve()
    })
    await act(async () => {
      Array.from(status?.querySelectorAll<HTMLButtonElement>('[role="dialog"] button') ?? [])
        .find((button) => button.textContent === 'Retry')?.click()
      await Promise.resolve()
    })
    await act(async () => {
      await controller.continuousSave.flush()
    })
    expect(container.querySelector('[data-save-status] [role="status"]')?.textContent).toBe('Saved in this browser')
    expect(appDataStore.loadDraft('draft-identity-state')?.description).toBe('Browser edit')
  })

  async function launchWithUnkeptDrafts(answer: Promise<boolean>) {
    const persist = vi.fn(() => answer)
    const persistence = createBrowserDraftPersistence({
      navigator: () => ({ storage: { persisted: async () => false, persist } }),
      logError: vi.fn(),
    })
    persistence.start({ hasDrafts: true })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const store = createDesignSessionStore()
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore: createBrowserAppDataStore({ storage: memoryStorage() }),
      fileAdapter: testFileAdapter(),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      createDraftId: () => 'draft-persistence-warning',
      requestDraftPersistence: () => persistence.requestOnce(),
    })
    await act(async () => {
      render(<WebApp controller={controller} persistence={persistence} workspace={<div data-testid="stub-workspace" />} />, container)
    })
    await clickShellCommand(container, 'file.new')
    return { persist }
  }

  it('2.1-Q198: with unkept Drafts New does not ask; the save-status warning opens the reason, Keep my Drafts and Download a copy', async () => {
    const { persist } = await launchWithUnkeptDrafts(Promise.resolve(false))
    expect(persist, 'New no longer asks an existing user').not.toHaveBeenCalled()

    const warning = container.querySelector<HTMLButtonElement>('[data-save-status="draft"] [data-draft-warning]')!
    expect(warning.textContent).toBe(t('webStorage.statusWarning'))
    expect(container.querySelector('[data-save-status] button.link, [data-save-status] button:not([data-draft-warning])')?.textContent).toBe('Download a copy')
    await act(async () => { warning.click() })
    expect(container.querySelector('[data-draft-warning-popover] [data-notice="draft-persistence-reason"]')?.textContent).toBe(t('webStorage.reason'))
    // P3-4: with the reason on screen, so only the Drafts-at-launch guard stops it, New still does not ask.
    await clickShellCommand(container, 'file.new')
    expect(persist, 'New does not ask an existing user, even with the reason shown').not.toHaveBeenCalled()

    if (!container.querySelector('[data-draft-warning-popover]')) {
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-draft-warning]')!.click() })
    }
    const popover = container.querySelector<HTMLElement>('[data-draft-warning-popover]')!
    expect(popover.querySelector('[data-notice="draft-persistence-reason"]')?.textContent).toBe(t('webStorage.reason'))
    const keep = Array.from(popover.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === t('webStorage.keepDrafts'))!
    await act(async () => { keep.click() })
    expect(persist, 'Keep my Drafts asks in its click').toHaveBeenCalledOnce()
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })

    // Refused (Q194): the warning stays, its popover now says what may happen and offers only Download a copy.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-draft-warning]')!.click() })
    const refused = container.querySelector<HTMLElement>('[data-draft-warning-popover]')!
    expect(refused.textContent).toContain(t('webStorage.statusDetails'))
    expect(Array.from(refused.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['Download a copy'])
    expect(persist).toHaveBeenCalledOnce()
  })

  it('2.1-Q198: granted from Keep my Drafts, the warning leaves and focus stays in the save status', async () => {
    await launchWithUnkeptDrafts(Promise.resolve(true))
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-draft-warning]')!.click() })
    const keep = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-draft-warning-popover] button')).find((button) => button.textContent === t('webStorage.keepDrafts'))!
    await act(async () => { keep.click() })
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
    expect(container.querySelector('[data-draft-warning]')).toBeNull()
    expect(container.querySelector('[data-save-status] [role="status"]')?.textContent).toBe('Saved in this browser')
    expect(document.activeElement?.closest('[data-save-status]'), 'focus did not drop to the page').not.toBeNull()
  })

  it('Retry writes the Draft again after a failed write even when an undo left nothing pending', async () => {
    const store = createDesignSessionStore()
    const storage = memoryStorage()
    const appDataStore = createBrowserAppDataStore({ storage })
    const controller = createBrowserDesignSessionController({
      store,
      appDataStore,
      fileAdapter: testFileAdapter(),
      now: () => new Date('2026-07-04T12:00:00.000Z'),
      createDraftId: () => 'draft-retry-clean',
    })
    await act(async () => {
      render(<WebApp controller={controller} workspace={<div data-testid="stub-workspace" />} />, container)
    })
    await clickShellCommand(container, 'file.new')

    storage.failWrites = true
    await act(async () => {
      store.setCanvasClean(false)
      await controller.continuousSave.flush()
    })
    const status = container.querySelector('[data-save-status]')
    expect(status?.getAttribute('data-save-status')).toBe('error')

    // Undo back to the clean point: nothing is pending, but the error stays until a write lands.
    storage.failWrites = false
    await act(async () => { store.setCanvasClean(true) })
    expect(container.querySelector('[data-save-status]')?.getAttribute('data-save-status')).toBe('error')

    await act(async () => {
      status?.querySelector('button')?.click()
      await Promise.resolve()
    })
    await act(async () => {
      Array.from(status?.querySelectorAll<HTMLButtonElement>('[role="dialog"] button') ?? [])
        .find((button) => button.textContent === 'Retry')?.click()
      await Promise.resolve()
    })
    await act(async () => { await controller.continuousSave.flush() })
    expect(container.querySelector('[data-save-status] [role="status"]')?.textContent).toBe('Saved in this browser')
  })
  it('offers Resolve… when another browser tab changed the open Draft', async () => {
    const onResolveSaveConflict = vi.fn()
    await act(async () => {
      render(
        <BrowserAppShell
          commandProjection={shellCommandProjection()}
          designIdentity={{ name: 'Orchard', saveStatus: 'conflict', saveFailureReason: null }}
          onResolveSaveConflict={onResolveSaveConflict}
        />,
        container,
      )
    })
    const status = container.querySelector<HTMLElement>('[data-save-status="conflict"]')!
    expect(status.querySelector('[role="alert"]')?.textContent).toBe('Changed in another tab')
    await act(async () => { status.querySelector('button')!.click() })
    expect(onResolveSaveConflict).toHaveBeenCalledOnce()
  })

  describe('on a phone', () => {
    const size = { width: window.innerWidth, height: window.innerHeight }
    const resizeTo = (width: number, height: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
      window.dispatchEvent(new Event('resize'))
    }

    afterEach(() => {
      resizeTo(size.width, size.height)
    })

    it('turns the title bar into the 44 px top bar with Undo and a place search card, and drops the rail', async () => {
      const undo = vi.fn()
      resizeTo(390, 844)
      await act(async () => {
        render(
          <BrowserAppShell
            commandProjection={shellCommandProjection()}
            designIdentity={{ name: 'Orchard', saveStatus: 'draft', saveFailureReason: null }}
            placeSearch
            undo={{ label: 'Undo', shortcut: 'Ctrl Z', ariaShortcut: 'Control+Z', disabled: false, action: undo }}
          />,
          container,
        )
      })
      const shell = container.querySelector<HTMLElement>('[data-testid="browser-app-shell"]')!
      expect(shell.dataset.phoneLayout).toBe('portrait')
      expect(container.querySelector('[data-panel-rail]')).toBeNull()
      expect(container.querySelector('[role="combobox"]')).toBeNull()

      const undoButton = container.querySelector<HTMLButtonElement>('button[data-phone-undo]')!
      expect(undoButton.getAttribute('aria-label')).toBe('Undo')
      await act(async () => { undoButton.click() })
      expect(undo).toHaveBeenCalledTimes(1)

      const search = container.querySelector<HTMLButtonElement>('button[data-phone-search]')!
      expect(search.getAttribute('aria-label')).toBe('Search a place')
      expect(search.getAttribute('aria-expanded')).toBe('false')
      await act(async () => { search.click() })
      const card = container.querySelector<HTMLElement>('[data-phone-search-card]')!
      expect(card.getAttribute('role')).toBe('search')
      expect(card.querySelector('[role="combobox"]')).not.toBeNull()
      expect(search.getAttribute('aria-expanded')).toBe('true')
      await act(async () => {
        card.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      expect(container.querySelector('[data-phone-search-card]')).toBeNull()
      expect(document.activeElement).toBe(search)

      // Back closes it too.
      await act(async () => { search.click() })
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-phone-search-card] button[aria-label="Back to the map"]')!.click()
      })
      expect(container.querySelector('[data-phone-search-card]')).toBeNull()

      // Search a place (Ctrl K) opens the card where no field waits in the bar.
      await act(async () => { requestPlaceSearchFocus() })
      expect(container.querySelector('[data-phone-search-card]')).not.toBeNull()

      await act(async () => { resizeTo(1280, 800) })
      expect(shell.dataset.phoneLayout).toBeUndefined()
      expect(container.querySelector('[data-panel-rail]')).not.toBeNull()
      expect(container.querySelector('[data-phone-search-card]')).toBeNull()
      expect(container.querySelector('button[data-phone-undo]')).toBeNull()
      expect(container.querySelector('[role="combobox"]')).not.toBeNull()
    })

    it('uses the side layout when the phone lies on its side, and the desktop layout again once released', async () => {
      resizeTo(844, 390)
      await act(async () => {
        render(<BrowserAppShell commandProjection={shellCommandProjection()} />, container)
      })
      expect(container.querySelector<HTMLElement>('[data-testid="browser-app-shell"]')!.dataset.phoneLayout).toBe('landscape')
      expect(container.querySelector('button[data-phone-search]')).toBeNull()
      await act(async () => { render(null, container) })
      expect(phoneLayout.value).toBeNull()
    })
  })
})

async function clickShellCommand(container: HTMLElement, id: string): Promise<void> {
  await openCommandMenu(container, id)
  if (id === 'file.exportGeoJson' || id === 'file.exportCanvasPdf') await openExportSubmenu(container)
  await act(async () => {
    commandButton(container, id).click()
  })
}

async function openCommandMenu(container: HTMLElement, id: string): Promise<void> {
  await act(async () => {
    ensureCommandMenuOpen(container, id)
  })
}

function ensureCommandMenuOpen(container: HTMLElement, id: string): void {
  const menuId = menuIdForCommand(id)
  if (!menuId) return
  const trigger = menuTrigger(container, menuId)
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    trigger.click()
  }
}

/** Export ▸ items live in a submenu; hovering its parent opens it. */
async function openExportSubmenu(container: HTMLElement): Promise<void> {
  await act(async () => {
    container.querySelector('[data-submenu-id="submenu.export"]')!
      .parentElement!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
  })
}

function menuIdForCommand(id: string): string | null {
  if (id.startsWith('file.') || id === 'app.settings') return 'file'
  if (id.startsWith('view.')) return 'view'
  return null
}

async function clickThemeControl(container: HTMLElement): Promise<void> {
  await clickShellCommand(container, 'view.toggleTheme')
}

async function selectLocale(container: HTMLElement, code: string): Promise<void> {
  const names: Record<string, string> = { fr: 'Français', en: 'English' }
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Settings…"]')!.click()
  })
  await act(async () => {
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((button) => button.getAttribute('aria-haspopup') === 'listbox')!.click()
  })
  const option = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    .find((button) => button.textContent === names[code])
  if (!option) throw new Error(`Missing locale option ${code}`)
  await act(async () => {
    option.click()
  })
}

function commandButton(container: HTMLElement, id: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-menu-popup="root"] [data-command-id="${id}"]`)
  if (!button) throw new Error(`Missing command ${id}`)
  return button
}

function menuTrigger(container: HTMLElement, id: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-menu-id="${id}"]`)
  if (!button) throw new Error(`Missing menu ${id}`)
  return button
}

function openMenuCommandIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-menu-popup="root"] [data-menu-root-item][data-command-id]'))
    .map((element) => element.dataset.commandId ?? '')
}

interface MemoryStorage extends BrowserStorageAdapter {
  failWrites: boolean
}

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>()
  return {
    failWrites: false,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (this.failWrites) throw new Error('storage unavailable')
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

function testFileAdapter(): BrowserDesignFileAdapter {
  return {
    openCanopiFile: vi.fn(async () => null),
    downloadCanopiFile: vi.fn(async () => undefined),
  }
}
