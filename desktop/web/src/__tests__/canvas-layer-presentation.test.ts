// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mapLayers } from '../app/map-layers/state'
import {
  readCurrentCanvasLayerStatuses,
  retryCurrentCanvasLayer,
  setCurrentCanvasHostView,
  type CanvasSurfaceState,
} from '../app/canvas-map-surface/host-view'
import { openLayerRow, toggleLayerRow } from '../app/canvas-layer-presentation/open-row'
import type { LayerSlotId, LayerStatus } from '../maplibre/map-lifetime'
import { NEW_DESIGN_LAYER_DEFAULTS } from '../generated/new-design-defaults'
import {
  readCanvasLayerPresentation,
  setCanvasLayerPresentationContourIntervalMeters,
  setCanvasLayerPresentationLocked,
  setCanvasLayerPresentationOpacity,
  setCanvasLayerPresentationVisibility,
} from '../app/canvas-layer-presentation/presentation'
import { flushSettingsProjection, hydrateSettingsProjectionForTests } from '../app/settings/projection'
import { googleMapsApiKey, locale } from '../app/settings/state'
import { setCurrentCanvasSession } from '../canvas/session'
import { designSessionFixture } from './support/design-session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'

describe('Canvas Layer Presentation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    locale.value = 'en'
    openLayerRow.value = 'basemap'
    hydrateSettingsProjectionForTests({
      locale: 'en',
      theme: 'light',
      snap_to_grid: true,
      side_panel_width: null,
      saved_stamps_frame_height: 220,
      basemap_style: 'positron',
      basemap_visible: false,
      basemap_opacity: 0.65,
      satellite_visible: false,
      satellite_opacity: 0.9,
      google_maps_api_key: null,
      contour_visible: true,
      contour_opacity: 0.5,
      contour_interval: 12,
      hillshade_visible: true,
      hillshade_opacity: 0.45,
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
    })
    designSessionFixture.file = {
      version: 9,
      name: 'Layer presentation',
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
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({
        scene: {
          plantSpeciesColors: {},
          plantSpeciesSymbols: {},
    plantSpeciesCodes: {},
          layers: [
            { kind: 'layer', name: 'annotations', visible: true, locked: false, opacity: 1 },
            { kind: 'layer', name: 'plants', visible: true, locked: false, opacity: 0.8 },
            { kind: 'layer', name: 'measurement-guides', visible: true, locked: false, opacity: 0.6 },
            { kind: 'layer', name: 'zones', visible: false, locked: true, opacity: 0.35 },
          ],
          plants: [],
          zones: [],
          annotations: [],
          measurementGuides: [],
          groups: [],
        },
      }),
    }))
  })

  afterEach(() => {
    flushSettingsProjection()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
  })

  it('builds a visible Layer catalog from scene, map, and terrain authorities', () => {
    const presentation = readCanvasLayerPresentation()

    expect(presentation.rows.map((row) => ({
      id: row.id,
      label: row.label,
      authority: row.authority,
      group: row.group,
      open: row.open,
      visible: row.visible,
      opacity: row.opacity,
      locked: row.locked,
      canLock: row.canLock,
      detail: row.detail,
    }))).toEqual([
      {
        id: 'annotations',
        group: 'design',
        label: 'Annotations',
        authority: 'scene',
        open: false,
        visible: true,
        opacity: 1,
        locked: false,
        canLock: true,
        detail: { type: 'scene' },
      },
      {
        id: 'plants',
        group: 'design',
        label: 'Plants',
        authority: 'scene',
        open: false,
        visible: true,
        opacity: 0.8,
        locked: false,
        canLock: true,
        detail: { type: 'scene' },
      },
      {
        id: 'measurement-guides',
        group: 'design',
        label: 'Measurement guides',
        authority: 'scene',
        open: false,
        visible: true,
        opacity: 0.6,
        locked: false,
        canLock: true,
        detail: { type: 'scene' },
      },
      {
        id: 'zones',
        group: 'design',
        label: 'Zones',
        authority: 'scene',
        open: false,
        visible: false,
        opacity: 0.35,
        locked: true,
        canLock: true,
        detail: { type: 'scene' },
      },
      {
        id: 'basemap',
        group: 'background',
        label: 'Street map',
        authority: 'map-layers',
        open: true,
        visible: false,
        opacity: 0.65,
        locked: false,
        canLock: false,
        detail: {
          type: 'basemap',
          style: 'positron',
          styles: ['liberty', 'positron', 'bright', 'dark'],
          softenBackground: false,
        },
      },
      {
        id: 'satellite',
        group: 'background',
        label: 'Satellite',
        authority: 'map-layers',
        open: false,
        visible: false,
        opacity: 0.9,
        locked: false,
        canLock: false,
        detail: {
          type: 'satellite',
          hasGoogleKey: false,
          softenBackground: false,
        },
      },
      {
        id: 'contours',
        group: 'map',
        label: 'Contour lines',
        authority: 'map-layers',
        open: false,
        visible: true,
        opacity: 0.5,
        locked: false,
        canLock: false,
        detail: {
          type: 'contours',
          contourIntervalMeters: 12,
        },
      },
      {
        id: 'hillshade',
        group: 'map',
        label: 'Hillshading',
        authority: 'map-layers',
        open: false,
        visible: true,
        opacity: 0.45,
        locked: false,
        canLock: false,
        detail: { type: 'hillshade' },
      },
    ])
  })

  it('reads Design rows only from the scene, and shows the New Design defaults before a scene exists', () => {
    setCurrentCanvasSession(null)
    const design = readCanvasLayerPresentation().rows.filter((row) => row.authority === 'scene')
    expect(design.map((row) => ({ id: row.id, visible: row.visible, opacity: row.opacity, locked: row.locked }))).toEqual(
      ['annotations', 'plants', 'measurement-guides', 'zones'].map((id) => {
        const layer = NEW_DESIGN_LAYER_DEFAULTS.find((candidate) => candidate.name === id)!
        return { id, visible: layer.visible, opacity: layer.opacity, locked: layer.locked }
      }),
    )
  })

  it('opens one row at a time, and a second toggle closes it', () => {
    toggleLayerRow('plants')
    expect(readCanvasLayerPresentation().rows.filter((row) => row.open).map((row) => row.id)).toEqual(['plants'])
    toggleLayerRow('zones')
    expect(readCanvasLayerPresentation().rows.filter((row) => row.open).map((row) => row.id)).toEqual(['zones'])
    toggleLayerRow('zones')
    expect(readCanvasLayerPresentation().rows.some((row) => row.open)).toBe(false)
  })

  it('reports the background choices, Soften background and a saved Google key without exposing it', () => {
    googleMapsApiKey.value = 'secret-google-key'
    mapLayers.value = {
      ...mapLayers.value,
      basemap: { ...mapLayers.value.basemap, visible: true },
      satellite: { ...mapLayers.value.satellite, visible: true },
      softenBackground: true,
    }

    const presentation = readCanvasLayerPresentation()
    const basemap = presentation.rows.find((row) => row.id === 'basemap')
    const satellite = presentation.rows.find((row) => row.id === 'satellite')

    expect(basemap?.visible).toBe(true)
    expect(basemap?.detail).toEqual(expect.objectContaining({ type: 'basemap', softenBackground: true }))
    expect(satellite?.detail).toEqual({ type: 'satellite', hasGoogleKey: true, softenBackground: true })
    expect(JSON.stringify(presentation)).not.toContain('secret-google-key')
    googleMapsApiKey.value = null
  })

  it('routes Layer commands to the authority that owns each row', () => {
    const layerCommands = {
      setSceneLayerVisibility: vi.fn(() => true),
      setSceneLayerOpacity: vi.fn(() => true),
      setSceneLayerLocked: vi.fn(() => true),
      presentLayers: vi.fn(),
    }

    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      commands: createTestCanvasCommandSurface({ layers: layerCommands }),
    }))

    expect(setCanvasLayerPresentationVisibility('basemap', true)).toBe(true)
    expect(setCanvasLayerPresentationVisibility('satellite', true)).toBe(true)
    expect(setCanvasLayerPresentationOpacity('satellite', 0.3)).toBe(true)
    expect(setCanvasLayerPresentationOpacity('contours', 0.25)).toBe(true)
    expect(setCanvasLayerPresentationVisibility('hillshade', false)).toBe(true)
    expect(setCanvasLayerPresentationOpacity('hillshade', 0.2)).toBe(true)
    expect(setCanvasLayerPresentationContourIntervalMeters(18)).toBe(true)

    expect(mapLayers.value.basemap.visible).toBe(true)
    expect(mapLayers.value.satellite.visible).toBe(true)
    expect(mapLayers.value.satellite.opacity).toBe(0.3)
    expect(mapLayers.value.contours.opacity).toBe(0.25)
    expect(mapLayers.value.hillshade.visible).toBe(false)
    expect(mapLayers.value.hillshade.opacity).toBe(0.2)
    expect(mapLayers.value.contours.intervalMeters).toBe(18)

    expect(setCanvasLayerPresentationVisibility('plants', false)).toBe(true)
    expect(setCanvasLayerPresentationOpacity('zones', 0.4)).toBe(true)
    expect(setCanvasLayerPresentationLocked('annotations', true)).toBe(true)
    expect(setCanvasLayerPresentationLocked('basemap', true)).toBe(false)
    expect(setCanvasLayerPresentationLocked('satellite', true)).toBe(false)

    expect(layerCommands.setSceneLayerVisibility).toHaveBeenCalledWith('plants', false)
    expect(layerCommands.setSceneLayerOpacity).toHaveBeenCalledWith('zones', 0.4)
    expect(layerCommands.setSceneLayerLocked).toHaveBeenCalledWith('annotations', true)
    expect(layerCommands.setSceneLayerLocked).not.toHaveBeenCalledWith('basemap', true)
    expect(layerCommands.setSceneLayerVisibility).not.toHaveBeenCalledWith('satellite', true)
  })

  it('rejects invalid numeric Layer inputs without mutating state', () => {
    expect(setCanvasLayerPresentationContourIntervalMeters(Number.NaN)).toBe(false)
    expect(setCanvasLayerPresentationOpacity('basemap', Number.NaN)).toBe(false)

    expect(mapLayers.value.contours.intervalMeters).toBe(12)
    expect(mapLayers.value.basemap.opacity).toBe(0.65)
  })

  it('MAP-02 (2.1-Q351): marks failed terrain rows with Retry and routes Retry to the active map host', () => {
    const retryLayer = vi.fn()
    const layers = new Map<LayerSlotId, LayerStatus>([
      ['background', { kind: 'ready' }],
      ['terrain', { kind: 'failed', reason: 'terrain' }],
    ])
    const surface = signal<CanvasSurfaceState>({ kind: 'map', map: { kind: 'ready', attempt: 1, layers }, retry: 'withheld' })
    setCurrentCanvasHostView({ surface, ready: signal(true), retryMap: () => false, retryLayer })
    try {
      const rows = readCanvasLayerPresentation(readCurrentCanvasLayerStatuses()).rows
      const contours = rows.find((row) => row.id === 'contours')
      const hillshade = rows.find((row) => row.id === 'hillshade')
      const basemap = rows.find((row) => row.id === 'basemap')

      expect(contours?.failed).toBe(true)
      expect(contours?.retrySlot).toBe('terrain')
      expect(hillshade?.failed).toBe(true)
      expect(hillshade?.retrySlot).toBe('terrain')
      expect(basemap?.failed).toBeUndefined()

      retryCurrentCanvasLayer('terrain')
      expect(retryLayer).toHaveBeenCalledWith('terrain')
    } finally {
      setCurrentCanvasHostView(null)
    }
  })

  it('MAP-02 (2.1-Q351): maps failed library raster statuses onto Layers rows using the item name and Retry', () => {
    const retryLayer = vi.fn()
    const rawId = 'lidar-result-1111-gen1-relief'
    const layers = new Map<LayerSlotId, LayerStatus>([
      ['background', { kind: 'ready' }],
      [`library:${rawId}`, { kind: 'failed', reason: 'raster', label: 'North DEM' }],
      ['library:ok-layer', { kind: 'ready' }],
      ['library:skipped', { kind: 'skipped', reason: 'layer-skipped' }],
    ])
    const surface = signal<CanvasSurfaceState>({ kind: 'map', map: { kind: 'ready', attempt: 1, layers }, retry: 'withheld' })
    setCurrentCanvasHostView({ surface, ready: signal(true), retryMap: () => false, retryLayer })
    try {
      const rows = readCanvasLayerPresentation(readCurrentCanvasLayerStatuses()).rows
      const failedLib = rows.find((row) => row.id === `library:${rawId}`)
      expect(failedLib).toBeDefined()
      expect(failedLib?.label).toBe('North DEM')
      expect(failedLib?.failed).toBe(true)
      expect(failedLib?.retrySlot).toBe(`library:${rawId}`)
      expect(failedLib?.detail).toEqual({ type: 'library', libraryId: rawId })
      expect(rows.find((row) => row.id === 'library:ok-layer')).toBeUndefined()
      expect(rows.find((row) => row.id === 'library:skipped')).toBeUndefined()

      retryCurrentCanvasLayer(`library:${rawId}`)
      expect(retryLayer).toHaveBeenCalledWith(`library:${rawId}`)
    } finally {
      setCurrentCanvasHostView(null)
    }
  })
})
