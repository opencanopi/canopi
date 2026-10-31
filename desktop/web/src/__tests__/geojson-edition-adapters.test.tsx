// @vitest-environment jsdom

import { projectBrowserShellForTest } from './support/browser-shell-projection'
import { flattenMenuActions } from '../app/shell-commands/menus'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  message: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: tauri.message }))

import { desktopGeoJsonFiles } from '../ipc/geojson'
import { presentDesktopGeoJsonNotice } from '../platform/geojson.desktop'
import { browserGeoJsonFiles } from '../web/browser-geojson'
import {
  browserShellNotice,
  dismissBrowserShellNotice,
  showBrowserShellNotice,
} from '../web/browser-shell-notice'
import { BrowserAppShell } from '../web/BrowserAppShell'
import { appCommandGraphChromeProjection } from '../commands/registry'
import { setCurrentCanvasSession } from '../canvas/session'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { designSessionFixture } from './support/design-session-state'
import type { CanopiFile } from '../types/design'

function emptyDesign(): CanopiFile {
  return {
    version: 9,
    name: 'Adapters',
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
    created_at: '',
    updated_at: '',
    extra: {},
  }
}

beforeEach(() => {
  for (const mock of Object.values(tauri)) mock.mockReset()
})

afterEach(() => {
  setCurrentCanvasSession(null)
  designSessionFixture.file = null
  dismissBrowserShellNotice()
  vi.restoreAllMocks()
})

describe('Desktop GeoJSON file adapter', () => {
  it('lets the native side pick and read the file, so the page never names a path', async () => {
    const source = { name: 'beds.geojson', text: '{"type":"FeatureCollection","features":[]}' }
    tauri.invoke.mockResolvedValue(source)

    await expect(desktopGeoJsonFiles.pickGeoJsonFile()).resolves.toEqual(source)
    expect(tauri.invoke.mock.calls).toEqual([['pick_geojson_file']])
  })

  it('returns null when the native open dialog is cancelled', async () => {
    tauri.invoke.mockResolvedValue(null)

    await expect(desktopGeoJsonFiles.pickGeoJsonFile()).resolves.toBeNull()
  })

  it('writes through the text export command at the path the host GeoJSON Save dialog chose', async () => {
    tauri.invoke
      .mockResolvedValueOnce({ kind: 'picked', path: '/tmp/site.geojson' })
      .mockResolvedValueOnce('/tmp/site.geojson')
      .mockResolvedValueOnce({ kind: 'cancelled' })

    await expect(desktopGeoJsonFiles.writeGeoJsonFile('{}', 'Site.geojson')).resolves.toBe('written')
    await expect(desktopGeoJsonFiles.writeGeoJsonFile('{}', 'Site.geojson')).resolves.toBe('cancelled')

    expect(tauri.invoke.mock.calls).toEqual([
      ['pick_save', { kind: 'geojson-export', stem: 'Site.geojson' }],
      ['export_file', { data: '{}', path: '/tmp/site.geojson' }],
      ['pick_save', { kind: 'geojson-export', stem: 'Site.geojson' }],
    ])
  })

  it('presents notices through the native message dialog', async () => {
    await presentDesktopGeoJsonNotice({ tone: 'error', title: 'GeoJSON import', message: 'Bad file' })

    expect(tauri.message).toHaveBeenCalledWith('Bad file', { title: 'GeoJSON import', kind: 'error' })
  })
})

describe('Desktop App Command Graph GeoJSON commands', () => {
  it('lists GeoJSON import and export in the File menu, enabled with a mounted Design', () => {
    const fileMenuIds = () => flattenMenuActions([appCommandGraphChromeProjection.value.menus
      .find((menu) => menu.id === 'file')!])
      .map((entry) => ({ id: entry.id, disabled: entry.disabled }))
      .filter((entry) => entry.id.includes('GeoJson'))

    expect(fileMenuIds()).toEqual([
      { id: 'file.importGeoJson', disabled: true },
      { id: 'file.exportGeoJson', disabled: true },
    ])

    designSessionFixture.file = emptyDesign()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces())

    expect(fileMenuIds()).toEqual([
      { id: 'file.importGeoJson', disabled: false },
      { id: 'file.exportGeoJson', disabled: false },
    ])
  })

  it('opens the native picker of the shared workflow and imports nothing when it is cancelled', async () => {
    designSessionFixture.file = emptyDesign()
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces())
    tauri.invoke.mockResolvedValue(null)

    appCommandGraphChromeProjection.value.paletteCommands
      .find((command) => command.id === 'file.importGeoJson')!
      .action()
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledOnce())
    expect(tauri.invoke).toHaveBeenCalledWith('pick_geojson_file')
  })
})

describe('Web GeoJSON file adapter and notice', () => {
  it('downloads GeoJSON with its media type and file name', async () => {
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as Blob)
      return 'blob:geojson'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this)
    })

    await expect(browserGeoJsonFiles.writeGeoJsonFile('{"type":"FeatureCollection"}', 'Site.geojson'))
      .resolves.toBe('written')

    expect(clicked[0]!.download).toBe('Site.geojson')
    expect(created[0]!.type).toBe('application/geo+json')
    await expect(created[0]!.text()).resolves.toBe('{"type":"FeatureCollection"}')
  })

  it('reads a picked file through the browser picker', async () => {
    let input: HTMLInputElement | null = null
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      input = this
      const file = new File(['{"type":"Feature"}'], 'site.geojson', { type: 'application/geo+json' })
      Object.defineProperty(this, 'files', { value: [file] })
      this.dispatchEvent(new Event('change'))
    })

    await expect(browserGeoJsonFiles.pickGeoJsonFile()).resolves.toEqual({
      name: 'site.geojson',
      text: '{"type":"Feature"}',
    })
    expect(input!.accept).toBe('.geojson,.json,application/geo+json,application/json')
  })

  it('shows and dismisses the shell notice', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const projection = projectBrowserShellForTest({
      currentPanel: 'canvas',
      currentSidePanel: null,
      downloadCanopiEnabled: true,
      revertAvailable: false,
      geoJsonEnabled: true,
      templatesEnabled: false,
      capabilities: {
        newDesign: () => undefined,
        openCanopi: () => undefined,
        downloadCanopi: () => undefined,
        revertDesign: () => undefined,
        importGeoJson: () => undefined,
        exportGeoJson: () => undefined,
        exportBudgetCsv: () => undefined,
        closeDesign: () => undefined,
        navigate: () => undefined,
      },
    })

    try {
      await act(async () => {
        render(<BrowserAppShell commandProjection={projection} />, container)
      })
      expect(container.querySelector('[data-web-shell-notice]')).toBeNull()

      await act(async () => {
        showBrowserShellNotice({ tone: 'error', title: 'GeoJSON import', message: 'Feature 2 has invalid geometry.' })
      })
      const notice = container.querySelector<HTMLElement>('[data-web-shell-notice]')!
      expect(notice.getAttribute('role')).toBe('alert')
      expect(notice.textContent).toContain('Feature 2 has invalid geometry.')
      // Its own row below the title bar: the rail, the dock and the chips start below it.
      const shell = container.querySelector<HTMLElement>('[data-testid="browser-app-shell"]')!
      expect(notice.parentElement).toBe(shell)
      expect(shell.style.getPropertyValue('--chrome-rail-top')).toMatch(/^calc\(\d+px \+ var\(--space-2\)\)$/)

      await act(async () => {
        notice.querySelector('button')!.click()
      })
      expect(browserShellNotice.value).toBeNull()
      expect(container.querySelector('[data-web-shell-notice]')).toBeNull()
      expect(container.querySelector<HTMLElement>('[data-testid="browser-app-shell"]')!.style.getPropertyValue('--chrome-rail-top')).toBe('')
    } finally {
      render(null, container)
      container.remove()
    }
  })
})
