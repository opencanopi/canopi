// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canShowSavedViews,
  cancelDeleteView,
  closeManageViewsDialog,
  closeSaveViewDialog,
  confirmDeleteView,
  confirmSaveViewDialog,
  dismissDeleteViewUndo,
  goToSavedView,
  manageViewsDialogOpen,
  openManageViewsDialog,
  openSaveViewDialog,
  renameView,
  requestDeleteView,
  savedViewDeleteConfirmation,
  savedViewDialogOpen,
  savedViewUndo,
  saveViewDialog,
  undoDeleteView,
} from '../app/saved-views'
import { saveCurrentView } from '../app/saved-views/actions'
import { composeSavedView } from '../app/saved-views/model'
import { savedViewZoom } from '../canvas/saved-view-framing'
import { SAVED_VIEW_MAX_GROUND_SIZE_M } from '../generated/canopi-design-format'
import { describeSavedViewSnapshot, savedViewPresentedLabels, VIEW_SNAPSHOT_THUMBNAIL } from '../app/saved-views/snapshot'
import type { ViewCamera } from '../canvas/runtime/view/types'
import { setPlantLabels } from '../app/plant-display/actions'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { currentDesign, designSessionStore } from '../app/document-session/store'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene'
import { mapZoomToStageScale } from '../canvas/projection'
import { createSessionPlane } from '../canvas/session-plane'
import { setCurrentCanvasSession } from '../canvas/session'
import type { CanopiFile, PlacedPlant, SavedView, Story } from '../types/design'
import {
  createTestCanvasCommandSurface,
  createTestCanvasRuntimeSurfaces,
} from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { replaceCurrentDesignState } from './support/design-session-state'
import { TEST_GEO_ORIGIN } from './support/geo-design'
import { framedCornersOnScreen, groundSizeShown, type WindowSize } from './support/saved-view-frame'

function design(views: SavedView[] = [], stories: Story[] = []): CanopiFile {
  return {
    version: 9,
    name: 'Orchard',
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    plant_species_codes: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    lidar: {
      visible: true,
      entries: [
        { kind: 'Source', id: 'dtm-shown', name: 'Shown terrain', visible: true, opacity: 1, order: 0, ramp: null, reversed: false, range: null },
        { kind: 'Source', id: 'dtm-hidden', name: 'Hidden terrain', visible: false, opacity: 1, order: 1, ramp: null, reversed: false, range: null },
      ],
    },
    views,
    stories,
    created_at: '',
    updated_at: '',
    extra: {},
  }
}

const BERRIES: SavedView = {
  id: 'berries',
  name: 'Berry hedges',
  // Framed in the 400 × 300 window mountCanvas makes by default.
  camera: { lon: 13.0012, lat: 22.9991, zoom: 19.5, bearing: 0, ground_size_m: groundSizeShown({ lat: 22.9991, zoom: 19.5 }, { width: 400, height: 300 }) },
  visible_layers: {
    background: { kind: 'satellite' },
    terrain: { contours: false, hillshade: true },
    scene_layers: ['plants'],
    site_data: [],
  },
  highlighted: {
    species: ['Rubus idaeus', 'Lycium barbarum'],
    objects: [{ kind: 'plant', id: 'p1' }, { kind: 'measurement_guide', id: 'g1' }],
  },
  title: null,
  text: [],
}

function plant(canonicalName: string): PlacedPlant {
  return {
    id: canonicalName, canonical_name: canonicalName, common_name: null, color: null,
    position: TEST_GEO_ORIGIN, rotation: null, scale: null, notes: null,
    planted_date: null, quantity: 1, locked: false,
  }
}

const POND: SavedView = { ...BERRIES, id: 'pond', name: 'Pond' }

function visit(viewIds: string[]): Story {
  return {
    id: 'visit',
    name: 'Client visit',
    steps: viewIds.map((viewId, index) => ({ id: `step-${index}`, view_id: viewId, title: 'Step', text: [], images: [] })),
  }
}

/** A map on a `screen` CSS px window (400 × 300 by default) whose centre shows the plane origin at zoom 18. */
function mountCanvas(screen: WindowSize = { width: 400, height: 300 }) {
  const scale = mapZoomToStageScale(18, TEST_GEO_ORIGIN.lat)
  const scene = createDefaultScenePersistedState()
  scene.layers = [
    { kind: 'layer', name: 'plants', visible: true, locked: false, opacity: 1 },
    { kind: 'layer', name: 'water', visible: false, locked: false, opacity: 1 },
  ]
  const queries = createTestCanvasQuerySurface({
    scene,
    // The plane origin sits at the screen centre.
    placement: { x: screen.width / 2, y: screen.height / 2, scale },
    screen,
    plants: [plant('Lycium barbarum')],
    selection: [{ kind: 'zone', id: 'Hedge' }, { kind: 'measurement-guide', id: 'g1' }],
    sessionPlane: createSessionPlane(TEST_GEO_ORIGIN),
  })
  queries.getSpeciesFocus = () => ({ canonicalName: 'Lycium barbarum', showCodes: false })
  const showPlace = vi.fn(() => true)
  const showCamera = vi.fn<(camera: ViewCamera, options?: { readonly motion?: 'fly' | 'jump' }) => void>()
  const focus = vi.fn()
  const selectSpecies = vi.fn()
  const commands = createTestCanvasCommandSurface()
  commands.viewport.showPlace = showPlace
  commands.viewport.showCamera = showCamera
  commands.speciesFocus.focus = focus
  commands.sceneEdits.selectSpecies = selectSpecies
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ commands, queries }))
  return { showPlace, showCamera, focus, selectSpecies, queries }
}

/** The camera going to BERRIES shows: its centre, zoom and bearing. */
function berriesCamera(bearingDeg = 0): ViewCamera {
  return { center: { lon: 13.0012, lat: 22.9991 }, zoom: 19.5, bearingDeg, pitchDeg: 0 }
}

afterEach(() => {
  setCurrentCanvasSession(null)
  closeSaveViewDialog()
  closeManageViewsDialog()
  dismissDeleteViewUndo()
  mapLayers.value = createDefaultMapLayers()
  // A saved view dirties the Design; the next test opens its own clean one.
  designSessionStore.clearCurrentDesign()
})

describe('saving the current view', () => {
  it('saves the camera, layers, focused species, selection and title as Design Edit data', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    mountCanvas()
    mapLayers.value = { ...createDefaultMapLayers(), hillshade: { visible: true, opacity: 0.5 } }
    expect(designSessionStore.designDirty.value).toBe(false)

    const saved = saveCurrentView({ name: '  Hedges  ', title: '  The berry hedges ' })

    expect(saved).not.toBeNull()
    expect(currentDesign.value?.views).toEqual([saved])
    expect(saved).toMatchObject({
      name: 'Hedges',
      title: 'The berry hedges',
      camera: { lon: TEST_GEO_ORIGIN.lon, lat: TEST_GEO_ORIGIN.lat, bearing: 0 },
      visible_layers: {
        background: { kind: 'basemap', style: 'liberty' },
        terrain: { contours: false, hillshade: true },
        scene_layers: ['plants'],
        site_data: ['dtm-shown'],
      },
      highlighted: {
        species: ['Lycium barbarum'],
        objects: [{ kind: 'zone', id: 'Hedge' }, { kind: 'measurement_guide', id: 'g1' }],
      },
      text: [],
    })
    expect(saved!.camera.zoom).toBeCloseTo(18, 6)
    // The ground the 400 × 300 map shows, in metres at the stored camera: what going to the view fits into any window.
    const ground = groundSizeShown(saved!.camera, { width: 400, height: 300 })
    expect(saved!.camera.ground_size_m!.width).toBeCloseTo(ground.width, 6)
    expect(saved!.camera.ground_size_m!.height).toBeCloseTo(ground.height, 6)
    expect(Object.keys(saved!)).not.toContain('extent')
    expect(designSessionStore.designDirty.value).toBe(true)
  })

  it('captures no site data while the Site data eye is off, whatever each entry stores', () => {
    const base = design()
    replaceCurrentDesignState({ ...base, lidar: { ...base.lidar!, visible: false } }, null, 'Orchard')
    mountCanvas()

    expect(saveCurrentView({ name: 'Hedges' })?.visible_layers.site_data).toEqual([])
  })

  it('a thumbnail shows the framed area fitted into the image, whatever the workspace size', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    const { queries } = mountCanvas()
    const context = { queries, mapLayers: createDefaultMapLayers(), locale: 'en', plantLabels: 'names' as const }
    // Saved in this 400 × 300 workspace: the 320 × 200 image shows its frame, limited by the height.
    const saved = saveCurrentView({ name: 'Hedges' })!
    const request = describeSavedViewSnapshot(saved, VIEW_SNAPSHOT_THUMBNAIL, context)!
    expect(request.camera.zoom).toBeCloseTo(saved.camera.zoom + Math.log2(200 / 300), 6)
    // A view framed in a 1400 × 900 window, turned 30°: its frame fitted into the image at its bearing, not this workspace's.
    const camera = { ...BERRIES.camera, bearing: 30 }
    const turned: SavedView = { ...BERRIES, camera: { ...camera, ground_size_m: groundSizeShown(camera, { width: 1400, height: 900 }) } }
    const thumbnail = describeSavedViewSnapshot(turned, VIEW_SNAPSHOT_THUMBNAIL, context)!
    expect(thumbnail.camera).toMatchObject({ lon: 13.0012, lat: 22.9991, bearing: 30 })
    expect(thumbnail.camera.zoom).toBeCloseTo(19.5 + Math.log2(200 / 900), 6)
  })

  it('records the label choice with the view, and presents the view with it', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    mountCanvas()
    setPlantLabels('codes')

    const saved = saveCurrentView({ name: 'Hedges' })!

    // The view stores the choice itself, as `views[].labels`.
    expect(saved.labels).toBe('codes')
    expect(currentDesign.value?.views?.find((view) => view.id === saved.id)?.labels).toBe('codes')
    expect(currentDesign.value?.extra).not.toHaveProperty('saved_view_display')
    setPlantLabels('none')
    expect(savedViewPresentedLabels(saved)).toBe('codes')
    // A view stored without labels shows the Design's current choice.
    expect(savedViewPresentedLabels(BERRIES)).toBe('none')
  })

  it('reads a view’s labels from the view, never from a saved_view_display key in extra', () => {
    replaceCurrentDesignState(
      { ...design([BERRIES]), extra: { saved_view_display: { berries: { labels: 'codes' } } } },
      null,
      'Orchard',
    )
    setPlantLabels('none')
    expect(savedViewPresentedLabels(currentDesign.value!.views![0]!)).toBe('none')
  })

  it('stores a blank title as none', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    mountCanvas()
    expect(saveCurrentView({ name: 'Pond', title: '   ' })?.title).toBeNull()
    expect(saveCurrentView({ name: 'Pond again' })?.title).toBeNull()
  })

  it('saves no view from a map with no size', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    mountCanvas({ width: 0, height: 0 })
    expect(saveCurrentView({ name: 'Nowhere' })).toBeNull()
    expect(currentDesign.value?.views).toEqual([])
  })

  it('cannot save without an open Design on a map', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    expect(canShowSavedViews()).toBe(false)
    expect(saveCurrentView({ name: 'View' })).toBeNull()
    openSaveViewDialog()
    expect(saveViewDialog.value).toBeNull()
  })

  it('names a new view through the dialog, which stays open for a blank name', () => {
    replaceCurrentDesignState(design([BERRIES]), null, 'Orchard')
    mountCanvas()

    openSaveViewDialog()
    expect(saveViewDialog.value).toEqual({ defaultName: 'View 2' })
    expect(savedViewDialogOpen.value).toBe(true)
    expect(confirmSaveViewDialog({ name: '   ', title: '' })).toBe(false)
    expect(saveViewDialog.value).not.toBeNull()
    expect(confirmSaveViewDialog({ name: 'Pond', title: 'From the south' })).toBe(true)

    expect(saveViewDialog.value).toBeNull()
    expect(currentDesign.value?.views?.map((view) => [view.name, view.title])).toEqual([
      ['Berry hedges', null],
      ['Pond', 'From the south'],
    ])
  })

  it('drops the dialog when another Design replaces the one that opened it', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    mountCanvas()
    openSaveViewDialog()

    replaceCurrentDesignState(design(), null, 'Other')

    expect(saveViewDialog.value).toBeNull()
    expect(confirmSaveViewDialog({ name: 'Late', title: '' })).toBe(false)
    expect(currentDesign.value?.views).toEqual([])
  })
})

describe('going to a saved view', () => {
  it('flies the camera there and touches nothing else: no Design edit, dirt, layers, focus or selection', () => {
    replaceCurrentDesignState(design([BERRIES]), null, 'Orchard')
    const { showPlace, showCamera, focus, selectSpecies } = mountCanvas()
    designSessionStore.resetDirtyBaselines()
    expect(designSessionStore.designDirty.value).toBe(false)
    const before = currentDesign.value
    const revision = designSessionStore.committedDesignRevision.value
    const layersBefore = mapLayers.value

    expect(goToSavedView('berries')).toBe(true)

    expect(showCamera).toHaveBeenCalledWith(berriesCamera(), { motion: 'fly' })
    expect(showPlace).not.toHaveBeenCalled()
    expect(currentDesign.value).toBe(before)
    expect(designSessionStore.designDirty.value).toBe(false)
    expect(designSessionStore.committedDesignRevision.value).toBe(revision)
    expect(mapLayers.value).toBe(layersBefore)
    expect(focus).not.toHaveBeenCalled()
    expect(selectSpecies).not.toHaveBeenCalled()
  })

  it('ignores unknown views', () => {
    replaceCurrentDesignState(design([BERRIES]), null, 'Orchard')
    const { showCamera } = mountCanvas()

    expect(goToSavedView('missing')).toBe(false)
    expect(goToSavedView('berries')).toBe(true)

    expect(showCamera).toHaveBeenCalledTimes(1)
    expect(showCamera).toHaveBeenCalledWith(berriesCamera(), { motion: 'fly' })
  })

  it('a view saved in a 1400x900 window and opened in a 1000x700 one keeps every corner inside', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    mountCanvas({ width: 1400, height: 900 })
    const saved = saveCurrentView({ name: 'Hedges' })!
    const { showCamera } = mountCanvas({ width: 1000, height: 700 })

    expect(goToSavedView(saved.id)).toBe(true)

    const [shown] = showCamera.mock.calls[0]!
    expect(shown.zoom).toBeLessThan(saved.camera.zoom)
    expect(shown).toMatchObject({ center: { lon: saved.camera.lon, lat: saved.camera.lat }, bearingDeg: 0 })
    const corners = framedCornersOnScreen(saved.camera, { width: 1400, height: 900 }, shown, { width: 1000, height: 700 })
    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(-1e-6)
      expect(corner.x).toBeLessThanOrEqual(1000 + 1e-6)
      expect(corner.y).toBeGreaterThanOrEqual(-1e-6)
      expect(corner.y).toBeLessThanOrEqual(700 + 1e-6)
    }
    // Zoomed out just enough: the width (1000 / 1400 < 700 / 900) fills the window edge to edge.
    expect(Math.min(...corners.map((corner) => corner.x))).toBeCloseTo(0, 4)
    expect(Math.max(...corners.map((corner) => corner.x))).toBeCloseTo(1000, 4)
  })

  it('the same window restores the exact camera', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    const { showCamera } = mountCanvas({ width: 1400, height: 900 })
    const saved = saveCurrentView({ name: 'Hedges' })!
    // A turned view framed in this window, as saving it records.
    const camera = { ...BERRIES.camera, bearing: 30 }
    const turned: SavedView = {
      ...BERRIES,
      camera: { ...camera, ground_size_m: groundSizeShown(camera, { width: 1400, height: 900 }) },
    }
    replaceCurrentDesignState(design([saved, turned]), null, 'Orchard')

    goToSavedView(saved.id)
    goToSavedView('berries')

    expect(showCamera.mock.calls).toEqual([
      [{ center: { lon: saved.camera.lon, lat: saved.camera.lat }, zoom: saved.camera.zoom, bearingDeg: 0, pitchDeg: 0 }, { motion: 'fly' }],
      [berriesCamera(30), { motion: 'fly' }],
    ])
  })

  it('a larger window never zooms in past the saved zoom', () => {
    replaceCurrentDesignState(design(), null, 'Orchard')
    mountCanvas()
    const saved = saveCurrentView({ name: 'Hedges' })!
    const { showCamera } = mountCanvas({ width: 1600, height: 1000 })

    goToSavedView(saved.id)

    expect(showCamera).toHaveBeenCalledWith(
      { center: { lon: saved.camera.lon, lat: saved.camera.lat }, zoom: saved.camera.zoom, bearingDeg: 0, pitchDeg: 0 },
      { motion: 'fly' },
    )
  })

  it('does nothing without a map', () => {
    replaceCurrentDesignState(design([BERRIES]), null, 'Orchard')
    expect(goToSavedView('berries')).toBe(false)
  })
})

describe('managing views', () => {
  it('renames a view; a blank name keeps the old one', () => {
    replaceCurrentDesignState(design([BERRIES]), null, 'Orchard')
    renameView('berries', '  Hedges ')
    renameView('berries', '  ')
    expect(currentDesign.value?.views?.[0]?.name).toBe('Hedges')
  })

  it('deletes an unused view at once and offers Undo', () => {
    replaceCurrentDesignState(design([BERRIES, POND]), null, 'Orchard')
    openManageViewsDialog()
    expect(manageViewsDialogOpen.value).toBe(true)

    requestDeleteView('berries')

    expect(savedViewDeleteConfirmation.value).toBeNull()
    expect(currentDesign.value?.views?.map((view) => view.id)).toEqual(['pond'])
    expect(savedViewUndo.value?.message).toBe('Deleted “Berry hedges”')

    undoDeleteView()
    expect(currentDesign.value?.views?.map((view) => view.id)).toEqual(['berries', 'pond'])
    expect(savedViewUndo.value).toBeNull()
  })

  it('brings a deleted view back with its label choice on Undo', () => {
    replaceCurrentDesignState(design([{ ...BERRIES, labels: 'none' }, POND]), null, 'Orchard')
    requestDeleteView('berries')
    undoDeleteView()
    expect(currentDesign.value?.views?.[0]).toEqual({ ...BERRIES, labels: 'none' })
  })

  it('asks first, naming the stories, when stories show the view', () => {
    replaceCurrentDesignState(
      design([BERRIES, POND], [visit(['berries', 'pond']), { ...visit(['berries']), id: 'tour', name: 'Open day' }]),
      null,
      'Orchard',
    )
    const before = currentDesign.value

    requestDeleteView('berries')
    expect(savedViewDeleteConfirmation.value).toEqual({
      viewId: 'berries',
      viewName: 'Berry hedges',
      stories: ['Client visit', 'Open day'],
    })
    expect(currentDesign.value).toBe(before)

    cancelDeleteView()
    expect(savedViewDeleteConfirmation.value).toBeNull()
    expect(currentDesign.value).toBe(before)

    requestDeleteView('berries')
    confirmDeleteView()
    expect(currentDesign.value?.views?.map((view) => view.id)).toEqual(['pond'])
    expect(currentDesign.value?.stories?.map((story) => story.steps.map((step) => step.view_id))).toEqual([['pond'], []])

    undoDeleteView()
    expect(currentDesign.value?.stories?.map((story) => story.steps.map((step) => step.view_id))).toEqual([
      ['berries', 'pond'],
      ['berries'],
    ])
  })

  it('never undoes into another Design', () => {
    replaceCurrentDesignState(design([BERRIES]), null, 'Orchard')
    requestDeleteView('berries')
    expect(savedViewUndo.value).not.toBeNull()

    replaceCurrentDesignState(design(), null, 'Other')
    expect(savedViewUndo.value).toBeNull()
    undoDeleteView()
    expect(currentDesign.value?.views).toEqual([])
  })
})

describe('saved view model', () => {
  const capture = (view: { lon: number; lat: number; zoom: number; bearing: number }, screen: WindowSize) => composeSavedView({
    id: 'v', name: 'V', title: null, view, screen,
    mapLayers: createDefaultMapLayers(),
    sceneLayers: [], siteData: [], focusedSpecies: null, selection: [], labels: 'names',
  })

  it('rounds the camera like stored positions and clamps zoom to the map range', () => {
    const view = capture({ lon: 2.29448123456789, lat: 48.85837012345678, zoom: 31, bearing: 0 }, { width: 400, height: 300 })!
    expect(view.camera).toMatchObject({ lon: 2.294481235, lat: 48.858370123, zoom: 27, bearing: 0 })
    expect(view.highlighted).toEqual({ species: [], objects: [] })
  })

  it('a map with no size frames no ground and saves no view', () => {
    expect(capture({ lon: 2.2944, lat: 48.8583, zoom: 18, bearing: 0 }, { width: 0, height: 0 })).toBeNull()
    expect(capture({ lon: 2.2944, lat: 48.8583, zoom: 18, bearing: 0 }, { width: 400, height: 0 })).toBeNull()
  })

  it('at zoom 0 a 2,000 px map frames at most 1e8 m a side, and going there keeps the zoom', () => {
    const view = capture({ lon: 0, lat: 0, zoom: 0, bearing: 0 }, { width: 2000, height: 1000 })!
    const shown = groundSizeShown({ lat: 0, zoom: 0 }, { width: 2000, height: 1000 })
    expect(shown.width).toBeGreaterThan(SAVED_VIEW_MAX_GROUND_SIZE_M)
    expect(view.camera.ground_size_m).toEqual({ width: SAVED_VIEW_MAX_GROUND_SIZE_M, height: Number(shown.height.toPrecision(10)) })
    expect(savedViewZoom(view.camera, { width: 2000, height: 1000 })).toBe(0)
  })

  it('capture writes the bearing, rounded, 360 as 0', () => {
    const bearingOf = (bearing: number) => composeSavedView({
      id: 'v', name: 'V', title: null,
      view: { lon: 2.2944, lat: 48.8583, zoom: 18, bearing },
      screen: { width: 400, height: 300 },
      mapLayers: createDefaultMapLayers(),
      sceneLayers: [], siteData: [], focusedSpecies: null, selection: [], labels: 'names',
    })!.camera.bearing
    expect(bearingOf(30)).toBe(30)
    expect(bearingOf(30.12345678912)).toBe(30.123457)
    expect(bearingOf(359.99999999)).toBe(0)
    expect(bearingOf(360)).toBe(0)
    expect(bearingOf(-15)).toBe(345)
  })
})
