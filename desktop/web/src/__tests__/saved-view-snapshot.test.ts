// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViewSnapshotCapture, ViewSnapshotRequest } from '../maplibre/view-snapshot-map'

const snapshotOwner = vi.hoisted(() => ({
  requests: [] as ViewSnapshotRequest[],
  created: 0,
  disposed: 0,
}))

vi.mock('../maplibre/view-snapshot-map', async (importOriginal) => {
  const actual = await importOriginal<typeof ViewSnapshotMapModule>()
  return {
    ...actual,
    createViewSnapshotMap: () => {
      snapshotOwner.created += 1
      return {
        capture: async (request: ViewSnapshotRequest): Promise<ViewSnapshotCapture> => {
          snapshotOwner.requests.push(request)
          request.scene.build(createTestRendererView({ x: 160, y: 100, scale: 2 }))
          return {
            blob: new Blob(['png'], { type: 'image/png' }),
            width: request.width,
            height: request.height,
            missingTiles: false,
            attribution: ['OpenFreeMap'],
            timings: { mapSetupMs: 0, settleMs: 0, readMs: 0, encodeMs: 0, totalMs: 0 },
          }
        },
        dispose: async () => { snapshotOwner.disposed += 1 },
      }
    },
  }
})

import {
  captureSavedViewSnapshot,
  describeSavedViewSnapshot,
  disposeViewSnapshots,
  VIEW_SNAPSHOT_DEFAULT_TIMEOUT_MS,
  VIEW_SNAPSHOT_THUMBNAIL,
  ViewSnapshotSceneBusyError,
} from '../app/saved-views/snapshot'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { designSessionStore } from '../app/document-session/store'
import { setCurrentCanvasSession } from '../canvas/session'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import type { CanopiFile, SavedView } from '../types/design'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestRendererView } from './support/scene-renderer-snapshot'
import { replaceCurrentDesignState } from './support/design-session-state'
import { TEST_GEO_ORIGIN } from './support/geo-design'
import { groundSizeShown } from './support/saved-view-frame'
import type * as ViewSnapshotMapModule from '../maplibre/view-snapshot-map'

const VIEW: SavedView = {
  id: 'hedges',
  name: 'Hedges',
  // Framed in a 400 × 300 window.
  camera: {
    lon: TEST_GEO_ORIGIN.lon, lat: TEST_GEO_ORIGIN.lat, zoom: 19, bearing: 0,
    ground_size_m: groundSizeShown({ lat: TEST_GEO_ORIGIN.lat, zoom: 19 }, { width: 400, height: 300 }),
  },
  visible_layers: {
    background: { kind: 'satellite' },
    terrain: { contours: false, hillshade: false },
    scene_layers: ['plants'],
    site_data: [],
  },
  highlighted: { species: ['Rubus idaeus'], objects: [{ kind: 'plant', id: 'p1' }] },
  title: null,
  text: [],
}

function withBackground(background: SavedView['visible_layers']['background']): SavedView {
  return { ...VIEW, visible_layers: { ...VIEW.visible_layers, background } }
}

function queries(screen?: { readonly width: number; readonly height: number }) {
  const scene = createDefaultScenePersistedState()
  scene.layers = [
    { kind: 'layer', name: 'plants', visible: false, locked: false, opacity: 1 },
    { kind: 'layer', name: 'zones', visible: true, locked: false, opacity: 1 },
  ]
  return createTestCanvasQuerySurface({ scene, placement: { x: 200, y: 150, scale: 3 }, ...(screen ? { screen } : {}) })
}

function design(): CanopiFile {
  return {
    version: 9, name: 'Orchard', description: null,
    plant_species_colors: {}, plant_species_symbols: {}, plant_species_codes: {},
    layers: [], plants: [], zones: [], annotations: [], measurement_guides: [], consortiums: [],
    groups: [], timeline: [], budget: [], budget_currency: 'EUR', lidar: null,
    views: [VIEW], stories: [], created_at: '', updated_at: '', extra: {},
  }
}

afterEach(async () => {
  setCurrentCanvasSession(null)
  mapLayers.value = createDefaultMapLayers()
  await disposeViewSnapshots()
  snapshotOwner.requests = []
  snapshotOwner.created = 0
  snapshotOwner.disposed = 0
})

describe('saved view snapshot request', () => {
  it('draws a turned view at its bearing with its framed area fitted into the image, whatever the workspace size', () => {
    // Framed in a 1000 × 500 window at zoom 19: 1000 / 320 limits the 320 × 200 image more than 500 / 200.
    const ground = groundSizeShown(VIEW.camera, { width: 1000, height: 500 })
    const turned: SavedView = { ...VIEW, camera: { ...VIEW.camera, bearing: 30, ground_size_m: ground } }
    const context = { mapLayers: createDefaultMapLayers(), locale: 'en', plantLabels: 'names' as const }
    const request = describeSavedViewSnapshot(turned, VIEW_SNAPSHOT_THUMBNAIL, { ...context, queries: queries() })!

    expect(request.camera).toMatchObject({ lon: VIEW.camera.lon, lat: VIEW.camera.lat, bearing: 30 })
    expect(request.camera.zoom).toBeCloseTo(19 + Math.log2(320 / 1000), 6)
    // The workspace size plays no part: the same image in a 1600 × 900 workspace.
    const wide = describeSavedViewSnapshot(turned, VIEW_SNAPSHOT_THUMBNAIL, { ...context, queries: queries({ width: 1600, height: 900 }) })!
    expect(wide.camera.zoom).toBe(request.camera.zoom)
  })

  it('draws the view off-screen with its layers, focused species and a fitted zoom', () => {
    const surface = queries()
    const build = vi.spyOn(surface, 'captureViewScene')
    const request = describeSavedViewSnapshot(VIEW, VIEW_SNAPSHOT_THUMBNAIL, {
      queries: surface,
      mapLayers: createDefaultMapLayers(),
      locale: 'fr',
      plantLabels: 'codes',
    })!

    // The view framed what a 400 × 300 window shows: a 320 × 200 image shows the same ground at two thirds of the size,
    // limited by its height.
    expect(request.camera.zoom).toBeCloseTo(19 + Math.log2(200 / 300), 9)
    expect(request.camera).toMatchObject({ lon: VIEW.camera.lon, lat: VIEW.camera.lat })
    expect(request).toMatchObject({ width: 320, height: 200, timeoutMs: VIEW_SNAPSHOT_DEFAULT_TIMEOUT_MS })
    expect(request.scene.origin).toEqual(TEST_GEO_ORIGIN)
    expect(request.background).toMatchObject({ satellite: { visible: true }, basemap: { visible: false }, locale: 'fr' })

    const view = createTestRendererView({ x: 1, y: 2, scale: 3 })
    const scene = request.scene.build(view)
    expect(build).toHaveBeenCalledWith({
      view, visibleLayerNames: ['plants'], focusedSpecies: 'Rubus idaeus', plantLabels: 'codes',
    })
    expect(scene.scene.layers.map((layer) => [layer.name, layer.visible])).toEqual([['plants', true], ['zones', false]])
  })

  it('never zooms a larger image in past the view zoom, within the map range', () => {
    const context = { queries: queries(), mapLayers: createDefaultMapLayers(), locale: 'en', plantLabels: 'names' as const }
    expect(describeSavedViewSnapshot(VIEW, { width: 1600, height: 1000 }, context)!.camera.zoom).toBe(19)
    const deep = { ...VIEW, camera: { ...VIEW.camera, zoom: 27, ground_size_m: groundSizeShown({ lat: VIEW.camera.lat, zoom: 27 }, { width: 400, height: 300 }) } }
    expect(describeSavedViewSnapshot(deep, { width: 1600, height: 1000 }, context)!.camera.zoom).toBe(27)
  })

  it('refuses a scene while an edit owns it, and a Design without a map frame', () => {
    const surface = queries()
    const context = { queries: surface, mapLayers: createDefaultMapLayers(), locale: 'en', plantLabels: 'names' as const }
    const request = describeSavedViewSnapshot(VIEW, VIEW_SNAPSHOT_THUMBNAIL, context)!
    surface.setSettled(false)
    expect(() => request.scene.build(createTestRendererView({ x: 0, y: 0, scale: 1 }))).toThrow(ViewSnapshotSceneBusyError)
    surface.sessionPlane.value = null
    expect(describeSavedViewSnapshot(VIEW, VIEW_SNAPSHOT_THUMBNAIL, context)).toBeNull()
  })

  it('maps each saved background onto the background band with the current opacities', () => {
    const layers = {
      ...createDefaultMapLayers(),
      basemap: { style: 'positron' as const, visible: false, opacity: 0.4 },
      satellite: { visible: false, opacity: 0.6 },
    }
    const context = { queries: queries(), mapLayers: layers, locale: 'en', plantLabels: 'names' as const }
    const backgroundOf = (background: SavedView['visible_layers']['background']) =>
      describeSavedViewSnapshot(withBackground(background), VIEW_SNAPSHOT_THUMBNAIL, context)!.background
    expect(backgroundOf({ kind: 'basemap', style: 'dark' })).toEqual({
      basemap: { style: 'dark', visible: true, opacity: 0.4 },
      satellite: { visible: false, opacity: 0.6 },
      locale: 'en',
    })
    expect(backgroundOf({ kind: 'basemap', style: 'retired' }).basemap.style).toBe('positron')
    expect(backgroundOf({ kind: 'satellite' })).toMatchObject({
      basemap: { visible: false },
      satellite: { visible: true, opacity: 0.6 },
    })
    expect(backgroundOf({ kind: 'none' })).toMatchObject({
      basemap: { visible: false },
      satellite: { visible: false },
    })
  })
})

describe('capturing a saved view', () => {
  it('resolves null without an open Design on a map', async () => {
    await expect(captureSavedViewSnapshot(VIEW, VIEW_SNAPSHOT_THUMBNAIL)).resolves.toBeNull()
    expect(snapshotOwner.created).toBe(0)
  })

  it('never moves the visible camera, changes the selection or marks the Design changed', async () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    const surface = queries()
    surface.setSelection([{ kind: 'zone', id: 'Hedge' }])
    const commands = createTestCanvasCommandSurface()
    const showPlace = vi.fn(() => true)
    const showCamera = vi.fn()
    commands.viewport.showPlace = showPlace
    // Going to a view moves the camera through showCamera; a snapshot of a turned view never does.
    commands.viewport.showCamera = showCamera
    const turned: SavedView = { ...VIEW, camera: { ...VIEW.camera, bearing: 30 } }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ commands, queries: surface }))
    const camera = surface.view.captureView().camera
    const scene = surface.getSceneSnapshot()
    expect(designSessionStore.designDirty.value).toBe(false)

    const first = await captureSavedViewSnapshot(turned, VIEW_SNAPSHOT_THUMBNAIL)
    await captureSavedViewSnapshot(turned, { width: 1600, height: 1000, pixelRatio: 2 })

    expect(first).toMatchObject({ width: 320, height: 200, missingTiles: false, attribution: ['OpenFreeMap'] })
    expect(snapshotOwner.created).toBe(1)
    expect(snapshotOwner.requests[1]).toMatchObject({ width: 1600, height: 1000, pixelRatio: 2, camera: { bearing: 30 } })
    expect(showPlace).not.toHaveBeenCalled()
    expect(showCamera).not.toHaveBeenCalled()
    expect(surface.view.captureView().camera).toBe(camera)
    expect(surface.getSceneSnapshot()).toBe(scene)
    expect(surface.getSelection()).toEqual([{ kind: 'zone', id: 'Hedge' }])
    expect(designSessionStore.designDirty.value).toBe(false)

    await disposeViewSnapshots()
    expect(snapshotOwner.disposed).toBe(1)
  })

  it('draws the labels recorded with the view, else the Design’s current choice', async () => {
    replaceCurrentDesignState({
      ...design(),
      extra: { plant_display: { labels: 'codes' } },
    }, null, 'Orchard')
    const surface = queries()
    const build = vi.spyOn(surface, 'captureViewScene')
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ queries: surface }))

    await captureSavedViewSnapshot({ ...VIEW, labels: 'none' }, VIEW_SNAPSHOT_THUMBNAIL)
    await captureSavedViewSnapshot(VIEW, VIEW_SNAPSHOT_THUMBNAIL)

    expect(build.mock.calls.map(([request]) => request.plantLabels)).toEqual(['none', 'codes'])
  })
})
