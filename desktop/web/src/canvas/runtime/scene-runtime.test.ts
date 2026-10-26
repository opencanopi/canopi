// @vitest-environment jsdom

import type { SceneRendererSnapshot, SceneRenderTarget } from './renderers/scene-types'
import type { DraftPresentation } from './tools/draft'
import type { ViewFrame } from './view/types'
import { planarCameraOf } from './view/view-transform'
import { roundGeoPosition } from './scene/geo-frame'
import { effect } from '@preact/signals'
import { stageScaleToMapZoom } from '../projection'
import { DEFAULT_NEW_DESIGN_VIEW } from '../session-plane'
import { getMapBackdropInk, type CanvasMapBackdrop } from './scene-visuals'
import type { SceneRuntimePresentationController,ScenePresentationRefreshResult } from './scene-runtime/presentation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../__tests__/support/camera-tolerance'

vi.mock('../../ipc/species', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../ipc/species')>(),
  getSpeciesBatch: vi.fn(async () => []),
  getFlowerColorBatch: vi.fn(async () => []),
  getCommonNames: vi.fn(async () => ({})),
}))
// The Desktop adapter reads labels from the live workbench, whose cache would
// outlive a test; answer straight from the mocked lookup instead.
vi.mock('../../app/plant-browser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../app/plant-browser')>()
  const { getCommonNames: lookup } = await import('../../ipc/species')
  return {
    ...original,
    speciesCatalogWorkbench: {
      ...original.speciesCatalogWorkbench,
      resolveDisplayNames: async (names: readonly string[], locale: string) => ({ names: await lookup([...names], locale), englishFallbacks: [] }),
    },
  }
})
import {
  snapToGridEnabled,
} from '../../app/canvas-settings/signals'
import { plantColorMenuOpen } from '../plant-color-menu-state'
import {
  clearPlantStampSource,
  readPlantStampSource,
  selectPlantStampSource,
} from '../plant-stamp-source'
import {
  clearSavedObjectStampSource,
  selectSavedObjectStampSource,
} from '../saved-object-stamp-source'
import { currentCanvasTool, currentCanvasToolGuidance, currentCanvasSelection } from '../session-state'
import {
  hoveredCanvasTargets,
  hoveredPanelTargets,
  selectedPanelTargetOrigin,
  selectedPanelTargets,
} from '../../app/panel-targets/state'
import { createAppCanvasRuntimeAppAdapter } from '../../app/canvas-runtime/app-adapter'
import { setStoryPresentationOverrides } from '../../app/story-presentation/overrides'
import { mapLayers } from '../../app/map-layers/state'
import { canvasContextMenuRequest } from '../../app/canvas-context-menu/state'
import { buildCanvasContextMenuEntries, type CanvasContextMenuCommand } from '../../app/canvas-context-menu/entries'
import { createDesktopCanvasRuntimeAppAdapter } from '../../app/canvas-runtime/desktop-adapter'
import { createAppSceneRuntimePanelTargetAdapter } from '../../app/canvas-runtime/panel-target-adapter'
import { locale, plantSpacingIntervalM } from '../../app/settings/state'
import type { CanopiFile, PanelTarget } from '../../types/design'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import { geoAt } from '../../__tests__/support/geo-design'
import { installCanvasKeyRouter } from '../../__tests__/support/key-router'
import { placeOnHost } from '../../__tests__/support/test-view'
import { createTestRendererView } from '../../__tests__/support/scene-renderer-snapshot'
import { speciesTarget } from '../../target'
import {
  CanvasDocumentReplacementNotAdmittedError,
  createCanvasDocumentReplacementToken,
} from './runtime'
import { SceneCanvasRuntime } from './scene-runtime.ts'
import { projectScenePlantLabels } from './selection-labels'
import type { SceneRuntimePanelTargetAdapter } from './scene-runtime/panel-target-adapter'
import {
  SceneEditBusyError,
  type SceneEditCoordinator,
  type SceneEditTransaction,
} from './scene-runtime/transactions'
import {
  createDetachedCanvasRuntimeAppAdapter,
  type CanvasRuntimeAppAdapter,
  type CanvasRuntimeDocumentCompositionInput,
  type CanvasRuntimeSettingsAdapter,
} from './app-adapter'
import { getCommonNames } from '../../ipc/species'

/** Toggled from inside a test to make the real Rectangle tool's activation throw. */
const rectangleActivation = vi.hoisted(() => ({ fails: false, deactivateFails: false }))
vi.mock('./tools/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/registry')>()
  return {
    ...actual,
    TOOL_REGISTRY: {
      ...actual.TOOL_REGISTRY,
      rectangle: () => {
        const tool = actual.TOOL_REGISTRY.rectangle!()
        const deactivate = tool.deactivate.bind(tool)
        tool.deactivate = (...args) => {
          if (rectangleActivation.deactivateFails) throw new Error('deactivation failed')
          return deactivate(...args)
        }
        if (!rectangleActivation.fails) return tool
        return { ...tool, activate: () => { throw new Error('activation failed') } }
      },
    },
  }
})
import { t } from '../../i18n'
import { createSceneInteractionEventHarness } from '../../__tests__/support/canvas-interaction-events'
import type { CameraDriverHostController } from './view/driver-host'

// Fixtures are authored in metres around the equator, where Mercator scale is
// stationary, so re-centring the session plane on them keeps their metre
// distances exact to well below the tools' 1 µm tolerances.
const FIXTURE_ORIGIN = { lon: 0, lat: 0 }
const at = (x: number, y: number) => geoAt(x, y, FIXTURE_ORIGIN)

const plantTarget = (id: string) => ({ kind: 'plant' as const, id })
const zoneTarget = (id: string) => ({ kind: 'zone' as const, id })

function makeFile(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Runtime demo',
    description: null,
    plant_species_colors: {},
    layers: [
      { name: 'plants', visible: true, locked: false, opacity: 1 },
      { name: 'zones', visible: true, locked: false, opacity: 1 },
    ],
    plants: [
      {
        id: 'plant-1',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        position: at(10, 10),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
      {
        id: 'plant-2',
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        position: at(20, 20),
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
        locked: false,
      },
    ],
    zones: [
      {
        id: 'zone-1', name: null,
        zone_type: 'rect',
        rotation: 0,
        points: [
          at(0, 0),
          at(5, 0),
          at(5, 5),
          at(0, 5),
        ],
        fill_color: null,
        notes: null,
        locked: false,
      },
    ],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    extra: {},
  }
}

function fileWithOnlyPlants(...ids: string[]): CanopiFile {
  const file = makeFile()
  return {
    ...file,
    plants: file.plants.filter((plant) => ids.includes(plant.id)),
    zones: [],
    annotations: [],
    groups: [],
  }
}

function fileWithOnlyAnnotation(text: string): CanopiFile {
  const file = makeFile()
  return {
    ...file,
    plants: [],
    zones: [],
    annotations: [{
      id: 'annotation-1',
      annotation_type: 'text',
      position: at(24, 32),
      text,
      font_size: 20,
      rotation: null,
      locked: false,
    }],
    groups: [],
    layers: [
      { name: 'annotations', visible: true, locked: false, opacity: 1 },
    ],
  }
}

function fileWithOnlyZone(zone: CanopiFile['zones'][number] = makeFile().zones[0]!): CanopiFile {
  const file = makeFile()
  return {
    ...file,
    plants: [],
    zones: [zone],
    annotations: [],
    groups: [],
  }
}

type TestMeasurementGuideFileEntity = NonNullable<CanopiFile['measurement_guides']>[number]

function fileWithMeasurementGuide(overrides: Partial<TestMeasurementGuideFileEntity> = {}): CanopiFile {
  const file = makeFile()
  return {
    ...file,
    plants: [],
    zones: [],
    annotations: [],
    groups: [],
    layers: [
      { name: 'plants', visible: true, locked: false, opacity: 1 },
      { name: 'zones', visible: true, locked: false, opacity: 1 },
      { name: 'annotations', visible: true, locked: false, opacity: 1 },
      { name: 'measurement-guides', visible: true, locked: false, opacity: 1 },
    ],
    measurement_guides: [{
      id: 'measurement-guide-1',
      locked: false,
      start: at(10, 10),
      end: at(40, 10),
      ...overrides,
    }],
  }
}

function fileWithGroupedPair(): CanopiFile {
  const file = makeFile()
  file.zones = []
  file.groups = [
    {
      id: 'group-1',
      name: null,
      locked: false,
      members: [
        { kind: 'plant', id: 'plant-1' },
        { kind: 'plant', id: 'plant-2' },
      ],
    },
  ]
  return file
}

/** The runtime's render target, as the map's shared scene layer fills its slot. */
function createRendererStub() {
  return {
    setSnapshot: vi.fn<(snapshot: SceneRendererSnapshot) => void>(),
    // The draft sink the runtime hands the session (ToolHostDeps.renderer): drafts and the host's chips draw in Pixi.
    setDraft: vi.fn<(draft: DraftPresentation | null) => void>(),
    requestRender: vi.fn<() => void>(),
  } satisfies SceneRenderTarget
}

type RendererStub = ReturnType<typeof createRendererStub>

/** The runtime camera's live frame. */
function frameOf(runtime: SceneCanvasRuntime): ViewFrame {
  return runtime.cameraHost.frames.viewFrame.peek()
}

/** A placement on the runtime's live camera, bearing 0, through the runtime's plane. */
function placeOn(runtime: SceneCanvasRuntime, placement: { x: number; y: number; scale: number }): void {
  placeOnHost(runtime.cameraHost, runtime.querySurface.sessionPlane.peek()!, placement)
}

/** A pan of the runtime's live camera, as a map gesture moves it. */
function panOn(runtime: SceneCanvasRuntime, deltaPx: { x: number; y: number }): void {
  runtime.cameraHost.current().apply({ kind: 'pan-by', deltaPx })
}

/** The runtime camera's bearing-0 placement: the plane origin's screen point and the scale. */
function placementOf(runtime: SceneCanvasRuntime): { x: number; y: number; scale: number } {
  const { x, y, scale } = planarCameraOf(frameOf(runtime).view)
  return { x, y, scale }
}

/** The last draft the runtime handed its renderer, or null. */
function lastDraft(renderer: RendererStub): DraftPresentation | null {
  return renderer.setDraft.mock.calls.at(-1)?.[0] ?? null
}

/** The chips of the last draft (the zone measurement labels), in draw order. */
function draftLabelTexts(renderer: RendererStub): string[] {
  return lastDraft(renderer)?.shapes.flatMap((shape) => (shape.kind === 'label' ? [shape.text] : [])) ?? []
}

/** The polygon draft's rubber band, in plane metres; null without one. */
function draftBand(renderer: RendererStub): readonly { x: number; y: number }[] | null {
  const band = lastDraft(renderer)?.shapes.find((shape) => shape.kind === 'polyline')
  return band?.kind === 'polyline' ? band.points : null
}

function expectBandNear(
  runtime: SceneCanvasRuntime,
  band: readonly { x: number; y: number }[] | null,
  points: readonly (readonly [number, number])[],
): void {
  expect(band).toHaveLength(points.length)
  points.forEach(([x, y], index) => expectPointNear(band?.[index], planeAt(runtime, x, y)))
}

function createRuntimeContainer(): HTMLDivElement {
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 400 })
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 })
  return container
}

const stubbedRenderers = new WeakMap<SceneCanvasRuntime, RendererStub>()

/** A runtime whose target slot holds one renderer stub, which initRuntimeWithStubbedRenderer returns. */
function stubbedRuntime(options: ConstructorParameters<typeof SceneCanvasRuntime>[0] = {}): SceneCanvasRuntime {
  const renderer = createRendererStub()
  const runtime = new SceneCanvasRuntime(options)
  runtime.connectRenderTarget(renderer)
  stubbedRenderers.set(runtime, renderer)
  return runtime
}

async function initRuntimeWithStubbedRenderer(runtime: SceneCanvasRuntime) {
  const container = createRuntimeContainer()
  const renderer = stubbedRenderers.get(runtime)
  if (!renderer) throw new Error('Build the runtime with stubbedRuntime')
  await runtime.init(container)
  return { container, renderer }
}

// Loading a Design centres the session plane on its objects. Offset the
// viewport by where the fixtures' authoring origin landed so the screen
// points below keep addressing the authored metres (x, y) around it.
function authoringOffset(runtime: SceneCanvasRuntime): { x: number; y: number } {
  const plane = runtime.querySurface.sessionPlane.value
  return plane ? plane.toPlane(FIXTURE_ORIGIN) : { x: 0, y: 0 }
}

function setInteractionViewport(
  runtime: SceneCanvasRuntime,
  viewport: { x: number; y: number; scale: number } = { x: 0, y: 0, scale: 1 },
): void {
  const offset = authoringOffset(runtime)
  placeOn(runtime, {
    x: viewport.x - offset.x * viewport.scale,
    y: viewport.y - offset.y * viewport.scale,
    scale: viewport.scale,
  })
  runtime.documentSurface.resize(400, 300)
}

// Plane metres of an authored fixture point in the runtime's current plane.
function planeAt(runtime: SceneCanvasRuntime, x: number, y: number): { x: number; y: number } {
  const offset = authoringOffset(runtime)
  return { x: offset.x + x, y: offset.y + y }
}

function expectGuideNear(
  runtime: SceneCanvasRuntime,
  guide: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined,
  start: readonly [number, number],
  end: readonly [number, number],
): void {
  expectPointNear(guide?.start, planeAt(runtime, start[0], start[1]))
  expectPointNear(guide?.end, planeAt(runtime, end[0], end[1]))
}

// Changed positions are saved at 1e-9 degree precision.
function geoNear(point: { lon: number; lat: number }) {
  return { lon: expect.closeTo(point.lon, 8), lat: expect.closeTo(point.lat, 8) }
}

function expectPointNear(
  actual: { x: number; y: number } | undefined,
  expected: { x: number; y: number },
  digits = 6,
): void {
  expect(actual?.x).toBeCloseTo(expected.x, digits)
  expect(actual?.y).toBeCloseTo(expected.y, digits)
}

function clickAt(
  events: ReturnType<typeof createSceneInteractionEventHarness>,
  point: { x: number; y: number },
): void {
  events.pointerDown(point)
  events.pointerUp(point)
}

function createRuntimeWithAppPanelTargets(appAdapter?: CanvasRuntimeAppAdapter): SceneCanvasRuntime {
  return stubbedRuntime({
    appAdapter,
    targetPresentation: createAppSceneRuntimePanelTargetAdapter(),
  })
}

function lastCleanState(setCanvasClean: ReturnType<typeof vi.fn<(clean: boolean) => void>>): boolean | undefined {
  return setCanvasClean.mock.calls[setCanvasClean.mock.calls.length - 1]?.[0]
}

function createCleanStateAdapterProbe() {
  const setCanvasClean = vi.fn<(clean: boolean) => void>()
  return {
    adapter: {
      cleanState: { setCanvasClean },
      document: { composeDocumentForSave: composeTestDocumentForSave },
      settings: createTestSettingsAdapter(),
      translate: t,
    } satisfies CanvasRuntimeAppAdapter,
    setCanvasClean,
  }
}

function createTestSettingsAdapter(
  overrides: Partial<CanvasRuntimeSettingsAdapter> = {},
): CanvasRuntimeSettingsAdapter {
  let gridVisible = false
  let snapToGrid = false
  let plantSpacingIntervalM = 0.5
  return {
    readLocale: () => 'en',
    readChromeOverlay: () => ({ gridVisible }),
    readSnapToGridEnabled: () => snapToGrid,
    readScrollWheel: () => 'zoom',
    readPlantSpacingIntervalMeters: () => plantSpacingIntervalM,
    commitPlantSpacingIntervalMeters: (meters) => {
      plantSpacingIntervalM = meters
    },
    toggleGridVisible: () => {
      gridVisible = !gridVisible
    },
    toggleSnapToGrid: () => {
      snapToGrid = !snapToGrid
    },
    subscribeTheme: (onChange) => {
      onChange()
      return () => {}
    },
    subscribeLocale: (onChange) => {
      onChange()
      return () => {}
    },
    subscribeChromeOverlay: (onChange) => {
      onChange()
      return () => {}
    },
    subscribeMapBackdrop: (onChange) => {
      onChange('basemap')
      return () => {}
    },
    ...overrides,
  }
}

function composeTestDocumentForSave({
  metadata,
  document,
  canvas,
}: CanvasRuntimeDocumentCompositionInput): CanopiFile {
  return {
    ...document,
    ...canvas,
    name: metadata.name,
    description: metadata.description ?? document.description ?? null,
    extra: {
      ...document.extra,
      ...canvas.extra,
    },
  }
}

function createPanelTargetAdapterProbe(initialTargets: readonly PanelTarget[] = []) {
  let panelOriginTargets = initialTargets
  let canvasHoverTargets: readonly PanelTarget[] = []
  const subscribers = new Set<() => void>()
  const adapter: SceneRuntimePanelTargetAdapter = {
    readPanelOriginTargets: () => panelOriginTargets,
    setCanvasHoverTargets: (targets) => {
      canvasHoverTargets = [...targets]
    },
    clearPanelOriginTargets: () => {
      panelOriginTargets = []
      subscribers.forEach((notify) => notify())
    },
    subscribePanelOriginTargetChanges: (onChange) => {
      subscribers.add(onChange)
      return () => subscribers.delete(onChange)
    },
  }

  return {
    adapter,
    setPanelOriginTargets: (targets: readonly PanelTarget[]) => {
      panelOriginTargets = targets
      subscribers.forEach((notify) => notify())
    },
    get canvasHoverTargets() {
      return canvasHoverTargets
    },
    get panelOriginTargets() {
      return panelOriginTargets
    },
  }
}

describe('scene canvas runtime', () => {
  beforeEach(() => {
    currentCanvasTool.value = 'select'
    locale.value = 'en'
    currentCanvasSelection.value = new Set()
    plantColorMenuOpen.value = false
    clearPlantStampSource()
    clearSavedObjectStampSource()
    snapToGridEnabled.value = false
    hoveredCanvasTargets.value = []
    hoveredPanelTargets.value = []
    selectedPanelTargetOrigin.value = null
    selectedPanelTargets.value = []
    plantSpacingIntervalM.value = 0.5
    vi.mocked(getCommonNames).mockReset()
    vi.mocked(getCommonNames).mockResolvedValue({})
  })

  describe('the start frame (plan §1, exception 3)', () => {
    /**
     * Fits the runtime's camera again (Fit to Design, at the opening bearing 0 here); a frame that already shows the fit stays where
     * it is. Plants and notes are sized at the scale a fit starts from, so a second fit can land a few micro-pixels from the first:
     * 1e-3 px tells a fit from any other frame.
     */
    function expectShowsTheFit(runtime: SceneCanvasRuntime): void {
      const shown = placementOf(runtime)
      runtime.commandSurface.viewport.zoomToFit()
      const fitted = placementOf(runtime)
      expect(shown.x).toBeCloseTo(fitted.x, 3)
      expect(shown.y).toBeCloseTo(fitted.y, 3)
      expect(shown.scale).toBeCloseTo(fitted.scale, 3)
    }

    it('init frames a Design opened before it: the first frame is the fit, with no 100 m frame between two fits', async () => {
      const runtime = stubbedRuntime()
      runtime.documentSurface.resize(400, 300)
      runtime.documentSurface.loadDocument(makeFile())
      const seen: ViewFrame[] = []
      const stop = effect(() => { seen.push(runtime.cameraHost.frames.viewFrame.value) })
      try {
        await initRuntimeWithStubbedRenderer(runtime)
        stop()

        // One frame during init, and it is the Design's fit: 100 m across the shorter side (3 px/m here) is never shown.
        expect(seen).toHaveLength(2)
        expect(seen[1]).toBe(frameOf(runtime))
        expect(placementOf(runtime).scale).not.toBeCloseTo(3, 3)
        expectShowsTheFit(runtime)
      } finally {
        stop()
        runtime.destroy()
      }
    })

    it('init frames a Design loaded before the screen had a size', async () => {
      const runtime = stubbedRuntime()
      runtime.documentSurface.loadDocument(makeFile())
      try {
        await initRuntimeWithStubbedRenderer(runtime)

        expect(frameOf(runtime).view.screen).toMatchObject({ width: 400, height: 300 })
        expectShowsTheFit(runtime)
      } finally {
        runtime.destroy()
      }
    })

    it('init shows the new-Design overview for an empty Design', async () => {
      const runtime = stubbedRuntime()
      try {
        await initRuntimeWithStubbedRenderer(runtime)

        // The empty Design's fit: the plane origin at the screen centre, at the new-Design overview's scale.
        const { view } = frameOf(runtime)
        const origin = view.worldToScreen({ x: 0, y: 0 })
        expect(origin.x).toBeCloseTo(200, 6)
        expect(origin.y).toBeCloseTo(150, 6)
        const plane = runtime.querySurface.sessionPlane.value!
        expect(stageScaleToMapZoom(view.pixelsPerMetre, plane.origin.lat)).toBeCloseTo(DEFAULT_NEW_DESIGN_VIEW.zoom, 6)
        expect(frameOf(runtime).mode).toBe('overview')
      } finally {
        runtime.destroy()
      }
    })

    it('a Design loaded after init: the last frame before its first scene render is the load\'s fit', async () => {
      const runtime = stubbedRuntime()
      try {
        const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
        const atSceneRender: Array<{ x: number; y: number; scale: number }> = []
        renderer.setSnapshot.mockImplementation(() => { atSceneRender.push(placementOf(runtime)) })

        runtime.documentSurface.loadDocument(makeFile())
        runtime.documentSurface.zoomToFit()
        await vi.waitFor(() => expect(atSceneRender).not.toHaveLength(0))

        // The first scene render places the camera, then draws: the camera and the scene land in one frame.
        expect(atSceneRender[0]).toEqual(placementOf(runtime))
        expectShowsTheFit(runtime)
      } finally {
        runtime.destroy()
      }
    })
  })

  it('a zoom with a selected plant keeps the rotation handle above the plant\'s top', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    try {
      // Two plants, since one plant alone does not rotate; the top plant's footprint is sized at the live scale.
      runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1', 'plant-2'))
      setInteractionViewport(runtime, { x: 100, y: 120, scale: 4 })
      runtime.commandSurface.tools.setTool('select')
      runtime.commandSurface.sceneEdits.selectAll()

      // Zoom about the screen centre, away from the plants: they move on screen, and the handle with them.
      for (let step = 0; step < 3; step += 1) runtime.commandSurface.viewport.zoomIn()

      const bounds = runtime.querySurface.getDesignObjectSelection().bounds!
      const { view } = frameOf(runtime)
      const top = view.worldToScreen({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY })
      const handle = container.querySelector<HTMLElement>('[data-canvas-handle="rotate"]')!
      // The handle is anchored on the selection's top edge at the new scale, and its 28 px button sits wholly above it.
      expect(handle.style.display).not.toBe('none')
      expect(Number(handle.dataset.canvasHandleScreenX)).toBeCloseTo(top.x, 6)
      expect(Number(handle.dataset.canvasHandleScreenY)).toBeCloseTo(top.y, 6)
      expect(Number.parseFloat(handle.style.top) + 28).toBeLessThanOrEqual(top.y)
    } finally {
      runtime.destroy()
    }
  })

  it('a zoom during a rotate-handle drag moves the rotate handle and its readout to the new scale', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    try {
      // Plant footprints are sized at the live scale, so a zoom moves the selection's top edge on the ground.
      runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1', 'plant-2'))
      setInteractionViewport(runtime, { x: 100, y: 120, scale: 4 })
      runtime.commandSurface.tools.setTool('select')
      runtime.commandSurface.sceneEdits.selectAll()
      const handle = () => container.querySelector<HTMLElement>('[data-canvas-handle="rotate"]')!
      const start = { x: Number.parseFloat(handle().style.left) + 14, y: Number.parseFloat(handle().style.top) + 14 }
      events.pointerDown(start, { button: 0, target: handle() })
      // Straight up, away from the pivot: a drag that has not turned the selection yet, so the handle and its readout show.
      const pointer = { x: start.x, y: start.y - 20 }
      events.pointerMove(pointer, { button: 0 })
      expect(handle().querySelector('[data-canvas-handle-readout]')?.textContent).toBe('0°')

      // A wheel zoom about the still pointer: the pointer keeps its ground point, so the turn does not change.
      runtime.cameraHost.current().apply({ kind: 'zoom-around', anchorPx: pointer, factor: 4 })

      const bounds = runtime.querySurface.getDesignObjectSelection().bounds!
      const top = frameOf(runtime).view.worldToScreen({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY })
      expect(Number(handle().dataset.canvasHandleScreenX)).toBeCloseTo(top.x, 6)
      expect(Number(handle().dataset.canvasHandleScreenY)).toBeCloseTo(top.y, 6)
      expect(handle().querySelector('[data-canvas-handle-readout]')?.textContent).toBe('0°')
      events.pointerUp(pointer, { button: 0 })
    } finally {
      runtime.destroy()
    }
  })

  it('with Select armed and a selection, a pan refreshes no handles and builds no selection model; a zoom builds it once', async () => {
    const runtime = stubbedRuntime()
    await initRuntimeWithStubbedRenderer(runtime)
    try {
      runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1', 'plant-2'))
      setInteractionViewport(runtime, { x: 100, y: 120, scale: 4 })
      runtime.commandSurface.tools.setTool('select')
      runtime.commandSurface.sceneEdits.selectAll()
      // Select's handle refresh reads the selection model first; the host drops handles equal to the last ones.
      const selectionReads = vi.spyOn(runtime.querySurface, 'getDesignObjectSelection')
      window.__CANOPI_SELECTION_MODEL_BUILDS__ = 0

      for (let step = 0; step < 10; step += 1) panOn(runtime, { x: 7, y: -3 })

      expect(selectionReads).not.toHaveBeenCalled()
      expect(window.__CANOPI_SELECTION_MODEL_BUILDS__).toBe(0)

      runtime.commandSurface.viewport.zoomIn()

      expect(window.__CANOPI_SELECTION_MODEL_BUILDS__).toBe(1)
    } finally {
      delete window.__CANOPI_SELECTION_MODEL_BUILDS__
      runtime.destroy()
    }
  })

  it('routes locale subscriptions through the mounted interaction translation refresh', async () => {
    let language = 'en'
    let notifyLocale = (): void => {}
    const cleanState = createCleanStateAdapterProbe()
    const runtime = stubbedRuntime({
      appAdapter: {
        ...cleanState.adapter,
        translate: (key, options?: Readonly<Record<string, unknown>>) =>
          `${language}:${key}${options?.count === undefined ? '' : `:${String(options.count)}`}`,
        settings: createTestSettingsAdapter({
          subscribeLocale: (onChange) => {
            notifyLocale = onChange
            onChange()
            return () => {}
          },
        }),
      },
    })
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    runtime.commandSurface.tools.setTool('plant-spacing')

    // The map host is named by the runtime's translator.
    expect(container.getAttribute('aria-label')).toBe('en:canvas.map.label')

    language = 'fr'
    notifyLocale()

    expect(container.getAttribute('aria-label')).toBe('fr:canvas.map.label')
    expect(currentCanvasToolGuidance.value.plantRow).toMatchObject({ phase: 'pick' })
    runtime.destroy()
  })

  it('marks the Design map aria-busy until a scene change is drawn, never for a camera frame', async () => {
    const runtime = stubbedRuntime()
    const { container, renderer } = await initRuntimeWithStubbedRenderer(runtime)
    const busyWhenDrawn: Array<string | null> = []
    renderer.setSnapshot.mockImplementation(() => { busyWhenDrawn.push(container.getAttribute('aria-busy')) })
    expect(container.getAttribute('aria-busy'), 'the opening render draws in the next frame').toBe('true')
    await vi.waitFor(() => expect(container.hasAttribute('aria-busy')).toBe(false))

    runtime.documentSurface.loadDocument(makeFile())
    expect(container.getAttribute('aria-busy')).toBe('true')
    await vi.waitFor(() => expect(container.hasAttribute('aria-busy')).toBe(false))
    expect(busyWhenDrawn, 'busy until the renderer drew the loaded Design').toEqual(['true'])

    renderer.requestRender.mockClear()
    panOn(runtime, { x: 12, y: -8 })
    expect(container.hasAttribute('aria-busy'), 'a camera frame moves the drawing, it does not redraw it').toBe(false)
    expect(renderer.requestRender).toHaveBeenCalled()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(container.hasAttribute('aria-busy')).toBe(false)

    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    expect(container.getAttribute('aria-busy')).toBe('true')
    runtime.destroy()
    expect(container.hasAttribute('aria-busy'), 'a destroyed runtime leaves the host as it found it').toBe(false)
  })

  describe('presenting an opened Design (its chrome waits for its first drawn scene)', () => {
    it('a replaced Design is presented only after the frame that draws its scene, and an edit never hides it again', async () => {
      const runtime = stubbedRuntime()
      const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
      const { presented } = runtime.documentSurface
      await vi.waitFor(() => expect(presented.value).toBe(true))
      const presentedWhenDrawn: boolean[] = []
      renderer.setSnapshot.mockImplementation(() => { presentedWhenDrawn.push(presented.value) })

      runtime.documentSurface.replaceDocument(makeFile(), createCanvasDocumentReplacementToken(), () => {})
      expect(presented.value).toBe(false)
      await vi.waitFor(() => expect(presented.value).toBe(true))
      expect(presentedWhenDrawn, 'not presented while its scene is synced, only once MapLibre drew it').toEqual([false])

      runtime.commandSurface.history.undo()
      runtime.cameraHost.current().apply({ kind: 'pan-by', deltaPx: { x: 5, y: 0 } })
      expect(presented.value).toBe(true)
      runtime.destroy()
    })

    it('a Design opened before the renderer mounts is presented by init\'s first drawn scene', async () => {
      const runtime = stubbedRuntime()
      runtime.documentSurface.loadDocument(makeFile())
      expect(runtime.documentSurface.presented.value).toBe(false)
      const init = initRuntimeWithStubbedRenderer(runtime)
      expect(runtime.documentSurface.presented.value).toBe(false)

      await init
      await vi.waitFor(() => expect(runtime.documentSurface.presented.value).toBe(true))
      runtime.destroy()
    })

    it('a Design is presented once its renderer unmounts (the map failed): nothing will draw it', async () => {
      const runtime = stubbedRuntime()
      runtime.documentSurface.loadDocument(makeFile())
      await initRuntimeWithStubbedRenderer(runtime)
      expect(runtime.documentSurface.presented.value, 'the first drawn frame has not run yet').toBe(false)

      await runtime.unmountRenderer()

      expect(runtime.documentSurface.presented.value).toBe(true)
      runtime.destroy()
    })
  })

  it('rolls back effects acquired before a later subscription fails', () => {
    const disposeTheme = vi.fn()
    const disposeLocale = vi.fn(() => {
      throw new Error('locale disposal failed')
    })
    const disposeChromeOverlay = vi.fn()
    const cleanState = createCleanStateAdapterProbe()
    const panelTargets = createPanelTargetAdapterProbe()

    expect(() => new SceneCanvasRuntime({
      appAdapter: {
        ...cleanState.adapter,
        settings: createTestSettingsAdapter({
          subscribeTheme: () => disposeTheme,
          subscribeLocale: () => disposeLocale,
          subscribeChromeOverlay: () => disposeChromeOverlay,
        }),
      },
      targetPresentation: {
        ...panelTargets.adapter,
        subscribePanelOriginTargetChanges: () => {
          throw new Error('panel subscription failed')
        },
      },
    })).toThrow('Scene Canvas runtime effect installation failed')

    expect(disposeTheme).toHaveBeenCalledTimes(1)
    expect(disposeLocale).toHaveBeenCalledTimes(1)
    expect(disposeChromeOverlay).toHaveBeenCalledTimes(1)
  })

  it('runs every installed effect disposer when one disposer fails', () => {
    const disposeTheme = vi.fn(() => {
      throw new Error('theme disposal failed')
    })
    const disposeLocale = vi.fn()
    const disposeChromeOverlay = vi.fn()
    const disposePanelTarget = vi.fn()
    const cleanState = createCleanStateAdapterProbe()
    const panelTargets = createPanelTargetAdapterProbe()
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...cleanState.adapter,
        settings: createTestSettingsAdapter({
          subscribeTheme: () => disposeTheme,
          subscribeLocale: () => disposeLocale,
          subscribeChromeOverlay: () => disposeChromeOverlay,
        }),
      },
      targetPresentation: {
        ...panelTargets.adapter,
        subscribePanelOriginTargetChanges: () => disposePanelTarget,
      },
    })

    expect(() => runtime.destroy()).toThrow('theme disposal failed')

    expect(disposeTheme).toHaveBeenCalledTimes(1)
    expect(disposeLocale).toHaveBeenCalledTimes(1)
    expect(disposeChromeOverlay).toHaveBeenCalledTimes(1)
    expect(disposePanelTarget).toHaveBeenCalledTimes(1)
  })

  it('publishes a tool change only after the live Session transition succeeds', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    const beginSceneEdit = sceneEdits.begin.bind(sceneEdits)
    let abortCalls = 0
    const beginSpy = vi.spyOn(sceneEdits, 'begin').mockImplementation((type: string) => {
      const transaction = beginSceneEdit(type)
      if (type !== 'interaction-drag') return transaction
      return {
        mutate: (edit) => transaction.mutate(edit),
        setSelection: (targets) => transaction.setSelection(targets),
        commit: () => transaction.commit(),
        get changed() {
          return transaction.changed
        },
        abort: () => {
          abortCalls += 1
          if (abortCalls === 1) throw new Error('drag abort failed')
          transaction.abort()
        },
      } satisfies SceneEditTransaction
    })

    events.pointerDown({ x: 10, y: 10 }, { pointerId: 51 })
    events.pointerMove({ x: 30, y: 30 }, { pointerId: 51 })

    expect(() => runtime.commandSurface.tools.setTool('rectangle'))
      .toThrow('drag abort failed')
    expect(currentCanvasTool.value).toBe('select')
    expect(container.style.cursor).toBe('default')

    runtime.commandSurface.tools.setTool('rectangle')

    expect(abortCalls).toBe(2)
    expect(currentCanvasTool.value).toBe('rectangle')
    expect(container.style.cursor).toBe('crosshair')

    beginSpy.mockRestore()
    events.dispose()
    runtime.destroy()
  })

  it('moves the app\'s own tool state to Select with the session when leaving a tool fails', async () => {
    const runtime = stubbedRuntime()
    await initRuntimeWithStubbedRenderer(runtime)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    setInteractionViewport(runtime)
    rectangleActivation.deactivateFails = true
    try {
      runtime.commandSurface.tools.setTool('rectangle')
      expect(currentCanvasTool.value).toBe('rectangle')
      // Leaving Rectangle throws before Ellipse is armed: the host arms a fresh Select, and so does the toolbar.
      expect(() => runtime.commandSurface.tools.setTool('ellipse')).toThrow('deactivation failed')
      expect(currentCanvasTool.value).toBe('select')
    } finally {
      rectangleActivation.deactivateFails = false
    }
    runtime.destroy()
  })

  it('falls back to Select, in the app\'s own tool state too, when a registered tool\'s activation throws', async () => {
    const runtime = stubbedRuntime()
    await initRuntimeWithStubbedRenderer(runtime)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('line')
    expect(currentCanvasTool.value).toBe('line')

    rectangleActivation.fails = true
    try {
      // Rectangle's activation throws: the host falls back to Select, and the app's own tool state (session-state.ts,
      // read here as `currentCanvasTool`) must follow it, not stay on the tool that was armed before the failed attempt.
      expect(() => runtime.commandSurface.tools.setTool('rectangle')).toThrow('activation failed')
      expect(currentCanvasTool.value).toBe('select')
    } finally {
      rectangleActivation.fails = false
    }

    runtime.commandSurface.tools.setTool('rectangle')
    expect(currentCanvasTool.value).toBe('rectangle')

    runtime.destroy()
  })

  it('rolls back a failed interaction cancellation before replacing a document', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    const beginSceneEdit = sceneEdits.begin.bind(sceneEdits)
    let abortCalls = 0
    const beginSpy = vi.spyOn(sceneEdits, 'begin').mockImplementation((type: string) => {
      const transaction = beginSceneEdit(type)
      if (type !== 'interaction-drag') return transaction
      return {
        mutate: (edit) => transaction.mutate(edit),
        setSelection: (targets) => transaction.setSelection(targets),
        commit: () => transaction.commit(),
        get changed() {
          return transaction.changed
        },
        abort: () => {
          abortCalls += 1
          if (abortCalls === 1) throw new Error('drag abort failed')
          transaction.abort()
        },
      } satisfies SceneEditTransaction
    })
    const replacementToken = createCanvasDocumentReplacementToken()

    try {
      events.pointerDown({ x: 10, y: 10 }, { pointerId: 61 })
      events.pointerMove({ x: 30, y: 30 }, { pointerId: 61 })

      expect(() => runtime.documentSurface.replaceDocument(
        fileWithOnlyPlants('plant-2'),
        replacementToken,
        () => {},
      ))
        .toThrow('drag abort failed')
      expect(runtime.querySurface.getSceneSnapshot().plants.map((plant) => plant.id))
        .toEqual(['plant-1'])

      runtime.documentSurface.replaceDocument(
        fileWithOnlyPlants('plant-2'),
        replacementToken,
        () => {},
      )

      expect(abortCalls).toBe(2)
      // A lone Plant frames the replacement's session plane at its origin.
      expect(runtime.querySurface.getSceneSnapshot().plants).toEqual([
        expect.objectContaining({ id: 'plant-2', position: { x: 0, y: 0 } }),
      ])

      events.pointerUp({ x: 30, y: 30 }, { pointerId: 61 })
      expect(runtime.querySurface.getSceneSnapshot().plants).toEqual([
        expect.objectContaining({ id: 'plant-2', position: { x: 0, y: 0 } }),
      ])
    } finally {
      beginSpy.mockRestore()
      events.dispose()
      runtime.destroy()
    }
  })

  it('reserves replacement authority before a live gesture releases', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')
    let admitReleaseObserver = false
    let attemptingAdmission = false
    const committedScenes: string[][] = []
    const dispose = effect(() => {
      const settledPlants = runtime.querySurface.getSettledPlacedPlants()
      if (!admitReleaseObserver || !settledPlants || attemptingAdmission) return
      attemptingAdmission = true
      try {
        const changed = runtime.commandSurface.plantPresentation.setPlantColorForSpecies(
          'Malus domestica',
          '#335577',
        )
        if (changed > 0) {
          committedScenes.push(settledPlants.map((plant) => plant.id))
          admitReleaseObserver = false
        }
      } finally {
        attemptingAdmission = false
      }
    })

    try {
      events.pointerDown({ x: 10, y: 10 }, { pointerId: 62 })
      events.pointerMove({ x: 30, y: 30 }, { pointerId: 62 })
      admitReleaseObserver = true

      runtime.documentSurface.replaceDocument(
        fileWithOnlyPlants('plant-2'),
        createCanvasDocumentReplacementToken(),
        () => {},
      )

      expect(committedScenes).toEqual([['plant-2']])
      expect(runtime.querySurface.getSceneSnapshot().plantSpeciesColors)
        .toEqual({ 'Malus domestica': '#335577' })
      expect(runtime.commandSurface.history.canUndo.value).toBe(true)
      runtime.commandSurface.history.undo()
      expect(runtime.querySurface.getSceneSnapshot().plantSpeciesColors).toEqual({})
    } finally {
      dispose()
      events.dispose()
      runtime.destroy()
    }
  })

  it('cannot commit an old Annotation editor into a replacement document', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(fileWithOnlyAnnotation('Old document'))
    setInteractionViewport(runtime)
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerUp({ x: 26, y: 34 }, { button: 0, detail: 1 })
    events.pointerDown({ x: 26, y: 34 }, { button: 0, detail: 2 })
    const oldTextarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    oldTextarea.value = 'Stale draft'

    runtime.documentSurface.replaceDocument(
      fileWithOnlyAnnotation('New document'),
      createCanvasDocumentReplacementToken(),
      () => {},
    )
    oldTextarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(container.querySelector('textarea')).toBeNull()
    expect(runtime.querySurface.getSceneSnapshot().annotations[0]?.text).toBe('New document')
    events.dispose()
    runtime.destroy()
  })

  it('Unlock in the canvas menu unlocks a directly locked object', async () => {
    const runtime = stubbedRuntime({
      appAdapter: createAppCanvasRuntimeAppAdapter({ presentationData: {} }),
    })
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = fileWithOnlyPlants('plant-1')
    runtime.documentSurface.loadDocument({ ...file, plants: file.plants.map((plant) => ({ ...plant, locked: true })) })
    setInteractionViewport(runtime)
    // A still right-click: the menu opens on its release.
    events.pointerDown({ x: 10, y: 10 }, { button: 2 })
    events.pointerUp({ x: 10, y: 10 }, { button: 2 })
    const request = canvasContextMenuRequest.value!
    const unlock = buildCanvasContextMenuEntries(request, {
      translate: (key) => key,
      characterKeyShortcuts: true,
      openPlantAppearance: () => {},
      summary: null,
      openSpeciesDetail: () => {},
      addToCalendar: () => {},
      setUnitCost: () => {},
    }).find((entry): entry is CanvasContextMenuCommand => 'run' in entry && entry.id === 'unlock')!

    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.locked).toBe(true)
    expect(unlock.disabled).toBe(false)
    unlock.run()

    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.locked).toBe(false)
    events.dispose()
    runtime.destroy()
  })

  it('cannot invoke an old Context Menu action against a replacement document', async () => {
    const runtime = stubbedRuntime({
      appAdapter: createAppCanvasRuntimeAppAdapter({ presentationData: {} }),
    })
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    setInteractionViewport(runtime)
    runtime.commandSurface.sceneEdits.selectAll()
    events.pointerDown({ x: 200, y: 180 }, { button: 2 })
    events.pointerUp({ x: 200, y: 180 }, { button: 2 })
    expect(canvasContextMenuRequest.value).not.toBeNull()

    runtime.documentSurface.replaceDocument(
      fileWithOnlyPlants('plant-2'),
      createCanvasDocumentReplacementToken(),
      () => {},
    )

    expect(canvasContextMenuRequest.value).toBeNull()
    expect(runtime.querySurface.getSceneSnapshot().plants.map((plant) => plant.id))
      .toEqual(['plant-2'])
    events.dispose()
    runtime.destroy()
  })

  it('blocks history while a long-lived Scene Edit owns the Scene', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    sceneEdits.run('move-before-drag', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position.x = 20
      })
    })
    const active = sceneEdits.begin('interaction-drag')
    active.mutate((draft) => {
      draft.plants[0]!.position.x = 30
    })

    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    runtime.commandSurface.history.undo()

    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.position.x).toBe(30)
    active.abort()
    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.position.x).toBe(20)
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)
    runtime.commandSurface.history.undo()
    // A lone Plant frames the session plane at its origin.
    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.position.x).toBe(0)
    runtime.destroy()
  })

  it('renames a zone as one undoable edit that keeps its id', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(makeFile())
    const edits = runtime.commandSurface.sceneEdits
    const zone = () => runtime.querySurface.getSceneSnapshot().zones[0]!

    expect(edits.renameZone('zone-1', '  North bed ')).toBe(true)
    expect(zone()).toMatchObject({ id: 'zone-1', name: 'North bed' })
    expect(edits.renameZone('zone-1', 'North bed')).toBe(false)
    expect(edits.renameZone('zone-missing', 'Pond')).toBe(false)

    // A blank name clears it; lists then name the zone by its type and size.
    expect(edits.renameZone('zone-1', '   ')).toBe(true)
    expect(zone()).toMatchObject({ id: 'zone-1', name: null })

    runtime.commandSurface.history.undo()
    expect(zone()).toMatchObject({ id: 'zone-1', name: 'North bed' })
    runtime.commandSurface.history.undo()
    expect(zone()).toMatchObject({ id: 'zone-1', name: null })
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    runtime.destroy()
  })

  it('does not rename a zone inside a locked group', () => {
    const file = makeFile()
    file.groups = [{ id: 'group-1', name: null, locked: true, members: [{ kind: 'zone', id: 'zone-1' }] }]
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(file)
    expect(runtime.commandSurface.sceneEdits.renameZone('zone-1', 'North bed')).toBe(false)
    expect(runtime.querySurface.getSceneSnapshot().zones[0]!.name).toBeNull()
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    runtime.destroy()
  })

  it('does not rename a locked zone or a zone on a locked layer', () => {
    const file = makeFile()
    for (const locked of [
      { ...file, zones: [{ ...file.zones[0]!, locked: true }] },
      { ...file, layers: file.layers.map((layer) => layer.name === 'zones' ? { ...layer, locked: true } : layer) },
    ]) {
      const runtime = new SceneCanvasRuntime()
      runtime.documentSurface.loadDocument(locked)
      expect(runtime.commandSurface.sceneEdits.renameZone('zone-1', 'North bed')).toBe(false)
      expect(runtime.querySurface.getSceneSnapshot().zones[0]!.name).toBeNull()
      runtime.destroy()
    }
  })

  it('captures print content only after an edit settles without changing history or dirty state', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    const before = runtime.querySurface.getSceneSnapshot()
    // A lone Plant frames the session plane at its origin.
    expect(runtime.querySurface.capturePrintSnapshot()?.plants[0]?.position.x).toBe(0)
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    const active = sceneEdits.begin('interaction-drag')
    active.mutate((draft) => { draft.plants[0]!.position.x = 30 })
    expect(runtime.querySurface.capturePrintSnapshot()).toBeNull()
    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.position.x).toBe(30)
    active.abort()
    expect(runtime.querySurface.capturePrintSnapshot()?.plants[0]?.position.x).toBe(0)
    expect(runtime.querySurface.getSceneSnapshot()).toEqual(before)
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    runtime.destroy()
  })

  it('captures a saved view scene without selection or session changes, and not during an edit', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    runtime.commandSurface.sceneEdits.selectAll()
    const selection = runtime.querySurface.getSelection()
    const scene = runtime.querySurface.getSceneSnapshot()
    const layerNames = scene.layers.map((layer) => layer.name)
    expect(selection.length).toBeGreaterThan(0)
    const view = createTestRendererView({ x: 100, y: 80, scale: 4 })

    const capture = runtime.querySurface.captureViewScene({
      view,
      visibleLayerNames: [layerNames[0]!],
      focusedSpecies: 'Malus domestica',
    })

    expect(capture?.scene.layers.map((layer) => layer.visible)).toEqual(layerNames.map((_, index) => index === 0))
    expect(capture?.speciesFocus).toEqual({ canonicalName: 'Malus domestica' })
    expect(capture?.selectedPlantIds.size).toBe(0)
    expect(capture?.hoverTarget).toBeNull()
    expect(runtime.querySurface.captureViewScene({ view: createTestRendererView({ x: 0, y: 0, scale: 0.001 }), visibleLayerNames: [], focusedSpecies: null })
      ?.scene.layers.every((layer) => !layer.visible)).toBe(true)
    expect(runtime.querySurface.getSelection()).toEqual(selection)
    expect(runtime.querySurface.getSceneSnapshot()).toEqual(scene)
    expect(runtime.querySurface.getSpeciesFocus().canonicalName).toBeNull()
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)

    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    const active = sceneEdits.begin('interaction-drag')
    active.mutate((draft) => { draft.plants[0]!.position.x = 30 })
    expect(runtime.querySurface.captureViewScene({ view, visibleLayerNames: layerNames, focusedSpecies: null })).toBeNull()
    active.abort()
    runtime.destroy()
  })

  it('presents only a story step’s layers, without selection or measurement guides, and changes nothing in the Scene', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    sceneEdits.run('guide-add', (tx) => {
      tx.mutate((draft) => {
        draft.measurementGuides.push({ kind: 'measurement-guide', id: 'measure-1', locked: false, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } })
      })
    })
    const canUndo = runtime.commandSurface.history.canUndo.value
    runtime.commandSurface.sceneEdits.selectAll()
    const selection = runtime.querySurface.getSelection()
    const scene = runtime.querySurface.getSceneSnapshot()
    const layerNames = scene.layers.map((layer) => layer.name)
    const presentation = (runtime as unknown as {
      _presentation: { buildRendererSnapshot(options?: { overview?: boolean }): SceneRendererSnapshot }
    })._presentation
    expect(presentation.buildRendererSnapshot().selectedPlantIds.size).toBeGreaterThan(0)

    runtime.commandSurface.layers.presentLayers([layerNames[1]!])
    const presented = presentation.buildRendererSnapshot()
    expect(presented.scene.layers.map((layer) => layer.visible)).toEqual(layerNames.map((_, index) => index === 1))
    expect(presented.selectedPlantIds.size).toBe(0)
    expect(presented.hoverTarget).toBeNull()
    // Measurement guides are an editing aid: a presented story never shows them.
    runtime.commandSurface.layers.presentLayers(layerNames)
    expect(scene.measurementGuides.length).toBeGreaterThan(0)
    expect(presentation.buildRendererSnapshot().scene.measurementGuides).toEqual([])

    runtime.commandSurface.layers.presentLayers(null)
    expect(presentation.buildRendererSnapshot().scene.layers.map((layer) => layer.visible))
      .toEqual(scene.layers.map((layer) => layer.visible))
    expect(runtime.querySurface.getSelection()).toEqual(selection)
    expect(runtime.querySurface.getSceneSnapshot()).toEqual(scene)
    expect(runtime.commandSurface.history.canUndo.value).toBe(canUndo)
    runtime.destroy()
  })

  it('canopi-rg4q: a presented story step rings its plants on the canvas, and a view capture rings none', () => {
    const runtime = new SceneCanvasRuntime({ targetPresentation: createAppSceneRuntimePanelTargetAdapter() })
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1', 'plant-2'))
    const layerNames = runtime.querySurface.getSceneSnapshot().layers.map((layer) => layer.name)
    const presentation = (runtime as unknown as { _presentation: SceneRuntimePresentationController })._presentation
    setStoryPresentationOverrides({
      mapLayers: mapLayers.peek(), siteDataIds: new Set(), plantLabels: 'names',
      targets: [{ kind: 'placed_plant', plant_id: 'plant-2' }],
    })
    try {
      runtime.commandSurface.layers.presentLayers(layerNames)
      expect([...presentation.buildRendererSnapshot().highlightedPlantIds]).toEqual(['plant-2'])
      expect(presentation.buildViewCaptureSnapshot({
        overview: false, visibleLayerNames: layerNames, focusedSpecies: null,
      }).highlightedPlantIds.size).toBe(0)
    } finally {
      setStoryPresentationOverrides(null)
      runtime.destroy()
    }
  })

  it('draws the grid on the workspace map only while its chrome shows and the grid is on, never in the overview, a view capture or a story', () => {
    let gridVisible = true
    let onChromeOverlay = () => {}
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...createCleanStateAdapterProbe().adapter,
        settings: createTestSettingsAdapter({
          readChromeOverlay: () => ({ gridVisible }),
          subscribeChromeOverlay: (onChange) => {
            onChromeOverlay = onChange
            onChange()
            return () => {}
          },
        }),
      },
    })
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const presentation = (runtime as unknown as { _presentation: SceneRuntimePresentationController })._presentation
    const aids = () => presentation.buildRendererSnapshot().editingAids
    const ink = getMapBackdropInk()

    // Hidden chrome (a Design opening, a document replacement) draws no grid.
    expect(aids()).toBeUndefined()
    runtime.documentSurface.showCanvasChrome()
    expect(aids()).toEqual({ grid: { ink: ink.grid, majorInk: ink.gridMajor } })

    // The overview, a saved view's or story's thumbnail and a presented story draw none.
    expect(presentation.buildRendererSnapshot({ overview: true }).editingAids).toBeUndefined()
    expect(presentation.buildViewCaptureSnapshot({
      overview: false, visibleLayerNames: ['plants'], focusedSpecies: null,
    }).editingAids).toBeUndefined()
    runtime.commandSurface.layers.presentLayers(['plants'])
    expect(aids()).toBeUndefined()
    runtime.commandSurface.layers.presentLayers(null)

    gridVisible = false
    onChromeOverlay()
    expect(aids()).toBeUndefined()
    gridVisible = true
    onChromeOverlay()
    expect(aids()).toEqual({ grid: { ink: ink.grid, majorInk: ink.gridMajor } })
    runtime.documentSurface.hideCanvasChrome()
    expect(aids()).toBeUndefined()
    runtime.destroy()
  })

  it('the grid\'s ink follows a basemap backdrop change', () => {
    let onMapBackdrop: (backdrop: CanvasMapBackdrop) => void = () => {}
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...createCleanStateAdapterProbe().adapter,
        settings: createTestSettingsAdapter({
          readChromeOverlay: () => ({ gridVisible: true }),
          subscribeMapBackdrop: (onChange) => {
            onMapBackdrop = onChange
            onChange('basemap')
            return () => {}
          },
        }),
      },
    })
    try {
      runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
      runtime.documentSurface.showCanvasChrome()
      const presentation = (runtime as unknown as { _presentation: SceneRuntimePresentationController })._presentation
      const gridInk = () => presentation.buildRendererSnapshot().editingAids?.grid.ink
      const light = getMapBackdropInk().grid
      expect(gridInk()).toBe(light)

      onMapBackdrop('dark-basemap')

      expect(getMapBackdropInk().grid).not.toBe(light)
      expect(gridInk()).toBe(getMapBackdropInk().grid)
    } finally {
      onMapBackdrop('basemap')
      runtime.destroy()
    }
  })

  it('shows a searched place by moving only the view', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const scene = runtime.querySurface.getSceneSnapshot()
    const plane = runtime.querySurface.sessionPlane.value!
    const before = placementOf(runtime)
    const place = plane.toGeo({ x: 250, y: -120 })

    expect(runtime.commandSurface.viewport.showPlace(place, 17)).toBe(true)

    const after = placementOf(runtime)
    expect(after).not.toEqual(before)
    expect(runtime.querySurface.getSceneSnapshot()).toEqual(scene)
    expect(runtime.querySurface.sessionPlane.value).toBe(plane)
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    expect(runtime.commandSurface.viewport.showPlace({ lon: Number.NaN, lat: 0 }, 17)).toBe(false)
    runtime.destroy()
  })

  it('shows a place far from the plane origin at the MapLibre zoom it asked for', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const plane = runtime.querySurface.sessionPlane.value!
    const oslo = { lon: 10.75, lat: plane.origin.lat + 11 }

    expect(runtime.commandSurface.viewport.showPlace(oslo, 17)).toBe(true)

    const scale = placementOf(runtime).scale
    expect(stageScaleToMapZoom(scale, plane.origin.lat)).toBeCloseTo(17, 9)
    runtime.destroy()
  })

  it('asks the camera to fly to a place only for fly motion', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const apply = vi.spyOn(runtime.cameraHost.current(), 'apply')
    const place = runtime.querySurface.sessionPlane.value!.toGeo({ x: 40, y: 10 })

    runtime.commandSurface.viewport.showPlace(place, 18, { motion: 'fly' })
    runtime.commandSurface.viewport.showPlace(place, 18)

    expect(apply.mock.calls.map(([move]) => move.kind === 'set' ? move.animation : move.kind)).toEqual(['fly', 'none'])
    runtime.destroy()
  })

  it('an undo whose render publication throws keeps its step through the public command surface', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    sceneEdits.run('move-before-undo', (tx) => {
      tx.mutate((draft) => {
        draft.plants[0]!.position.x = 20
      })
    })
    const invalidate = vi.spyOn(runtime as any, '_invalidate')
      .mockImplementationOnce(() => {
        throw new Error('history render publication failed')
      })

    expect(() => runtime.commandSurface.history.undo())
      .toThrow('history render publication failed')
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    expect(runtime.commandSurface.history.canRedo.value).toBe(true)
    // A lone Plant frames the session plane at its origin.
    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.position.x).toBe(0)

    // Nothing waits to be resumed: a second undo has nothing left to undo.
    runtime.commandSurface.history.undo()
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(runtime.commandSurface.history.canRedo.value).toBe(true)
    invalidate.mockRestore()
    runtime.destroy()
  })

  it('admits whole Scene commands only while the Scene is settled', () => {
    const runtime = new SceneCanvasRuntime()
    const file = fileWithOnlyPlants('plant-1', 'plant-2')
    file.plant_species_colors['Malus domestica'] = '#335577'
    runtime.documentSurface.loadDocument(file)
    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    sceneEdits.run('seed-selection', (tx) => {
      tx.setSelection([plantTarget('plant-1')])
    })
    runtime.commandSurface.sceneEdits.copy()
    expect(runtime.commandSurface.sceneEdits.canPaste()).toBe(true)
    const active = sceneEdits.begin('interaction-drag')
    active.mutate((draft) => {
      draft.plants[1]!.canonicalName = 'Pyrus communis'
    })
    active.setSelection([plantTarget('plant-2')])

    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.sceneEdits.copy()
    runtime.commandSurface.sceneEdits.paste()

    expect(runtime.querySurface.getSelection()).toEqual([plantTarget('plant-2')])
    expect(runtime.querySurface.getSettledPlacedPlants()).toBeNull()
    expect(runtime.commandSurface.sceneEdits.canPaste()).toBe(false)
    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(2)
    expect(runtime.commandSurface.layers.setSceneLayerVisibility('plants', false)).toBe(false)
    expect(runtime.commandSurface.plantPresentation.setPlantColorForSpecies('Malus domestica', '#112233')).toBe(0)
    expect(runtime.querySurface.getSceneSnapshot().layers.find((layer) => layer.name === 'plants')?.visible)
      .toBe(true)
    expect(runtime.querySurface.getSceneSnapshot().plantSpeciesColors['Malus domestica'])
      .toBe('#335577')
    active.abort()
    expect(runtime.querySurface.getSelection()).toEqual([plantTarget('plant-1')])
    expect(runtime.querySurface.getSettledPlacedPlants()).toHaveLength(2)
    expect(runtime.commandSurface.sceneEdits.canPaste()).toBe(true)
    runtime.commandSurface.sceneEdits.paste()
    const pastedScene = runtime.querySurface.getSceneSnapshot()
    expect(pastedScene.plants).toHaveLength(3)
    expect(
      pastedScene.plants.find((plant) => !['plant-1', 'plant-2'].includes(plant.id))?.canonicalName,
    ).toBe('Malus domestica')
    runtime.destroy()
  })

  it('blocks spatial command mutations in overview while preserving read and layer roles', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1', 'plant-2'))
    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.sceneEdits.copy()
    placeOn(runtime, { x: 0, y: 0, scale: 0.01 })
    const before = runtime.querySurface.getSceneSnapshot()

    expect(frameOf(runtime).mode).toBe('overview')
    expect(runtime.commandSurface.sceneEdits.canPaste()).toBe(false)
    runtime.commandSurface.sceneEdits.paste()
    runtime.commandSurface.sceneEdits.pasteAt({ x: 30, y: 40 })
    runtime.commandSurface.sceneEdits.duplicateSelected()
    runtime.commandSurface.sceneEdits.deleteSelected()
    runtime.commandSurface.sceneEdits.bringToFront()
    runtime.commandSurface.sceneEdits.sendToBack()
    runtime.commandSurface.sceneEdits.lockSelected()
    runtime.commandSurface.sceneEdits.unlockSelected()
    runtime.commandSurface.sceneEdits.groupSelected()
    runtime.commandSurface.sceneEdits.ungroupSelected()

    expect(runtime.querySurface.getSceneSnapshot()).toEqual(before)
    expect(runtime.querySurface.getSelection()).toEqual([
      plantTarget('plant-1'),
      plantTarget('plant-2'),
    ])
    expect(runtime.commandSurface.layers.setSceneLayerVisibility('plants', false)).toBe(true)
    expect(runtime.querySurface.getSceneSnapshot().layers.find((layer) => layer.name === 'plants')?.visible)
      .toBe(false)
    runtime.destroy()
  })

  it('captures Saved Object Stamps only while the Scene is settled', () => {
    const saveCurrentSelection = vi.fn()
    const localizedCommonNames = new Map<string, string | null>([
      ['Malus domestica', 'Orchard Apple'],
    ])
    const desktop = createDesktopCanvasRuntimeAppAdapter()
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...desktop,
        settings: createTestSettingsAdapter(),
        savedObjectStamps: { saveCurrentSelection },
        presentationData: {
          ...desktop.presentationData,
          plantLabels: {
            getLocaleSnapshot: () => localizedCommonNames,
            getEnglishFallbackSnapshot: () => new Map(),
            ensureEntries: async () => false,
          },
        },
      },
    })
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    runtime.commandSurface.sceneEdits.selectAll()
    const save = runtime.commandSurface.sceneEdits.saveSelectionAsObjectStamp!

    save()
    expect(saveCurrentSelection).toHaveBeenCalledTimes(1)
    const firstCapture = saveCurrentSelection.mock.calls[0]![0]
    expect(firstCapture.scene.plants[0]?.id).toBe('plant-1')
    expect(firstCapture.selection.editableTargets).toEqual([{ kind: 'plant', id: 'plant-1' }])
    expect(firstCapture.localizedCommonNames).toEqual(new Map([
      ['Malus domestica', 'Orchard Apple'],
    ]))
    expect(firstCapture.localizedCommonNames).not.toBe(localizedCommonNames)

    const active = sceneEdits.begin('interaction-drag')
    save()
    expect(saveCurrentSelection).toHaveBeenCalledTimes(1)

    active.abort()
    save()
    expect(saveCurrentSelection).toHaveBeenCalledTimes(2)
    runtime.destroy()
  })

  it('advertises Saved Object Stamp actions only when the edition supplies the capability', async () => {
    const withoutStamps = stubbedRuntime({
      appAdapter: createAppCanvasRuntimeAppAdapter({ presentationData: {} }),
    })
    const withoutStampsMount = await initRuntimeWithStubbedRenderer(withoutStamps)
    withoutStamps.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    // A load after init takes its own fit in its first scene render, as Design loads do (init showed the empty Design's overview).
    withoutStamps.documentSurface.zoomToFit()
    await vi.waitFor(() => expect(withoutStamps.documentSurface.presented.value).toBe(true))
    withoutStamps.commandSurface.sceneEdits.selectAll()
    openContextMenuFromKeyboard(withoutStamps, withoutStampsMount.container)

    expect(canvasContextMenuRequest.value?.selection?.editableTargets).toHaveLength(1)
    expect(canvasContextMenuRequest.value?.saveSelectionAsObjectStamp).toBeUndefined()
    withoutStamps.destroy()
    expect(canvasContextMenuRequest.value).toBeNull()

    const withStamps = stubbedRuntime({
      appAdapter: createAppCanvasRuntimeAppAdapter({
        presentationData: {},
        savedObjectStamps: { saveCurrentSelection: vi.fn() },
      }),
    })
    const withStampsMount = await initRuntimeWithStubbedRenderer(withStamps)
    withStamps.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    // A load after init takes its own fit in its first scene render, as Design loads do (init showed the empty Design's overview).
    withStamps.documentSurface.zoomToFit()
    await vi.waitFor(() => expect(withStamps.documentSurface.presented.value).toBe(true))
    withStamps.commandSurface.sceneEdits.selectAll()
    openContextMenuFromKeyboard(withStamps, withStampsMount.container)

    expect(canvasContextMenuRequest.value?.saveSelectionAsObjectStamp).toBeTypeOf('function')
    withStamps.destroy()
  })

  it('groups, duplicates, and deletes grouped scene entities', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1', 'plant-2'))

    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.sceneEdits.groupSelected()

    const grouped = runtime.querySurface.getSceneSnapshot()
    expect(grouped.groups).toHaveLength(1)
    const groupId = grouped.groups[0]!.id
    expect(currentCanvasSelection.value).toEqual(new Set([groupId]))

    runtime.commandSurface.sceneEdits.duplicateSelected()

    const duplicated = runtime.querySurface.getSceneSnapshot()
    expect(duplicated.groups).toHaveLength(2)
    expect(duplicated.plants).toHaveLength(4)
    const duplicateGroupId = [...currentCanvasSelection.value][0]!
    expect(duplicateGroupId).not.toBe(groupId)

    runtime.commandSurface.sceneEdits.deleteSelected()

    const afterDelete = runtime.querySurface.getSceneSnapshot()
    expect(afterDelete.groups).toHaveLength(1)
    expect(afterDelete.plants).toHaveLength(2)
    expect(currentCanvasSelection.value.size).toBe(0)
  })

  it('selectAll prefers top-level group ids and skips locked items', () => {
    const runtime = new SceneCanvasRuntime()
    const file = makeFile()
    file.groups = [
      {
        id: 'group-1',
        name: null,
        locked: false,
        members: [
          { kind: 'plant', id: 'plant-1' },
          { kind: 'plant', id: 'plant-2' },
        ],
      },
    ]
    file.zones = file.zones.map((zone) =>
      zone.id === 'zone-1' ? { ...zone, locked: true } : zone,
    )
    runtime.documentSurface.loadDocument(file)

    runtime.commandSurface.sceneEdits.selectAll()

    expect(currentCanvasSelection.value).toEqual(new Set(['group-1']))
  })

  it('keeps Species focus separate from selection, history and saved content, and resets on replacement', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithGroupedPair())
    runtime.commandSurface.sceneEdits.selectAll()
    const selection = runtime.querySurface.getSelection()
    const scene = runtime.querySurface.getSceneSnapshot()
    const print = runtime.querySurface.capturePrintSnapshot()
    expect(scene.plantSpeciesCodes).toEqual({ 'Malus domestica': 'MDO' })
    runtime.commandSurface.speciesFocus.focus('Malus domestica')
    expect(runtime.querySurface.getSpeciesFocus()).toEqual({ canonicalName: 'Malus domestica' })
    expect(runtime.querySurface.getSelection()).toEqual(selection)
    expect(runtime.querySurface.getSceneSnapshot()).toEqual(scene)
    expect(runtime.querySurface.capturePrintSnapshot()).toEqual(print)
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    runtime.commandSurface.speciesFocus.focus('Missing species')
    expect(runtime.querySurface.getSpeciesFocus().canonicalName).toBe('Malus domestica')
    runtime.documentSurface.loadDocument(fileWithGroupedPair())
    expect(runtime.querySurface.getSpeciesFocus()).toEqual({ canonicalName: null })
    runtime.destroy()
    runtime.commandSurface.speciesFocus.focus('Malus domestica')
    expect(runtime.querySurface.getSpeciesFocus().canonicalName).toBe(null)
  })

  it('applies selected plant colors through grouped selection', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithGroupedPair())
    runtime.commandSurface.sceneEdits.selectAll()

    const changed = runtime.commandSurface.plantPresentation.setSelectedPlantColor('#ff5500')

    expect(changed).toBe(2)
    expect(runtime.querySurface.getSelectedPlantColorContext()).toMatchObject({
      plantIds: ['plant-1', 'plant-2'],
      sharedCurrentColor: '#FF5500',
      singleSpeciesCanonicalName: 'Malus domestica',
    })
  })

  it('applies selected plant symbols through grouped selection', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithGroupedPair())
    runtime.commandSurface.sceneEdits.selectAll()

    const changed = runtime.commandSurface.plantPresentation.setSelectedPlantSymbol('conifer')

    expect(changed).toBe(2)
    expect(runtime.querySurface.getSelectedPlantSymbolContext()).toMatchObject({
      plantIds: ['plant-1', 'plant-2'],
      sharedCurrentSymbol: 'conifer',
      sharedEffectiveSymbol: 'conifer',
      singleSpeciesCanonicalName: 'Malus domestica',
    })
  })

  it('sets species plant symbols through undoable scene history', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithGroupedPair())

    const changed = runtime.commandSurface.plantPresentation.setPlantSymbolForSpecies('Malus domestica', 'canopy')

    expect(changed).toBe(2)
    expect(runtime.querySurface.getSceneSnapshot().plantSpeciesSymbols).toEqual({
      'Malus domestica': 'canopy',
    })
    expect(runtime.querySurface.getSceneSnapshot().plants.map((plant) => plant.symbol)).toEqual(['canopy', 'canopy'])

    runtime.commandSurface.history.undo()
    expect(runtime.querySurface.getSceneSnapshot().plantSpeciesSymbols).toEqual({})
    expect(runtime.querySurface.getSceneSnapshot().plants.map((plant) => plant.symbol ?? null)).toEqual([null, null])

    runtime.commandSurface.history.redo()
    expect(runtime.querySurface.getSceneSnapshot().plantSpeciesSymbols).toEqual({
      'Malus domestica': 'canopy',
    })
  })

  it('excludes a locked Plant selected for unlock from plant color edits', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = fileWithOnlyPlants('plant-1')
    file.plants = file.plants.map((plant) => ({ ...plant, locked: true }))
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    clickAt(events, { x: 10, y: 10 })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(runtime.querySurface.getDesignObjectSelection().lockedTargets).toEqual([
      { kind: 'plant', id: 'plant-1' },
    ])
    expect(runtime.querySurface.getSelectedPlantColorContext().plantIds).toEqual([])

    const changed = runtime.commandSurface.plantPresentation.setSelectedPlantColor('#228833')

    expect(changed).toBe(0)
    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.color).toBeNull()
    events.dispose()
    runtime.destroy()
  })

  it('excludes a locked Plant selected for unlock from plant symbol edits', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = fileWithOnlyPlants('plant-1')
    file.plants = file.plants.map((plant) => ({ ...plant, locked: true }))
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    clickAt(events, { x: 10, y: 10 })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(runtime.querySurface.getSelectedPlantSymbolContext().plantIds).toEqual([])

    const changed = runtime.commandSurface.plantPresentation.setSelectedPlantSymbol('conifer')

    expect(changed).toBe(0)
    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.symbol ?? null).toBeNull()
    events.dispose()
    runtime.destroy()
  })

  it('applies selected plant color only to editable Plants in a mixed locked selection', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = makeFile()
    file.plants = file.plants.map((plant) => (
      plant.id === 'plant-2' ? { ...plant, locked: true } : plant
    ))
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    clickAt(events, { x: 10, y: 10 })
    events.pointerDown({ x: 20, y: 20 }, { button: 0, shiftKey: true })
    events.pointerUp({ x: 20, y: 20 }, { button: 0, shiftKey: true })

    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1', 'plant-2']))
    expect(runtime.querySurface.getSelectedPlantColorContext().plantIds).toEqual(['plant-1'])

    const changed = runtime.commandSurface.plantPresentation.setSelectedPlantColor('#228833')
    const plants = runtime.querySurface.getSceneSnapshot().plants

    expect(changed).toBe(1)
    expect(plants.find((plant) => plant.id === 'plant-1')?.color).toBe('#228833')
    expect(plants.find((plant) => plant.id === 'plant-2')?.color).toBeNull()
    events.dispose()
    runtime.destroy()
  })

  it('toggles snap-to-grid through shared canvas state', () => {
    const runtime = new SceneCanvasRuntime({
      appAdapter: createDesktopCanvasRuntimeAppAdapter(),
    })

    runtime.commandSurface.chrome.toggleSnapToGrid()
    expect(snapToGridEnabled.value).toBe(true)

    runtime.commandSurface.chrome.toggleSnapToGrid()
    expect(snapToGridEnabled.value).toBe(false)

    runtime.destroy()
  })

  it('routes settings-backed canvas commands through the injected app adapter', () => {
    const adapterProbe = createCleanStateAdapterProbe()
    const toggleGridVisible = vi.fn()
    const toggleSnapToGrid = vi.fn()
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...adapterProbe.adapter,
        settings: createTestSettingsAdapter({
          toggleGridVisible,
          toggleSnapToGrid,
        }),
      },
    })

    runtime.commandSurface.chrome.toggleGrid()
    runtime.commandSurface.chrome.toggleSnapToGrid()

    expect(toggleGridVisible).toHaveBeenCalledTimes(1)
    expect(toggleSnapToGrid).toHaveBeenCalledTimes(1)
  })

  it('publishes viewport-only camera changes through the canonical snapshot', async () => {
    const runtime = stubbedRuntime()
    await initRuntimeWithStubbedRenderer(runtime)
    const before = frameOf(runtime)

    runtime.commandSurface.viewport.zoomIn()

    const after = frameOf(runtime)
    expect(after).not.toBe(before)
    expect(after.view.pixelsPerMetre).toBeGreaterThan(before.view.pixelsPerMetre)
    expect(after.view.screen).toEqual(before.view.screen)
    runtime.destroy()
  })

  it('repaints for externally published camera frames and releases the owner on destroy', async () => {
    const runtime = stubbedRuntime()
    const disposeCamera = vi.spyOn(runtime.cameraHost as CameraDriverHostController, 'dispose')
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
    renderer.requestRender.mockClear()

    panOn(runtime, { x: 12, y: -8 })

    expect(renderer.requestRender).toHaveBeenCalledOnce()

    runtime.destroy()
    expect(disposeCamera).toHaveBeenCalledOnce()
    renderer.requestRender.mockClear()

    panOn(runtime, { x: 1, y: 1 })

    expect(renderer.requestRender).not.toHaveBeenCalled()
  })

  it('does not publish a viewport change when document hydration leaves the camera unchanged', async () => {
    const runtime = stubbedRuntime()
    await initRuntimeWithStubbedRenderer(runtime)
    // The scale bounds follow the plane's latitude: a first load moves them to the Design's, a second one finds them unchanged.
    runtime.documentSurface.loadDocument(makeFile())
    const before = frameOf(runtime)

    runtime.documentSurface.loadDocument(makeFile())

    // The hydration's new plane may publish a frame (a viewport render, coalesced per animation frame); it shows the same view.
    const after = frameOf(runtime)
    expect(after.view.camera).toEqual(before.view.camera)
    expect(after.view.screen).toEqual(before.view.screen)
    expect(after.mode).toBe(before.mode)
    expect(after.scaleBounds).toEqual(before.scaleBounds)
    runtime.destroy()
  })

  it('publishes current cache changes with one scene invalidation', async () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(makeFile())
    const invalidate = vi.spyOn(runtime as any, '_invalidate')

    let resolveRefresh!: (value: ScenePresentationRefreshResult) => void
    const pendingRefresh = new Promise<ScenePresentationRefreshResult>((resolve) => {
      resolveRefresh = resolve
    })
    ;(runtime as any)._presentation.refreshSpeciesCacheEntries = vi.fn(() => pendingRefresh)

    const pending = runtime.commandSurface.plantPresentation.ensureSpeciesCacheEntries(['Malus domestica'], 'en')
    runtime.commandSurface.plantPresentation.setPlantColorForSpecies('Malus domestica', '#335577')
    const invalidationsBeforeRefresh = invalidate.mock.calls.length
    resolveRefresh({ changed: true, plantNamesRevision: 0, failure: null })

    await expect(pending).resolves.toBe(true)
    expect(invalidate.mock.calls.slice(invalidationsBeforeRefresh)).toEqual([[]])
    invalidate.mockRestore()
    runtime.destroy()
  })

  it('derives selected plant context from scene session, not the mirror signal', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))

    runtime.commandSurface.sceneEdits.selectAll()
    currentCanvasSelection.value = new Set(['plant-2'])

    expect(runtime.querySurface.getSelectedPlantColorContext().plantIds).toEqual(['plant-1'])
  })

  it('keeps runtime-backed selection authoritative over the mirror signal', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))

    runtime.commandSurface.sceneEdits.selectAll()
    currentCanvasSelection.value = new Set(['zone-1'])

    expect(runtime.querySurface.getSelection()).toEqual([plantTarget('plant-1')])

    runtime.documentSurface.replaceDocument(
      fileWithOnlyPlants('plant-2'),
      createCanvasDocumentReplacementToken(),
      () => {},
    )
    runtime.commandSurface.sceneEdits.selectAll()
    expect(runtime.querySurface.getSelection()).toEqual([plantTarget('plant-2')])
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-2']))

    runtime.documentSurface.replaceDocument(
      fileWithOnlyPlants('plant-2'),
      createCanvasDocumentReplacementToken(),
      () => {},
    )
    expect(runtime.querySurface.getSelection()).toEqual([])
    expect(currentCanvasSelection.value.size).toBe(0)
  })

  it('publishes the UI selection mirror when only the selected target kind changes', () => {
    const file = makeFile()
    file.plants[0] = { ...file.plants[0]!, id: 'shared-id' }
    file.zones[0] = { ...file.zones[0]!, id: 'shared-id' }
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(file)
    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    const publications: string[][] = []
    const dispose = effect(() => {
      publications.push([...currentCanvasSelection.value])
    })

    sceneEdits.run('select-colliding-plant', (tx) => {
      tx.setSelection([plantTarget('shared-id')])
    })
    const publicationsAfterPlant = publications.length
    sceneEdits.run('select-colliding-zone', (tx) => {
      tx.setSelection([zoneTarget('shared-id')])
    })

    expect(runtime.querySurface.getSelection()).toEqual([zoneTarget('shared-id')])
    expect(currentCanvasSelection.value).toEqual(new Set(['shared-id']))
    expect(publications).toHaveLength(publicationsAfterPlant + 1)
    dispose()
    runtime.destroy()
  })

  it('returns an owned typed selection snapshot with stable collision order', () => {
    const file = makeFile()
    file.plants[0] = { ...file.plants[0]!, id: 'shared-id' }
    file.zones[0] = { ...file.zones[0]!, id: 'shared-id' }
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(file)
    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    const plant = plantTarget('shared-id')
    const zone = zoneTarget('shared-id')

    sceneEdits.run('select-owned-colliding-targets', (tx) => {
      tx.setSelection([plant, zone, plantTarget('shared-id')])
    })
    plant.id = 'mutated-input'
    zone.id = 'mutated-input'

    const snapshot = runtime.querySurface.getSelection()
    ;(snapshot[0] as { id: string }).id = 'mutated-snapshot'
    snapshot.reverse()

    expect(runtime.querySurface.getSelection()).toEqual([
      plantTarget('shared-id'),
      zoneTarget('shared-id'),
    ])
    runtime.destroy()
  })

  it('keeps document replacement behind settled Scene admission', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const sceneEdits = (runtime as unknown as { _sceneCommands: SceneEditCoordinator })._sceneCommands
    const active = sceneEdits.begin('interaction-drag')
    active.mutate((draft) => {
      draft.plants[0]!.position = { x: 99, y: 99 }
    })
    const replacementToken = createCanvasDocumentReplacementToken()

    let rejection: unknown
    try {
      runtime.documentSurface.replaceDocument(
        fileWithOnlyPlants('plant-2'),
        replacementToken,
        () => {},
      )
    } catch (error) {
      rejection = error
    }
    expect(rejection).toBeInstanceOf(CanvasDocumentReplacementNotAdmittedError)
    expect(rejection).toMatchObject({ reason: expect.any(SceneEditBusyError) })
    expect(runtime.querySurface.getSceneSnapshot().plants[0]).toMatchObject({
      id: 'plant-1',
      position: { x: 99, y: 99 },
    })

    active.abort()
    runtime.documentSurface.replaceDocument(
      fileWithOnlyPlants('plant-2'),
      replacementToken,
      () => {},
    )
    expect(runtime.querySurface.getSceneSnapshot().plants.map((plant) => plant.id))
      .toEqual(['plant-2'])
    runtime.destroy()
  })

  it('keeps the old Scene authoritative when pre-hydration target cleanup fails', () => {
    let failPanelTargetCleanup = false
    const targetPresentation: SceneRuntimePanelTargetAdapter = {
      readPanelOriginTargets: () => [],
      setCanvasHoverTargets: () => {},
      clearPanelOriginTargets: () => {
        if (failPanelTargetCleanup) throw new Error('panel target cleanup failed')
      },
      subscribePanelOriginTargetChanges: () => () => {},
    }
    const runtime = new SceneCanvasRuntime({ targetPresentation })
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    runtime.commandSurface.sceneEdits.selectAll()
    expect(runtime.querySurface.getSelection()).toEqual([plantTarget('plant-1')])
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    failPanelTargetCleanup = true
    const replacementToken = createCanvasDocumentReplacementToken()

    expect(() => runtime.documentSurface.replaceDocument(
      fileWithOnlyPlants('plant-2'),
      replacementToken,
      () => {},
    ))
      .toThrow('panel target cleanup failed')
    expect(runtime.querySurface.getSceneSnapshot().plants.map((plant) => plant.id))
      .toEqual(['plant-1'])
    expect(runtime.querySurface.getSelection()).toEqual([plantTarget('plant-1')])
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

    failPanelTargetCleanup = false
    runtime.documentSurface.replaceDocument(
      fileWithOnlyPlants('plant-2'),
      replacementToken,
      () => {},
    )
    expect(runtime.querySurface.getSceneSnapshot().plants.map((plant) => plant.id))
      .toEqual(['plant-2'])
    expect(runtime.querySurface.getSelection()).toEqual([])
    expect(currentCanvasSelection.value).toEqual(new Set())
    runtime.destroy()
  })

  it('rolls back the renderer mount when interaction Session construction fails', async () => {
    const container = createRuntimeContainer()
    const runtime = stubbedRuntime()
    const appendChild = vi.spyOn(container, 'appendChild').mockImplementation(() => {
      throw new Error('interaction construction failed')
    })

    try {
      await expect(runtime.init(container)).rejects.toThrow('interaction construction failed')
    } finally {
      appendChild.mockRestore()
    }

    expect((runtime as any)._rendering.container).toBeNull()
    runtime.destroy()
  })

  it('rolls back Session listeners and the renderer mount when the initial render fails', async () => {
    const container = createRuntimeContainer()
    const events = createSceneInteractionEventHarness(container, { trackListeners: true })
    const renderer = createRendererStub()
    renderer.setSnapshot.mockImplementation(() => {
      throw new Error('initial render failed')
    })
    const runtime = new SceneCanvasRuntime()
    runtime.connectRenderTarget(renderer)

    await expect(runtime.init(container)).rejects.toThrow('initial render failed')

    // The source's press listener and the selection-drag guard's.
    expect(events.listenerLog?.containerRemoves('pointerdown')).toHaveLength(2)
    expect(events.listenerLog?.containerRemoves('pointermove')).toHaveLength(1)
    expect(events.listenerLog?.windowRemoves('blur')).toHaveLength(1)
    expect(document.querySelector('[data-hover-tooltip]')).toBeNull()
    expect((runtime as any)._rendering.container).toBeNull()
    events.dispose()
    runtime.destroy()
  })

  it('does not publish a species load that lands after runtime teardown', async () => {
    const cache = new Map<string, Record<string, unknown>>()
    let resolveRefresh!: () => void
    const refresh = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    const ensureEntries = vi.fn(async (canonicalNames: string[]) => {
      await refresh
      for (const canonicalName of canonicalNames) {
        cache.set(canonicalName, { stratum: 'canopy', width_max_m: 4 })
      }
      return true
    })
    const renderer = createRendererStub()
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...createDetachedCanvasRuntimeAppAdapter(),
        presentationData: {
          speciesCache: {
            getCache: () => cache,
            ensureEntries,
            getSuggestedPlantColor: () => null,
          },
        },
      },
    })
    runtime.connectRenderTarget(renderer)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const container = createRuntimeContainer()
    const initialize = runtime.init(container)
    await vi.waitFor(() => expect(ensureEntries).toHaveBeenCalledOnce())
    const sceneRevision = runtime.querySurface.revision.scene.value
    const plantNamesRevision = runtime.querySurface.revision.plantNames.value
    const invalidate = vi.spyOn((runtime as any)._rendering, 'invalidate')
    invalidate.mockClear()

    runtime.destroy()
    resolveRefresh()
    await initialize

    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.canopySpreadM).toBeNull()
    expect(runtime.querySurface.revision.scene.value).toBe(sceneRevision)
    expect(runtime.querySurface.revision.plantNames.value).toBe(plantNamesRevision)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('does not publish a deferred presentation command after runtime teardown', async () => {
    const cache = new Map<string, Record<string, unknown>>()
    let resolveRefresh!: () => void
    const refresh = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    const ensureEntries = vi.fn(async (canonicalNames: string[]) => {
      await refresh
      for (const canonicalName of canonicalNames) {
        cache.set(canonicalName, { stratum: 'canopy', width_max_m: 4 })
      }
      return true
    })
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...createDetachedCanvasRuntimeAppAdapter(),
        presentationData: {
          speciesCache: {
            getCache: () => cache,
            ensureEntries,
            getSuggestedPlantColor: () => null,
          },
        },
      },
    })
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const publication = runtime.commandSurface.plantPresentation.ensureSpeciesCacheEntries(
      ['Malus domestica'],
      'en',
    )
    await vi.waitFor(() => expect(ensureEntries).toHaveBeenCalledOnce())
    const sceneRevision = runtime.querySurface.revision.scene.value
    const invalidate = vi.spyOn((runtime as any)._rendering, 'invalidate')
    invalidate.mockClear()

    runtime.destroy()
    resolveRefresh()

    await expect(publication).resolves.toBe(false)
    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.canopySpreadM).toBeNull()
    expect(runtime.querySurface.revision.scene.value).toBe(sceneRevision)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('publishes prepared plant labels before surfacing a later species-cache failure', async () => {
    const labelsByLocale = new Map<string, Map<string, string | null>>()
    const speciesFailure = new Error('species refresh failed')
    let activeLocale = 'en'
    let failSpeciesRefresh = false
    const appAdapterProbe = createCleanStateAdapterProbe()
    const runtime = stubbedRuntime({
      appAdapter: {
        ...appAdapterProbe.adapter,
        settings: createTestSettingsAdapter({
          readLocale: () => activeLocale,
        }),
        presentationData: {
          plantLabels: {
            getLocaleSnapshot: (locale) => labelsByLocale.get(locale) ?? new Map(),
            getEnglishFallbackSnapshot: () => new Map(),
            ensureEntries: async (_canonicalNames, locale) => {
              if (labelsByLocale.has(locale)) return false
              labelsByLocale.set(locale, new Map([
                ['Malus domestica', locale === 'fr' ? 'Pommier' : 'Apple'],
              ]))
              return true
            },
          },
          speciesCache: {
            getCache: () => new Map(),
            ensureEntries: async () => {
              if (failSpeciesRefresh) throw speciesFailure
              return false
            },
            getSuggestedPlantColor: () => null,
          },
        },
      },
    })
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
    const plantNamesRevision = runtime.querySurface.revision.plantNames.value
    const initialRenderCount = renderer.setSnapshot.mock.calls.length
    activeLocale = 'fr'
    failSpeciesRefresh = true

    await expect(runtime.commandSurface.plantPresentation.ensureSpeciesCacheEntries(
      ['Malus domestica'],
      'fr',
    )).rejects.toBe(speciesFailure)
    await vi.waitFor(() => {
      expect(renderer.setSnapshot.mock.calls.length).toBeGreaterThan(initialRenderCount)
    })

    const rendered = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
    expect(rendered?.localizedCommonNames.get('Malus domestica')).toBe('Pommier')
    expect(runtime.querySurface.getLocalizedCommonNames().get('Malus domestica')).toBe('Pommier')
    expect(runtime.querySurface.revision.plantNames.value).toBe(plantNamesRevision + 1)
    runtime.destroy()
  })

  it('invalidates and reports a cached refresh that publishes pending plant labels', async () => {
    const labels = new Map<string, string | null>()
    let labelsLoaded = false
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...createDetachedCanvasRuntimeAppAdapter(),
        presentationData: {
          plantLabels: {
            getLocaleSnapshot: () => labels,
            getEnglishFallbackSnapshot: () => new Map(),
            ensureEntries: async () => {
              if (labelsLoaded) return false
              labelsLoaded = true
              labels.set('Malus domestica', 'Apple')
              return true
            },
          },
          speciesCache: {
            getCache: () => new Map(),
            ensureEntries: async () => false,
            getSuggestedPlantColor: () => null,
          },
        },
      },
    })
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const plantNamesRevision = runtime.querySurface.revision.plantNames.value
    const stagedRefresh = await (runtime as any)._presentation.refreshSpeciesCacheEntries(
      ['Malus domestica'],
      'en',
    )
    expect(stagedRefresh.changed).toBe(true)
    expect(runtime.querySurface.revision.plantNames.value).toBe(plantNamesRevision)
    const invalidate = vi.spyOn((runtime as any)._rendering, 'invalidate')

    await expect(runtime.commandSurface.plantPresentation.ensureSpeciesCacheEntries(
      ['Malus domestica'],
      'en',
    )).resolves.toBe(true)

    expect(runtime.querySurface.revision.plantNames.value).toBe(plantNamesRevision + 1)
    expect(invalidate).toHaveBeenCalled()
    runtime.destroy()
  })

  it('does not publish prepared plant labels when a later species failure settles after teardown', async () => {
    const labels = new Map<string, string | null>()
    const speciesFailure = new Error('deferred species refresh failed')
    let rejectSpecies!: (error: Error) => void
    const speciesRefresh = new Promise<boolean>((_resolve, reject) => {
      rejectSpecies = reject
    })
    const ensureSpeciesEntries = vi.fn(() => speciesRefresh)
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...createDetachedCanvasRuntimeAppAdapter(),
        presentationData: {
          plantLabels: {
            getLocaleSnapshot: () => labels,
            getEnglishFallbackSnapshot: () => new Map(),
            ensureEntries: async () => {
              labels.set('Malus domestica', 'Apple')
              return true
            },
          },
          speciesCache: {
            getCache: () => new Map(),
            ensureEntries: ensureSpeciesEntries,
            getSuggestedPlantColor: () => null,
          },
        },
      },
    })
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    const plantNamesRevision = runtime.querySurface.revision.plantNames.value
    const invalidate = vi.spyOn((runtime as any)._rendering, 'invalidate')
    const publication = runtime.commandSurface.plantPresentation.ensureSpeciesCacheEntries(
      ['Malus domestica'],
      'en',
    )
    const rejection = expect(publication).rejects.toBe(speciesFailure)
    await vi.waitFor(() => expect(ensureSpeciesEntries).toHaveBeenCalledOnce())

    runtime.destroy()
    rejectSpecies(speciesFailure)

    await rejection
    expect(runtime.querySurface.getLocalizedCommonNames().get('Malus domestica')).toBe('Apple')
    expect(runtime.querySurface.revision.plantNames.value).toBe(plantNamesRevision)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('describes editable top-level Design Object selection with visual bounds', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyZone())

    runtime.commandSurface.sceneEdits.selectAll()

    const selection = runtime.querySurface.getDesignObjectSelection()
    // The lone 5 m square Zone frames the session plane around its centre.
    expect(selection.bounds?.minX).toBeCloseTo(-2.5, 6)
    expect(selection.bounds?.minY).toBeCloseTo(-2.5, 6)
    expect(selection.bounds?.maxX).toBeCloseTo(2.5, 6)
    expect(selection.bounds?.maxY).toBeCloseTo(2.5, 6)
    expect(selection).toEqual({
      editableTargets: [{ kind: 'zone', id: 'zone-1' }],
      lockedTargets: [],
      blockedTargets: [],
      bounds: expect.any(Object),
      sameSpeciesReferenceCanonicalName: null,
      plantNamePinning: {
        plantIds: [],
        allPinned: false,
      },
    })
  })

  it('describes selected Design Objects blocked by locked Layers', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(fileWithOnlyZone())
    runtime.commandSurface.sceneEdits.selectAll()

    runtime.commandSurface.layers.setSceneLayerLocked('zones', true)

    expect(runtime.querySurface.getDesignObjectSelection()).toEqual({
      editableTargets: [],
      lockedTargets: [],
      blockedTargets: [{
        target: { kind: 'zone', id: 'zone-1' },
        reason: 'structural',
      }],
      bounds: null,
      sameSpeciesReferenceCanonicalName: null,
      plantNamePinning: {
        plantIds: [],
        allPinned: false,
      },
    })
  })

  it('refreshes Zone Measurements when runtime selection changes', async () => {
    const runtime = stubbedRuntime()
    const file = makeFile()
    file.zones = [{
      id: 'zone-1', name: null,
      zone_type: 'rect',
      rotation: 0,
      points: [at(10, 10), at(110, 10), at(110, 90), at(10, 90)],
      fill_color: null,
      notes: null,
      locked: false,
    }]
    runtime.documentSurface.loadDocument(fileWithOnlyZone(file.zones[0]!))
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)

    runtime.commandSurface.sceneEdits.selectAll()

    expect(draftLabelTexts(renderer)).toEqual([
      '100 m',
      '80 m',
      '100 m',
      '80 m',
      '8000 m²',
    ])

    runtime.documentSurface.replaceDocument(
      fileWithOnlyZone(file.zones[0]!),
      createCanvasDocumentReplacementToken(),
      () => {},
    )

    expect(draftLabelTexts(renderer)).toEqual([])
    runtime.destroy()
  })

  it('resolves hovered panel targets for renderer highlights without mutating selection', async () => {
    const runtime = createRuntimeWithAppPanelTargets()
    runtime.documentSurface.loadDocument(makeFile())
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)

    renderer.setSnapshot.mockClear()
    hoveredPanelTargets.value = [
      speciesTarget('Malus domestica'),
      { kind: 'zone', zone_id: 'zone-1' },
      { kind: 'placed_plant', plant_id: 'missing-plant' },
    ]

    await vi.waitFor(() => {
      expect(renderer.setSnapshot).toHaveBeenCalled()
    })

    const snapshot = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
    expect(snapshot?.highlightedPlantIds).toEqual(new Set(['plant-1', 'plant-2']))
    expect(snapshot?.highlightedZoneIds).toEqual(new Set(['zone-1']))
    expect(runtime.querySurface.getSelection().length).toBe(0)
    expect(currentCanvasSelection.value.size).toBe(0)
    runtime.destroy()
  })

  it('resolves selected panel targets for renderer highlights without mutating canvas selection or dirty state', async () => {
    const cleanState = createCleanStateAdapterProbe()
    const runtime = createRuntimeWithAppPanelTargets(cleanState.adapter)
    runtime.documentSurface.loadDocument(makeFile())
    cleanState.setCanvasClean.mockClear()
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)

    renderer.setSnapshot.mockClear()
    selectedPanelTargets.value = [
      speciesTarget('Malus domestica'),
      { kind: 'zone', zone_id: 'zone-1' },
    ]

    await vi.waitFor(() => {
      expect(renderer.setSnapshot).toHaveBeenCalled()
    })

    const snapshot = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
    expect(snapshot?.highlightedPlantIds).toEqual(new Set(['plant-1', 'plant-2']))
    expect(snapshot?.highlightedZoneIds).toEqual(new Set(['zone-1']))
    expect(runtime.querySurface.getSelection().length).toBe(0)
    expect(currentCanvasSelection.value.size).toBe(0)
    expect(cleanState.setCanvasClean).not.toHaveBeenCalledWith(false)
    runtime.destroy()
  })

  it('keeps typed panel target highlights separate when plant and zone ids collide', async () => {
    const runtime = createRuntimeWithAppPanelTargets()
    runtime.documentSurface.loadDocument({
      ...makeFile(),
      plants: [
        {
          ...makeFile().plants[0]!,
          id: 'colliding-id',
          canonical_name: 'Malus domestica',
          locked: false,
        },
      ],
      zones: [
        {
          ...makeFile().zones[0]!,
          id: 'colliding-id',
        },
      ],
    })
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)

    renderer.setSnapshot.mockClear()
    hoveredPanelTargets.value = [{ kind: 'zone', zone_id: 'colliding-id' }]

    await vi.waitFor(() => {
      expect(renderer.setSnapshot).toHaveBeenCalled()
    })

    const snapshot = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
    expect(snapshot?.highlightedPlantIds).toEqual(new Set())
    expect(snapshot?.highlightedZoneIds).toEqual(new Set(['colliding-id']))
    runtime.destroy()
  })

  it('unions selected and hovered panel target highlights without mutating canvas selection', async () => {
    const runtime = createRuntimeWithAppPanelTargets()
    runtime.documentSurface.loadDocument(makeFile())
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)

    renderer.setSnapshot.mockClear()
    selectedPanelTargets.value = [speciesTarget('Malus domestica')]
    hoveredPanelTargets.value = [{ kind: 'zone', zone_id: 'zone-1' }]

    await vi.waitFor(() => {
      const snapshot = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
      expect(snapshot?.highlightedPlantIds).toEqual(new Set(['plant-1', 'plant-2']))
      expect(snapshot?.highlightedZoneIds).toEqual(new Set(['zone-1']))
    })

    expect(runtime.querySurface.getSelection().length).toBe(0)
    expect(currentCanvasSelection.value.size).toBe(0)
    runtime.destroy()
  })

  it('uses the injected panel target adapter for highlights and canvas-origin hover', async () => {
    const panelTargetProbe = createPanelTargetAdapterProbe()
    const runtime = stubbedRuntime({ targetPresentation: panelTargetProbe.adapter })
    runtime.documentSurface.loadDocument(makeFile())
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)

    renderer.setSnapshot.mockClear()
    panelTargetProbe.setPanelOriginTargets([speciesTarget('Malus domestica')])

    await vi.waitFor(() => {
      expect(renderer.setSnapshot).toHaveBeenCalled()
    })

    const snapshot = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
    expect(snapshot?.highlightedPlantIds).toEqual(new Set(['plant-1', 'plant-2']))

    ;(runtime as any)._interaction._deps.setHoveredTarget(plantTarget('plant-1'))
    expect(panelTargetProbe.canvasHoverTargets).toEqual([speciesTarget('Malus domestica')])

    panelTargetProbe.setPanelOriginTargets([{ kind: 'zone', zone_id: 'zone-1' }])
    runtime.documentSurface.replaceDocument(
      makeFile(),
      createCanvasDocumentReplacementToken(),
      () => {},
    )
    expect(panelTargetProbe.panelOriginTargets).toEqual([])
    runtime.destroy()
  })

  it('reports canvas clean-state transitions through the injected app adapter', () => {
    const cleanState = createCleanStateAdapterProbe()
    const runtime = new SceneCanvasRuntime({ appAdapter: cleanState.adapter })
    const file = fileWithOnlyPlants('plant-1')

    runtime.documentSurface.loadDocument(file)
    runtime.documentSurface.captureForPersistence({ name: file.name }, file).acknowledgeSaved()
    cleanState.setCanvasClean.mockClear()

    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.sceneEdits.lockSelected()
    expect(lastCleanState(cleanState.setCanvasClean)).toBe(false)

    runtime.commandSurface.history.undo()
    expect(lastCleanState(cleanState.setCanvasClean)).toBe(true)

    runtime.commandSurface.history.redo()
    expect(lastCleanState(cleanState.setCanvasClean)).toBe(false)

    runtime.documentSurface.captureForPersistence({ name: file.name }, file).acknowledgeSaved()
    expect(lastCleanState(cleanState.setCanvasClean)).toBe(true)
  })

  it('stales existing persistence receipts and rejects new capture after destroy', () => {
    const runtime = new SceneCanvasRuntime()
    const file = fileWithOnlyPlants('plant-1')
    runtime.documentSurface.loadDocument(file)
    const capture = runtime.documentSurface.captureForPersistence({ name: file.name }, file)

    runtime.destroy()

    expect(capture.acknowledgeSaved()).toBe('stale')
    expect(() => runtime.documentSurface.captureForPersistence({ name: file.name }, file))
      .toThrow('runtime-disposed')
  })

  it('delegates Design file composition through the injected app adapter', () => {
    const composeDocumentForSave = vi.fn(({
      metadata,
      document,
      canvas,
    }: CanvasRuntimeDocumentCompositionInput) => ({
      ...document,
      ...canvas,
      name: metadata.name,
      description: 'composed by adapter',
    } as CanopiFile))
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        cleanState: { setCanvasClean: () => {} },
        document: { composeDocumentForSave },
        settings: createTestSettingsAdapter(),
        translate: t,
      },
    })
    const file = makeFile()

    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.plantPresentation.setSelectedPlantColor('#228833')

    const serialized = runtime.documentSurface.captureForPersistence({ name: 'Adapter save' }, file).content

    expect(composeDocumentForSave).toHaveBeenCalledTimes(1)
    const input = composeDocumentForSave.mock.calls[0]?.[0]
    expect(input?.metadata).toEqual({ name: 'Adapter save' })
    expect(input?.document).toBe(file)
    expect(input?.canvas.plants[0]?.color).toBe('#228833')
    expect(serialized.description).toBe('composed by adapter')
  })

  it('preserves document-owned fields when serializing with the detached runtime adapter', () => {
    const runtime = new SceneCanvasRuntime()
    const file = {
      ...makeFile(),
      description: 'Loaded description',
      consortiums: [{
        target: { kind: 'species', canonical_name: 'Malus domestica' },
        stratum: 'canopy',
        start_phase: 1,
        end_phase: 3,
      }],
      timeline: [{
        id: 'action-1',
        action_type: 'prune',
        description: 'Winter prune',
        start_date: '2026-12-01',
        end_date: null,
        recurrence: null,
        targets: [{ kind: 'species', canonical_name: 'Malus domestica' }],
        depends_on: null,
        completed: false,
        order: 0,
      }],
      budget: [{
        target: { kind: 'manual' },
        category: 'tools',
        description: 'Pruning saw',
        quantity: 1,
        unit_cost: 35,
        currency: 'EUR',
      }],
      budget_currency: 'USD',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-02-01T00:00:00.000Z',
      extra: {
        imported_from: 'legacy-plan',
      },
    } satisfies CanopiFile

    runtime.documentSurface.loadDocument({
      ...file,
      plants: [file.plants[0]!],
      zones: [],
      groups: [],
    })
    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.plantPresentation.setSelectedPlantColor('#228833')

    const serialized = runtime.documentSurface.captureForPersistence({ name: 'Detached save' }, file).content

    expect(serialized.name).toBe('Detached save')
    expect(serialized.description).toBe('Loaded description')
    expect(serialized).not.toHaveProperty('spatial_frame')
    expect(serialized.consortiums).toEqual(file.consortiums)
    expect(serialized.timeline).toEqual(file.timeline)
    expect(serialized.budget).toEqual(file.budget)
    expect(serialized.budget_currency).toBe('USD')
    expect(serialized.created_at).toBe('2025-01-01T00:00:00.000Z')
    expect(serialized.extra).toEqual({ imported_from: 'legacy-plan' })
    expect(serialized.plants[0]?.color).toBe('#228833')
  })

  it('saves unedited loaded positions back on the 1e-9° grid in detached composition', () => {
    const runtime = new SceneCanvasRuntime()
    const file = makeFile()
    runtime.documentSurface.loadDocument(file)

    const serialized = runtime.documentSurface.captureForPersistence(
      { name: 'Grid positions' },
      file,
    ).content

    expect(serialized.plants.map((plant) => plant.position))
      .toEqual(file.plants.map((plant) => roundGeoPosition(plant.position)))
    expect(serialized.zones.map((zone) => zone.points))
      .toEqual(file.zones.map((zone) => zone.points.map(roundGeoPosition)))
  })

  it('publishes canvas-origin species hover targets without mutating selection', async () => {
    const cleanState = createCleanStateAdapterProbe()
    const runtime = createRuntimeWithAppPanelTargets(cleanState.adapter)
    runtime.documentSurface.loadDocument(makeFile())
    cleanState.setCanvasClean.mockClear()
    await initRuntimeWithStubbedRenderer(runtime)

    ;(runtime as any)._interaction._deps.setHoveredTarget(plantTarget('plant-1'))

    expect(hoveredCanvasTargets.value).toEqual([speciesTarget('Malus domestica')])
    expect(runtime.querySurface.getSelection().length).toBe(0)
    expect(currentCanvasSelection.value.size).toBe(0)
    expect(cleanState.setCanvasClean).not.toHaveBeenCalledWith(false)

    ;(runtime as any)._interaction._deps.setHoveredTarget(null)

    expect(hoveredCanvasTargets.value).toEqual([])
    expect(runtime.querySurface.getSelection().length).toBe(0)
    expect(currentCanvasSelection.value.size).toBe(0)
    expect(cleanState.setCanvasClean).not.toHaveBeenCalledWith(false)
    runtime.destroy()
  })

  it('clears canvas-origin hover during destroy without rendering into a disposing renderer', async () => {
    const runtime = createRuntimeWithAppPanelTargets()
    runtime.documentSurface.loadDocument(makeFile())
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)

    ;(runtime as any)._interaction._deps.setHoveredTarget(plantTarget('plant-1'))
    expect(hoveredCanvasTargets.value).toEqual([speciesTarget('Malus domestica')])

    renderer.setSnapshot.mockClear()
    runtime.destroy()

    expect(hoveredCanvasTargets.value).toEqual([])
    expect(renderer.setSnapshot).not.toHaveBeenCalled()
  })

  it('asks the target for a repaint on a zoom and publishes no snapshot', async () => {
    const runtime = stubbedRuntime()
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
    setInteractionViewport(runtime, { x: 50, y: 0, scale: 3 })

    renderer.setSnapshot.mockClear()
    runtime.commandSurface.viewport.zoomIn()
    await Promise.resolve()
    await Promise.resolve()

    expect(renderer.requestRender).toHaveBeenCalled()
    expect(renderer.setSnapshot).not.toHaveBeenCalled()
    runtime.destroy()
  })

  it('a view command the camera refuses does not redraw', async () => {
    const runtime = stubbedRuntime()
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
    setInteractionViewport(runtime, { x: 50, y: 0, scale: 3 })
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await nextFrame()

    renderer.requestRender.mockClear()
    runtime.commandSurface.viewport.zoomBy(Number.NaN)
    await nextFrame()

    expect(renderer.requestRender).not.toHaveBeenCalled()
    runtime.destroy()
  })

  it('a reopen frames the Design inside the chrome insets reported before its first frame, as Fit to Design does', async () => {
    const runtime = stubbedRuntime()
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
    await vi.waitFor(() => expect(runtime.documentSurface.presented.value).toBe(true))
    // The start screen's insets while no Design is open (the title bar).
    runtime.commandSurface.viewport.setFramingInsets({ top: 60, right: 0, bottom: 0, left: 0 })
    const atSceneSync: Array<{ x: number; y: number; scale: number }> = []
    renderer.setSnapshot.mockImplementation(() => { atSceneSync.push(placementOf(runtime)) })

    runtime.documentSurface.replaceDocument(makeFile(), createCanvasDocumentReplacementToken(), () => {})
    runtime.documentSurface.zoomToFit()
    // The Design chrome mounts and reports where it sits before the next frame.
    runtime.commandSurface.viewport.setFramingInsets({ top: 60, right: 64, bottom: 52, left: 236 })
    await vi.waitFor(() => expect(runtime.documentSurface.presented.value).toBe(true))
    const opened = placementOf(runtime)

    expect(atSceneSync.at(-1), 'the camera and the scene land in one frame').toEqual(opened)
    runtime.commandSurface.viewport.zoomToFit()
    const fitted = placementOf(runtime)
    expect(opened.x).toBeCloseTo(fitted.x, 3)
    expect(opened.y).toBeCloseTo(fitted.y, 3)
    expect(opened.scale).toBeCloseTo(fitted.scale, 3)
    runtime.destroy()
  })

  it('the open fit places the camera in the scene render that draws it, never before', async () => {
    const runtime = stubbedRuntime()
    runtime.documentSurface.loadDocument(makeFile())
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
    setInteractionViewport(runtime, { x: 50, y: 0, scale: 3 })
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const before = placementOf(runtime)
    const atSceneSync: Array<{ x: number; y: number; scale: number }> = []
    renderer.setSnapshot.mockImplementation(() => { atSceneSync.push(placementOf(runtime)) })

    runtime.documentSurface.zoomToFit()
    expect(placementOf(runtime), 'the camera waits for the scene render').toEqual(before)
    await vi.waitFor(() => expect(atSceneSync).toHaveLength(1))

    expect(atSceneSync[0]).not.toEqual(before)
    expect(atSceneSync[0]).toEqual(placementOf(runtime))
    runtime.destroy()
  })

  it('resets transient runtime state before replacing the document', async () => {
    const runtime = createRuntimeWithAppPanelTargets()
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)

    runtime.documentSurface.loadDocument(makeFile())
    runtime.commandSurface.tools.setTool('plant-stamp')
    currentCanvasTool.value = 'plant-stamp'
    selectPlantStampSource({
      canonical_name: 'Malus domestica',
      common_name: 'Apple',
      stratum: 'high',
      width_max_m: 4,
    })
    plantColorMenuOpen.value = true
    currentCanvasSelection.value = new Set(['plant-1'])
    hoveredPanelTargets.value = [speciesTarget('Malus domestica')]
    selectedPanelTargetOrigin.value = 'timeline'
    selectedPanelTargets.value = [{ kind: 'zone', zone_id: 'zone-1' }]
    runtime.commandSurface.sceneEdits.selectAll()

    renderer.setSnapshot.mockClear()
    runtime.documentSurface.replaceDocument(
      makeFile(),
      createCanvasDocumentReplacementToken(),
      () => {},
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(currentCanvasTool.value).toBe('select')
    expect(readPlantStampSource()).toBe(null)
    expect(plantColorMenuOpen.value).toBe(false)
    expect(currentCanvasSelection.value.size).toBe(0)
    expect(hoveredPanelTargets.value).toEqual([])
    expect(selectedPanelTargets.value).toEqual([])
    expect(selectedPanelTargetOrigin.value).toBeNull()
    runtime.destroy()
  })

  it('records Object Stamp plant placement in history without replacing the clipboard', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = makeFile()
    file.plants = file.plants.map((plant) => ({ ...plant, symbol: 'conifer', pinned_name: true }))
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)

    clickAt(events, { x: 20, y: 20 })
    runtime.commandSurface.sceneEdits.copy()
    runtime.commandSurface.tools.setTool('object-stamp')

    events.pointerDown({ x: 10, y: 10 })
    events.pointerDown({ x: 30, y: 30 })

    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(3)
    const stampedId = runtime.querySurface.getSceneSnapshot().plants[2]!.id
    expect(runtime.querySurface.getSceneSnapshot().plants[2]!.pinnedName).toBe(false)
    expect(currentCanvasSelection.value).toEqual(new Set([stampedId]))

    runtime.commandSurface.history.undo()
    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(2)

    runtime.commandSurface.sceneEdits.paste()
    const pasted = runtime.querySurface.getSceneSnapshot().plants[2]!
    expect(pasted.canonicalName).toBe('Malus domestica')
    expect(pasted.symbol).toBe('conifer')
    expect(pasted.pinnedName).toBe(false)
    expectPointNear(pasted.position, planeAt(runtime, 21, 20))
    events.dispose()
    runtime.destroy()
  })

  it('records Object Stamp group placement as one undoable edit with cloned members', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = makeFile()
    file.zones = []
    file.groups = [{
      id: 'group-1',
      name: 'Pair',
      locked: false,
      members: [
        { kind: 'plant', id: 'plant-1' },
        { kind: 'plant', id: 'plant-2' },
      ],
    }]
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('object-stamp')

    events.pointerDown({ x: 10, y: 10 })
    events.pointerDown({ x: 40, y: 40 })

    expect(runtime.querySurface.getSceneSnapshot().groups).toHaveLength(2)
    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(4)
    const stampedGroup = runtime.querySurface.getSceneSnapshot().groups[1]!
    expect(currentCanvasSelection.value).toEqual(new Set([stampedGroup.id]))
    expect(stampedGroup.members).toHaveLength(2)
    expect(stampedGroup.members.map((member) => member.id)).not.toContain('plant-1')
    expect(stampedGroup.members.map((member) => member.id)).not.toContain('plant-2')

    runtime.commandSurface.history.undo()
    expect(runtime.querySurface.getSceneSnapshot().groups).toHaveLength(1)
    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(2)
    events.dispose()
    runtime.destroy()
  })

  it('records Saved Object Stamp placement as one undoable scene edit', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = makeFile()
    file.plants = []
    file.zones = []
    file.annotations = []
    file.groups = []
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)
    selectSavedObjectStampSource({
      version: 2,
      anchor: { x: 10, y: 10 },
      plants: [{
        id: 'plant-1',
        canonicalName: 'Malus domestica',
        commonName: 'Apple',
        color: null,
        symbol: null,
        position: { x: 10, y: 10 },
        rotationDeg: null,
        scale: 2,
      }],
      zones: [{
        id: 'zone-1',
        name: 'Bed',
        zoneType: 'rect',
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 },
        ],
        rotationDeg: 0,
        fillColor: null,
      }],
      annotations: [],
      groups: [],
    })
    runtime.commandSurface.tools.setTool('saved-object-stamp')

    events.pointerDown({ x: 40, y: 40 })

    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(1)
    expect(runtime.querySurface.getSceneSnapshot().plants[0]?.pinnedName).toBe(false)
    expect(runtime.querySurface.getSceneSnapshot().zones).toHaveLength(1)
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)

    runtime.commandSurface.history.undo()

    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(0)
    expect(runtime.querySurface.getSceneSnapshot().zones).toHaveLength(0)
    expect(runtime.commandSurface.history.canRedo.value).toBe(true)
    events.dispose()
    runtime.destroy()
  })

  it('records Plant Spacing commit as one undoable scene edit', async () => {
    const cleanState = createCleanStateAdapterProbe()
    cleanState.adapter.settings.commitPlantSpacingIntervalMeters(5)
    const runtime = stubbedRuntime({ appAdapter: cleanState.adapter })
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = makeFile()
    file.plants = file.plants.map((plant) =>
      plant.id === 'plant-1' ? { ...plant, pinned_name: true } : plant,
    )
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('plant-spacing')

    events.pointerDown({ x: 10, y: 10 })
    events.pointerMove({ x: 20, y: 10 })
    // The press adds the row's second point; Enter (the canvas keyboard's confirm) plants it (U58).
    events.pointerDown({ x: 20, y: 10 })
    expect(runtime.keyboardPort!.command({ kind: 'confirm' })).toBe(true)

    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(4)
    expect(runtime.querySurface.getSceneSnapshot().plants.slice(2).map((plant) => plant.pinnedName)).toEqual([false, false])
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)

    runtime.commandSurface.history.undo()
    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(2)
    expect(runtime.commandSurface.history.canRedo.value).toBe(true)

    runtime.commandSurface.history.redo()
    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(4)
    events.dispose()
    runtime.destroy()
  })

  it('nudges the editable selection as one undoable edit per series, never moving locked objects', async () => {
    const runtime = stubbedRuntime({ appAdapter: createCleanStateAdapterProbe().adapter })
    await initRuntimeWithStubbedRenderer(runtime)
    const file = makeFile()
    file.plants = file.plants.map((plant) => plant.id === 'plant-2' ? { ...plant, locked: true } : plant)
    runtime.documentSurface.loadDocument({ ...file, zones: [], annotations: [], groups: [] })
    setInteractionViewport(runtime)
    const position = (id: string) => runtime.querySurface.getSceneSnapshot().plants.find((plant) => plant.id === id)!.position
    const start1 = { ...position('plant-1') }
    const start2 = { ...position('plant-2') }
    runtime.commandSurface.sceneEdits.selectAll()
    expect(runtime.querySurface.getSelection().length).toBeGreaterThan(0)

    expect(runtime.commandSurface.sceneEdits.nudgeSelected({ x: 0.1, y: 0 })).toBe(true)
    expect(runtime.commandSurface.sceneEdits.nudgeSelected({ x: 0.1, y: 0 })).toBe(true)
    expect(runtime.commandSurface.sceneEdits.nudgeSelected({ x: 0, y: -1 })).toBe(true)
    expect(position('plant-1').x).toBeCloseTo(start1.x + 0.2, 6)
    expect(position('plant-1').y).toBeCloseTo(start1.y - 1, 6)
    expect(position('plant-2')).toEqual(start2)
    runtime.commandSurface.sceneEdits.endNudge()
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)

    runtime.commandSurface.history.undo()
    expect(position('plant-1').x).toBeCloseTo(start1.x, 6)
    expect(position('plant-1').y).toBeCloseTo(start1.y, 6)
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)

    // Aborting a series restores the objects and records nothing.
    runtime.commandSurface.history.redo()
    runtime.commandSurface.history.undo()
    runtime.commandSurface.sceneEdits.nudgeSelected({ x: 1, y: 0 })
    runtime.commandSurface.sceneEdits.endNudge({ abort: true })
    expect(position('plant-1').x).toBeCloseTo(start1.x, 6)
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)

    // Nothing editable selected: nothing moves.
    runtime.commandSurface.sceneEdits.clearSelection()
    expect(runtime.commandSurface.sceneEdits.nudgeSelected({ x: 1, y: 0 })).toBe(false)
    runtime.destroy()
  })

  it('records nothing for a nudge series that returns to where it started', async () => {
    const cleanState = createCleanStateAdapterProbe()
    const runtime = stubbedRuntime({ appAdapter: cleanState.adapter })
    await initRuntimeWithStubbedRenderer(runtime)
    const file = fileWithOnlyPlants('plant-1')
    runtime.documentSurface.loadDocument(file)
    runtime.documentSurface.captureForPersistence({ name: file.name }, file).acknowledgeSaved()
    setInteractionViewport(runtime)
    const position = () => runtime.querySurface.getSceneSnapshot().plants[0]!.position
    const start = { ...position() }
    runtime.commandSurface.sceneEdits.selectAll()
    cleanState.setCanvasClean.mockClear()

    // 3 × 0.1 m right then 3 × 0.1 m left sums to 2.8e-17 in floating point, not 0.
    for (let step = 0; step < 3; step += 1) runtime.commandSurface.sceneEdits.nudgeSelected({ x: 0.1, y: 0 })
    for (let step = 0; step < 3; step += 1) runtime.commandSurface.sceneEdits.nudgeSelected({ x: -0.1, y: 0 })
    runtime.commandSurface.sceneEdits.endNudge()

    expect(position()).toEqual(start)
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    expect(cleanState.setCanvasClean.mock.calls.some(([clean]) => clean === false)).toBe(false)
    runtime.destroy()
  })

  it('mounts the renderer and editing again after a map failure, keeping the Scene, view, selection and undo', async () => {
    const runtime = new SceneCanvasRuntime()
    runtime.connectRenderTarget(createRendererStub())
    const container = createRuntimeContainer()
    await runtime.init(container)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    setInteractionViewport(runtime)
    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.sceneEdits.nudgeSelected({ x: 1, y: 0 })
    runtime.commandSurface.sceneEdits.endNudge()
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)
    panOn(runtime, { x: 40, y: 10 })
    const placement = placementOf(runtime)
    const scene = runtime.querySurface.getSceneSnapshot()

    await runtime.unmountRenderer()
    expect(runtime.keyboardPort).toBeNull()
    // The map Retry built connects its layer, then the runtime mounts on it.
    const rebuilt = createRendererStub()
    runtime.connectRenderTarget(rebuilt)
    await runtime.remountRenderer(container)

    expect(rebuilt.setSnapshot).toHaveBeenCalledOnce()
    expect(runtime.keyboardPort).not.toBeNull()
    expect(runtime.querySurface.getSceneSnapshot()).toEqual(scene)
    expect(runtime.querySurface.getSelection()).toEqual([{ kind: 'plant', id: 'plant-1' }])
    const kept = placementOf(runtime)
    expect(kept.x).toBeCloseTo(placement.x, 6)
    expect(kept.y).toBeCloseTo(placement.y, 6)
    expect(kept.scale).toBeCloseTo(placement.scale, 6)
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)
    runtime.destroy()
  })

  it('leaves nothing mounted when a remount fails', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    await runtime.unmountRenderer()
    const rebuilt = createRendererStub()
    rebuilt.setSnapshot.mockImplementation(() => { throw new Error('renderer remount failed') })
    runtime.connectRenderTarget(rebuilt)

    await expect(runtime.remountRenderer(container)).rejects.toThrow('renderer remount failed')

    expect(runtime.keyboardPort).toBeNull()
    expect((runtime as any)._rendering.container).toBeNull()
    runtime.destroy()
  })

  it('a runtime mounts synchronously and draws on its first frame', async () => {
    const runtime = new SceneCanvasRuntime()
    const target = createRendererStub()
    runtime.connectRenderTarget(target)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))

    const init = runtime.init(createRuntimeContainer())
    // Nothing to wait for before editing: the slot is the renderer.
    expect(runtime.keyboardPort).not.toBeNull()
    await init

    expect(target.setSnapshot).toHaveBeenCalledOnce()
    expect(target.setSnapshot.mock.calls[0]![0].scene.plants.map((plant) => plant.id)).toEqual(['plant-1'])
    runtime.destroy()
  })

  it('nudges from the arrow keys on the focused map through the runtime command', async () => {
    const runtime = stubbedRuntime({ appAdapter: createCleanStateAdapterProbe().adapter })
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(fileWithOnlyPlants('plant-1'))
    setInteractionViewport(runtime)
    const position = () => runtime.querySurface.getSceneSnapshot().plants[0]!.position
    const start = { ...position() }
    runtime.commandSurface.sceneEdits.selectAll()
    // Key routing listens on the window, so the map must be in the document.
    document.body.append(container)
    container.focus()
    const keys = installCanvasKeyRouter(() => runtime.keyboardPort)

    events.keyDown({ key: 'ArrowRight', target: container })
    events.keyDown({ key: 'ArrowRight', ctrlKey: true, target: container })
    expect(position().x).toBeCloseTo(start.x + 1.1, 6)
    // Another key ends the series: one edit to undo.
    events.keyDown({ key: 'Control', target: container })
    events.keyDown({ key: 'a', target: container })
    runtime.commandSurface.history.undo()
    expect(position().x).toBeCloseTo(start.x, 6)
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    keys.dispose()
    events.dispose()
    runtime.destroy()
    container.remove()
  })

  it('records Measurement Guide creation as one undoable scene edit', async () => {
    const runtime = stubbedRuntime()
    const { container, renderer } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = makeFile()
    file.layers = [
      ...file.layers,
      { name: 'measurement-guides', visible: true, locked: false, opacity: 1 },
    ]
    file.measurement_guides = []
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('measurement-guide')

    events.pointerDown({ x: 10, y: 10 })
    events.pointerMove({ x: 40, y: 10 })

    expect(draftLabelTexts(renderer)).toEqual(['30 m'])

    events.pointerUp({ x: 40, y: 10 })

    const created = runtime.querySurface.getSceneSnapshot().measurementGuides
    expect(created).toHaveLength(1)
    const createdGuide = created?.[0]!
    expect(createdGuide).toMatchObject({ kind: 'measurement-guide', locked: false })
    expectGuideNear(runtime, createdGuide, [10, 10], [40, 10])
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)

    const serialized = runtime.documentSurface.captureForPersistence({ name: file.name }, file).content
    expect(serialized.measurement_guides).toEqual([
      {
        id: createdGuide.id,
        locked: false,
        start: geoNear(at(10, 10)),
        end: geoNear(at(40, 10)),
      },
    ])

    runtime.commandSurface.history.undo()
    expect(runtime.querySurface.getSceneSnapshot().measurementGuides).toHaveLength(0)
    expect(runtime.commandSurface.history.canRedo.value).toBe(true)

    runtime.commandSurface.history.redo()
    expect(runtime.querySurface.getSceneSnapshot().measurementGuides).toHaveLength(1)
    events.dispose()
    runtime.destroy()
  })

  it('selects a newly created Measurement Guide instead of keeping a stale object selection', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = makeFile()
    file.layers = [
      ...file.layers,
      { name: 'measurement-guides', visible: true, locked: false, opacity: 1 },
    ]
    file.measurement_guides = []
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    clickAt(events, { x: 10, y: 10 })
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

    runtime.commandSurface.tools.setTool('measurement-guide')
    events.pointerDown({ x: 100, y: 10 })
    events.pointerMove({ x: 140, y: 10 })
    events.pointerUp({ x: 140, y: 10 })

    const createdGuide = runtime.querySurface.getSceneSnapshot().measurementGuides[0]
    expect(createdGuide).toBeDefined()
    expect(currentCanvasSelection.value).toEqual(new Set([createdGuide!.id]))
    expect(runtime.querySurface.getDesignObjectSelection().editableTargets).toEqual([
      { kind: 'measurement-guide', id: createdGuide!.id },
    ])

    runtime.commandSurface.sceneEdits.deleteSelected()

    expect(runtime.querySurface.getSceneSnapshot().measurementGuides).toHaveLength(0)
    expect(runtime.querySurface.getSceneSnapshot().plants).toHaveLength(2)
    events.dispose()
    runtime.destroy()
  })

  it('keeps the current selection when a Measurement Guide drag creates no guide', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    const file = makeFile()
    file.layers = [
      ...file.layers,
      { name: 'measurement-guides', visible: true, locked: false, opacity: 1 },
    ]
    file.measurement_guides = []
    runtime.documentSurface.loadDocument(file)
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    clickAt(events, { x: 10, y: 10 })
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

    runtime.commandSurface.tools.setTool('measurement-guide')
    events.pointerDown({ x: 100, y: 10 })
    events.pointerUp({ x: 100, y: 10 })

    expect(runtime.querySurface.getSceneSnapshot().measurementGuides).toHaveLength(0)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(runtime.commandSurface.history.canUndo.value).toBe(false)
    events.dispose()
    runtime.destroy()
  })

  it('selects and moves Measurement Guides as undoable Design Objects', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(fileWithMeasurementGuide())
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    clickAt(events, { x: 25, y: 10 })

    expect(currentCanvasSelection.value).toEqual(new Set(['measurement-guide-1']))
    expect(runtime.querySurface.getDesignObjectSelection().editableTargets).toEqual([
      { kind: 'measurement-guide', id: 'measurement-guide-1' },
    ])

    events.pointerDown({ x: 25, y: 10 })
    events.pointerMove({ x: 35, y: 20 })
    events.pointerUp({ x: 35, y: 20 })

    expect(runtime.querySurface.getSceneSnapshot().measurementGuides).toEqual([{
      kind: 'measurement-guide',
      id: 'measurement-guide-1',
      locked: false,
      start: expect.any(Object),
      end: expect.any(Object),
    }])
    expectGuideNear(runtime, runtime.querySurface.getSceneSnapshot().measurementGuides[0], [20, 20], [50, 20])
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)

    runtime.commandSurface.history.undo()
    expectGuideNear(runtime, runtime.querySurface.getSceneSnapshot().measurementGuides[0], [10, 10], [40, 10])
    expect(runtime.commandSurface.history.canRedo.value).toBe(true)

    runtime.commandSurface.history.redo()
    expectGuideNear(runtime, runtime.querySurface.getSceneSnapshot().measurementGuides[0], [20, 20], [50, 20])
    events.dispose()
    runtime.destroy()
  })

  it('duplicates, copy/pastes, and deletes Measurement Guides', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(fileWithMeasurementGuide())
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    clickAt(events, { x: 25, y: 10 })
    runtime.commandSurface.sceneEdits.duplicateSelected()

    let guides = runtime.querySurface.getSceneSnapshot().measurementGuides
    expect(guides).toHaveLength(2)
    const duplicate = guides.find((guide) => guide.id !== 'measurement-guide-1')
    expect(duplicate).toMatchObject({ locked: false })
    expectGuideNear(runtime, duplicate, [11, 10], [41, 10])
    expect(currentCanvasSelection.value).toEqual(new Set([duplicate!.id]))

    runtime.commandSurface.sceneEdits.copy()
    runtime.commandSurface.sceneEdits.paste()

    guides = runtime.querySurface.getSceneSnapshot().measurementGuides
    expect(guides).toHaveLength(3)
    const pastedId = [...currentCanvasSelection.value][0]!
    const pasted = guides.find((guide) => guide.id === pastedId)
    expect(pasted).toMatchObject({ locked: false })
    expectGuideNear(runtime, pasted, [12, 10], [42, 10])

    runtime.commandSurface.sceneEdits.deleteSelected()

    guides = runtime.querySurface.getSceneSnapshot().measurementGuides
    expect(guides).toHaveLength(2)
    expect(guides.some((guide) => guide.id === pastedId)).toBe(false)
    expect(currentCanvasSelection.value.size).toBe(0)
    events.dispose()
    runtime.destroy()
  })

  it('respects direct Measurement Guide locks and layer locks for selection and mutation', async () => {
    const runtime = stubbedRuntime()
    const { container } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(fileWithMeasurementGuide({ locked: true }))
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('select')

    clickAt(events, { x: 25, y: 10 })

    expect(currentCanvasSelection.value).toEqual(new Set(['measurement-guide-1']))
    expect(runtime.querySurface.getDesignObjectSelection().editableTargets).toEqual([])
    expect(runtime.querySurface.getDesignObjectSelection().lockedTargets).toEqual([
      { kind: 'measurement-guide', id: 'measurement-guide-1' },
    ])

    runtime.commandSurface.sceneEdits.duplicateSelected()
    runtime.commandSurface.sceneEdits.deleteSelected()

    expect(runtime.querySurface.getSceneSnapshot().measurementGuides).toHaveLength(1)
    expect(runtime.querySurface.getSceneSnapshot().measurementGuides[0]?.locked).toBe(true)

    runtime.commandSurface.sceneEdits.unlockSelected()
    expect(runtime.querySurface.getSceneSnapshot().measurementGuides[0]?.locked).toBe(false)
    runtime.commandSurface.sceneEdits.duplicateSelected()
    expect(runtime.querySurface.getSceneSnapshot().measurementGuides).toHaveLength(2)
    events.dispose()
    runtime.destroy()
    currentCanvasSelection.value = new Set()

    const lockedLayerRuntime = stubbedRuntime()
    const { container: lockedLayerContainer } = await initRuntimeWithStubbedRenderer(lockedLayerRuntime)
    const lockedLayerEvents = createSceneInteractionEventHarness(lockedLayerContainer)
    const lockedLayerFile = fileWithMeasurementGuide()
    lockedLayerFile.layers = lockedLayerFile.layers.map((layer) =>
      layer.name === 'measurement-guides' ? { ...layer, locked: true } : layer,
    )
    lockedLayerRuntime.documentSurface.loadDocument(lockedLayerFile)
    setInteractionViewport(lockedLayerRuntime)
    lockedLayerRuntime.commandSurface.tools.setTool('select')

    clickAt(lockedLayerEvents, { x: 25, y: 10 })
    lockedLayerRuntime.commandSurface.sceneEdits.selectAll()

    expect(currentCanvasSelection.value.size).toBe(0)
    expect(lockedLayerRuntime.querySurface.getDesignObjectSelection().editableTargets).toEqual([])
    lockedLayerEvents.dispose()
    lockedLayerRuntime.destroy()
    currentCanvasSelection.value = new Set()

    const hiddenLayerRuntime = stubbedRuntime()
    const { container: hiddenLayerContainer } = await initRuntimeWithStubbedRenderer(hiddenLayerRuntime)
    const hiddenLayerEvents = createSceneInteractionEventHarness(hiddenLayerContainer)
    const hiddenLayerFile = fileWithMeasurementGuide()
    hiddenLayerFile.layers = hiddenLayerFile.layers.map((layer) =>
      layer.name === 'measurement-guides' ? { ...layer, visible: false } : layer,
    )
    hiddenLayerRuntime.documentSurface.loadDocument(hiddenLayerFile)
    setInteractionViewport(hiddenLayerRuntime)
    hiddenLayerRuntime.commandSurface.tools.setTool('select')

    clickAt(hiddenLayerEvents, { x: 25, y: 10 })
    hiddenLayerRuntime.commandSurface.sceneEdits.selectAll()

    expect(currentCanvasSelection.value.size).toBe(0)
    expect(hiddenLayerRuntime.querySurface.getDesignObjectSelection().editableTargets).toEqual([])
    hiddenLayerEvents.dispose()
    hiddenLayerRuntime.destroy()
  })

  it('keeps Measurement Guides out of Object Groups', () => {
    const runtime = new SceneCanvasRuntime()
    const file = fileWithMeasurementGuide()
    file.plants = [makeFile().plants[0]!]
    file.zones = [makeFile().zones[0]!]
    runtime.documentSurface.loadDocument(file)

    runtime.commandSurface.sceneEdits.selectAll()
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1', 'zone-1', 'measurement-guide-1']))

    runtime.commandSurface.sceneEdits.groupSelected()

    const scene = runtime.querySurface.getSceneSnapshot()
    expect(scene.groups).toHaveLength(1)
    expect(scene.groups[0]?.members).toEqual([
      { kind: 'plant', id: 'plant-1' },
      { kind: 'zone', id: 'zone-1' },
    ])
    expect(scene.measurementGuides).toHaveLength(1)
    runtime.destroy()
  })

  it('does not create Measurement Guides when their layer is locked or hidden', async () => {
    const lockedRuntime = stubbedRuntime()
    const { container: lockedContainer, renderer: lockedRenderer } = await initRuntimeWithStubbedRenderer(lockedRuntime)
    const lockedEvents = createSceneInteractionEventHarness(lockedContainer)
    const lockedFile = makeFile()
    lockedFile.layers = [
      ...lockedFile.layers,
      { name: 'measurement-guides', visible: true, locked: true, opacity: 1 },
    ]
    lockedFile.measurement_guides = []
    lockedRuntime.documentSurface.loadDocument(lockedFile)
    setInteractionViewport(lockedRuntime)
    lockedRuntime.commandSurface.tools.setTool('select')

    clickAt(lockedEvents, { x: 10, y: 10 })
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

    lockedRuntime.commandSurface.tools.setTool('measurement-guide')

    lockedEvents.pointerDown({ x: 10, y: 10 })
    lockedEvents.pointerMove({ x: 40, y: 10 })
    lockedEvents.pointerUp({ x: 40, y: 10 })

    expect(draftLabelTexts(lockedRenderer)).toEqual([])
    expect(lockedRuntime.querySurface.getSceneSnapshot().measurementGuides).toHaveLength(0)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(lockedRuntime.commandSurface.history.canUndo.value).toBe(false)
    lockedEvents.dispose()
    lockedRuntime.destroy()

    const hiddenRuntime = stubbedRuntime()
    const { container: hiddenContainer, renderer: hiddenRenderer } = await initRuntimeWithStubbedRenderer(hiddenRuntime)
    const hiddenEvents = createSceneInteractionEventHarness(hiddenContainer)
    const hiddenFile = makeFile()
    hiddenFile.layers = [
      ...hiddenFile.layers,
      { name: 'measurement-guides', visible: false, locked: false, opacity: 1 },
    ]
    hiddenFile.measurement_guides = []
    hiddenRuntime.documentSurface.loadDocument(hiddenFile)
    setInteractionViewport(hiddenRuntime)
    hiddenRuntime.commandSurface.tools.setTool('select')

    clickAt(hiddenEvents, { x: 10, y: 10 })
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))

    hiddenRuntime.commandSurface.tools.setTool('measurement-guide')

    hiddenEvents.pointerDown({ x: 10, y: 10 })
    hiddenEvents.pointerMove({ x: 40, y: 10 })
    hiddenEvents.pointerUp({ x: 40, y: 10 })

    expect(draftLabelTexts(hiddenRenderer)).toEqual([])
    expect(hiddenRuntime.querySurface.getSceneSnapshot().measurementGuides).toHaveLength(0)
    expect(currentCanvasSelection.value).toEqual(new Set(['plant-1']))
    expect(hiddenRuntime.commandSurface.history.canUndo.value).toBe(false)
    hiddenEvents.dispose()
    hiddenRuntime.destroy()
  })

  it('routes history commands through polygonal zone draft vertices before scene history', async () => {
    const runtime = stubbedRuntime()
    const { container, renderer } = await initRuntimeWithStubbedRenderer(runtime)
    const events = createSceneInteractionEventHarness(container)
    runtime.documentSurface.loadDocument(makeFile())
    setInteractionViewport(runtime)
    runtime.commandSurface.tools.setTool('polygon')

    events.pointerDown({ x: 10, y: 10 })
    events.pointerDown({ x: 60, y: 10 })
    events.pointerMove({ x: 60, y: 50 })

    expect(runtime.commandSurface.history.canUndo.value).toBe(true)
    expect(runtime.commandSurface.history.canRedo.value).toBe(false)

    runtime.commandSurface.history.undo()

    expectBandNear(runtime, draftBand(renderer), [[10, 10], [60, 50]])
    expect(runtime.querySurface.getSceneSnapshot().zones).toHaveLength(1)
    expect(runtime.commandSurface.history.canRedo.value).toBe(true)

    runtime.commandSurface.history.redo()

    expectBandNear(runtime, draftBand(renderer), [[10, 10], [60, 10], [60, 50]])
    expect(runtime.querySurface.getSceneSnapshot().zones).toHaveLength(1)
    events.dispose()
    runtime.destroy()
  })

  it('invalidates the scene after select-all and lock mutations', () => {
    const runtime = new SceneCanvasRuntime()
    runtime.documentSurface.loadDocument(makeFile())
    const invalidate = vi.spyOn(runtime as any, '_invalidate')

    invalidate.mockClear()
    runtime.commandSurface.sceneEdits.selectAll()
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenLastCalledWith()

    invalidate.mockClear()
    runtime.commandSurface.sceneEdits.lockSelected()
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenLastCalledWith()

    invalidate.mockClear()
    runtime.commandSurface.sceneEdits.unlockSelected()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('locks selected Design Objects through scene edit history and serialization', () => {
    const cleanState = createCleanStateAdapterProbe()
    const runtime = new SceneCanvasRuntime({ appAdapter: cleanState.adapter })
    const file = fileWithOnlyPlants('plant-1')
    runtime.documentSurface.loadDocument(file)
    runtime.documentSurface.captureForPersistence({ name: file.name }, file).acknowledgeSaved()
    cleanState.setCanvasClean.mockClear()

    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.sceneEdits.lockSelected()

    expect(runtime.documentSurface.captureForPersistence({ name: file.name }, file).content.plants.find((plant) => plant.id === 'plant-1')?.locked)
      .toBe(true)
    expect(runtime.querySurface.getSelection().length).toBe(0)
    expect(lastCleanState(cleanState.setCanvasClean)).toBe(false)
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)

    runtime.commandSurface.history.undo()
    expect(runtime.documentSurface.captureForPersistence({ name: file.name }, file).content.plants.find((plant) => plant.id === 'plant-1')?.locked)
      .toBe(false)

    runtime.commandSurface.history.redo()
    expect(runtime.documentSurface.captureForPersistence({ name: file.name }, file).content.plants.find((plant) => plant.id === 'plant-1')?.locked)
      .toBe(true)

    runtime.commandSurface.sceneEdits.unlockSelected()
    expect(runtime.documentSurface.captureForPersistence({ name: file.name }, file).content.plants.find((plant) => plant.id === 'plant-1')?.locked)
      .toBe(true)
  })

  it('edits layer state through the scene edit history and projection signals', () => {
    const cleanState = createCleanStateAdapterProbe()
    const runtime = new SceneCanvasRuntime({
      appAdapter: {
        ...cleanState.adapter,
        settings: createDesktopCanvasRuntimeAppAdapter().settings,
      },
    })
    const file = makeFile()
    runtime.documentSurface.loadDocument(file)
    runtime.documentSurface.captureForPersistence({ name: file.name }, file).acknowledgeSaved()
    cleanState.setCanvasClean.mockClear()

    expect(runtime.commandSurface.layers.setSceneLayerVisibility('plants', false)).toBe(true)
    expect(runtime.commandSurface.layers.setSceneLayerOpacity('zones', 0.4)).toBe(true)
    expect(runtime.commandSurface.layers.setSceneLayerLocked('zones', true)).toBe(true)

    const serialized = runtime.documentSurface.captureForPersistence({ name: file.name }, file).content

    expect(serialized.layers.find((layer) => layer.name === 'plants')?.visible).toBe(false)
    expect(serialized.layers.find((layer) => layer.name === 'zones')?.opacity).toBe(0.4)
    expect(serialized.layers.find((layer) => layer.name === 'zones')?.locked).toBe(true)
    expect(lastCleanState(cleanState.setCanvasClean)).toBe(false)
    expect(runtime.commandSurface.history.canUndo.value).toBe(true)

    runtime.commandSurface.history.undo()
    expect(runtime.documentSurface.captureForPersistence({ name: file.name }, file).content.layers.find((layer) => layer.name === 'zones')?.locked)
      .toBe(false)

    runtime.commandSurface.history.redo()
    expect(runtime.documentSurface.captureForPersistence({ name: file.name }, file).content.layers.find((layer) => layer.name === 'zones')?.locked)
      .toBe(true)

    runtime.destroy()
  })

  it('marks the canvas dirty when only the species default color changes', () => {
    const cleanState = createCleanStateAdapterProbe()
    const runtime = new SceneCanvasRuntime({ appAdapter: cleanState.adapter })
    const file = makeFile()
    file.plant_species_colors = {
      'Malus domestica': '#112233',
    }
    file.plants[0]!.color = '#C44230'
    file.plants[1]!.color = '#C44230'
    runtime.documentSurface.loadDocument(file)
    runtime.documentSurface.captureForPersistence({ name: file.name }, file).acknowledgeSaved()
    cleanState.setCanvasClean.mockClear()

    const changed = runtime.commandSurface.plantPresentation.setPlantColorForSpecies('Malus domestica', '#C44230')

    expect(changed).toBe(0)
    expect(lastCleanState(cleanState.setCanvasClean)).toBe(false)
    expect(runtime.documentSurface.captureForPersistence({ name: file.name }, file).content.plant_species_colors).toEqual({
      'Malus domestica': '#C44230',
    })
  })

  it('refreshes localized common names in renderer snapshots when the active locale changes', async () => {
    vi.mocked(getCommonNames)
      .mockResolvedValueOnce({ 'Malus domestica': 'Apple' })
      .mockResolvedValueOnce({ 'Malus domestica': 'Pommier' })

    const runtime = stubbedRuntime({
      appAdapter: createDesktopCanvasRuntimeAppAdapter(),
    })
    runtime.documentSurface.loadDocument(makeFile())
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
    await Promise.resolve()
    await Promise.resolve()

    const initialSnapshot = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
    expect(initialSnapshot?.localizedCommonNames.get('Malus domestica')).toBe('Apple')
    const initialRenderCount = renderer.setSnapshot.mock.calls.length

    locale.value = 'fr'
    await vi.waitFor(() => {
      expect(renderer.setSnapshot.mock.calls.length).toBeGreaterThan(initialRenderCount)
    })

    const localizedSnapshot = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
    expect(localizedSnapshot?.localizedCommonNames.get('Malus domestica')).toBe('Pommier')
    runtime.destroy()
  })

  it('keeps pinned plant name labels visible and localized in renderer snapshots', async () => {
    vi.mocked(getCommonNames)
      .mockResolvedValueOnce({ 'Malus domestica': 'Apple' })
      .mockResolvedValueOnce({ 'Malus domestica': 'Pommier' })

    const runtime = stubbedRuntime({
      appAdapter: createDesktopCanvasRuntimeAppAdapter(),
    })
    runtime.documentSurface.loadDocument(makeFile())
    const { renderer } = await initRuntimeWithStubbedRenderer(runtime)
    setInteractionViewport(runtime, { x: 0, y: 0, scale: 20 })
    const pinnedNames = (snapshot: SceneRendererSnapshot) => projectScenePlantLabels(snapshot, 20)
      .pinnedPlantNameLabels.map((label) => label.text)
    runtime.commandSurface.sceneEdits.selectAll()
    runtime.commandSurface.sceneEdits.toggleSelectedPlantNamePins()
    expect(runtime.querySurface.getSceneSnapshot().plants.map((plant) => plant.pinnedName)).toEqual([true, true])

    await vi.waitFor(() => {
      const snapshot = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
      if (!snapshot) throw new Error('Expected a renderer snapshot')
      expect(pinnedNames(snapshot)).toEqual(['Apple', 'Apple'])
    })
    const initialRenderCount = renderer.setSnapshot.mock.calls.length

    locale.value = 'fr'
    await vi.waitFor(() => {
      expect(renderer.setSnapshot.mock.calls.length).toBeGreaterThan(initialRenderCount)
    })

    const localizedSnapshot = renderer.setSnapshot.mock.calls[renderer.setSnapshot.mock.calls.length - 1]?.[0]
    if (!localizedSnapshot) throw new Error('Expected a localized renderer snapshot')
    expect(pinnedNames(localizedSnapshot)).toEqual(['Pommier', 'Pommier'])
    runtime.destroy()
  })

  it('uses localized common names in selected plant presentation contexts', async () => {
    vi.mocked(getCommonNames).mockImplementation(async (_canonicalNames, activeLocale) => ({
      'Malus domestica': activeLocale === 'fr' ? 'Pommier' : 'Apple',
    }))

    const runtime = new SceneCanvasRuntime({
      appAdapter: createDesktopCanvasRuntimeAppAdapter(),
    })
    runtime.documentSurface.loadDocument(makeFile())
    runtime.commandSurface.sceneEdits.selectAll()

    locale.value = 'fr'
    await runtime.commandSurface.plantPresentation.ensureSpeciesCacheEntries(['Malus domestica'], 'fr')

    expect(getCommonNames).toHaveBeenCalledWith(['Malus domestica'], 'fr')
    expect(runtime.querySurface.getLocalizedCommonNames().get('Malus domestica')).toBe('Pommier')
    expect(runtime.querySurface.getSelectedPlantColorContext().singleSpeciesCommonName).toBe('Pommier')
    expect(runtime.querySurface.getSelectedPlantSymbolContext().singleSpeciesCommonName).toBe('Pommier')
  })
})

/** The Menu key while the map has focus opens the right-click menu for the selection. */
function openContextMenuFromKeyboard(runtime: SceneCanvasRuntime, container: HTMLElement): void {
  // The key router listens on the window, so the map must be in the document.
  document.body.appendChild(container)
  container.tabIndex = -1
  container.focus()
  const keys = installCanvasKeyRouter(() => runtime.keyboardPort)
  container.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))
  keys.dispose()
  container.remove()
}
