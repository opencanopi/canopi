// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MEASUREMENT_GUIDE_LABEL_OFFSET_PX } from '../canvas/runtime/measurement-guides'
import type { SceneRendererSnapshot } from '../canvas/runtime/renderers/scene-types'
import type { ViewTransform } from '../canvas/runtime/view/types'
import { createTestRendererView, createTestSceneRendererSnapshot } from './support/scene-renderer-snapshot'
import { LabelCollisionIndex } from '../canvas/label-collision'
import { Container, Text } from 'pixi.js'
import { createPixiScenePresentation } from '../canvas/runtime/renderers/pixi-scene'
import { CANVAS_CHROME_FONT_FAMILY } from '../canvas/chrome-fonts'
import { getCanvasTextOpacity } from '../canvas/runtime/text-visibility'
import { bandCentreScale, zoomBandOf } from '../canvas/runtime/view/frame-source'
import './support/camera-tolerance'
import { ROUND_PLANT_SYMBOL_RADIUS } from '../canvas/runtime/plant-symbol-recipes'

vi.mock('pixi.js', () => {
  const state = {
    containers: [] as MockContainer[],
    graphics: [] as MockGraphics[],
    graphicsContexts: [] as MockGraphicsContext[],
    texts: [] as MockText[],
  }

  class MockContainer {
    children: unknown[] = []
    visible = true
    alpha = 1
    filters: MockAlphaFilter[] | null = null
    filterArea: unknown = null
    sortableChildren = false
    parent: MockContainer | null = null
    position = { set: vi.fn() }
    scale = { set: vi.fn() }
    /** The last affine written with setFromMatrix, [a, b, c, d, tx, ty]. */
    matrix: number[] | null = null
    setFromMatrix = vi.fn((matrix: MockMatrix) => {
      this.matrix = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty]
    })
    addChild(...children: unknown[]) {
      for (const child of children as Array<{ parent?: MockContainer | null }>) {
        if (child.parent) child.parent.children = child.parent.children.filter((entry) => entry !== child)
        child.parent = this
      }
      this.children.push(...children)
      return children[0]
    }
    removeChildren = vi.fn(() => {
      this.children = []
    })
    constructor() {
      state.containers.push(this)
    }
  }

  class MockGraphicsContext {
    private owners = new Set<MockGraphics>()
    clear = vi.fn(() => this)
    circle = vi.fn((...args: unknown[]) => this.record('circle', args))
    roundRect = vi.fn((...args: unknown[]) => this.record('roundRect', args))
    rect = vi.fn((...args: unknown[]) => this.record('rect', args))
    ellipse = vi.fn((...args: unknown[]) => this.record('ellipse', args))
    moveTo = vi.fn((...args: unknown[]) => this.record('moveTo', args))
    lineTo = vi.fn((...args: unknown[]) => this.record('lineTo', args))
    bezierCurveTo = vi.fn((...args: unknown[]) => this.record('bezierCurveTo', args))
    cut = vi.fn(() => this.record('cut'))
    closePath = vi.fn(() => this.record('closePath'))
    fill = vi.fn((...args: unknown[]) => this.record('fill', args))
    stroke = vi.fn((...args: unknown[]) => this.record('stroke', args))
    destroyed = false
    destroy = vi.fn(() => { this.destroyed = true })
    constructor() {
      state.graphicsContexts.push(this)
    }
    attach(graphics: MockGraphics) { this.owners.add(graphics) }
    detach(graphics: MockGraphics) { this.owners.delete(graphics) }
    get ownerCount() { return this.owners.size }
    private record(method: string, args: unknown[] = []) {
      for (const graphics of this.owners) graphics.record(method, args)
      return this
    }
  }

  class MockAlphaFilter {
    alpha: number
    destroy = vi.fn()
    constructor(public readonly options: { alpha: number }) {
      this.alpha = options.alpha
    }
  }

  class MockMatrix {
    a = 1
    b = 0
    c = 0
    d = 1
    tx = 0
    ty = 0
    set(a: number, b: number, c: number, d: number, tx: number, ty: number) {
      Object.assign(this, { a, b, c, d, tx, ty })
      return this
    }
  }

  class MockRectangle {
    constructor(public x: number, public y: number, public width: number, public height: number) {}
  }

  class MockGraphics {
    private _context: MockGraphicsContext
    parent: MockContainer | null = null
    zIndex = 0
    position = { set: vi.fn() }
    visible = true
    alpha = 1
    clear = vi.fn(() => this)
    circle = vi.fn(() => this)
    roundRect = vi.fn(() => this)
    rect = vi.fn(() => this)
    ellipse = vi.fn(() => this)
    moveTo = vi.fn(() => this)
    lineTo = vi.fn(() => this)
    bezierCurveTo = vi.fn(() => this)
    cut = vi.fn(() => this)
    closePath = vi.fn(() => this)
    fill = vi.fn(() => this)
    stroke = vi.fn(() => this)
    removeFromParent = vi.fn(() => {
      if (this.parent) this.parent.children = this.parent.children.filter((entry) => entry !== this)
      this.parent = null
    })
    destroy = vi.fn((options?: boolean | { context?: boolean }) => {
      if (options === true || (typeof options === 'object' && options.context)) this._context.destroy()
      this._context.detach(this)
    })
    constructor(options?: MockGraphicsContext | { context?: MockGraphicsContext }) {
      this._context = options instanceof MockGraphicsContext
        ? options
        : options?.context ?? new MockGraphicsContext()
      this._context.attach(this)
      state.graphics.push(this)
    }
    get context() { return this._context }
    set context(context: MockGraphicsContext) {
      if (context === this._context) return
      this._context.detach(this)
      this._context = context
      this._context.attach(this)
    }
    record(method: string, args: unknown[]) {
      const target = this as unknown as Record<string, (...values: unknown[]) => unknown>
      target[method]?.(...args)
    }
  }

  class MockText {
    resolution: number | null
    visible = true
    alpha = 1
    rotation = 0
    text = ''
    style: unknown = {}
    anchor = { set: vi.fn() }
    position = { set: vi.fn() }
    scale = { set: vi.fn() }
    removeFromParent = vi.fn()
    destroy = vi.fn()
    constructor(options: { resolution?: number } = {}) {
      this.resolution = options.resolution ?? null
      state.texts.push(this)
    }
  }

  class MockTextStyle {
    constructor(public readonly options: Record<string, unknown>) {}
  }

  return {
    AlphaFilter: MockAlphaFilter,
    Rectangle: MockRectangle,
    Matrix: MockMatrix,
    Container: MockContainer,
    Graphics: MockGraphics,
    GraphicsContext: MockGraphicsContext,
    Text: MockText,
    TextStyle: MockTextStyle,
    __pixiMockState: state,
  }
})

/** Mounts the presentation the way the MapLibre custom layer does: text at twice the density. */
function mountPresentation(container: HTMLElement, dpr = 1) {
  const stage = new Container()
  const presentation = createPixiScenePresentation({
    stage,
    createText: () => new Text({ resolution: dpr * 2 }),
    viewSize: { width: container.clientWidth, height: container.clientHeight },
  })
  return Object.assign(presentation, { stage: stage as unknown as { children: Array<{ matrix: number[] | null }> } })
}

/** The view that places the plane as `viewport` did: screen = world × scale + { x, y }, bearing 0. */
function view(viewport: { x: number; y: number; scale: number }): ViewTransform {
  return createTestRendererView(viewport)
}

describe('createPixiScenePresentation', () => {
  it('a pan keeps the admitted names and moves them with their anchors', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { texts: Array<{ text: string; position: { set: ReturnType<typeof vi.fn> } }> }
    }
    const renderer = mountPresentation(document.createElement('div'))
    const add = vi.spyOn(LabelCollisionIndex.prototype, 'add')
    try {
      renderer.present(view({ x: 0, y: 0, scale: 100 }), createTestSceneRendererSnapshot({ scene: { plants: [createPlant({ position: { x: 1, y: 1 } })] } }))
      const text = pixi.__pixiMockState.texts.find(t => t.text === 'Apple')!
      expect(text).toBeDefined()
      const [x, y] = text.position.set.mock.calls.at(-1)!
      add.mockClear()
      // A pan writes the world root's matrix and projects the anchors again; admission is kept.
      const panned = view({ x: 10, y: 20, scale: 100 })
      const projectAnchors = vi.fn(panned.projectAnchors)
      renderer.present({ ...panned, projectAnchors })
      expect(add).not.toHaveBeenCalled()
      expect(projectAnchors).toHaveBeenCalled()
      expect(renderer.stage.children[0]!.matrix).toEqual([100, 0, 0, 100, 10, 20])
      const [pannedX, pannedY] = text.position.set.mock.calls.at(-1)!
      expect(pannedX).toBeCloseTo(x + 10, 3)
      expect(pannedY).toBeCloseTo(y + 20, 3)
    } finally {
      add.mockRestore()
      renderer.dispose()
    }
  })
  it('keeps world geometry warm during pan and refreshes screen-weight strokes on zoom', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { graphics: Array<{ clear: ReturnType<typeof vi.fn> }> }
    }
    const renderer = mountPresentation(document.createElement('div'))
    renderer.present(view({ x: 0, y: 0, scale: 30 }), createTestSceneRendererSnapshot({ scene: {
      zones: [{ kind: 'zone', id: 'bed', name: 'bed', zoneType: 'rect', locked: false, rotationDeg: 0, fillColor: '#eeeeee', notes: null,
        points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }],
      measurementGuides: [{ kind: 'measurement-guide', id: 'guide', locked: false, start: { x: 0, y: 0 }, end: { x: 2, y: 0 } }],
    } }))
    const graphics = pixi.__pixiMockState.graphics
    graphics.forEach(g => g.clear.mockClear())
    renderer.present(view({ x: 10, y: 20, scale: 30 }))
    graphics.forEach(g => expect(g.clear).not.toHaveBeenCalled())
    expect(renderer.stage.children[0]!.matrix).toEqual([30, 0, 0, 30, 10, 20])
    renderer.present(view({ x: 10, y: 20, scale: 60 }))
    graphics.forEach(g => expect(g.clear).toHaveBeenCalledOnce())
    expect(renderer.stage.children[0]!.matrix).toEqual([60, 0, 0, 60, 10, 20])
    renderer.dispose()
  })
  it('skips offscreen plant paths and restores them with current appearance on re-entry', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { graphics: Array<{ visible: boolean; clear: ReturnType<typeof vi.fn>; bezierCurveTo: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn> }> }
    }
    const container = document.createElement('div')
    Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 300 } })
    const renderer = mountPresentation(container)
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [
      createPlant({ symbol: 'shrub', position: { x: 2, y: 2 } }),
    ] } })
    renderer.present(view({ x: 0, y: 0, scale: 30 }), snapshot)
    const plant = pixi.__pixiMockState.graphics[0]!
    plant.clear.mockClear()
    renderer.present(view({ x: 10000, y: 0, scale: 60 }))
    expect(plant.visible).toBe(false)
    expect(plant.clear).not.toHaveBeenCalled()
    renderer.present(view({ x: 10000, y: 0, scale: 60 }), { ...snapshot,
      scene: { ...snapshot.scene, plants: snapshot.scene.plants.map(p => ({ ...p, color: '#ff0000' })) },
    })
    renderer.present(view({ x: 0, y: 0, scale: 60 }))
    expect(plant.visible).toBe(true)
    expect(plant.clear).not.toHaveBeenCalled()
    expect(plant.fill).toHaveBeenLastCalledWith(expect.objectContaining({ color: 0xff0000 }))
    renderer.dispose()
  })
  it('never leaves a plant symbol, ring, badge or note marker bound to a drawing context the cache has destroyed', async () => {
    // A story step zooms away from a plant, the cache retires its glyph two
    // generations later, and the step back must not render a dead context
    // ("null is not an object (evaluating 'context.instructions.length')").
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { graphicsContexts: Array<{ destroyed: boolean; ownerCount: number }> }
    }
    const container = document.createElement('div')
    Object.defineProperties(container, { clientWidth: { value: 400 }, clientHeight: { value: 300 } })
    const renderer = mountPresentation(container)
    // A ringed plant, a stacked pair (a badge) and a note shown as its marker.
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [
      createPlant({ id: 'ringed', symbol: 'shrub', position: { x: 2, y: 2 } }),
      createPlant({ id: 'stack-a', position: { x: 4, y: 2 } }),
      createPlant({ id: 'stack-b', position: { x: 4, y: 2 } }),
    ], annotations: [{ kind: 'annotation', id: 'note', annotationType: 'text', locked: false,
      position: { x: 3, y: 3 }, text: 'Gate', fontSize: 14, rotationDeg: null }] },
    selectedTargets: [{ kind: 'plant', id: 'ringed' }, { kind: 'annotation', id: 'note' }] })
    renderer.present(view({ x: 0, y: 0, scale: 6 }), snapshot)
    const orphaned = () => pixi.__pixiMockState.graphicsContexts.filter((c) => c.destroyed && c.ownerCount > 0).length
    for (let generation = 0; generation < 4; generation += 1) {
      renderer.present(view({ x: 10000 + generation, y: 0, scale: 60 }), snapshot)
      expect(orphaned()).toBe(0)
    }
    expect(() => {
      renderer.present(view({ x: 0, y: 0, scale: 60 }), snapshot)
    }).not.toThrow()
    expect(orphaned()).toBe(0)
    // The note's marker gives way to its text on zoom and returns after the syncs retired its drawing.
    for (let generation = 0; generation < 4; generation += 1) {
      renderer.present(view({ x: 0, y: 0, scale: 60 }), snapshot)
      expect(orphaned()).toBe(0)
    }
    renderer.present(view({ x: 0, y: 0, scale: 6 }))
    expect(orphaned()).toBe(0)
    renderer.dispose()
  })

  it('retains annotation text style during pan and updates it after an authored font change', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { texts: Array<{ style: unknown }> }
    }
    const renderer = mountPresentation(document.createElement('div'))
    const snapshot = createTestSceneRendererSnapshot({ scene: { annotations: [{
      kind: 'annotation', id: 'note', annotationType: 'text', locked: false,
      position: { x: 1, y: 1 }, text: 'Orchard', fontSize: 16, rotationDeg: 0,
    }] } })
    renderer.present(view({ x: 0, y: 0, scale: 30 }), snapshot)
    const text = pixi.__pixiMockState.texts[0]!
    const style = text.style
    renderer.present(view({ x: 10, y: 20, scale: 30 }))
    expect(text.style).toBe(style)
    renderer.present(view({ x: 10, y: 20, scale: 30 }), { ...snapshot, scene: { ...snapshot.scene,
      annotations: snapshot.scene.annotations.map(a => ({ ...a, fontSize: 20 })),
    } })
    expect(text.style).not.toBe(style)
    renderer.dispose()
  })
  it('shares exact botanical geometry, refreshes it for zoom and colour, and rings interaction apart', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{
          clear: ReturnType<typeof vi.fn>
          context: unknown
          position: { set: ReturnType<typeof vi.fn> }
          bezierCurveTo: ReturnType<typeof vi.fn>
        }>
        graphicsContexts: Array<{ bezierCurveTo: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; ownerCount: number }>
      }
    }
    const renderer = mountPresentation(document.createElement('div'))
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [
      // Half a metre apart: 30, 60 and 90 px/m draw three sizes (6.3, 12.6 and the 14 px cap).
      createPlant({ id: 'a', symbol: 'shrub', position: { x: 1, y: 1 } }),
      createPlant({ id: 'b', symbol: 'shrub', position: { x: 1.5, y: 1 } }),
    ] } })
    renderer.present(view({ x: 0, y: 0, scale: 30 }), snapshot)
    const [firstPlant, secondPlant] = pixi.__pixiMockState.graphics
    expect(firstPlant).toBeDefined()
    expect(secondPlant).toBeDefined()
    expect(firstPlant?.context).toBe(secondPlant?.context)
    const sharedContext = firstPlant!.context
    expect(pixi.__pixiMockState.graphicsContexts).toHaveLength(2)
    expect((sharedContext as { ownerCount: number }).ownerCount).toBe(2)
    firstPlant!.clear.mockClear()
    secondPlant!.clear.mockClear()
    renderer.present(view({ x: 10, y: 20, scale: 30 }))
    expect(firstPlant!.clear).not.toHaveBeenCalled()
    expect(secondPlant!.clear).not.toHaveBeenCalled()
    expect(firstPlant!.position.set).toHaveBeenLastCalledWith(40, 50)
    expect(firstPlant!.context).toBe(sharedContext)
    renderer.present(view({ x: 10, y: 20, scale: 30 }), { ...snapshot, selectedPlantIds: new Set(['b']) })
    // Selection rings the plant in its own graphic; the symbol geometry stays shared.
    expect(firstPlant!.context).toBe(sharedContext)
    expect(secondPlant!.context).toBe(sharedContext)
    expect(pixi.__pixiMockState.graphics).toHaveLength(3)
    renderer.present(view({ x: 0, y: 0, scale: 60 }))
    expect(firstPlant!.context).not.toBe(sharedContext)
    const zoomContext = firstPlant!.context
    renderer.present(view({ x: 0, y: 0, scale: 60 }), { ...snapshot, scene: { ...snapshot.scene, plants: snapshot.scene.plants.map(p => ({ ...p, color: '#ff0000' })) } })
    expect(firstPlant!.context).toBe(secondPlant!.context)
    expect(firstPlant!.context).not.toBe(zoomContext)
    expect(firstPlant!.clear).not.toHaveBeenCalled()
    expect(secondPlant!.clear).not.toHaveBeenCalled()
    renderer.present(view({ x: 0, y: 0, scale: 30 }))
    renderer.present(view({ x: 0, y: 0, scale: 60 }))
    renderer.present(view({ x: 0, y: 0, scale: 90 }))
    // A size nothing shows retires after two more scene syncs.
    for (let sync = 0; sync < 3; sync += 1) renderer.present(view({ x: 0, y: 0, scale: 90 }), snapshot)
    const plantContexts = pixi.__pixiMockState.graphicsContexts
      .filter(context => context.bezierCurveTo.mock.calls.length > 0)
    expect(plantContexts.filter(context => context.destroy.mock.calls.length > 0)).not.toHaveLength(0)
    renderer.dispose()
    for (const context of plantContexts) expect(context.destroy).toHaveBeenCalledTimes(1)
  })
  it('detaches removed and disposed Plant graphics from externally shared contexts', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{ context: { ownerCount: number; destroy: ReturnType<typeof vi.fn> }; destroy: ReturnType<typeof vi.fn> }>
        graphicsContexts: Array<{ ownerCount: number; destroy: ReturnType<typeof vi.fn> }>
      }
    }
    const renderer = mountPresentation(document.createElement('div'))
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [
      createPlant({ id: 'a', position: { x: 1, y: 1 } }),
      createPlant({ id: 'b', position: { x: 5, y: 1 } }),
    ] } })
    renderer.present(view({ x: 0, y: 0, scale: 30 }), snapshot)
    const [firstPlant, secondPlant] = pixi.__pixiMockState.graphics
    const sharedContext = firstPlant!.context
    expect(secondPlant!.context).toBe(sharedContext)
    expect(sharedContext.ownerCount).toBe(2)

    renderer.present(view({ x: 0, y: 0, scale: 30 }), { ...snapshot, scene: { ...snapshot.scene, plants: [snapshot.scene.plants[1]!] } })
    expect(firstPlant!.destroy).toHaveBeenCalledOnce()
    expect(sharedContext.ownerCount).toBe(1)

    renderer.dispose()
    expect(secondPlant!.destroy).toHaveBeenCalledOnce()
    expect(sharedContext.ownerCount).toBe(0)
    for (const context of pixi.__pixiMockState.graphicsContexts) {
      expect(context.ownerCount).toBe(0)
      expect(context.destroy).toHaveBeenCalledOnce()
    }
  })
  it('reuses each drawn size on zoom and retires a size two scene syncs after nothing shows it', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{ context: { destroy: ReturnType<typeof vi.fn> }; bezierCurveTo: ReturnType<typeof vi.fn> }>
      }
    }
    const renderer = mountPresentation(document.createElement('div'))
    const snapshot = createTestSceneRendererSnapshot({ scene: {
      plants: [createPlant({ symbol: 'shrub', position: { x: 2, y: 2 } })],
    } })
    // A lone plant at 4, 6 and 12 px/m is 6.72, 10.08 and 14 px in radius: three drawn sizes.
    renderer.present(view({ x: 0, y: 0, scale: 4 }), snapshot)
    const plant = pixi.__pixiMockState.graphics[0]!
    const contextA = plant.context
    renderer.present(view({ x: 0, y: 0, scale: 6 }))
    const contextB = plant.context
    expect(contextB).not.toBe(contextA)
    renderer.present(view({ x: 0, y: 0, scale: 4 }))
    expect(plant.context).toBe(contextA)
    // Zoom frames retire nothing, however many sizes they draw.
    renderer.present(view({ x: 0, y: 0, scale: 12 }))
    const contextC = plant.context
    expect(contextA.destroy).not.toHaveBeenCalled()
    expect(contextB.destroy).not.toHaveBeenCalled()
    // Each sync begins a generation; A and B, unseen since, go at the third.
    renderer.present(view({ x: 0, y: 0, scale: 12 }), snapshot)
    renderer.present(view({ x: 0, y: 0, scale: 12 }), snapshot)
    expect(contextA.destroy).not.toHaveBeenCalled()
    renderer.present(view({ x: 0, y: 0, scale: 12 }), snapshot)
    expect(contextA.destroy).toHaveBeenCalledOnce()
    expect(contextB.destroy).toHaveBeenCalledOnce()
    expect(contextC.destroy).not.toHaveBeenCalled()
    expect(plant.context).toBe(contextC)
    renderer.dispose()
    expect(contextA.destroy).toHaveBeenCalledOnce()
    expect(contextB.destroy).toHaveBeenCalledOnce()
    expect(contextC.destroy).toHaveBeenCalledOnce()
  })
  beforeEach(async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        containers: unknown[]
        graphics: unknown[]
        graphicsContexts: unknown[]
        texts: unknown[]
      }
    }
    pixi.__pixiMockState.containers.length = 0
    pixi.__pixiMockState.graphics.length = 0
    pixi.__pixiMockState.graphicsContexts.length = 0
    pixi.__pixiMockState.texts.length = 0
  })

  it('dims Species focus as one composite per plant and keeps rings and camera-only updates at full strength', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{ parent: { filters: Array<{ alpha: number }> | null } | null; circle: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn> }>
      }
    }
    const renderer = mountPresentation(document.createElement('div'))
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [
      createPlant({ id: 'apple', position: { x: 0, y: 0 } }),
      createPlant({ id: 'mint', canonicalName: 'Mentha spicata', position: { x: 3, y: 0 } }),
    ] }, selectedTargets: [{ kind: 'plant', id: 'mint' }], speciesFocus: { canonicalName: 'Malus domestica' } })
    renderer.present(view({ x: 0, y: 0, scale: 1 }), snapshot)
    const [apple, mint] = pixi.__pixiMockState.graphics
    const ring = pixi.__pixiMockState.graphics.find((graphic) => graphic.stroke.mock.calls.length > 0)!
    const layerAlpha = (graphic: typeof apple) => graphic!.parent?.filters?.map((filter) => filter.alpha) ?? []
    // Every path is opaque; the dimmed plant's container applies 0.16 once, so its parts never double-blend.
    const fillAlphas = () => [apple, mint].map((mark) => mark!.fill.mock.calls.at(-1)?.[0].alpha ?? 1)
    expect(fillAlphas()).toEqual([1, 1])
    expect(layerAlpha(apple)).toEqual([])
    expect(layerAlpha(mint)).toEqual([0.16])
    // The dimmed plant's selection ring is drawn outside the dimmed composite, at full strength.
    expect(layerAlpha(ring)).toEqual([])
    expect(ring.stroke.mock.calls.at(-1)?.[0].alpha).toBe(1)
    renderer.present(view({ x: 10, y: 20, scale: 2 }))
    expect(layerAlpha(mint)).toEqual([0.16])
    renderer.present(view({ x: 10, y: 20, scale: 2 }), { ...snapshot, speciesFocus: { canonicalName: null } })
    expect(fillAlphas()).toEqual([1, 1])
    expect(layerAlpha(apple)).toEqual([])
    expect(layerAlpha(mint)).toEqual([])
    renderer.dispose()
  })

  it('applies Plants layer opacity once to the whole layer instead of to each overlapping path', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{ fill: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn> }>
        containers: Array<{ alpha: number; filters: Array<{ alpha: number }> | null; filterArea: { width: number; height: number } | null }>
      }
    }
    const host = document.createElement('div')
    Object.defineProperties(host, { clientWidth: { value: 400 }, clientHeight: { value: 300 } })
    const renderer = mountPresentation(host)
    const snapshot = createTestSceneRendererSnapshot({ scene: {
      plants: [createPlant({ id: 'a', symbol: 'shrub', position: { x: 2, y: 2 } })],
      layers: [{ kind: 'layer', name: 'plants', visible: true, locked: false, opacity: 0.4 }],
    } })
    renderer.present(view({ x: 0, y: 0, scale: 30 }), snapshot)
    const fills = pixi.__pixiMockState.graphics.flatMap((graphics) => graphics.fill.mock.calls.map(([fill]) => fill.alpha ?? 1))
    expect(fills.length).toBeGreaterThan(0)
    expect(new Set(fills)).toEqual(new Set([1]))
    const filtered = pixi.__pixiMockState.containers.filter((container) => container.filters?.length)
    expect(filtered.map((container) => container.filters!.map((filter) => filter.alpha))).toEqual([[0.4]])
    expect(filtered[0]!.alpha).toBe(1)
    expect(filtered[0]!.filterArea).toMatchObject({ width: 400, height: 300 })
    renderer.resize(640, 480)
    expect(filtered[0]!.filterArea).toMatchObject({ width: 640, height: 480 })
    renderer.present(view({ x: 0, y: 0, scale: 30 }), { ...snapshot, scene: { ...snapshot.scene, layers: [] } })
    expect(pixi.__pixiMockState.containers.filter((container) => container.filters?.length)).toEqual([])
    renderer.dispose()
  })

  it.each([1, 1.5, 2])('keeps every text role at its CSS font size without scaling text during zoom at DPR %s', async (dpr) => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { texts: Array<{ text: string; style: { options: { fontSize: number; fontFamily: string } }; scale: { set: ReturnType<typeof vi.fn> } }> }
    }
    const renderer = mountPresentation(document.createElement('div'), dpr)
    try {
      // Two plants on one spot (a stack badge), one with a pinned name and one selected (its own name).
      renderer.present(view({ x: 0.35, y: 0.45, scale: 20 }), createTestSceneRendererSnapshot({
        scene: {
          plants: [
            createPlant({ id: 'a', commonName: 'Pinned name', pinnedName: true }),
            createPlant({ id: 'b', canonicalName: 'Pyrus communis', commonName: 'Selected name' }),
          ],
          annotations: [{ kind: 'annotation', annotationType: 'text', id: 'note', locked: false,
            position: { x: 1, y: 1 }, text: 'Érable 日本語', fontSize: 16, rotationDeg: 15 }],
          measurementGuides: [{ kind: 'measurement-guide', id: 'guide', locked: false,
            start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }],
        },
        selectedTargets: [{ kind: 'plant', id: 'b' }],
      }))
      const texts = pixi.__pixiMockState.texts
      expect(texts.map(text => text.text)).toEqual(expect.arrayContaining(['2', 'Érable 日本語', 'Pinned name', 'Selected name']))
      expect(texts).toHaveLength(5)
      for (const scale of [0.1, 8, 14, 20, 63.75, 1000, 20]) {
        renderer.present(view({ x: 0.35, y: 0.45, scale }))
        for (const text of texts) {
          expect(text.style.options.fontFamily).toBe(CANVAS_CHROME_FONT_FAMILY)
          expect(text.scale.set).not.toHaveBeenCalled()
        }
        expect(texts.find(text => text.text === 'Érable 日本語')?.style.options.fontSize).toBe(16)
      }
    } finally {
      renderer.dispose()
    }
  })

  it('a pinned name fades in band steps through a zoom and its reversal, exact on the settled frame (Q5), at a readable size', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { texts: Array<{ text: string; alpha: number; style: { options: { fontSize: number } }; destroy: ReturnType<typeof vi.fn> }> }
    }
    const host = document.createElement('div')
    const renderer = mountPresentation(host, 2)
    renderer.present(view({ x: 0, y: 0, scale: 20 }), createRendererSnapshot({ plants: [createPlant({ pinnedName: true })] }))
    // Each scale is in its own band, 12 px/m in 14's band: the fade holds there until the settled frame.
    for (const [scale, opacity, settled] of [
      [20, 1, false], [14, 0.5, false], [12, 0.5, false], [12, getCanvasTextOpacity(12), true],
      [8, 0, false], [14, 0.5, false], [20, 1, false],
    ] as const) {
      renderer.present(view({ x: 0, y: 0, scale }), undefined, settled)
      const labels = pixi.__pixiMockState.texts.filter((text) => text.text === 'Apple' && !text.destroy.mock.calls.length)
      expect(labels).toHaveLength(opacity === 0 ? 0 : 1)
      if (opacity) {
        expect(labels[0]?.alpha).toBeCloseTo(opacity, 9)
        expect(labels[0]?.style.options.fontSize).toBe(12)
      }
    }
    renderer.dispose()
  })

  it('crossfades Annotation markers and text, and reveals only the direct selected note', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { texts: Array<{ text: string; alpha: number; visible: boolean; style: { options: { fontSize: number } } }>; graphics: Array<{ visible: boolean; alpha: number; stroke: ReturnType<typeof vi.fn> }> }
    }
    const renderer = mountPresentation(document.createElement('div'), 2)
    const snapshot = createTestSceneRendererSnapshot({ scene: {
      annotations: [{ kind: 'annotation', id: 'note', annotationType: 'text', locked: false,
        position: { x: 10, y: 20 }, text: 'First\nSecond', fontSize: 16, rotationDeg: 45 }],
    } })
    renderer.present(view({ x: 0, y: 0, scale: 20 }), snapshot)
    for (const [scale, opacity] of [[20, 1], [14, 0.5], [8, 0], [14, 0.5], [20, 1]]) {
      renderer.present(view({ x: 0, y: 0, scale: scale! }))
      const text = pixi.__pixiMockState.texts.find((entry) => entry.text === 'First\nSecond')!
      expect(text.alpha).toBeCloseTo(opacity!, 9)
      expect(text.visible).toBe(opacity! > 0)
      expect(text.style.options.fontSize).toBe(16)
      // The marker shows at full strength where the text has faded out.
      if (scale === 8) {
        expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.visible && graphics.alpha === 1
          && graphics.stroke.mock.calls.some(([stroke]) => stroke.width === 1.5))).toBe(true)
      }
    }
    renderer.present(view({ x: 0, y: 0, scale: 4 }), { ...snapshot, revealedAnnotationId: 'note', selectedAnnotationIds: new Set(['note']) })
    expect(pixi.__pixiMockState.texts.find((entry) => entry.text === 'First\nSecond')).toMatchObject({ alpha: 1, visible: true })
    renderer.dispose()
  })

  it('renders precision glyphs and stack badges in CSS pixels', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{ circle: ReturnType<typeof vi.fn>; roundRect: ReturnType<typeof vi.fn>; fill: ReturnType<typeof vi.fn>; position: { set: ReturnType<typeof vi.fn> } }>;
        texts: Array<{ text: string; style: { options: { fontSize: number } } }>;
      }
    }
    const renderer = mountPresentation(document.createElement('div'), 1.5)
    renderer.present(view({ x: -9900, y: -9900, scale: 1000 }), createRendererSnapshot({
      plants: [createPlant({ id: 'a', symbol: 'round' }), createPlant({ id: 'b', symbol: 'round' })],
    }))
    const glyph = pixi.__pixiMockState.graphics.find(graphics => graphics.circle.mock.calls.some(([x, y, radius]) => x === 0 && y === 0 && Math.abs(radius - 14 * ROUND_PLANT_SYMBOL_RADIUS) < 0.13))!
    expect(glyph).toBeDefined()
    expect(glyph.position.set).toHaveBeenLastCalledWith(100, 100)
    // Stack counts keep the 12 px type floor on a badge sized for them.
    expect(pixi.__pixiMockState.texts.find((text) => text.text === '2')?.style.options.fontSize).toBeGreaterThanOrEqual(12)
    const badgeRects = pixi.__pixiMockState.graphics.flatMap((graphics) => graphics.roundRect.mock.calls)
    expect(badgeRects).toHaveLength(1)
    expect(badgeRects[0]!.slice(2, 4)).toEqual([18, 18])
    renderer.dispose()
  })

  it('preserves CSS Zone fill alpha when composing Layer opacity', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { graphics: Array<{ fill: ReturnType<typeof vi.fn> }>; containers: Array<{ alpha: number }> }
    }
    const renderer = mountPresentation(document.createElement('div'))
    renderer.present(view({ x: 0, y: 0, scale: 1 }), createTestSceneRendererSnapshot({ scene: {
      zones: [{ kind: 'zone', id: 'bed', name: 'bed', zoneType: 'rect', locked: false, rotationDeg: 0,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], fillColor: 'rgba(45, 95, 63, 0.1)', notes: null }],
      layers: [{ kind: 'layer', name: 'zones', visible: true, locked: false, opacity: 0.5 }],
    } }))
    const fills = pixi.__pixiMockState.graphics.flatMap((graphics) => graphics.fill.mock.calls)
    expect(fills[0]?.[0].alpha).toBeCloseTo(0.02)
    expect(pixi.__pixiMockState.containers.some((container) => container.alpha === 0.5)).toBe(true)
    renderer.dispose()
  })

  it('parses short and eight-digit hex zone fills like the CSS ghosts do', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { graphics: Array<{ fill: ReturnType<typeof vi.fn> }> }
    }
    const renderer = mountPresentation(document.createElement('div'))
    const zone = (id: string, fillColor: string, x: number) => ({
      kind: 'zone' as const, id, name: id, zoneType: 'rect' as const, locked: false, rotationDeg: 0,
      points: [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }], fillColor, notes: null,
    })
    renderer.present(view({ x: 0, y: 0, scale: 1 }), createTestSceneRendererSnapshot({ scene: {
      zones: [zone('short', '#0a0', 0), zone('long-alpha', '#00aa0080', 20)],
      layers: [{ kind: 'layer', name: 'zones', visible: true, locked: false, opacity: 1 }],
    } }))
    const fills = pixi.__pixiMockState.graphics.flatMap((graphics) => graphics.fill.mock.calls.map(([fill]) => fill))
    expect(fills[0]).toMatchObject({ color: 0x00aa00 })
    expect(fills[1]).toMatchObject({ color: 0x00aa00 })
    expect(fills[1].alpha / fills[0].alpha).toBeCloseTo(128 / 255)
    renderer.dispose()
  })

  it('releases the previous Design\'s objects on a Design switch even while their layers are hidden', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { graphics: Array<{ destroy: ReturnType<typeof vi.fn> }>; texts: Array<{ destroy: ReturnType<typeof vi.fn> }> }
    }
    const renderer = mountPresentation(document.createElement('div'))
    const visible = (name: string, visible: boolean) => ({ kind: 'layer' as const, name, visible, locked: false, opacity: 1 })
    renderer.present(view({ x: 0, y: 0, scale: 1 }), createTestSceneRendererSnapshot({ scene: {
      plants: [createPlant({ id: 'old-plant' })],
      zones: [{ kind: 'zone', id: 'old-zone', name: 'old', zoneType: 'rect', locked: false, rotationDeg: 0,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], fillColor: null, notes: null }],
      annotations: [{ kind: 'annotation', id: 'old-note', annotationType: 'text', locked: false, position: { x: 5, y: 5 }, text: 'Gate', fontSize: 14, rotationDeg: null }],
      measurementGuides: [{ kind: 'measurement-guide', id: 'old-guide', locked: false, start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }],
      layers: ['plants', 'zones', 'annotations', 'measurement-guides'].map((name) => visible(name, true)),
    } }))
    const before = { graphics: [...pixi.__pixiMockState.graphics], texts: [...pixi.__pixiMockState.texts] }
    expect(before.graphics.length + before.texts.length).toBeGreaterThan(3)

    // The next Design has none of these objects and keeps every layer hidden.
    renderer.present(view({ x: 0, y: 0, scale: 1 }), createTestSceneRendererSnapshot({ scene: {
      layers: ['plants', 'zones', 'annotations', 'measurement-guides'].map((name) => visible(name, false)),
    } }))

    for (const graphics of before.graphics) expect(graphics.destroy).toHaveBeenCalled()
    for (const text of before.texts) expect(text.destroy).toHaveBeenCalled()
    renderer.dispose()
  })

  it('draws plant symbol glyphs at readable zoom and collapses them to dots at low zoom', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{
          circle: ReturnType<typeof vi.fn>
          rect: ReturnType<typeof vi.fn>
          bezierCurveTo: ReturnType<typeof vi.fn>
          lineTo: ReturnType<typeof vi.fn>
        }>
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    const snapshot = createRendererSnapshot({
      plants: [
        createPlant({ id: 'rosette', symbol: 'rosette', position: { x: 10, y: 10 } }),
        createPlant({ id: 'conifer', canonicalName: 'Pyrus communis', position: { x: 15, y: 10 } }),
      ],
      plantSpeciesSymbols: { 'Pyrus communis': 'conifer' },
    })

    renderer.present(view({ x: 0, y: 0, scale: 20 }), snapshot)

    expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.bezierCurveTo.mock.calls.length > 0)).toBe(true)
    expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.lineTo.mock.calls.length > 0)).toBe(true)

    vi.clearAllMocks()
    renderer.present(view({ x: 0, y: 0, scale: 0.25 }), snapshot)

    expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.circle.mock.calls.length > 0)).toBe(true)
    expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.bezierCurveTo.mock.calls.length > 0)).toBe(false)
    expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.lineTo.mock.calls.length > 0)).toBe(false)
    renderer.dispose()
  })

  it('rings highlighted plants at a readable size at any zoom, solid over a wider halo, without moving them', async () => {
    type MockContext = { circle: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn> }
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: { graphics: Array<{ visible: boolean; context: MockContext }> }
    }
    const renderer = mountPresentation(document.createElement('div'))
    const plant = createPlant({ id: 'a', symbol: 'round', position: { x: 10, y: 10 } })

    // The whole-Design zoom of a 70 m site: plants are dots of a pixel or two. Both rings share one drawing.
    for (const scale of [0.25, 4]) {
      const snapshot = createRendererSnapshot({ plants: [plant] })
      renderer.present(view({ x: 0, y: 0, scale }), { ...snapshot, highlightedPlantIds: new Set(['a']) })
      const shown = pixi.__pixiMockState.graphics.filter((graphics) => graphics.visible).map((graphics) => graphics.context)
      const ring = shown.find((context) => context.stroke.mock.calls.length > 1)!
      const glyph = shown.find((context) => context !== ring && context.circle.mock.calls.length > 0)!
      const glyphRadius = Math.max(...glyph.circle.mock.calls.map((call) => call[2] as number))
      const ringRadius = Math.min(...ring.circle.mock.calls.map((call) => call[2] as number))
      expect(ringRadius, `scale ${scale}`).toBeGreaterThanOrEqual(8)
      expect(ringRadius, `scale ${scale}`).toBeGreaterThan(glyphRadius + 2)
      const [casing, stroke] = ring.stroke.mock.calls.slice(-2).map((call) => call[0] as { width: number; alpha: number })
      expect(stroke!.alpha).toBe(1)
      expect(stroke!.width).toBeGreaterThanOrEqual(2)
      expect(casing!.width).toBeGreaterThanOrEqual(stroke!.width + 2)
      expect(casing!.alpha).toBe(1)
    }
    expect(plant.position).toEqual({ x: 10, y: 10 })
    renderer.dispose()
  })

  it('draws curved plant symbol recipes with native Pixi curves', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{
          bezierCurveTo: ReturnType<typeof vi.fn>
          fill: ReturnType<typeof vi.fn>
          stroke: ReturnType<typeof vi.fn>
        }>
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    renderer.present(view({ x: 0, y: 0, scale: 20 }), createRendererSnapshot({
      plants: [
        createPlant({ id: 'shrub', symbol: 'shrub', position: { x: 10, y: 10 } }),
        createPlant({ id: 'groundcover', symbol: 'groundcover', position: { x: 30, y: 10 } }),
      ],
    }))

    expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.bezierCurveTo.mock.calls.length > 0)).toBe(true)
    expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.fill.mock.calls.length > 0)).toBe(true)
    expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.stroke.mock.calls.length > 0)).toBe(true)
    renderer.dispose()
  })

  it('renders Measurement Guides with screen-space distance labels and layer visibility', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{
          moveTo: ReturnType<typeof vi.fn>
          lineTo: ReturnType<typeof vi.fn>
          stroke: ReturnType<typeof vi.fn>
        }>
        texts: Array<{
          text: string
          rotation: number
          style: unknown
          position: { set: ReturnType<typeof vi.fn> }
        }>
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    const snapshot = createRendererSnapshot({
      measurementGuides: [{
        kind: 'measurement-guide',
        id: 'guide-1',
        locked: false,
        start: { x: 40, y: 10 },
        end: { x: 10, y: 40 },
      }],
      layers: [{ kind: 'layer', name: 'measurement-guides', visible: true, locked: false, opacity: 1 }],
    })

    renderer.present(view({ x: 0, y: 0, scale: 2 }), snapshot)

    const guideGraphic = pixi.__pixiMockState.graphics.find((graphics) =>
      graphics.moveTo.mock.calls.some(([x, y]) => x === 40 && y === 10)
      && graphics.lineTo.mock.calls.some(([x, y]) => x === 10 && y === 40),
    )
    // A light 1.5 px guide over a 3.5 px dark casing, in world units at the centre of scale 2's band.
    const band = bandCentreScale(zoomBandOf(2))
    expect(guideGraphic?.stroke.mock.calls).toHaveLength(2)
    expect(guideGraphic?.stroke.mock.calls[0]?.[0]).toMatchObject({ color: 0x14100a, width: 3.5 / band, alpha: .6 })
    expect(guideGraphic?.stroke.mock.calls[1]?.[0]).toMatchObject({ color: 0xfff3d6, width: 1.5 / band, alpha: 1 })
    const label = pixi.__pixiMockState.texts.find((text) => text.text === '42 m')
    const expectedLabelPoint = {
      x: 50 - MEASUREMENT_GUIDE_LABEL_OFFSET_PX * Math.SQRT1_2,
      y: 50 - MEASUREMENT_GUIDE_LABEL_OFFSET_PX * Math.SQRT1_2,
    }
    const labelPositionCall = label?.position.set.mock.calls[0]
    expect(labelPositionCall?.[0]).toBeCloseTo(expectedLabelPoint.x)
    expect(labelPositionCall?.[1]).toBeCloseTo(expectedLabelPoint.y)
    expect(label?.rotation).toBeCloseTo(-Math.PI / 4)

    // Selecting the guide changes its stroke, never the label's ink, which follows the map backdrop.
    const backdropInk = (label?.style as { options: { fill: number } }).options.fill
    renderer.present(view({ x: 0, y: 0, scale: 2 }), { ...snapshot, selectedMeasurementGuideIds: new Set(['guide-1']) })
    expect((label?.style as { options: { fill: number } }).options.fill).toBe(backdropInk)

    vi.clearAllMocks()
    renderer.present(view({ x: 0, y: 0, scale: 2 }), {
      ...snapshot,
      scene: {
        ...snapshot.scene,
        layers: [{ kind: 'layer', name: 'measurement-guides', visible: false, locked: false, opacity: 1 }],
      },
    })

    expect(pixi.__pixiMockState.graphics.some((graphics) => graphics.lineTo.mock.calls.length > 0)).toBe(false)
    expect(pixi.__pixiMockState.texts.some((text) => text.position.set.mock.calls.length > 0)).toBe(false)
    renderer.dispose()
  })

  it('retains plant and annotation display objects across viewport updates', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        containers: Array<{ removeChildren: ReturnType<typeof vi.fn> }>
        graphics: unknown[]
        texts: unknown[]
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    const snapshot = createTestSceneRendererSnapshot({
      scene: {
        plants: [{
          kind: 'plant',
          locked: false,
          id: 'plant-1',
          canonicalName: 'Malus domestica',
          commonName: 'Apple',
          color: null,
          canopySpreadM: 3,
          position: { x: 10, y: 20 },
          rotationDeg: null,
          notes: null,
          plantedDate: null,
          quantity: 1,
        }],
        zones: [],
        annotations: [{
          kind: 'annotation',
          locked: false,
          id: 'annotation-1',
          annotationType: 'text',
          position: { x: 25, y: 35 },
          text: 'Hello',
          fontSize: 16,
          rotationDeg: null,
        }],
      },
      selectedTargets: [{ kind: 'annotation', id: 'annotation-1' }],
    })

    renderer.present(view({ x: 0, y: 0, scale: 1 }), snapshot)

    const graphicsAfterSceneRender = pixi.__pixiMockState.graphics.length
    const textsAfterSceneRender = pixi.__pixiMockState.texts.length
    const removeChildrenCallsAfterSceneRender = pixi.__pixiMockState.containers
      .reduce((count, container) => count + container.removeChildren.mock.calls.length, 0)

    renderer.present(view({ x: 15, y: 25, scale: 1.5 }))

    expect(pixi.__pixiMockState.graphics).toHaveLength(graphicsAfterSceneRender)
    expect(pixi.__pixiMockState.texts).toHaveLength(textsAfterSceneRender)
    expect(
      pixi.__pixiMockState.containers
        .reduce((count, container) => count + container.removeChildren.mock.calls.length, 0),
    ).toBe(removeChildrenCallsAfterSceneRender)

    renderer.dispose()
  })

  it('applies text annotation rotation in screen space', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        texts: Array<{
          text: string
          rotation: number
          style: unknown
          position: { set: ReturnType<typeof vi.fn> }
        }>
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    const snapshot = createTestSceneRendererSnapshot({
      scene: {
        annotations: [{
          kind: 'annotation',
          locked: false,
          id: 'annotation-1',
          annotationType: 'text',
          position: { x: 25, y: 35 },
          text: 'Hello',
          fontSize: 16,
          rotationDeg: 90,
        }],
      },
    })

    renderer.present(view({ x: 10, y: 20, scale: 2 }), snapshot)

    const annotationText = pixi.__pixiMockState.texts.find((text) => text.text === 'Hello')
    expect(annotationText?.position.set).toHaveBeenCalledWith(60, 90)
    expect(annotationText?.rotation).toBeCloseTo(Math.PI / 2)
    renderer.dispose()
  })

  it('renders elliptical zones from center and radii geometry', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{ ellipse: ReturnType<typeof vi.fn> }>
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    const snapshot = createTestSceneRendererSnapshot({
      scene: {
        zones: [{
          kind: 'zone',
          locked: false,
          id: 'ellipse-1', name: 'ellipse-1',
          zoneType: 'ellipse',
          points: [
            { x: 50, y: 60 },
            { x: 30, y: 20 },
          ],
          rotationDeg: 0,
          fillColor: null,
          notes: null,
        }],
      },
    })

    renderer.present(view({ x: 0, y: 0, scale: 1 }), snapshot)

    const ellipseGraphic = pixi.__pixiMockState.graphics.find((graphics) => graphics.ellipse.mock.calls.length > 0)
    expect(ellipseGraphic?.ellipse).toHaveBeenCalledWith(50, 60, 30, 20)
    renderer.dispose()
  })

  it('renders rotated rectangular zones as oriented paths', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{
          rect: ReturnType<typeof vi.fn>
          moveTo: ReturnType<typeof vi.fn>
          lineTo: ReturnType<typeof vi.fn>
        }>
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    const snapshot = createTestSceneRendererSnapshot({
      scene: {
        zones: [{
          kind: 'zone',
          locked: false,
          id: 'zone-1', name: null,
          zoneType: 'rect',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 4 },
            { x: 0, y: 4 },
          ],
          rotationDeg: 90,
          fillColor: null,
          notes: null,
        }],
      },
    })

    renderer.present(view({ x: 0, y: 0, scale: 1 }), snapshot)

    const zoneGraphic = pixi.__pixiMockState.graphics.find((graphics) =>
      graphics.rect.mock.calls.length > 0 || graphics.moveTo.mock.calls.length > 0,
    )
    expect(zoneGraphic).toBeDefined()
    expect(zoneGraphic?.rect).not.toHaveBeenCalled()
    expect(zoneGraphic?.moveTo).toHaveBeenCalledWith(7, -3)
    expect(zoneGraphic?.lineTo).toHaveBeenCalledWith(7, 7)
    expect(zoneGraphic?.lineTo).toHaveBeenCalledWith(3, 7)
    expect(zoneGraphic?.lineTo).toHaveBeenCalledWith(3, -3)
    renderer.dispose()
  })

  it('uses interaction stroke alpha for rotated Pixi zones', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{
          moveTo: ReturnType<typeof vi.fn>
          stroke: ReturnType<typeof vi.fn>
        }>
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    const snapshot = createTestSceneRendererSnapshot({
      scene: {
        zones: [
          {
            kind: 'zone',
            locked: false,
            id: 'rotated-rect', name: 'rotated-rect',
            zoneType: 'rect',
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 4 },
              { x: 0, y: 4 },
            ],
            rotationDeg: 90,
            fillColor: null,
            notes: null,
          },
          {
            kind: 'zone',
            locked: false,
            id: 'rotated-ellipse', name: 'rotated-ellipse',
            zoneType: 'ellipse',
            points: [
              { x: 40, y: 40 },
              { x: 8, y: 4 },
            ],
            rotationDeg: 45,
            fillColor: null,
            notes: null,
          },
        ],
      },
      highlightedZoneIds: new Set<string>(['rotated-rect', 'rotated-ellipse']),
    })

    renderer.present(view({ x: 0, y: 0, scale: 1 }), snapshot)

    const rotatedZoneStrokes = pixi.__pixiMockState.graphics
      .filter((graphics) => graphics.moveTo.mock.calls.length > 0)
      .map((graphics) => graphics.stroke.mock.calls)

    expect(rotatedZoneStrokes).toHaveLength(2)
    for (const [casing, stroke] of rotatedZoneStrokes) {
      expect(casing?.[0].alpha).toBeCloseTo(0.72)
      expect(casing?.[0].width).toBeGreaterThan(stroke?.[0].width)
      expect(stroke?.[0].alpha).toBeCloseTo(0.72 * 0.62)
    }
    renderer.dispose()
  })

  it('keeps colliding Zone and Plant selection strokes typed and screen-readable', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{
          rect: ReturnType<typeof vi.fn>
          circle: ReturnType<typeof vi.fn>
          stroke: ReturnType<typeof vi.fn>
        }>
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    const snapshot = createTestSceneRendererSnapshot({
      scene: {
        plants: [{
          kind: 'plant',
          locked: false,
          id: 'shared-id',
          canonicalName: 'Malus domestica',
          commonName: 'Apple',
          color: null,
          canopySpreadM: null,
          position: { x: 10, y: 20 },
          rotationDeg: null,
          notes: null,
          plantedDate: null,
          quantity: 1,
        }, // A neighbour 1 m away keeps the plant a dot, which strokes nothing, at both scales.
        createPlant({ id: 'neighbour', position: { x: 11, y: 20 } })],
        zones: [{
          kind: 'zone',
          locked: false,
          id: 'shared-id', name: 'shared-id',
          zoneType: 'rect',
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
          ],
          rotationDeg: 0,
          fillColor: null,
          notes: null,
        }],
      },
      selectedTargets: [{ kind: 'zone', id: 'shared-id' }],
    })

    renderer.present(view({ x: 0, y: 0, scale: 4 }), snapshot)

    const zoneGraphic = pixi.__pixiMockState.graphics.find((graphics) => graphics.rect.mock.calls.length > 0)
    const plantGraphic = pixi.__pixiMockState.graphics.find((graphics) => graphics.circle.mock.calls.length > 0)
    // Selected: 2.5 CSS px over a 5.5 CSS px casing, divided by the centre scale of camera scale 4's band.
    const atFour = bandCentreScale(zoomBandOf(4))
    const atTwo = bandCentreScale(zoomBandOf(2))
    expect(zoneGraphic?.stroke.mock.calls[0]?.[0]).toMatchObject({ width: 5.5 / atFour })
    expect(zoneGraphic?.stroke.mock.calls[1]?.[0]).toMatchObject({ width: 2.5 / atFour })
    expect(plantGraphic?.stroke).not.toHaveBeenCalled()

    renderer.present(view({ x: 0, y: 0, scale: 2 }))

    expect(zoneGraphic?.stroke.mock.calls.slice(-1)[0]?.[0]).toMatchObject({ width: 2.5 / atTwo })
    expect(plantGraphic?.stroke).not.toHaveBeenCalled()

    renderer.present(view({ x: 0, y: 0, scale: 4 }), createTestSceneRendererSnapshot({
      scene: snapshot.scene,
      selectedTargets: [
        { kind: 'zone', id: 'shared-id' },
        { kind: 'plant', id: 'shared-id' },
      ],
    }))

    expect(zoneGraphic?.stroke.mock.calls.slice(-1)[0]?.[0]).toMatchObject({ width: 2.5 / atFour })
    // The plant's ring is its own graphic above the symbol, in CSS pixels.
    const plantRing = pixi.__pixiMockState.graphics.find((graphics) => graphics !== zoneGraphic && graphics.stroke.mock.calls.length > 0)
    expect(plantGraphic?.stroke).not.toHaveBeenCalled()
    expect(plantRing?.stroke.mock.calls.slice(-2).map(([stroke]) => stroke.width)).toEqual([5.5, 2.5])

    renderer.present(view({ x: 0, y: 0, scale: 2 }))

    expect(zoneGraphic?.stroke.mock.calls.slice(-1)[0]?.[0]).toMatchObject({ width: 2.5 / atTwo })
    expect(plantRing?.stroke.mock.calls.slice(-2).map(([stroke]) => stroke.width)).toEqual([5.5, 2.5])
    renderer.dispose()
  })

  it('renders selected zones with stronger ochre strokes than hover highlights', async () => {
    const pixi = await import('pixi.js') as unknown as {
      __pixiMockState: {
        graphics: Array<{
          rect: ReturnType<typeof vi.fn>
          stroke: ReturnType<typeof vi.fn>
        }>
      }
    }

    const host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 })
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 })

    const renderer = mountPresentation(host)

    const snapshot = createTestSceneRendererSnapshot({
      scene: {
        zones: [
          {
            kind: 'zone',
            locked: false,
            id: 'selected-zone', name: 'selected-zone',
            zoneType: 'rect',
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 0, y: 10 },
            ],
            rotationDeg: 0,
            fillColor: null,
            notes: null,
          },
          {
            kind: 'zone',
            locked: false,
            id: 'hover-zone', name: 'hover-zone',
            zoneType: 'rect',
            points: [
              { x: 20, y: 0 },
              { x: 30, y: 0 },
              { x: 30, y: 10 },
              { x: 20, y: 10 },
            ],
            rotationDeg: 0,
            fillColor: null,
            notes: null,
          },
        ],
      },
      selectedTargets: [{ kind: 'zone', id: 'selected-zone' }],
      highlightedZoneIds: new Set<string>(['hover-zone']),
    })

    renderer.present(view({ x: 0, y: 0, scale: 1 }), snapshot)

    const selectedGraphic = pixi.__pixiMockState.graphics
      .find((graphics) => graphics.rect.mock.calls[0]?.[0] === 0)
    const hoverGraphic = pixi.__pixiMockState.graphics
      .find((graphics) => graphics.rect.mock.calls[0]?.[0] === 20)
    const selectedCasing = selectedGraphic?.stroke.mock.calls[0]?.[0]
    const selectedStroke = selectedGraphic?.stroke.mock.calls[1]?.[0]
    const hoverStroke = hoverGraphic?.stroke.mock.calls[1]?.[0]

    expect(selectedStroke).toMatchObject({ color: 0x9c5a16 })
    expect(selectedCasing).toMatchObject({ color: 0xfff8ec })
    expect(selectedCasing.width).toBeGreaterThan(selectedStroke.width)
    expect(selectedStroke.width).toBeGreaterThan(hoverStroke.width)
    expect(selectedStroke.alpha).toBeGreaterThan(hoverStroke.alpha)
    renderer.dispose()
  })

  it('a draft set on the presentation is drawn and cleared', () => {
    interface MockNode {
      children: MockNode[]
      matrix: number[] | null
      moveTo: ReturnType<typeof vi.fn>
      lineTo: ReturnType<typeof vi.fn>
      stroke: ReturnType<typeof vi.fn>
      destroy: ReturnType<typeof vi.fn>
    }
    const stage = new Container()
    const renderer = createPixiScenePresentation({
      stage,
      createText: () => new Text({ resolution: 2 }),
      viewSize: { width: 400, height: 300 },
    })
    // Drafts draw over plants, notes and every label: the world and billboard draft roots, the last two stage children.
    const children = (stage as unknown as MockNode).children
    expect(children).toHaveLength(4)
    const [draftWorld, draftScreen] = children.slice(-2) as [MockNode, MockNode]

    renderer.present(view({ x: 5, y: 6, scale: 10 }), createRendererSnapshot())
    expect(draftWorld.matrix).toEqual([10, 0, 0, 10, 5, 6])
    renderer.setDraft({ shapes: [{ kind: 'polyline', points: [{ x: 1, y: 2 }, { x: 3, y: 2 }], style: { token: 'draft', widthPx: 2 } }] })
    const [line] = draftWorld.children
    expect(line).toBeDefined()
    expect(line!.moveTo).toHaveBeenCalledWith(1, 2)
    expect(line!.lineTo).toHaveBeenCalledWith(3, 2)
    // The 4 px casing under the 2 px stroke, in world units at scale 10.
    expect(line!.stroke.mock.calls.map(([style]) => style.width)).toEqual([0.4, 0.2])
    expect(draftScreen.children).toEqual([])

    renderer.present(view({ x: 15, y: 16, scale: 10 }))
    expect(draftWorld.matrix).toEqual([10, 0, 0, 10, 15, 16])
    expect(draftWorld.children).toEqual([line])

    renderer.setDraft(null)
    expect(draftWorld.children).toEqual([])
    expect(line!.destroy).toHaveBeenCalled()
    renderer.dispose()
  })
})

function createRendererSnapshot(overrides: {
  plants?: SceneRendererSnapshot['scene']['plants']
  measurementGuides?: SceneRendererSnapshot['scene']['measurementGuides']
  layers?: SceneRendererSnapshot['scene']['layers']
  plantSpeciesSymbols?: Record<string, string>
} = {}): SceneRendererSnapshot {
  return createTestSceneRendererSnapshot({
    scene: {
      plants: overrides.plants ?? [],
      layers: overrides.layers ?? [],
      plantSpeciesSymbols: overrides.plantSpeciesSymbols ?? {},
      measurementGuides: overrides.measurementGuides ?? [],
    },
  })
}

function createPlant(
  overrides: Partial<SceneRendererSnapshot['scene']['plants'][number]> = {},
): SceneRendererSnapshot['scene']['plants'][number] {
  return {
    kind: 'plant',
    locked: false,
    id: 'plant-1',
    canonicalName: 'Malus domestica',
    commonName: 'Apple',
    color: null,
    canopySpreadM: null,
    position: { x: 10, y: 10 },
    rotationDeg: null,
    notes: null,
    plantedDate: null,
    quantity: 1,
    ...overrides,
  }
}
