// @vitest-environment jsdom

import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { Container, Text, Ticker, WebGLRenderer, type WebGLOptions } from 'pixi.js'
import {
  createSharedMapSceneLayer,
  sharedPixiRendererInitOptions,
  type SharedMapSceneMap,
  type SharedPixiRenderer,
} from '../maplibre/shared-scene-layer'
import { createSharedMapSceneRendererComposition } from '../maplibre/shared-scene-renderer'
import { createPixiScenePresentation, type PixiScenePresentation } from '../canvas/runtime/renderers/pixi-scene'
import type { ScenePlantEntity } from '../canvas/runtime/scene'
import { SceneRuntimeRenderScheduler } from '../canvas/runtime/scene-runtime/render-scheduler'
import { getCanvasTextOpacity } from '../canvas/runtime/text-visibility'
import { SETTLE_MS } from '../canvas/runtime/view/frame-source'
import type { DraftPresentation } from '../canvas/runtime/tools/draft'
import { createTestSceneRendererSnapshot } from './support/scene-renderer-snapshot'
import { createTestView, type TestView } from './support/test-view'
import './support/camera-tolerance'

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  Object.defineProperties(canvas, {
    clientWidth: { value: 200, writable: true },
    clientHeight: { value: 100, writable: true },
    width: { value: 400, writable: true },
    height: { value: 200, writable: true },
  })
  return canvas
}

/** A MapLibre map as the layer sees it; `project` and `getPitch` are there only to show that the layer never asks them. */
function createMap(canvas: HTMLCanvasElement): SharedMapSceneMap & { project: ReturnType<typeof vi.fn>; getPitch: ReturnType<typeof vi.fn> } {
  return {
    getCanvas: () => canvas,
    getPitch: vi.fn(() => 0),
    project: vi.fn(() => ({ x: 0, y: 0 })),
    triggerRepaint: vi.fn(),
  }
}

/** The runtime's camera on the canvas's 200 × 100 CSS px at density 2, plane origin at (40, 30), 4 px/m. */
function createFrames(): TestView {
  return createTestView({ screen: { width: 200, height: 100, devicePixelRatio: 2 }, viewport: { x: 40, y: 30, scale: 4 } })
}

const PINNED_PLANT: ScenePlantEntity = {
  kind: 'plant', locked: false, id: 'apple', canonicalName: 'Malus domestica', commonName: 'Apple', color: null,
  canopySpreadM: null, position: { x: 2, y: 1 }, rotationDeg: null, notes: null, plantedDate: null, quantity: 1, pinnedName: true,
}

/** Every node under `root`, depth first. */
function nodes(root: Container): Container[] {
  return root.children.flatMap((child) => [child, ...nodes(child)])
}

function createRenderer(init = vi.fn(async () => {})): SharedPixiRenderer {
  return {
    init,
    render: vi.fn(),
    resize: vi.fn(),
    resetState: vi.fn(),
    destroy: vi.fn(),
    context: { extensions: { loseContext: { loseContext: vi.fn() } } },
  }
}

describe('createSharedMapSceneLayer', () => {
  // ADR 0004: MapLibre owns the canvas's events and the only frame loop. The
  // options are Pixi's real ones (the type check below), so nothing hides
  // behind a cast, and what init installs anyway is detached right after.
  // skipExtensionImports leaves out Pixi's filter extensions, yet the scene's plant layer
  // (layer opacity, species focus dim) and the Place plants and stamp ghosts draw through an
  // AlphaFilter. Without the filter pipe Pixi's render throws, and the map is torn down.
  it('registers Pixi\'s filter system and pipe, which every AlphaFilter of the scene and its drafts needs', () => {
    // The extensions a WebGL renderer is built with; `config` is protected, so a subclass reads it.
    const { renderPipes, systems } = new class extends WebGLRenderer {
      readonly extensionLists = this.config
    }().extensionLists
    expect(renderPipes.map((entry) => entry.name)).toContain('filter')
    expect(systems.map((entry) => entry.name)).toContain('filter')
  })

  it('initializes Pixi for MapLibre\'s context and loop: no extension imports, events, clears or GC, then detaches Pixi from the canvas and stops its ticker', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    const gl = {} as WebGL2RenderingContext
    const options: Partial<WebGLOptions> = sharedPixiRendererInitOptions({ canvas, context: gl, width: 200, height: 100, resolution: 2 })
    expect(options).toEqual({
      canvas, context: gl, width: 200, height: 100, resolution: 2,
      autoDensity: false, antialias: true, backgroundAlpha: 0, clearBeforeRender: false, premultipliedAlpha: true,
      skipExtensionImports: true,
      eventMode: 'none',
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
      textureGCActive: false,
      renderableGCActive: false,
    })

    const setTargetElement = vi.fn()
    const renderer: SharedPixiRenderer = { ...createRenderer(), events: { setTargetElement } }
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: createFrames().frames, createRenderer: () => renderer,
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => ({ dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }),
    })
    Ticker.system.start()
    expect(Ticker.system.started).toBe(true)

    await adapter.initialize(map, gl)

    expect(renderer.init).toHaveBeenCalledWith(expect.objectContaining({ canvas, context: gl, skipExtensionImports: true, eventMode: 'none' }))
    expect(setTargetElement).toHaveBeenCalledWith(null)
    expect(Ticker.system.started).toBe(false)
    await adapter.dispose()
  })

  it('draws only in MapLibre render after an explicit initialization and repaint request', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    const renderer = createRenderer()
    const presentation = { dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene',
      frames: createFrames().frames,
      createRenderer: () => renderer,
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => presentation,
    })
    const gl = {} as WebGL2RenderingContext

    await adapter.initialize(map, gl)
    const snapshot = createTestSceneRendererSnapshot()
    adapter.setSnapshot(snapshot)
    expect(map.triggerRepaint).toHaveBeenCalledOnce()
    expect(renderer.render).not.toHaveBeenCalled()

    adapter.layer.onAdd!(map as never, gl)
    adapter.requestRender()
    expect(map.triggerRepaint).toHaveBeenCalledTimes(2)
    adapter.layer.render(gl, {} as never)

    expect(presentation.present).toHaveBeenCalledOnce()
    expect(presentation.present.mock.calls[0]![0].planar.affine).toEqual([4, 0, 0, 4, 40, 30])
    expect(presentation.present.mock.calls[0]![1]).toBe(snapshot)
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({ clear: false }))
    expect(renderer.resetState).toHaveBeenCalledOnce()

    adapter.layer.render(gl, {} as never)
    expect(presentation.present).toHaveBeenCalledOnce()
    expect(renderer.init).toHaveBeenCalledOnce()
    expect(renderer.render).toHaveBeenCalledTimes(2)
    expect(adapter.diagnostics).toMatchObject({ phase: 'attached', sceneSyncCount: 1 })
  })

  it('rasterizes scene text at twice the MapLibre canvas density', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    let createText: (() => { resolution: number }) | null = null
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: createFrames().frames, createRenderer: () => createRenderer(),
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: (input) => {
        createText = input.createText
        return { dispose() {}, resize() {}, present() {}, setDraft() {} }
      },
    })

    await adapter.initialize(map, {} as WebGL2RenderingContext)

    // 400×200 backing pixels for a 200×100 CSS canvas is a density of 2.
    expect(createText!().resolution).toBe(4)
    await adapter.dispose()
  })

  it('the layer never derives a transform', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    const camera = createFrames()
    const presentation = { dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: camera.frames, createRenderer: () => createRenderer(),
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => presentation,
    })
    const gl = {} as WebGL2RenderingContext
    await adapter.initialize(map, gl)
    adapter.layer.onAdd!(map as never, gl)
    adapter.setSnapshot(createTestSceneRendererSnapshot())

    // The frame's own view, in CSS px whatever the canvas density (400 × 200 backing pixels here).
    adapter.layer.render(gl, {} as never)
    expect(presentation.present).toHaveBeenCalledExactlyOnceWith(camera.view(), expect.anything(), true)
    // A pan publishes a frame; the layer takes it on its next render, and nothing else.
    camera.setViewport({ x: 52, y: 18, scale: 4 })
    adapter.layer.render(gl, {} as never)
    expect(presentation.present).toHaveBeenCalledTimes(2)
    expect(presentation.present).toHaveBeenLastCalledWith(camera.view(), undefined, false)
    adapter.layer.render(gl, {} as never)
    expect(presentation.present).toHaveBeenCalledTimes(2)

    expect(map.project).not.toHaveBeenCalled()
    expect(map.getPitch).not.toHaveBeenCalled()
    await adapter.dispose()
  })

  it('resynchronizes presentation after a MapLibre-owned resize even when the camera is unchanged', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    const renderer = createRenderer()
    const camera = createFrames()
    const presentation = { dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: camera.frames, createRenderer: () => renderer,
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => presentation,
    })
    const gl = {} as WebGL2RenderingContext
    await adapter.initialize(map, gl)
    adapter.layer.onAdd!(map as never, gl)
    adapter.setSnapshot(createTestSceneRendererSnapshot())
    adapter.layer.render(gl, {} as never)

    Object.defineProperties(canvas, { clientWidth: { value: 300 }, clientHeight: { value: 150 } })
    canvas.width = 600
    canvas.height = 300
    // The camera takes the new screen and publishes a frame, the camera itself unchanged.
    camera.host.current().setScreen({ width: 300, height: 150, devicePixelRatio: 2 })
    adapter.layer.render(gl, {} as never)

    expect(presentation.present).toHaveBeenCalledTimes(2)
    expect(presentation.present.mock.calls[1]![0].screen).toMatchObject({ width: 300, height: 150 })
    expect(renderer.render).toHaveBeenCalledTimes(2)
    expect(adapter.diagnostics.sceneSyncCount).toBe(1)
    await adapter.dispose()
  })

  it('disposes an initialization that completes after its final owner has gone away', async () => {
    let resolveInit: (() => void) | undefined
    const renderer = createRenderer(vi.fn(() => new Promise<void>(resolve => { resolveInit = resolve })))
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: createFrames().frames, createRenderer: () => renderer,
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => ({ dispose() {}, resize() {}, present() {}, setDraft() {} }),
    })
    const canvas = createCanvas()
    const initialize = adapter.initialize(createMap(canvas), {} as WebGL2RenderingContext)
    const disposal = adapter.dispose()
    resolveInit!()
    await initialize
    await disposal

    expect(renderer.destroy).toHaveBeenCalledOnce()
    expect(adapter.diagnostics.phase).toBe('disposed')
  })

  // ADR 0004: nothing reloads the style, so the owner disposes the layer only right before MapLibre removes the map.
  it('dispose() on an attached layer destroys the renderer at once, without waiting for a frame', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    const renderer = createRenderer()
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: createFrames().frames, createRenderer: () => renderer,
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => ({ dispose() {}, resize() {}, present() {}, setDraft() {} }),
    })
    const gl = {} as WebGL2RenderingContext
    await adapter.initialize(map, gl)
    adapter.layer.onAdd!(map as never, gl)

    const disposal = adapter.dispose().then(() => 'disposed')
    const settled = await Promise.race([disposal, new Promise((resolve) => setTimeout(() => resolve('waiting for a frame'), 0))])

    expect(settled).toBe('disposed')
    expect(renderer.destroy).toHaveBeenCalledOnce()
    expect(renderer.context.extensions.loseContext).toBeUndefined()
    expect(adapter.diagnostics.phase).toBe('disposed')
  })

  it('lets MapLibre resize first without changing its backing dimensions', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    const renderer = createRenderer()
    const presentation = { dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: createFrames().frames, createRenderer: () => renderer,
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => presentation,
    })
    const gl = {} as WebGL2RenderingContext
    await adapter.initialize(map, gl)
    adapter.layer.onAdd!(map as never, gl)
    adapter.setSnapshot(createTestSceneRendererSnapshot())

    Object.defineProperties(canvas, { clientWidth: { value: 300 }, clientHeight: { value: 150 } })
    canvas.width = 600
    canvas.height = 300
    adapter.layer.render(gl, {} as never)

    expect(renderer.resize).toHaveBeenCalledWith(300, 150, expect.closeTo(2, 3))
    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(300)
    expect(presentation.resize).toHaveBeenCalledWith(300, 150)
    await adapter.dispose()
  })

  it('reports a terminal render failure once to the lifecycle owner', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    const renderer = createRenderer()
    const onFailure = vi.fn()
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: createFrames().frames,
      createRenderer: () => renderer,
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => ({
        dispose() {}, resize() {}, setDraft() {},
        present() { throw new Error('presentation failed') },
      }),
      onFailure,
    })
    const gl = {} as WebGL2RenderingContext
    await adapter.initialize(map, gl)
    adapter.layer.onAdd!(map as never, gl)
    adapter.setSnapshot(createTestSceneRendererSnapshot())

    adapter.layer.render(gl, {} as never)
    adapter.layer.render(gl, {} as never)

    expect(onFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: 'presentation failed',
    }))
    expect(adapter.diagnostics.phase).toBe('failed')
    await adapter.dispose()
  })

  it('a repaint the presentation asks for outside a render repaints the map (a draft chip\'s font arrived)', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    let requestRepaint: (() => void) | null = null
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene',
      frames: createFrames().frames,
      createRenderer: () => createRenderer(),
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: (input) => {
        requestRepaint = input.requestRepaint
        return { dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }
      },
    })
    await adapter.initialize(map, {} as WebGL2RenderingContext)
    expect(requestRepaint).not.toBeNull()
    requestRepaint!()
    expect(map.triggerRepaint).toHaveBeenCalledOnce()
  })

  it('a frame with a new view and a new snapshot presents once', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    const camera = createFrames()
    const presentation = { dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: camera.frames, createRenderer: () => createRenderer(),
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => presentation,
    })
    const gl = {} as WebGL2RenderingContext
    await adapter.initialize(map, gl)
    adapter.layer.onAdd!(map as never, gl)
    adapter.setSnapshot(createTestSceneRendererSnapshot())
    adapter.layer.render(gl, {} as never)

    // An edit lands during a zoom: one present draws the new snapshot under the new view.
    camera.setViewport({ x: 52, y: 18, scale: 8 })
    const edited = createTestSceneRendererSnapshot({ speciesFocus: { canonicalName: 'Malus domestica' } })
    adapter.setSnapshot(edited)
    adapter.layer.render(gl, {} as never)

    expect(presentation.present).toHaveBeenCalledTimes(2)
    expect(presentation.present).toHaveBeenLastCalledWith(camera.view(), edited, false)
    expect(adapter.diagnostics.sceneSyncCount).toBe(2)
    await adapter.dispose()
  })

  it('a settled frame repaints once and admits names at its exact scale', async () => {
    vi.useFakeTimers()
    try {
      const canvas = createCanvas()
      const map = createMap(canvas)
      const camera = createTestView({ screen: { width: 200, height: 100, devicePixelRatio: 2 }, viewport: { x: 40, y: 30, scale: 20 } })
      let present: MockInstance<PixiScenePresentation['present']> | null = null
      const stage = new Container()
      // The real presentation on a real Pixi stage; only the WebGL renderer is a stand-in.
      const adapter = createSharedMapSceneLayer({
        id: 'v2-scene', frames: camera.frames, createRenderer: () => createRenderer(), createStage: () => stage,
        createPresentation: (input) => {
          const presentation = createPixiScenePresentation(input)
          present = vi.spyOn(presentation, 'present')
          return presentation
        },
      })
      const gl = {} as WebGL2RenderingContext
      await adapter.initialize(map, gl)
      adapter.layer.onAdd!(map as never, gl)
      adapter.setSnapshot(createTestSceneRendererSnapshot({ scene: { plants: [PINNED_PLANT] } }))
      adapter.layer.render(gl, {} as never)
      const name = () => nodes(stage).find((node): node is Text => node instanceof Text && node.text === 'Apple')
      expect(name()?.alpha).toBe(1)

      // A zoom: 14 px/m is two bands down and admits; 12 px/m is in its band and keeps that admission.
      camera.setViewport({ x: 40, y: 30, scale: 14 })
      adapter.layer.render(gl, {} as never)
      camera.setViewport({ x: 40, y: 30, scale: 12 })
      adapter.layer.render(gl, {} as never)
      expect(present!).toHaveBeenLastCalledWith(camera.view(), undefined, false)
      expect(name()?.alpha).toBeCloseTo(getCanvasTextOpacity(14), 9)
      const repaints = vi.mocked(map.triggerRepaint).mock.calls.length

      vi.advanceTimersByTime(SETTLE_MS)
      expect(map.triggerRepaint).toHaveBeenCalledTimes(repaints + 1)
      adapter.layer.render(gl, {} as never)
      expect(present!).toHaveBeenLastCalledWith(camera.view(), undefined, true)
      expect(name()?.alpha).toBeCloseTo(getCanvasTextOpacity(12), 9)
      expect(getCanvasTextOpacity(12)).not.toBeCloseTo(getCanvasTextOpacity(14), 2)
      // Rest: a later repaint presents nothing.
      const presents = present!.mock.calls.length
      adapter.layer.render(gl, {} as never)
      expect(present!).toHaveBeenCalledTimes(presents)
      await adapter.dispose()
      // A settle after disposal asks for no frame.
      camera.setViewport({ x: 40, y: 30, scale: 20 })
      vi.advanceTimersByTime(SETTLE_MS)
      expect(map.triggerRepaint).toHaveBeenCalledTimes(repaints + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a disposal whose teardown throws still releases the map: a later settle asks it for no frame', async () => {
    vi.useFakeTimers()
    try {
      const map = createMap(createCanvas())
      const camera = createFrames()
      // Pixi's teardown throws, as on a lost or never-initialized WebGL context.
      const renderer = { ...createRenderer(), destroy: vi.fn(() => { throw new Error('context lost') }) }
      const adapter = createSharedMapSceneLayer({
        id: 'v2-scene', frames: camera.frames, createRenderer: () => renderer,
        createStage: () => ({ destroy: vi.fn() }) as never,
        createPresentation: () => ({ dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }),
      })
      const gl = {} as WebGL2RenderingContext
      await adapter.initialize(map, gl)
      adapter.layer.onAdd!(map as never, gl)

      await expect(adapter.dispose()).rejects.toThrow('context lost')
      expect(adapter.diagnostics.phase).toBe('disposed')
      const repaints = vi.mocked(map.triggerRepaint).mock.calls.length
      camera.setViewport({ x: 40, y: 30, scale: 7 })
      vi.advanceTimersByTime(SETTLE_MS)
      expect(map.triggerRepaint).toHaveBeenCalledTimes(repaints)
    } finally {
      vi.useRealTimers()
    }
  })

  it('with no settled frame (the snapshot map), every frame counts as settled', async () => {
    const canvas = createCanvas()
    const map = createMap(canvas)
    const camera = createFrames()
    const presentation = { dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }
    const adapter = createSharedMapSceneLayer({
      id: 'v2-scene', frames: { viewFrame: camera.frames.viewFrame }, createRenderer: () => createRenderer(),
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => presentation,
    })
    const gl = {} as WebGL2RenderingContext
    await adapter.initialize(map, gl)
    adapter.layer.onAdd!(map as never, gl)
    adapter.setSnapshot(createTestSceneRendererSnapshot())
    adapter.layer.render(gl, {} as never)
    camera.setViewport({ x: 40, y: 30, scale: 7 })
    adapter.layer.render(gl, {} as never)
    expect(presentation.present.mock.calls.map((call) => call[2])).toEqual([true, true])
    await adapter.dispose()
  })

  it('a tool draft set on the mounted runtime\'s slot reaches the Pixi draft layer', async () => {
    const scheduler = new SceneRuntimeRenderScheduler({
      prepareSceneRender: async () => ({ publish: () => createTestSceneRendererSnapshot() }),
      placeOpenedDesign: () => {},
    })
    const composition = createSharedMapSceneRendererComposition((target) => scheduler.connect(target))
    const presentation = { dispose: vi.fn(), resize: vi.fn(), present: vi.fn(), setDraft: vi.fn() }
    const canvas = createCanvas()
    const map = createMap(canvas)
    const gl = {} as WebGL2RenderingContext
    const layer = composition.createLayer({
      id: 'v2-scene', frames: createFrames().frames, createRenderer: () => createRenderer(),
      createStage: () => ({ destroy: vi.fn() }) as never,
      createPresentation: () => presentation,
    })
    scheduler.mount(document.createElement('div'))
    const draft: DraftPresentation = {
      shapes: [{ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 4, y: 3 }], style: { token: 'draft', widthPx: 2 } }],
    }

    // Set before MapLibre attaches the layer: the slot hands it over when the layer connects, on attaching.
    scheduler.setDraft(draft)
    await layer.initialize(map, gl)
    expect(presentation.setDraft).not.toHaveBeenCalled()
    layer.layer.onAdd!(map as never, gl)
    expect(presentation.setDraft).toHaveBeenCalledExactlyOnceWith(draft)

    const repaints = vi.mocked(map.triggerRepaint).mock.calls.length
    scheduler.setDraft(null)
    expect(presentation.setDraft).toHaveBeenLastCalledWith(null)
    expect(vi.mocked(map.triggerRepaint).mock.calls.length).toBe(repaints + 1)

    // Unmounted, the scheduler has nothing to draw on.
    scheduler.unmount()
    scheduler.setDraft(draft)
    expect(presentation.setDraft).toHaveBeenCalledTimes(2)
    await layer.dispose()
  })
})
