// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../app/lidar/library-store', async () => ({
  ...(await vi.importActual<typeof LibraryStoreModule>('../app/lidar/library-store')),
  installLidarLibraryObserver: () => () => {},
}))

import { LayersPanel as LayerPanel } from '../components/panels/LayersPanel'
import { openLayerRow } from '../app/canvas-layer-presentation/open-row'
import { lidarLibrary } from '../app/lidar/library-store'
import type { CanopiFile } from '../types/design'
import { librarySnapshot, sourceItem } from './support/library-fixtures'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { googleMapsApiKey, locale } from '../app/settings/state'
import type { Settings } from '../types/settings'
import {
  currentDesign,
  designSessionFixture,
} from './support/design-session-state'
import { activePanel, sidePanel } from '../app/shell/state'
import {
  flushSettingsProjection,
  installSettingsProjection,
  resetSettingsProjectionForTests,
} from '../app/settings/projection'
import { setCurrentCanvasSession } from '../canvas/session'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'
import { dropdownTrigger } from './support/dropdown-trigger'
import type * as LibraryStoreModule from '../app/lidar/library-store'

function baseSettings(): Settings {
  return {
    locale: 'en',
    theme: 'light',
    snap_to_grid: true,
    side_panel_width: null,
    saved_stamps_frame_height: 220,
    basemap_style: 'liberty',
    basemap_visible: true,
    basemap_opacity: 1,
    satellite_visible: false,
    satellite_opacity: 1,
    google_maps_api_key: null,
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
  }
}

describe('LayerPanel', () => {
  let container: HTMLDivElement

  /** A row's name button, which opens and closes the row. */
  function nameButton(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'))
      .find((button) => button.textContent?.startsWith(label))
    if (!found) throw new Error(`no row ${label}`)
    return found
  }

  /** The summary row's name area, which runs Site data's panel command. */
  function siteDataName(): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button:not([aria-label])'))
      .find((button) => button.textContent?.startsWith('Site data'))
    if (!found) throw new Error('no Site data row')
    return found
  }
  const saveSettings = vi.fn(async (_settings: Settings): Promise<void> => {})

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    saveSettings.mockReset().mockResolvedValue(undefined)
    resetSettingsProjectionForTests()
    designSessionFixture.file = {
      version: 9,
      name: 'Demo',
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
      created_at: '2026-04-12T00:00:00.000Z',
      updated_at: '2026-04-12T00:00:00.000Z',
      extra: {},
    }
    openLayerRow.value = null
    lidarLibrary.value = null
    mapLayers.value = createDefaultMapLayers()
    googleMapsApiKey.value = null
    activePanel.value = 'canvas'
    sidePanel.value = 'favorites'
    installSettingsProjection({
      load: () => baseSettings(),
      save: saveSettings,
    })
    setCurrentCanvasSession(null)
    activePanel.value = 'canvas'
    sidePanel.value = null
  })

  afterEach(() => {
    flushSettingsProjection()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    render(null, container)
    container.remove()
    setCurrentCanvasSession(null)
    resetSettingsProjectionForTests()
  })

  it('chooses the background as Satellite, Street map or None and persists it', async () => {
    await act(async () => {
      render(<LayerPanel />, container)
    })

    const group = container.querySelector('[role="radiogroup"][aria-labelledby="layers-background"]')!
    const radio = (label: string) => Array.from(group.querySelectorAll('label'))
      .find((option) => option.textContent?.startsWith(label))!.querySelector('input')!
    expect(Array.from(group.querySelectorAll('label')).map((option) => option.textContent))
      .toEqual(['SatelliteGoogle', 'Street mapOpenFreeMap', 'NonePlain paper'])
    expect(radio('Street map').checked).toBe(true)
    // The rows show how many layers there are; the header carries no bare count.
    expect(container.querySelector('header')?.textContent).not.toMatch(/\d/)
    expect(container.querySelector('input[aria-label="Opacity: Street map"]')).toBeTruthy()
    // Background has no eye toggles: it is one choice.
    expect(container.querySelector('button[aria-label="Hide Street map"]')).toBeNull()

    await act(async () => { radio('None').click() })
    expect(mapLayers.value.basemap.visible).toBe(false)
    expect(mapLayers.value.satellite.visible).toBe(false)
    expect(radio('None').checked).toBe(true)
    expect(container.querySelector('input[aria-label="Opacity: Street map"]')).toBeNull()
    await Promise.resolve()
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ basemap_visible: false }))

    await act(async () => { radio('Satellite').click() })
    expect(mapLayers.value.satellite.visible).toBe(true)
    expect(container.querySelector('input[aria-label="Opacity: Satellite"]')).toBeTruthy()

    await act(async () => { radio('Street map').click() })
    expect(mapLayers.value.satellite.visible).toBe(false)
    expect(mapLayers.value.basemap.visible).toBe(true)
  })

  it('keeps opacity and Soften background with the chosen background', async () => {
    await act(async () => {
      render(<LayerPanel />, container)
    })
    const soften = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[role="switch"]'))
      .find((input) => input.closest('label')?.textContent?.includes('Soften background'))

    expect(soften()?.checked).toBe(false)
    await act(async () => { soften()?.click() })
    expect(mapLayers.value.softenBackground).toBe(true)

    // Satellite keeps the Map choice underneath and shows its own settings.
    const satellite = Array.from(container.querySelectorAll('label'))
      .find((option) => option.textContent?.startsWith('Satellite'))!.querySelector('input')!
    await act(async () => { satellite.click() })
    expect(mapLayers.value.basemap.visible).toBe(true)
    expect(soften()?.checked).toBe(true)
    expect(container.querySelector('input[type="password"]')).toBeTruthy()

    // Opening a row elsewhere keeps the chosen background's settings in view.
    await act(async () => { nameButton('Plants').click() })
    expect(soften()).toBeTruthy()
  })

  it('updates mounted Layer chrome when only the locale changes', async () => {
    await act(async () => {
      render(<LayerPanel />, container)
    })

    expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('Layers')
    expect(container.textContent).toContain('Plain paper')

    await act(async () => {
      locale.value = 'fr'
    })

    expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('Calques')
    expect(container.textContent).toContain('Papier uni')
  })

  it('chooses the Basemap style from the Basemap row and persists it', async () => {
    await act(async () => {
      render(<LayerPanel />, container)
    })

    const styleTrigger = dropdownTrigger(container, 'Style')
    expect(styleTrigger?.textContent).toContain('Liberty')
    await act(async () => {
      styleTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    expect(options.map((option) => option.textContent)).toEqual(['Liberty', 'Positron', 'Bright', 'Dark'])

    await act(async () => {
      options.find((option) => option.textContent === 'Positron')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mapLayers.value.basemap.style).toBe('positron')
    await Promise.resolve()
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ basemap_style: 'positron' }))
  })

  it('shows the optional Google key field without any imagery choice', async () => {
    await act(async () => {
      mapLayers.value = { ...createDefaultMapLayers(), satellite: { visible: true, opacity: 1 } }
      render(<LayerPanel />, container)
    })

    expect(container.querySelector('button[aria-label="Imagery"]')).toBeNull()
    expect(container.querySelector('[role="listbox"], [role="option"]')).toBeNull()
    expect(container.querySelector('input[type="password"]')).toBeTruthy()
    expect(container.textContent).toContain('Google Maps API key')
    expect(container.textContent).toContain("Without a key, Canopi uses Google's public satellite tiles.")
    expect(container.querySelector('input[aria-label="Opacity: Satellite"]')).toBeTruthy()
  })

  it('saves the Google key trimmed without echoing it and clears it', async () => {
    await act(async () => {
      mapLayers.value = { ...createDefaultMapLayers(), satellite: { visible: true, opacity: 1 } }
      render(<LayerPanel />, container)
    })

    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')
    expect(keyInput).toBeTruthy()
    await act(async () => {
      if (!keyInput) return
      keyInput.value = '  device-key  '
      keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(googleMapsApiKey.value).toBe('device-key')
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('')
    expect(container.textContent).not.toContain('device-key')
    expect(container.textContent).not.toContain("Without a key, Canopi uses Google's public satellite tiles.")
    expect(container.textContent).toContain('Key saved on this device.')
    await Promise.resolve()
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      google_maps_api_key: 'device-key',
    }))
    expect(saveSettings.mock.lastCall?.[0]).not.toHaveProperty('satellite_provider')

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Clear key')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(googleMapsApiKey.value).toBeNull()
    expect(container.textContent).toContain("Without a key, Canopi uses Google's public satellite tiles.")
  })

  it('shows map layer detail controls without a Design Location action', async () => {
    await act(async () => {
      render(<LayerPanel />, container)
    })

    const hasLocationButton = () => Array.from(container.querySelectorAll('button'))
      .some((button) => button.textContent === 'Design Location')
    expect(hasLocationButton()).toBe(false)
    expect(container.querySelector('input[aria-label="Opacity: Street map"]')).toBeTruthy()

    await act(async () => { nameButton('Contour lines').click() })

    expect(hasLocationButton()).toBe(false)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Contour interval"]')).toBeTruthy()

    await act(async () => { nameButton('Hillshading').click() })

    expect(hasLocationButton()).toBe(false)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Opacity: Hillshading"]')).toBeTruthy()
  })

  it('exposes scene Layer lock controls through Canvas Layer Presentation', async () => {
    const layerCommands = {
      setSceneLayerVisibility: vi.fn(() => true),
      setSceneLayerOpacity: vi.fn(() => true),
      setSceneLayerLocked: vi.fn(() => true),
      presentLayers: vi.fn(),
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ layers: layerCommands }),
      queries: createTestCanvasQuerySurface({
        scene: {
          plantSpeciesColors: {},
          plantSpeciesSymbols: {},
    plantSpeciesCodes: {},
          layers: [
            { kind: 'layer', name: 'annotations', visible: true, locked: false, opacity: 1 },
            { kind: 'layer', name: 'plants', visible: true, locked: true, opacity: 1 },
            { kind: 'layer', name: 'zones', visible: true, locked: false, opacity: 1 },
          ],
          plants: [],
          zones: [],
          annotations: [],
          measurementGuides: [],
          groups: [],
        },
      }),
    }))

    await act(async () => {
      render(<LayerPanel />, container)
    })

    const plantsLock = Array.from(container.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === 'Unlock layer: Plants')
    expect(plantsLock).toBeTruthy()
    expect(plantsLock?.getAttribute('aria-pressed')).toBe('true')

    const basemapLock = Array.from(container.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label')?.includes('layer: Basemap'))
    expect(basemapLock).toBeUndefined()

    await act(async () => {
      plantsLock?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(layerCommands.setSceneLayerLocked).toHaveBeenCalledWith('plants', false)
  })

  it('lists the Design, the Site data summary and the Map with its Background, and has no footer', async () => {
    await act(async () => {
      render(<LayerPanel />, container)
    })
    const sections = Array.from(container.querySelectorAll('section h3')).map((heading) => heading.textContent)
    expect(sections).toEqual(['Design', 'Map'])
    expect(container.textContent).toContain('Site data')
    const map = container.querySelector('section[aria-labelledby="layers-map"]')!
    // Contour lines and hillshading say which elevation they come from, then the background is chosen.
    expect(map.textContent).toContain('Contour lines')
    expect(map.textContent).toContain('from online elevation · spacing follows zoom')
    expect(map.textContent).toContain('Hillshading')
    expect(map.textContent).not.toContain('Online elevation')
    expect(map.querySelector('h4')?.textContent).toBe('Background')
    expect(Array.from(map.querySelectorAll('input[type="radio"]')).map((input) => (input as HTMLInputElement).value))
      .toEqual(['satellite', 'basemap', 'none'])
    // Nothing replaces the list: no footer, no inspector heading, no Add data.
    expect(container.textContent).not.toMatch(/Visible ·|Hidden ·/)
    expect(container.querySelector('button[aria-haspopup="menu"]')).toBeNull()
  })

  it('names every eye Hide or Show with the row, and opens one row at a time', async () => {
    await act(async () => {
      render(<LayerPanel />, container)
    })
    expect(container.querySelector('button[aria-label="Hide Zones"]')).toBeTruthy()
    expect(container.querySelector('button[aria-label="Show Contour lines"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Toggle visibility')
    // Nothing is open at start.
    expect(container.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0)
    expect(container.querySelector('input[aria-label="Opacity: Zones"]')).toBeNull()

    await act(async () => { nameButton('Zones').click() })
    expect(nameButton('Zones').getAttribute('aria-expanded')).toBe('true')
    const zones = nameButton('Zones').closest('[role="listitem"]')!
    expect(zones.querySelector('input[aria-label="Opacity: Zones"]')).toBeTruthy()

    await act(async () => { nameButton('Plants').click() })
    expect(nameButton('Zones').getAttribute('aria-expanded')).toBe('false')
    expect(nameButton('Plants').getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('input[aria-label="Opacity: Zones"]')).toBeNull()

    // A second click closes the open row.
    await act(async () => { nameButton('Plants').click() })
    expect(container.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0)
  })

  it('always shows the chosen background\'s settings, and none for None', async () => {
    await act(async () => {
      render(<LayerPanel />, container)
    })
    await act(async () => { nameButton('Zones').click() })
    expect(dropdownTrigger(container, 'Style')).toBeTruthy()
    expect(container.querySelector('input[aria-label="Opacity: Street map"]')).toBeTruthy()
    const radio = (value: string) => container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!
    await act(async () => { radio('satellite').click() })
    expect(container.querySelector('input[type="password"]')).toBeTruthy()
    expect(container.querySelector('input[aria-label="Opacity: Satellite"]')).toBeTruthy()
    await act(async () => { radio('none').click() })
    expect(container.querySelector('input[aria-label^="Opacity: S"]')).toBeNull()
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  describe('the Site data summary row (Desktop)', () => {
    function entry(id: string, name: string, visible: boolean, order: number) {
      return { kind: 'Source' as const, id, name, visible, opacity: 1, order, ramp: null, reversed: false, range: null }
    }

    function withSiteData(entries: ReturnType<typeof entry>[], visible = true): void {
      designSessionFixture.file = { ...currentDesign.value!, lidar: { visible, entries } } as CanopiFile
    }

    const threeEntries = () => [entry('a', 'Ground', true, 0), entry('b', 'Surface', true, 1), entry('c', 'Canopy', false, 2)]

    it('says how many entries are shown, and its eye hides all site data and leaves the row eyes', async () => {
      withSiteData(threeEntries())
      lidarLibrary.value = librarySnapshot([sourceItem('a', 'Ground'), sourceItem('b', 'Surface'), sourceItem('c', 'Canopy')])
      await act(async () => {
        render(<LayerPanel />, container)
      })
      expect(container.textContent).toContain('2 of 3 shown')
      const eye = container.querySelector<HTMLButtonElement>('button[aria-label="Hide Site data"]')!
      expect(eye.getAttribute('aria-pressed')).toBe('true')
      await act(async () => { eye.click() })
      expect(currentDesign.value?.lidar?.visible).toBe(false)
      expect(currentDesign.value?.lidar?.entries.map((item) => item.visible)).toEqual([true, true, false])
      expect(container.textContent).toContain('0 of 3 shown')
      await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Show Site data"]')!.click() })
      expect(currentDesign.value?.lidar?.visible).toBe(true)
      expect(container.textContent).toContain('2 of 3 shown')
    })

    it('counts entries by their own eye while the library is still loading, and leaves missing entries out', async () => {
      withSiteData(threeEntries())
      await act(async () => {
        render(<LayerPanel />, container)
      })
      expect(container.textContent).toContain('2 of 3 shown')
      // Loaded: the library has no Surface, so it is missing and not shown.
      await act(async () => {
        lidarLibrary.value = librarySnapshot([sourceItem('a', 'Ground'), sourceItem('c', 'Canopy')])
      })
      expect(container.textContent).toContain('1 of 3 shown')
    })

    it('opens Site data from its name and from Open Site data', async () => {
      withSiteData(threeEntries())
      sidePanel.value = 'layers'
      await act(async () => {
        render(<LayerPanel />, container)
      })
      await act(async () => { siteDataName().click() })
      expect(sidePanel.value).toBe('site-data')
      sidePanel.value = 'layers'
      await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Open Site data"]')!.click() })
      expect(sidePanel.value).toBe('site-data')
    })

    it('reads None yet with no eye when the Design has no site data, and still opens the panel', async () => {
      sidePanel.value = 'layers'
      await act(async () => {
        render(<LayerPanel />, container)
      })
      expect(container.textContent).toContain('None yet')
      expect(container.querySelector('button[aria-label="Hide Site data"]')).toBeNull()
      await act(async () => { siteDataName().click() })
      expect(sidePanel.value).toBe('site-data')
    })
  })

  it('exposes terrain controls without coupling them to the basemap toggle', async () => {
    await act(async () => {
      render(<LayerPanel />, container)
    })

    // Toggle contours visibility via eye button
    const contourToggle = Array.from(container.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === 'Show Contour lines')
    expect(contourToggle).toBeTruthy()

    await act(async () => {
      contourToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mapLayers.value.contours.visible).toBe(true)
    expect(mapLayers.value.basemap.visible).toBe(true)

    // Click the contours name to make it active and reveal controls
    const contourName = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.startsWith('Contour lines'))
    expect(contourName).toBeTruthy()
    await act(async () => {
      contourName?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const contourSlider = container.querySelector<HTMLInputElement>('input[aria-label="Contour interval"]')
    expect(contourSlider).toBeTruthy()
    await act(async () => {
      if (!contourSlider) return
      contourSlider.value = '25'
      contourSlider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(mapLayers.value.contours.intervalMeters).toBe(25)
    expect(container.textContent).toContain('from online elevation · every 25 m')
    vi.runAllTimers()
    await Promise.resolve()
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      contour_visible: true,
      contour_interval: 25,
    }))

    // Toggle hillshade visibility
    const hillshadeToggle = Array.from(container.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === 'Show Hillshading')
    expect(hillshadeToggle).toBeTruthy()
    await act(async () => {
      hillshadeToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mapLayers.value.hillshade.visible).toBe(true)

    // Click hillshading name to make it active and reveal controls
    const hillshadeName = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.startsWith('Hillshading'))
    expect(hillshadeName).toBeTruthy()
    await act(async () => {
      hillshadeName?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const hillshadeSlider = container.querySelector<HTMLInputElement>('input[aria-label="Opacity: Hillshading"]')
    expect(hillshadeSlider).toBeTruthy()
    await act(async () => {
      if (!hillshadeSlider) return
      hillshadeSlider.value = '30'
      hillshadeSlider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(mapLayers.value.hillshade.opacity).toBe(0.3)
    vi.runAllTimers()
    await Promise.resolve()
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      hillshade_visible: true,
      hillshade_opacity: 0.3,
    }))
  })
})
