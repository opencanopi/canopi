// @vitest-environment jsdom

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import { Container, Text } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'
import { createTestSceneCanvasRuntime } from '../../__tests__/support/detached-canvas-app-adapter'
import type { SceneCanvasRuntime } from './scene-runtime'
import { createPixiScenePresentation } from './renderers/pixi-scene'
import { createSharedMapSceneRendererComposition } from '../../maplibre/shared-scene-renderer'
import type { SharedMapSceneMap, SharedPixiRenderer } from '../../maplibre/shared-scene-layer'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFile } from '../../types/design'

/** jsdom has no 2D canvas to measure text with. */
class MeasuredText extends Text {
  override get width(): number { return 40 }
  override set width(_value: number) {}
  override get height(): number { return 16 }
  override set height(_value: number) {}
}

function createContainer(): HTMLElement {
  const container = document.createElement('div')
  Object.defineProperties(container, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
  })
  return container
}

/** One apple tree near Nantes. */
function orchard(): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name: 'Orchard',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [{
      id: 'apple', locked: false, canonical_name: 'Malus domestica', common_name: null, color: null,
      pinned_name: false, position: { lon: -1.5536, lat: 47.2184 }, rotation: null, scale: null, notes: null,
      planted_date: null, quantity: null,
    }],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-10-07T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z',
  }
}

/** MapLibre's canvas and repaint request, 800 × 600 CSS px at density 1. */
function createMap() {
  const canvas = document.createElement('canvas')
  Object.defineProperties(canvas, {
    clientWidth: { value: 800 }, clientHeight: { value: 600 },
    width: { value: 800, writable: true }, height: { value: 600, writable: true },
  })
  return { getCanvas: () => canvas, triggerRepaint: vi.fn<() => void>() } satisfies SharedMapSceneMap
}

/** Pixi's WebGL renderer, which jsdom cannot start; the stage and the presentation are Pixi's own. */
function createPixiRenderer(): SharedPixiRenderer {
  return {
    init: vi.fn(async () => {}), render: vi.fn(), resize: vi.fn(), resetState: vi.fn(),
    destroy: vi.fn(), context: { extensions: { loseContext: { loseContext: vi.fn() } } },
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** The shared scene layer's id, camera frames and a Pixi presentation that measures text without a canvas. */
function layerOptions(runtime: SceneCanvasRuntime) {
  return {
    id: 'canopi-shared-scene',
    frames: runtime.cameraHost.frames,
    createPresentation: (input: Parameters<typeof createPixiScenePresentation>[0]) =>
      createPixiScenePresentation({ ...input, createText: () => new MeasuredText() }),
  }
}

describe('SceneCanvasRuntime and the shared map scene layer', () => {
  it('a map layer connected after the runtime drew presents the Scene in its first frame, and a pan only repaints', async () => {
    const runtime = createTestSceneCanvasRuntime()
    runtime.documentSurface.loadDocument(orchard())
    const container = createContainer()
    await runtime.init(container)
    expect(container.querySelector('canvas'), 'MapLibre owns the only surface').toBeNull()

    // As a Design switch or a Retry builds a new map and layer: the slot replays the drawn Scene to it.
    const composition = createSharedMapSceneRendererComposition((target) => runtime.connectRenderTarget(target))
    const stage = new Container()
    const pixi = createPixiRenderer()
    const map = createMap()
    const gl = {} as WebGL2RenderingContext
    const layer = composition.createLayer({ ...layerOptions(runtime), createRenderer: () => pixi, createStage: () => stage })
    await layer.initialize(map, gl)
    layer.layer.onAdd!(map as never, gl)
    layer.layer.render(gl, {} as never)

    expect(layer.diagnostics.sceneSyncCount).toBe(1)
    expect(pixi.render).toHaveBeenCalledOnce()
    const [worldRoot, billboardRoot] = stage.children
    expect(billboardRoot!.children.length, 'the apple tree is drawn').toBeGreaterThan(0)

    // A pan asks MapLibre for a frame; the layer reads the camera itself and syncs no scene.
    map.triggerRepaint.mockClear()
    runtime.cameraHost.current().apply({ kind: 'pan-by', deltaPx: { x: 30, y: -20 } })
    expect(map.triggerRepaint).toHaveBeenCalled()
    layer.layer.render(gl, {} as never)
    expect(layer.diagnostics.sceneSyncCount).toBe(1)
    worldRoot!.updateLocalTransform()
    const view = runtime.cameraHost.frames.viewFrame.peek().view
    expect(worldRoot!.localTransform.tx).toBeCloseTo(view.planar.affine[4], 6)

    await layer.dispose()
    runtime.destroy()
  })

  it('a pan or a container resize asks the layer for exactly one repaint', async () => {
    const runtime = createTestSceneCanvasRuntime()
    runtime.documentSurface.loadDocument(orchard())
    const container = createContainer()
    await runtime.init(container)
    const composition = createSharedMapSceneRendererComposition((target) => runtime.connectRenderTarget(target))
    const map = createMap()
    const gl = {} as WebGL2RenderingContext
    const layer = composition.createLayer({ ...layerOptions(runtime), createRenderer: createPixiRenderer })
    await layer.initialize(map, gl)
    layer.layer.onAdd!(map as never, gl)
    layer.layer.render(gl, {} as never)

    // A mouse's Shift wheel pans through the session's navigation: its camera frame is the one repaint.
    map.triggerRepaint.mockClear()
    container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, deltaY: 60, shiftKey: true }))
    expect(map.triggerRepaint).toHaveBeenCalledOnce()

    // The container's resize gives the camera a new screen, whose frame is the one repaint.
    map.triggerRepaint.mockClear()
    runtime.documentSurface.resize(640, 480)
    expect(map.triggerRepaint).toHaveBeenCalledOnce()

    await layer.dispose()
    runtime.destroy()
  })

  it('a Design switch presents the new Design once its new layer has drawn it, not when the layer is created', async () => {
    const runtime = createTestSceneCanvasRuntime()
    runtime.documentSurface.loadDocument(orchard())
    const container = createContainer()
    const composition = createSharedMapSceneRendererComposition((target) => runtime.connectRenderTarget(target))
    const gl = {} as WebGL2RenderingContext
    const oldMap = createMap()
    const old = composition.createLayer({ ...layerOptions(runtime), createRenderer: createPixiRenderer })
    await old.initialize(oldMap, gl)
    old.layer.onAdd!(oldMap as never, gl)
    await runtime.init(container)
    await vi.waitFor(() => expect(runtime.documentSurface.presented.value).toBe(true))

    // The switch disposes the old layer; the new Design's render waits for the new map's layer.
    await old.dispose()
    runtime.documentSurface.loadDocument(orchard())
    await nextFrame()
    await nextFrame()
    expect(runtime.documentSurface.presented.value).toBe(false)

    // The new map's style loaded: the activation creates the layer, then Pixi starts while the browser keeps drawing frames.
    let finishPixiInit!: () => void
    const pixi = { ...createPixiRenderer(), init: vi.fn(() => new Promise<void>((resolve) => { finishPixiInit = resolve })) }
    const map = createMap()
    // MapLibre draws its custom layers in the animation frame a repaint request asks for.
    map.triggerRepaint.mockImplementation(() => { requestAnimationFrame(() => layer.layer.render(gl, {} as never)) })
    const layer = composition.createLayer({ ...layerOptions(runtime), createRenderer: () => pixi })
    const drawsWhenPresented: number[] = []
    const stopWatching = runtime.documentSurface.presented.subscribe((presented) => {
      if (presented) drawsWhenPresented.push(layer.diagnostics.sceneSyncCount)
    })
    const initialized = layer.initialize(map, gl)
    await nextFrame()
    await nextFrame()
    expect(runtime.documentSurface.presented.value, 'the layer has not drawn').toBe(false)
    expect(container.getAttribute('aria-busy')).toBe('true')

    finishPixiInit()
    await initialized
    // map.addLayer.
    layer.layer.onAdd!(map as never, gl)
    await vi.waitFor(() => expect(runtime.documentSurface.presented.value).toBe(true))
    expect(drawsWhenPresented, 'presented after the layer drew the Scene').toEqual([1])
    expect(container.hasAttribute('aria-busy')).toBe(false)
    stopWatching()
    await layer.dispose()
    runtime.destroy()
  })

  it('a layer whose disposal fails leaves the slot: the new Design waits for a live layer to draw it', async () => {
    const runtime = createTestSceneCanvasRuntime()
    runtime.documentSurface.loadDocument(orchard())
    const container = createContainer()
    const composition = createSharedMapSceneRendererComposition((target) => runtime.connectRenderTarget(target))
    const gl = {} as WebGL2RenderingContext
    const oldMap = createMap()
    // Pixi's teardown throws, as on a lost or never-initialized WebGL context.
    const pixi = { ...createPixiRenderer(), destroy: vi.fn(() => { throw new Error('context lost') }) }
    const old = composition.createLayer({ ...layerOptions(runtime), createRenderer: () => pixi })
    await old.initialize(oldMap, gl)
    old.layer.onAdd!(oldMap as never, gl)
    await runtime.init(container)
    await vi.waitFor(() => expect(runtime.documentSurface.presented.value).toBe(true))

    await expect(old.dispose()).rejects.toThrow('context lost')
    runtime.documentSurface.loadDocument(orchard())
    await nextFrame()
    await nextFrame()
    await nextFrame()
    expect(runtime.documentSurface.presented.value, 'no live layer has drawn the new Design').toBe(false)
    runtime.destroy()
  })

  it('closing the Design leaves the start screen idle: no layer is awaited, so the map is not busy', async () => {
    const runtime = createTestSceneCanvasRuntime()
    runtime.documentSurface.loadDocument(orchard())
    const container = createContainer()
    const composition = createSharedMapSceneRendererComposition((target) => runtime.connectRenderTarget(target))
    const map = createMap()
    const gl = {} as WebGL2RenderingContext
    const layer = composition.createLayer({ ...layerOptions(runtime), createRenderer: createPixiRenderer })
    await layer.initialize(map, gl)
    layer.layer.onAdd!(map as never, gl)
    await runtime.init(container)
    await vi.waitFor(() => expect(container.hasAttribute('aria-busy')).toBe(false))

    // Close Design: the workspace disposes the layer and builds no map; the runtime gets an empty Scene and hides its chrome.
    await layer.dispose()
    runtime.documentSurface.loadDocument({ ...orchard(), plants: [] })
    runtime.documentSurface.hideCanvasChrome()
    await nextFrame()
    await vi.waitFor(() => expect(container.hasAttribute('aria-busy'), 'the start screen is not busy').toBe(false))
    expect(runtime.documentSurface.presented.value).toBe(true)
    runtime.destroy()
  })
})
