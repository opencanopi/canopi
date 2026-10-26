// @vitest-environment jsdom

import { signal } from '@preact/signals'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import {
  goToPresentedStep,
  leaveStoryPresentation,
  nextPresentedStep,
  presentedStep,
  presentStory,
  previousPresentedStep,
  storyPresentationActive,
} from '../app/story-presentation'
import {
  presentedMapLayers,
  storyPresentationHidesEditingAids,
  storyPresentationOverrides,
} from '../app/story-presentation/overrides'
import { StoryPresenter } from '../components/stories/StoryPresenter'
import { MapNotice } from '../components/canvas/MapNotice'
import type { MapNoticeReadModel } from '../app/canvas-map-surface/map-notice'
import { t } from '../i18n'
import { PanelRail } from '../components/shared/PanelRail'
import { currentDesign, designSessionStore } from '../app/document-session/store'
import { createDefaultMapLayers, mapLayers } from '../app/map-layers/state'
import { modalLayerOpen } from '../app/shell/modal-layer'
import { readPanelTargetOverlaySnapshot } from '../app/panel-targets/presentation'
import { createAppCanvasRuntimeAppAdapter } from '../app/canvas-runtime/app-adapter'
import { mapZoomToStageScale } from '../canvas/projection'
import { createSessionPlane } from '../canvas/session-plane'
import { setCurrentCanvasSession,currentCanvasQuerySurface } from '../canvas/session'
import type { PlantDisplay } from '../canvas/runtime/plant-display'
import { createDefaultScenePersistedState } from '../canvas/runtime/scene/defaults'
import type { ScenePlantEntity } from '../canvas/runtime/scene'
import { locale } from '../app/settings/state'
import { gridVisible } from '../app/canvas-settings/signals'
import { focusOwner } from '../app/keyboard/focus-owner'
import type { CanopiFile, SavedView, Story } from '../types/design'
import type { ViewCamera } from '../canvas/runtime/view/types'
import { createTestCanvasCommandSurface, createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { replaceCurrentDesignState } from './support/design-session-state'
import { TEST_GEO_ORIGIN } from './support/geo-design'
import { framedCornersOnScreen, groundSizeShown } from './support/saved-view-frame'
import { describeSavedViewSnapshot, VIEW_SNAPSHOT_THUMBNAIL } from '../app/saved-views/snapshot'
import { readWorkspaceBackgroundPresentation } from '../app/canvas-map-surface/workspace-activation-snapshot'

function view(id: string, overrides: Partial<SavedView['visible_layers']> = {}, species: string[] = []): SavedView {
  return {
    id,
    name: `View ${id}`,
    camera: { lon: TEST_GEO_ORIGIN.lon + 0.001, lat: TEST_GEO_ORIGIN.lat, zoom: 20, bearing: 0, ground_size_m: { width: 20, height: 15 } },
    visible_layers: {
      background: { kind: 'satellite' },
      terrain: { contours: true, hillshade: false },
      scene_layers: ['plants'],
      site_data: ['dtm'],
      ...overrides,
    },
    highlighted: { species, objects: [{ kind: 'zone', id: 'zone-1' }, { kind: 'annotation', id: 'a1' }] },
    title: null,
    text: [],
  }
}

const TOUR: Story = {
  id: 'tour',
  name: 'Client visit',
  steps: [
    { id: 's1', view_id: 'site', title: 'The site', text: [{ kind: 'paragraph', spans: [{ text: 'Where water moves', bold: false, italic: false, link: null }] }], images: [] },
    { id: 's2', view_id: 'hedges', title: 'Berry hedges', text: [], images: [{ src: 'https://example.org/hedge.jpg', alt: 'The hedge in June' }] },
    { id: 's3', view_id: 'site', title: '', text: [], images: [] },
  ],
}

function design(): CanopiFile {
  return {
    version: 9, name: 'Stories', description: null, plant_species_colors: {},
    layers: [], plants: [], zones: [], annotations: [], consortiums: [], groups: [],
    timeline: [], budget: [], budget_currency: 'EUR',
    views: [
      view('site'),
      // Saved turned 45°: the step restores its bearing.
      {
        ...view('hedges', { background: { kind: 'basemap', style: 'dark' }, terrain: { contours: false, hillshade: true }, scene_layers: ['zones'], site_data: [] }, ['Lycium barbarum']),
        camera: { lon: TEST_GEO_ORIGIN.lon + 0.001, lat: TEST_GEO_ORIGIN.lat, zoom: 20, bearing: 45, ground_size_m: { width: 20, height: 15 } },
        labels: 'codes',
      },
    ],
    stories: [TOUR],
    created_at: '', updated_at: '',
    extra: {},
  }
}

let commands: ReturnType<typeof createTestCanvasCommandSurface>
let presentLayers: ReturnType<typeof vi.fn<(names: readonly string[] | null) => void>>
let focus: ReturnType<typeof vi.fn<(name: string | null) => void>>
let showPlace: ReturnType<typeof vi.fn<(place: { readonly lon: number; readonly lat: number }, zoom: number, options?: { readonly motion?: 'fly' | 'jump' }) => boolean>>
let showCamera: ReturnType<typeof vi.fn<(camera: ViewCamera, options?: { readonly motion?: 'fly' | 'jump' }) => void>>
let mapQueries: ReturnType<typeof createTestCanvasQuerySurface>

/** The camera a step of the tour shows: its view's centre, zoom 20 and bearing. */
function stepCamera(bearingDeg: number): ViewCamera {
  return { center: { lon: TEST_GEO_ORIGIN.lon + 0.001, lat: TEST_GEO_ORIGIN.lat }, zoom: 20, bearingDeg, pitchDeg: 0 }
}
let container: HTMLDivElement

function plant(id: string, canonicalName: string): ScenePlantEntity {
  return {
    kind: 'plant', id, locked: false, canonicalName, commonName: null, color: null,
    canopySpreadM: null, position: { x: 0, y: 0 }, rotationDeg: null, notes: null, plantedDate: null, quantity: 1,
  }
}

function mountMap(planted: readonly ScenePlantEntity[] = [plant('p1', 'Lycium barbarum')]): void {
  const queries = createTestCanvasQuerySurface({
    scene: { ...createDefaultScenePersistedState(), plants: [...planted] },
    placement: { x: 200, y: 150, scale: mapZoomToStageScale(18, TEST_GEO_ORIGIN.lat) },
    sessionPlane: createSessionPlane(TEST_GEO_ORIGIN),
  })
  queries.getSpeciesFocus = () => ({ canonicalName: 'Malus domestica' })
  queries.getLocalizedCommonNames = () => new Map([['Lycium barbarum', 'Goji']])
  commands = createTestCanvasCommandSurface()
  presentLayers = vi.fn()
  focus = vi.fn()
  showPlace = vi.fn(() => true)
  showCamera = vi.fn()
  commands.layers.presentLayers = presentLayers
  commands.speciesFocus.focus = focus
  commands.viewport.showPlace = showPlace
  commands.viewport.showCamera = showCamera
  mapQueries = queries
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ commands, queries }))
}

/** The map's live screen, which a test resizes, and its settled frame, which it settles: full screen ending, say. */
function resizableMap(width: number, height: number) {
  const base = mapQueries.view
  let screen = { width, height, devicePixelRatio: 1 }
  const settledRevision = signal(0)
  const view = { ...base, settledRevision, captureView: () => ({ ...base.captureView(), screen }) }
  setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({ commands, queries: { ...mapQueries, view } }))
  return {
    resize(nextWidth: number, nextHeight: number) { screen = { width: nextWidth, height: nextHeight, devicePixelRatio: 1 } },
    settle() { settledRevision.value += 1 },
  }
}

/** The tour with its hedges step framed in a `width` × `height` window at `bearing`. */
function framedTour(width: number, height: number, bearing: number): CanopiFile {
  const tour = design()
  const hedges = tour.views![1]!
  const camera = { ...hedges.camera, bearing }
  tour.views![1] = { ...hedges, camera: { ...camera, ground_size_m: groundSizeShown(camera, { width, height }) } }
  return tour
}

beforeEach(() => {
  locale.value = 'en'
  replaceCurrentDesignState(design(), null, 'Stories')
  designSessionStore.resetDirtyBaselines()
  mountMap()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  leaveStoryPresentation()
  render(null, container)
  document.body.replaceChildren()
  setCurrentCanvasSession(null)
  mapLayers.value = createDefaultMapLayers()
})

describe('presenting a story', () => {
  it('applies a step’s view as session overrides and never touches the Design', () => {
    const before = currentDesign.value
    const revision = designSessionStore.committedDesignRevision.value
    const userLayers = mapLayers.value

    expect(presentStory('tour', 1)).toBe(true)

    expect(storyPresentationActive.value).toBe(true)
    expect(presentedStep.value?.step.id).toBe('s2')
    const presented = presentedMapLayers()
    expect(presented.basemap).toMatchObject({ visible: true, style: 'dark' })
    expect(presented.satellite.visible).toBe(false)
    expect(presented.contours.visible).toBe(false)
    expect(presented.hillshade.visible).toBe(true)
    expect(storyPresentationOverrides.value?.plantLabels).toBe('codes')
    expect([...storyPresentationOverrides.value!.siteDataIds]).toEqual([])
    expect(readPanelTargetOverlaySnapshot().selectedTargets).toEqual([
      { kind: 'species', canonical_name: 'Lycium barbarum' },
      { kind: 'zone', zone_id: 'zone-1' },
    ])
    expect(presentLayers).toHaveBeenLastCalledWith(['zones'])
    expect(focus).toHaveBeenLastCalledWith('Lycium barbarum')
    expect(showCamera).toHaveBeenLastCalledWith(stepCamera(45), { motion: 'fly' })
    expect(showPlace).not.toHaveBeenCalled()
    expect(document.documentElement.hasAttribute('data-story-presenting')).toBe(true)

    expect(mapLayers.value).toBe(userLayers)
    expect(currentDesign.value).toBe(before)
    expect(designSessionStore.designDirty.value).toBe(false)
    expect(designSessionStore.committedDesignRevision.value).toBe(revision)
  })

  it('clears the highlight for a step whose species has no plants instead of keeping the previous one', () => {
    setCurrentCanvasSession(null)
    mountMap([])
    presentStory('tour', 1)
    expect(focus).toHaveBeenLastCalledWith(null)
  })

  it('flies between steps; the camera driver alone jumps under reduced motion', () => {
    presentStory('tour', 0)
    expect(showCamera).toHaveBeenLastCalledWith(stepCamera(0), { motion: 'fly' })
  })

  it('a story step saved at 30 keeps its frame on a smaller screen', () => {
    // Framed in a 1400 × 900 window, presented on the 400 × 300 map: zoomed out until the width (400 / 1400 < 300 / 900) fits.
    replaceCurrentDesignState(framedTour(1400, 900, 30), null, 'Stories')
    presentStory('tour', 1)

    const [shown] = showCamera.mock.calls.at(-1)!
    expect(shown.bearingDeg).toBe(30)
    expect(shown.zoom).toBeCloseTo(20 + Math.log2(400 / 1400), 6)
    const saved = presentedStep.value!.view!.camera
    for (const corner of framedCornersOnScreen(saved, { width: 1400, height: 900 }, shown, { width: 400, height: 300 })) {
      expect(corner.x).toBeGreaterThanOrEqual(-1e-6)
      expect(corner.x).toBeLessThanOrEqual(400 + 1e-6)
      expect(corner.y).toBeGreaterThanOrEqual(-1e-6)
      expect(corner.y).toBeLessThanOrEqual(300 + 1e-6)
    }
  })

  it('a story step keeps its frame when full screen ends', () => {
    // Framed in the full-screen 400 × 300 map; full screen ends and the map settles at 200 × 150.
    replaceCurrentDesignState(framedTour(400, 300, 45), null, 'Stories')
    const map = resizableMap(400, 300)
    presentStory('tour', 1)
    expect(showCamera).toHaveBeenLastCalledWith(stepCamera(45), { motion: 'fly' })
    showCamera.mockClear()

    // A settle at the same size, or a resize still in progress, refits nothing.
    map.settle()
    map.resize(300, 200)
    expect(showCamera).not.toHaveBeenCalled()
    map.resize(200, 150)
    map.settle()

    expect(showCamera).toHaveBeenCalledTimes(1)
    expect(showCamera).toHaveBeenCalledWith({ ...stepCamera(45), zoom: 19 }, { motion: 'jump' })
    // Every step's view records its frame, so another step is fitted again too; one framed smaller than both maps keeps its zoom.
    goToPresentedStep(0)
    showCamera.mockClear()
    map.resize(400, 300)
    map.settle()
    expect(showCamera).toHaveBeenCalledTimes(1)
    expect(showCamera).toHaveBeenCalledWith(stepCamera(0), { motion: 'jump' })
  })

  it('moves between steps within the story', () => {
    presentStory('tour', 0)
    previousPresentedStep()
    expect(presentedStep.value?.index).toBe(0)
    nextPresentedStep()
    nextPresentedStep()
    expect(presentedStep.value?.index).toBe(2)
    nextPresentedStep()
    expect(presentedStep.value?.index).toBe(2)
    goToPresentedStep(1)
    expect(presentedStep.value?.step.id).toBe('s2')
    goToPresentedStep(7)
    expect(presentedStep.value?.step.id).toBe('s2')
  })

  it('restores the user’s state exactly on leaving: layers, site data, labels, focus, camera', () => {
    const camera = mapQueries.view.captureView().camera
    presentStory('tour', 1)
    showCamera.mockClear()

    leaveStoryPresentation()

    expect(storyPresentationActive.value).toBe(false)
    expect(storyPresentationOverrides.value).toBeNull()
    expect(presentedMapLayers()).toBe(mapLayers.value)
    expect(presentLayers).toHaveBeenLastCalledWith(null)
    expect(focus).toHaveBeenLastCalledWith('Malus domestica')
    expect(showCamera).toHaveBeenCalledTimes(1)
    expect(showCamera).toHaveBeenCalledWith(camera, { motion: 'jump' })
    expect(showCamera.mock.calls[0]![0].zoom).toBeCloseTo(18, 6)
    expect(document.documentElement.hasAttribute('data-story-presenting')).toBe(false)
    expect(designSessionStore.designDirty.value).toBe(false)
  })

  it('restore after presenting returns the camera with its bearing', () => {
    // The user had turned the view 30° before presenting.
    const live = mapQueries.view.captureView()
    const turned = { ...live, camera: { ...live.camera, bearingDeg: 30 } }
    vi.spyOn(mapQueries.view, 'captureView').mockReturnValue(turned)
    presentStory('tour', 1)
    expect(showCamera).toHaveBeenLastCalledWith(stepCamera(45), { motion: 'fly' })

    leaveStoryPresentation()

    expect(showCamera).toHaveBeenLastCalledWith(turned.camera, { motion: 'jump' })
    expect(showPlace).not.toHaveBeenCalled()
  })

  it('ends without moving the camera when another Design replaces this one', async () => {
    presentStory('tour', 0)
    showPlace.mockClear()
    showCamera.mockClear()

    replaceCurrentDesignState(design(), null, 'Other')
    await Promise.resolve()

    expect(storyPresentationActive.value).toBe(false)
    expect(presentLayers).toHaveBeenLastCalledWith(null)
    expect(showPlace).not.toHaveBeenCalled()
    expect(showCamera).not.toHaveBeenCalled()
    expect(storyPresentationOverrides.value).toBeNull()
  })

  it('ends when its story goes away, and cannot present a story without steps or a map', async () => {
    presentStory('tour', 0)
    replaceCurrentDesignState({ ...design(), stories: [] }, null, 'Stories')
    await Promise.resolve()
    expect(storyPresentationActive.value).toBe(false)

    replaceCurrentDesignState({ ...design(), stories: [{ id: 'empty', name: 'Empty', steps: [] }] }, null, 'Stories')
    expect(presentStory('empty')).toBe(false)
    setCurrentCanvasSession(null)
    replaceCurrentDesignState(design(), null, 'Stories')
    expect(presentStory('tour')).toBe(false)
  })

  it('shows the step’s labels to the map and hides the grid, then gives it back', () => {
    const adapter = createAppCanvasRuntimeAppAdapter({ presentationData: {} as never })
    const displays: PlantDisplay[] = []
    const dispose = adapter.plantDisplay!.subscribe((display) => { displays.push(display) })
    gridVisible.value = true
    const overlay = () => adapter.settings.readChromeOverlay()
    const before = overlay()
    expect(before.gridVisible).toBe(true)

    presentStory('tour', 1)
    expect(displays.at(-1)?.labels).toBe('codes')
    expect(overlay()).toEqual({ gridVisible: false })

    leaveStoryPresentation()
    expect(displays.at(-1)?.labels).toBe('names')
    expect(overlay()).toEqual(before)
    dispose()
    gridVisible.value = false
  })

  it('hides the editing aids for the whole presentation, whatever a step overrides', () => {
    const adapter = createAppCanvasRuntimeAppAdapter({ presentationData: {} as never })
    gridVisible.value = true
    // No command surface: no step applies its overrides, yet the aids stay hidden.
    setCurrentCanvasSession({ ...createTestCanvasRuntimeSurfaces({ queries: currentCanvasQuerySurface.peek()! }), commands: null as never })
    try {
      presentStory('tour', 0)
      expect(storyPresentationOverrides.value).toBeNull()
      expect(storyPresentationHidesEditingAids.value).toBe(true)
      expect(adapter.settings.readChromeOverlay()).toEqual({ gridVisible: false })
      leaveStoryPresentation()
      expect(storyPresentationHidesEditingAids.value).toBe(false)
      expect(adapter.settings.readChromeOverlay()).toEqual({ gridVisible: true })
      expect(gridVisible.value).toBe(true)
    } finally {
      gridVisible.value = false
    }
  })

  it('gives focus back to the map when the presentation did not start from a Present button', async () => {
    const map = document.createElement('div')
    map.tabIndex = 0
    document.body.append(map)
    const release = focusOwner.registerRegion('map', map)
    try {
      presentStory('tour', 0)
      leaveStoryPresentation()
      await vi.waitFor(() => expect(document.activeElement).toBe(map))
    } finally {
      release()
    }
  })
})

describe('a story step and its view’s thumbnail', () => {
  it('draw the same background band over the user’s own opacities, style and locale', () => {
    const views = [
      view('satellite'),
      view('dark', { background: { kind: 'basemap', style: 'dark' } }),
      view('retired', { background: { kind: 'basemap', style: 'retired' } }),
      view('none', { background: { kind: 'none' }, terrain: { contours: false, hillshade: true } }),
    ]
    replaceCurrentDesignState({
      ...design(),
      views,
      stories: [{
        id: 'all',
        name: 'Every background',
        steps: views.map((shown, index) => ({ id: `s${index}`, view_id: shown.id, title: '', text: [], images: [] })),
      }],
    }, null, 'Stories')
    const defaults = createDefaultMapLayers()
    mapLayers.value = {
      ...defaults,
      basemap: { style: 'positron', visible: false, opacity: 0.7 },
      satellite: { visible: true, opacity: 0.6 },
      softenBackground: true,
    }
    locale.value = 'de'

    views.forEach((shown, index) => {
      expect(presentStory('all', index)).toBe(true)
      const thumbnail = describeSavedViewSnapshot(shown, VIEW_SNAPSHOT_THUMBNAIL, {
        queries: mapQueries,
        mapLayers: mapLayers.value,
        locale: locale.value,
        plantLabels: 'names',
      })
      expect(readWorkspaceBackgroundPresentation(), shown.id).toEqual(thumbnail?.background)
    })
  })
})

describe('the presenter', () => {
  async function present(index = 0): Promise<HTMLElement> {
    await act(async () => {
      presentStory('tour', index)
      render(<StoryPresenter />, container)
    })
    return container.querySelector<HTMLElement>('[data-story-presenter]')!
  }

  function key(target: Element, keyName: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }

  it('is a modal card with the story, the step and its text, and starts on Next', async () => {
    const presenter = await present(1)
    expect(presenter.getAttribute('role')).toBe('dialog')
    expect(presenter.getAttribute('aria-label')).toBe('Presenting Client visit')
    expect(modalLayerOpen.value).toBe(true)
    expect(presenter.querySelector('h1')?.textContent).toBe('Berry hedges')
    expect(presenter.textContent).toContain('Client visit · Step 2 of 3')
    expect(presenter.querySelector('img')?.getAttribute('alt')).toBe('The hedge in June')
    expect(presenter.textContent).toContain('Goji · 0 plants')
    expect(document.activeElement?.textContent).toContain('Next')
    expect(presenter.querySelector('[role="status"]')?.textContent).toBe('Step 2 of 3: Berry hedges')
    const dots = [...presenter.querySelectorAll<HTMLButtonElement>('nav button[aria-label^="Step"]')]
    expect(dots.map((dot) => dot.getAttribute('aria-label'))).toEqual(['Step 1: The site', 'Step 2: Berry hedges', 'Step 3: Untitled step'])
    expect(dots[1]!.getAttribute('aria-current')).toBe('step')
  })

  it('moves with the arrow keys, Space away from buttons, the dots and Previous/Next, and leaves with Esc', async () => {
    const presenter = await present(0)
    await act(async () => { key(presenter, 'ArrowRight') })
    expect(presentedStep.value?.index).toBe(1)
    await act(async () => { key(presenter, 'ArrowLeft') })
    expect(presentedStep.value?.index).toBe(0)
    await act(async () => { key(presenter.querySelector('h1')!, ' ') })
    expect(presentedStep.value?.index).toBe(1)
    // Space on a focused button presses it instead.
    const spaceOnButton = key(presenter.querySelector('button')!, ' ')
    expect(spaceOnButton.defaultPrevented).toBe(false)
    await act(async () => { presenter.querySelector<HTMLButtonElement>('nav button[aria-label="Step 3: Untitled step"]')!.click() })
    expect(presentedStep.value?.index).toBe(2)
    expect(presenter.querySelector('[role="status"]')?.textContent).toBe('Step 3 of 3: Untitled step')
    await act(async () => { key(presenter, 'ArrowRight') })
    expect(presentedStep.value?.index).toBe(2)

    await act(async () => { key(presenter, 'Escape') })
    expect(storyPresentationActive.value).toBe(false)
    expect(container.querySelector('[data-story-presenter]')).toBeNull()
    expect(modalLayerOpen.value).toBe(false)
  })

  it('offers Finish instead of Next on the last step, which leaves the presentation', async () => {
    const presenter = await present(1)
    const next = document.activeElement as HTMLButtonElement
    expect(next.textContent).toBe('Next')
    await act(async () => { next.click() })
    expect(presentedStep.value?.index).toBe(2)
    // The same button, so focus stays on it.
    expect(document.activeElement).toBe(next)
    expect(next.textContent).toBe('Finish')
    expect(next.hasAttribute('aria-disabled')).toBe(false)
    expect(presenter.querySelector('nav')?.textContent).not.toContain('Next')
    await act(async () => { next.click() })
    expect(storyPresentationActive.value).toBe(false)
    expect(container.querySelector('[data-story-presenter]')).toBeNull()
  })

  it('starts on Finish in a story with one step', async () => {
    replaceCurrentDesignState({ ...design(), stories: [{ ...TOUR, steps: [TOUR.steps[0]!] }] }, null, 'Stories')
    await present(0)
    expect(document.activeElement?.textContent).toBe('Finish')
    const previous = [...container.querySelectorAll<HTMLButtonElement>('nav button')][0]!
    expect(previous.getAttribute('aria-disabled')).toBe('true')
  })

  it('jumps to the first and last steps with Home and End, and pages with PageUp and PageDown', async () => {
    const presenter = await present(1)
    await act(async () => { key(presenter, 'End') })
    expect(presentedStep.value?.index).toBe(2)
    await act(async () => { key(presenter, 'Home') })
    expect(presentedStep.value?.index).toBe(0)
    await act(async () => { key(presenter, 'PageDown') })
    expect(presentedStep.value?.index).toBe(1)
    await act(async () => { key(presenter, 'PageUp') })
    expect(presentedStep.value?.index).toBe(0)
    // Modified keys belong to the browser.
    await act(async () => { key(presenter, 'ArrowRight', { ctrlKey: true }) })
    expect(presentedStep.value?.index).toBe(0)
  })

  it('goes full screen with the button or F where the window allows it, and leaves it on Leave', async () => {
    const requestFullscreen = vi.fn(async () => {
      Object.defineProperty(document, 'fullscreenElement', { value: document.documentElement, configurable: true })
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    const exitFullscreen = vi.fn(async () => {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    Object.defineProperty(document.documentElement, 'requestFullscreen', { value: requestFullscreen, configurable: true })
    Object.defineProperty(document, 'exitFullscreen', { value: exitFullscreen, configurable: true })
    try {
      const presenter = await present(0)
      const toggle = presenter.querySelector<HTMLButtonElement>('button[aria-label="Full screen"]')!
      await act(async () => { toggle.click() })
      expect(requestFullscreen).toHaveBeenCalledTimes(1)
      expect(presenter.querySelector('button[aria-label="Exit full screen"]')?.getAttribute('aria-pressed')).toBe('true')
      await act(async () => { key(presenter, 'f') })
      expect(exitFullscreen).toHaveBeenCalledTimes(1)
      await act(async () => { key(presenter, 'F') })
      expect(requestFullscreen).toHaveBeenCalledTimes(2)

      await act(async () => { presenter.querySelector<HTMLButtonElement>('[data-presenter-leave]')!.click() })
      expect(exitFullscreen).toHaveBeenCalledTimes(2)
      expect(storyPresentationActive.value).toBe(false)
    } finally {
      Object.defineProperty(document, 'fullscreenEnabled', { value: false, configurable: true })
    }
  })

  it('leaves full screen when the presentation ended while the window was still entering it', async () => {
    let enter!: () => void
    const requestFullscreen = vi.fn(() => new Promise<void>((resolve) => {
      enter = () => {
        Object.defineProperty(document, 'fullscreenElement', { value: document.documentElement, configurable: true })
        document.dispatchEvent(new Event('fullscreenchange'))
        resolve()
      }
    }))
    const exitFullscreen = vi.fn(async () => {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    Object.defineProperty(document.documentElement, 'requestFullscreen', { value: requestFullscreen, configurable: true })
    Object.defineProperty(document, 'exitFullscreen', { value: exitFullscreen, configurable: true })
    try {
      const presenter = await present(0)
      await act(async () => { key(presenter, 'f') })
      expect(requestFullscreen).toHaveBeenCalledTimes(1)
      await act(async () => { key(presenter, 'Escape') })
      expect(storyPresentationActive.value).toBe(false)
      expect(exitFullscreen).not.toHaveBeenCalled()

      await act(async () => { enter() })
      expect(exitFullscreen).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(document, 'fullscreenEnabled', { value: false, configurable: true })
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    }
  })

  it('offers no full screen where the window cannot go full screen', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: false, configurable: true })
    const presenter = await present(0)
    expect(presenter.querySelector('button[aria-label="Full screen"]')).toBeNull()
    const event = key(presenter, 'f')
    expect(event.defaultPrevented).toBe(false)
  })

  it('keeps Tab inside the presenter', async () => {
    const presenter = await present(0)
    const controls = [...presenter.querySelectorAll<HTMLElement>('button, a[href]')]
    controls.at(-1)!.focus()
    await act(async () => { key(controls.at(-1)!, 'Tab') })
    expect(document.activeElement).toBe(controls[0])
    await act(async () => { key(controls[0]!, 'Tab', { shiftKey: true }) })
    expect(document.activeElement).toBe(controls.at(-1))
  })

  describe('over a map notice', () => {
    const failed = (): MapNoticeReadModel => ({
      visible: true, mapSurfaceVisible: true, tone: 'error', statusText: t('canvas.layers.basemapFailed'), retry: true,
    })
    const loading = (): MapNoticeReadModel => ({ ...failed(), tone: 'loading', statusText: t('canvas.layers.basemapLoading'), retry: false })
    const hidden = (): MapNoticeReadModel => ({ ...loading(), visible: false, tone: 'ready', statusText: '' })

    /** The canvas's notice (either edition passes its own map's retry) beside the presenter, as the workspace draws them. */
    function workspace(notice: MapNoticeReadModel, retry: () => void) {
      const canvas = { current: document.body as HTMLElement }
      return (
        <>
          <div data-canvas><MapNotice notice={notice} onRetry={retry} canvasRef={canvas} /></div>
          <StoryPresenter />
        </>
      )
    }

    function retryIn(scope: Element | null): HTMLButtonElement | undefined {
      return [...scope?.querySelectorAll<HTMLButtonElement>('[data-map-notice] button') ?? []]
        .find((button) => button.textContent === t('canvas.layers.retryMap'))
    }

    it('draws the notice and a working Retry inside its own layer while the canvas draws none, and gives it back on leaving', async () => {
      const retry = vi.fn()
      await act(async () => { render(workspace(failed(), retry), container) })
      expect(retryIn(container.querySelector('[data-canvas]'))).toBeDefined()

      await act(async () => { presentStory('tour', 0) })
      const presenter = container.querySelector<HTMLElement>('[data-story-presenter]')!
      expect(container.querySelector('[data-canvas] [data-map-notice]'), 'the canvas draws no notice under the presenter').toBeNull()
      const notice = presenter.querySelector<HTMLElement>('[data-map-notice]')
      expect(notice?.querySelector('[role="status"]')?.textContent).toBe(t('canvas.layers.basemapFailed'))
      await act(async () => { retryIn(presenter)!.click() })
      expect(retry).toHaveBeenCalledOnce()

      await act(async () => { key(presenter, 'Escape') })
      expect(container.querySelector('[data-story-presenter]')).toBeNull()
      expect(retryIn(container.querySelector('[data-canvas]')), 'Retry is back on the canvas').toBeDefined()
    })

    it('keeps Retry inside its Tab cycle', async () => {
      await act(async () => { render(workspace(failed(), () => {}), container) })
      await act(async () => { presentStory('tour', 0) })
      const presenter = container.querySelector<HTMLElement>('[data-story-presenter]')!
      const controls = [...presenter.querySelectorAll<HTMLElement>('button, a[href]')]
      const retry = retryIn(presenter)!
      expect(controls).toContain(retry)
      // Tab from the cycle's last control returns to its first, and Shift+Tab from the first reaches the last.
      controls.at(-1)!.focus()
      await act(async () => { key(controls.at(-1)!, 'Tab') })
      expect(document.activeElement).toBe(controls[0])
      await act(async () => { key(controls[0]!, 'Tab', { shiftKey: true }) })
      expect(document.activeElement).toBe(controls.at(-1))
      expect(presenter.contains(retry)).toBe(true)
    })

    it('keeps Tab inside the presenter from the notice that holds focus after Retry, and Shift+Tab from the presenter itself', async () => {
      await act(async () => { render(workspace(failed(), () => {}), container) })
      await act(async () => { presentStory('tour', 0) })
      const presenter = container.querySelector<HTMLElement>('[data-story-presenter]')!
      const button = retryIn(presenter)!
      button.focus()
      await act(async () => { button.click() })
      await act(async () => { render(workspace(loading(), () => {}), container) })
      const chip = presenter.querySelector<HTMLElement>('[data-map-notice]')!
      expect(document.activeElement).toBe(chip)
      const controls = [...presenter.querySelectorAll<HTMLElement>('button, a[href]')]

      // The chip follows every control, so Tab would leave the page: it wraps to the first control instead.
      let event!: KeyboardEvent
      await act(async () => { event = key(chip, 'Tab') })
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(controls[0])

      // The presenter itself (focused after a press on the map) precedes every control, so Shift+Tab wraps to the last.
      presenter.focus()
      await act(async () => { event = key(presenter, 'Tab', { shiftKey: true }) })
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(controls.at(-1))
    })

    it('keeps focus in the presenter when Retry goes away, and when the notice goes once the map recovers', async () => {
      const retry = vi.fn()
      await act(async () => { render(workspace(failed(), retry), container) })
      await act(async () => { presentStory('tour', 0) })
      const presenter = container.querySelector<HTMLElement>('[data-story-presenter]')!
      const button = retryIn(presenter)!
      button.focus()
      await act(async () => { button.click() })
      await act(async () => { render(workspace(loading(), retry), container) })
      expect(document.activeElement).toBe(presenter.querySelector('[data-map-notice]'))

      await act(async () => { render(workspace(hidden(), retry), container) })
      expect(presenter.querySelector('[data-map-notice]')).toBeNull()
      expect(document.activeElement).toBe(presenter)
    })
  })

  it('moves by swiping on a touch screen', async () => {
    const presenter = await present(1)
    const pointer = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX, clientY: 400 }) as MouseEvent & { pointerId: number; pointerType: string }
      Object.defineProperty(event, 'pointerId', { value: 3 })
      Object.defineProperty(event, 'pointerType', { value: 'touch' })
      return event
    }
    await act(async () => {
      presenter.dispatchEvent(pointer('pointerdown', 300))
      presenter.dispatchEvent(pointer('pointerup', 200))
    })
    expect(presentedStep.value?.index).toBe(2)
    await act(async () => {
      presenter.dispatchEvent(pointer('pointerdown', 100))
      presenter.dispatchEvent(pointer('pointerup', 300))
    })
    expect(presentedStep.value?.index).toBe(1)
    await act(async () => {
      presenter.dispatchEvent(pointer('pointerdown', 100))
      presenter.dispatchEvent(pointer('pointerup', 120))
    })
    expect(presentedStep.value?.index).toBe(1)
  })

  it('hides the editing chrome while presenting', async () => {
    await act(async () => {
      render(<PanelRail label="Panels" groups={[[{ id: 'nav.layers', label: 'Layers', disabled: false, panel: 'layers', action: () => undefined }]]} />, container)
    })
    expect(container.querySelector('nav')).not.toBeNull()
    await act(async () => { presentStory('tour', 0) })
    expect(container.querySelector('nav')).toBeNull()
    await act(async () => { leaveStoryPresentation() })
    expect(container.querySelector('nav')).not.toBeNull()
  })
})
