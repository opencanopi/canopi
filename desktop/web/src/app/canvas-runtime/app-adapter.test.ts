// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CanvasRuntimePresentationDataAdapter,
  CanvasRuntimeSavedObjectStampAdapter,
} from '../../canvas/runtime/app-adapter'
import { CanvasPlantLabelResolver } from '../../canvas/runtime/plant-labels'
import { CanvasSpeciesCache } from './species-cache'
import { t } from '../../i18n'
import type { Settings } from '../../types/settings'
import { gridVisible } from '../canvas-settings/signals'
import { composeDocumentForSave } from '../contracts/document'
import { createTestSessionCore } from '../../__tests__/support/session-core-fixture'
import type { CanopiFile } from '../../types/design'
import {
  installSettingsProjection,
  resetSettingsProjectionForTests,
} from '../settings/projection'
import {
  locale,
  theme,
  createDefaultMapLayersForTests as createDefaultMapLayers,
  mapLayers,
  type MapLayersState,
} from '../settings/state'
import { createAppCanvasRuntimeAppAdapter } from './app-adapter'
import { createDesktopCanvasRuntimeAppAdapter } from './desktop-adapter'

describe('Canvas Runtime app adapter composition', () => {
  const persistSettings = vi.fn<(settings: Settings) => Promise<void>>()

  beforeEach(() => {
    persistSettings.mockReset().mockResolvedValue(undefined)
    installSettingsProjection({
      load: () => baseSettings(),
      save: persistSettings,
    })
    resetGrid()
  })

  afterEach(() => {
    resetSettingsProjectionForTests()
    resetGrid()
  })

  it('preserves the edition capabilities supplied by its composition root', () => {
    const presentationData: CanvasRuntimePresentationDataAdapter = {}
    const savedObjectStamps: CanvasRuntimeSavedObjectStampAdapter = {
      saveCurrentSelection: vi.fn(),
    }

    const adapter = createAppCanvasRuntimeAppAdapter({
      presentationData,
      savedObjectStamps,
    })

    expect(adapter.presentationData).toBe(presentationData)
    expect(adapter.savedObjectStamps).toBe(savedObjectStamps)
  })

  it('does not manufacture an optional capability that the edition omits', () => {
    const adapter = createAppCanvasRuntimeAppAdapter({
      presentationData: {},
    })

    expect(adapter.savedObjectStamps).toBeUndefined()
  })

  it('delegates sceneSession history, document composition, and translation to app authorities', () => {
    const session = createTestSessionCore({ file: { version: 9, name: 'Orchard', plants: [] } as unknown as CanopiFile })
    try {
      const adapter = createAdapter()

      expect(adapter.sceneSession?.canUndo.value).toBe(false)
      adapter.sceneSession?.recordSceneEdit('move', { type: 'move', before: {}, after: {} })
      expect(adapter.sceneSession?.canUndo.value).toBe(true)
      expect(session.core.dirty.value).toBe(true)
      expect(adapter.document.composeDocumentForSave).toBe(composeDocumentForSave)
      expect(adapter.translate).toBe(t)
    } finally {
      session.dispose()
    }
  })

  it('persists Plant Spacing interval commits immediately', () => {
    const adapter = createAdapter()

    adapter.settings.commitPlantSpacingIntervalMeters(0.75)

    expect(persistSettings).toHaveBeenCalledOnce()
    expect(persistSettings).toHaveBeenCalledWith(expect.objectContaining({
      plant_spacing_interval_m: 0.75,
    }))
  })

  it('persists the discrete snap-to-grid toggle immediately', () => {
    const adapter = createAdapter()

    adapter.settings.toggleSnapToGrid()

    expect(adapter.settings.readSnapToGridEnabled()).toBe(false)
    expect(persistSettings).toHaveBeenCalledOnce()
    expect(persistSettings).toHaveBeenCalledWith(expect.objectContaining({
      snap_to_grid: false,
    }))
  })

  it('subscribes to the exact app signals owned by the adapter', () => {
    const adapter = createAdapter()
    const onTheme = vi.fn()
    const onLocale = vi.fn()
    const onChromeOverlay = vi.fn()
    const disposeTheme = adapter.settings.subscribeTheme(onTheme)
    const disposeLocale = adapter.settings.subscribeLocale(onLocale)
    const disposeChromeOverlay = adapter.settings.subscribeChromeOverlay(onChromeOverlay)

    try {
      expect([onTheme, onLocale, onChromeOverlay].map((callback) => callback.mock.calls.length))
        .toEqual([1, 1, 1])

      theme.value = 'dark'
      locale.value = 'fr'
      gridVisible.value = false

      expect(onTheme).toHaveBeenCalledTimes(2)
      expect(onLocale).toHaveBeenCalledTimes(2)
      expect(onChromeOverlay).toHaveBeenCalledTimes(2)

      disposeTheme()
      disposeLocale()
      disposeChromeOverlay()
      theme.value = 'light'
      locale.value = 'en'
      gridVisible.value = true

      expect(onTheme).toHaveBeenCalledTimes(2)
      expect(onLocale).toHaveBeenCalledTimes(2)
      expect(onChromeOverlay).toHaveBeenCalledTimes(2)
    } finally {
      disposeTheme()
      disposeLocale()
      disposeChromeOverlay()
    }
  })

  it('reports the map backdrop the layer store shows, whatever the UI theme', () => {
    const adapter = createAdapter()
    const onBackdrop = vi.fn()
    const base = createDefaultMapLayers()
    const withLayers = (patch: Partial<MapLayersState>): MapLayersState => ({ ...base, ...patch })
    mapLayers.value = withLayers({ basemap: { ...base.basemap, style: 'liberty', visible: true, opacity: 1 } })
    const dispose = adapter.settings.subscribeMapBackdrop(onBackdrop)

    try {
      expect(onBackdrop).toHaveBeenLastCalledWith('basemap')
      theme.value = 'dark'
      expect(onBackdrop).toHaveBeenCalledTimes(1)

      mapLayers.value = withLayers({ satellite: { visible: true, opacity: 1 } })
      expect(onBackdrop).toHaveBeenLastCalledWith('satellite')
      mapLayers.value = withLayers({ basemap: { ...base.basemap, style: 'dark', visible: true, opacity: 1 } })
      expect(onBackdrop).toHaveBeenLastCalledWith('dark-basemap')
      mapLayers.value = withLayers({ basemap: { ...base.basemap, visible: false } })
      expect(onBackdrop).toHaveBeenLastCalledWith('paper')
      // A faint background lets the map's paper show through.
      mapLayers.value = withLayers({ satellite: { visible: true, opacity: 0.3 } })
      expect(onBackdrop).toHaveBeenLastCalledWith('paper')

      dispose()
      mapLayers.value = withLayers({ satellite: { visible: true, opacity: 1 } })
      expect(onBackdrop).toHaveBeenLastCalledWith('paper')
    } finally {
      dispose()
      theme.value = 'light'
      mapLayers.value = base
    }
  })

  it('lets the Desktop root supply native presentation and Saved Stamp capture', () => {
    const adapter = createDesktopCanvasRuntimeAppAdapter()

    expect(adapter.presentationData?.plantLabels).toBeInstanceOf(CanvasPlantLabelResolver)
    expect(adapter.presentationData?.speciesCache).toBeInstanceOf(CanvasSpeciesCache)
    expect(adapter.savedObjectStamps?.saveCurrentSelection).toBeTypeOf('function')
  })
})

describe('reduced motion', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('the reduced-motion preference is live, and a key turn jumps with it on or off', async () => {
    // A live prefers-reduced-motion query: on, then turned off while the app runs. It reaches the flights only: every turn jumps (U34).
    let onChange: ((event: { readonly matches: boolean }) => void) | null = null
    const query = {
      matches: true,
      addEventListener: (_type: string, listener: (event: { readonly matches: boolean }) => void) => { onChange = listener },
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('matchMedia', vi.fn(() => query))
    vi.resetModules()
    const { createAppCanvasRuntimeAppAdapter: createLiveAdapter } = await import('./app-adapter')
    const { createLiveTestCanvasRuntimeHost } = await import('../../__tests__/support/live-canvas-runtime')
    const appAdapter = createLiveAdapter({ presentationData: {} })
    const host = createLiveTestCanvasRuntimeHost({ screen: { width: 800, height: 600 }, appAdapter })
    const bearing = () => host.surfaces.queries.view.captureView().camera.bearingDeg

    expect(appAdapter.reducedMotion?.value).toBe(true)
    host.surfaces.commands.viewport.rotateBy(1)
    expect(bearing()).toBeCloseTo(15, 6)

    query.matches = false
    onChange!({ matches: false })
    expect(appAdapter.reducedMotion?.value).toBe(false)
    host.surfaces.commands.viewport.rotateBy(1)
    expect(bearing()).toBeCloseTo(30, 6)
    await host.destroy()
  })
})

function createAdapter() {
  return createAppCanvasRuntimeAppAdapter({ presentationData: {} })
}

function resetGrid(): void {
  gridVisible.value = true
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
