import { describe, expect, it, vi } from 'vitest'
import './support/camera-tolerance'

import { drawInspectionLensScene } from '../canvas/runtime/inspection-lens-drawing'
import type { SceneRendererSnapshot } from '../canvas/runtime/renderers/scene-types'
import type { SceneDesignObjectSelection } from '../canvas/runtime/scene'
import { getCanvasInteractionStrokeVisual, readCanvasPaintTokens } from '../canvas/runtime/scene-visuals'
import { DEFAULT_PLANT_DISPLAY } from '../canvas/runtime/plant-display'
import { createTestRendererView, createTestSceneRendererSnapshot } from './support/scene-renderer-snapshot'

/** A lens snapshot and the placement its view draws it at (screen = world × scale + { x, y }, bearing 0). */
interface LensScene {
  readonly snapshot: SceneRendererSnapshot
  readonly viewport: { readonly x: number; readonly y: number; readonly scale: number }
}

function draw(
  ctx: ReturnType<typeof createMockCanvasContext>,
  scene: LensScene,
  options: { widthPx?: number; heightPx?: number; dpr?: number; scratch?: (widthPx: number, heightPx: number) => CanvasRenderingContext2D } = {},
): void {
  const widthPx = options.widthPx ?? 400
  const heightPx = options.heightPx ?? 300
  const view = createTestRendererView(scene.viewport, { screen: { width: widthPx, height: heightPx, devicePixelRatio: options.dpr ?? 1 } })
  const { snapshot } = scene
  const hoveredPlantId = snapshot.hoverTarget?.kind === 'plant' ? snapshot.hoverTarget.id : null
  drawInspectionLensScene(ctx as unknown as CanvasRenderingContext2D, {
    scene: snapshot.scene,
    speciesCache: snapshot.speciesCache,
    hoveredPlantId,
    plantDisplay: snapshot.plantDisplay,
    paintTokens: snapshot.paintTokens,
  }, view, {
    widthPx,
    heightPx,
    dpr: options.dpr ?? 1,
    scratch: options.scratch ?? (() => { throw new Error('an opaque Plants layer draws on the page') }),
  })
}

describe('drawInspectionLensScene', () => {
  it('skips distant plants but draws edge footprints', () => {
    const ctx = createMockCanvasContext()
    draw(ctx, createRendererSnapshot({
      plants: [createPlant({ id: 'edge', position: { x: -.1, y: 1 } }),
        createPlant({ id: 'far', position: { x: 1000, y: 1 } })],
      viewport: { x: 0, y: 0, scale: 30 },
    }))
    expect(ctx.fill).toHaveBeenCalledTimes(1)
  })

  it('retains offscreen neighbours when calculating an edge plant footprint', () => {
    const ctx = createMockCanvasContext()
    draw(ctx, createRendererSnapshot({
      plants: [createPlant({ id: 'edge', position: { x: -31 / 30, y: 1 } }),
        createPlant({ id: 'neighbour', position: { x: -33 / 30, y: 1 } })],
      viewport: { x: 0, y: 0, scale: 30 },
    }))
    expect(ctx.arc).toHaveBeenCalledTimes(1)
    // Two CSS pixels between centres leaves a .84 CSS-pixel position mark.
    expect(ctx.arc.mock.calls[0]?.[2]).toBeCloseTo(.028)
  })

  it('renders crowded position marks as solid dots without outlines exceeding their footprints', () => {
    const ctx = createMockCanvasContext()
    draw(ctx, createRendererSnapshot({
      plants: [createPlant({ id: 'a', position: { x: 0, y: 0 } }), createPlant({ id: 'b', position: { x: .27, y: 0 } })],
      viewport: { x: 0, y: 0, scale: 10 },
    }))
    expect(ctx.fill).toHaveBeenCalledTimes(2)
    expect(ctx.stroke).not.toHaveBeenCalled()
  })

  it('keeps Zone outlines two CSS pixels wide over a four-pixel casing on a high-density backing store', () => {
    const canvas = createTransformTrackingCanvasContext(2)
    const widths: number[] = []
    canvas.context.stroke.mockImplementation(() => { widths.push(canvas.context.lineWidth) })
    draw(canvas.context, createRendererSnapshot({
      viewport: { x: 0, y: 0, scale: 20 },
      zones: [{ kind: 'zone', id: 'bed', name: 'bed', zoneType: 'rect', locked: false, rotationDeg: 0,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], fillColor: null, notes: null }],
    }), { dpr: 2 })
    expect(widths).toEqual([0.2, 0.1])
  })

  it('draws plant symbol glyphs at readable zoom and collapses them to dots at low zoom', () => {
    const snapshot = createRendererSnapshot({
      plants: [
        createPlant({ id: 'rosette', symbol: 'rosette', position: { x: 10, y: 10 } }),
        createPlant({ id: 'conifer', canonicalName: 'Pyrus communis', position: { x: 15, y: 10 } }),
      ],
      plantSpeciesSymbols: { 'Pyrus communis': 'conifer' },
      viewport: { x: 0, y: 0, scale: 20 },
    })
    const readable = createMockCanvasContext()
    draw(readable, snapshot)
    expect(readable.bezierCurveTo).toHaveBeenCalled()
    expect(readable.lineTo).toHaveBeenCalled()

    const distant = createMockCanvasContext()
    draw(distant, { ...snapshot, viewport: { x: 0, y: 0, scale: 0.25 } })
    expect(distant.arc).toHaveBeenCalled()
    expect(distant.rect).not.toHaveBeenCalled()
    expect(distant.lineTo).not.toHaveBeenCalled()
  })

  it('draws curved plant symbol recipes with native Canvas2D curves', () => {
    const ctx = createMockCanvasContext()
    draw(ctx, createRendererSnapshot({
      plants: [
        createPlant({ id: 'shrub', symbol: 'shrub', position: { x: 10, y: 10 } }),
        createPlant({ id: 'groundcover', symbol: 'groundcover', position: { x: 15, y: 10 } }),
      ],
      viewport: { x: 0, y: 0, scale: 20 },
    }))
    expect(ctx.bezierCurveTo).toHaveBeenCalled()
    expect(ctx.fill).toHaveBeenCalled()
    expect(ctx.stroke).toHaveBeenCalled()
  })

  it('keeps a Placed Plant stack badge anchored and screen-sized on a HiDPI canvas', () => {
    const canvas = createTransformTrackingCanvasContext(2)
    draw(canvas.context, createRendererSnapshot({
      plants: [
        createPlant({ id: 'plant-1', position: { x: 10, y: 20 } }),
        createPlant({ id: 'plant-2', position: { x: 10, y: 20 } }),
      ],
      viewport: { x: 40, y: -15, scale: 3 },
    }), { dpr: 2 })

    const plantCenter = canvas.arcs[0]!.centerCss
    const badgeText = canvas.texts.find((entry) => entry.text === '2')!
    expect(badgeText.originCss.x).toBeGreaterThan(plantCenter.x)
    expect(badgeText.originCss.y).toBeLessThan(plantCenter.y)
    // The count keeps the 12 px type floor, on an 18 px badge that stays screen-sized.
    expect(Number.parseFloat(badgeText.font)).toBeGreaterThanOrEqual(12)
    expect(canvas.roundRects).toEqual([expect.objectContaining({ widthCss: 18, heightCss: 18 })])
  })

  it('composites translucent plants once: opaque on a scratch, then one drawImage at the Plants opacity (canopi-h90p.67)', () => {
    const ctx = createAlphaRecordingContext()
    const scratch = createAlphaRecordingContext()
    const scratches: Array<[number, number]> = []
    const half = createRendererSnapshot({
      plants: [createPlant({ id: 'a', position: { x: 10, y: 10 } }), createPlant({ id: 'b', position: { x: 10.4, y: 10 } })],
      zones: [{ kind: 'zone', id: 'bed', name: 'bed', zoneType: 'rect', locked: false, rotationDeg: 0,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }], fillColor: null, notes: null }],
      layers: [
        { kind: 'layer', name: 'plants', visible: true, locked: false, opacity: .5 },
        { kind: 'layer', name: 'zones', visible: true, locked: false, opacity: .5 },
      ],
      viewport: { x: 0, y: 0, scale: 20 },
    })
    draw(ctx, { ...half, snapshot: { ...half.snapshot, hoverTarget: { kind: 'plant', id: 'a', state: 'hover' } } }, {
      dpr: 2,
      scratch: (width, height) => { scratches.push([width, height]); return scratch as unknown as CanvasRenderingContext2D },
    })

    // Both symbols and the hover ring are opaque on the scratch, so the overlap is no darker than either plant.
    expect(scratches).toEqual([[800, 600]])
    expect(scratch.fills.length).toBeGreaterThanOrEqual(2)
    expect(scratch.fills.every((alpha) => alpha === 1)).toBe(true)
    expect(scratch.strokes.length).toBeGreaterThan(0)
    expect(Math.max(...scratch.strokes)).toBeLessThanOrEqual(1)
    expect(Math.min(...scratch.strokes)).toBeGreaterThan(.5)
    // The page gets the zone per shape, then the plants in one drawImage at 0.5 on the device-pixel grid.
    expect(ctx.drawImage).toHaveBeenCalledExactlyOnceWith(scratch.canvas, 0, 0)
    expect(ctx.drawImageAlpha).toEqual([.5])
    expect(ctx.fills).toEqual([.1])
    expect(ctx.order.indexOf('fill')).toBeLessThan(ctx.order.indexOf('drawImage'))
    expect(ctx.setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, 0)

    // An opaque layer draws straight on the page.
    const opaque = createAlphaRecordingContext()
    const unused = vi.fn()
    draw(opaque, createRendererSnapshot({
      plants: [createPlant({ id: 'a', position: { x: 10, y: 10 } })],
      viewport: { x: 0, y: 0, scale: 20 },
    }), { scratch: unused })
    expect(unused).not.toHaveBeenCalled()
    expect(opaque.drawImage).not.toHaveBeenCalled()
    expect(opaque.fills).toEqual([1])
  })

  it('clears the whole reused scratch backing at a fractional device pixel ratio', () => {
    // A 431 x 300 lens at dpr 1.25 has a 539 x 375 backing: a clear in CSS pixels reaches only 538.75 x 375 device pixels.
    const scratch = createAlphaRecordingContext()
    scratch.canvas = { width: 539, height: 375 }
    let m = { a: 1, d: 1, e: 0, f: 0 }
    scratch.setTransform = vi.fn((a: number, _b: number, _c: number, d: number, e: number, f: number) => { m = { a, d, e, f } })
    const cleared: Array<{ readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }> = []
    scratch.clearRect = vi.fn((x: number, y: number, w: number, h: number) => {
      scratch.order.push('clearRect')
      cleared.push({ left: m.a * x + m.e, top: m.d * y + m.f, right: m.a * (x + w) + m.e, bottom: m.d * (y + h) + m.f })
    })
    draw(createAlphaRecordingContext(), createRendererSnapshot({
      plants: [createPlant({ id: 'edge', position: { x: 430.5 / 20, y: 5 } })],
      layers: [{ kind: 'layer', name: 'plants', visible: true, locked: false, opacity: .5 }],
      viewport: { x: 0, y: 0, scale: 20 },
    }), { widthPx: 431, heightPx: 300, dpr: 1.25, scratch: () => scratch as unknown as CanvasRenderingContext2D })

    expect(cleared.some((rect) => rect.left <= 0 && rect.top <= 0 && rect.right >= 539 && rect.bottom >= 375)).toBe(true)
    expect(scratch.order.indexOf('clearRect')).toBeLessThan(scratch.order.indexOf('fill'))
  })

  it('keeps stack badges per shape at the Plants opacity, on the page above the composited plants', () => {
    const ctx = createAlphaRecordingContext()
    const scratch = createAlphaRecordingContext()
    draw(ctx, createRendererSnapshot({
      plants: [createPlant({ id: 'plant-1', position: { x: 10, y: 20 } }), createPlant({ id: 'plant-2', position: { x: 10, y: 20 } })],
      layers: [{ kind: 'layer', name: 'plants', visible: true, locked: false, opacity: .5 }],
      viewport: { x: 40, y: -15, scale: 3 },
    }), { scratch: () => scratch as unknown as CanvasRenderingContext2D })
    expect(scratch.fillText).not.toHaveBeenCalled()
    expect(ctx.fills).toEqual([.5])
    expect(ctx.fillText).toHaveBeenCalledOnce()
    expect(ctx.order.indexOf('drawImage')).toBeLessThan(ctx.order.indexOf('fillText'))
  })

  it('draws the hover ring above every plant symbol, as the map does', () => {
    const ring = getCanvasInteractionStrokeVisual('hover')
    for (const opacity of [.5, 1]) {
      const ctx = createAlphaRecordingContext()
      const scratch = createAlphaRecordingContext()
      const strokeStyles: string[] = []
      for (const target of [ctx, scratch]) {
        target.stroke = vi.fn(() => { target.order.push('stroke'); target.strokes.push(target.globalAlpha); strokeStyles.push(target.strokeStyle) })
      }
      // The hovered plant comes first, so its neighbour, drawn later and overlapping it, would cover a ring drawn with it.
      const overlapping = createRendererSnapshot({
        plants: [createPlant({ id: 'a', position: { x: 10, y: 10 } }), createPlant({ id: 'b', position: { x: 10.4, y: 10 } })],
        layers: [{ kind: 'layer', name: 'plants', visible: true, locked: false, opacity }],
        viewport: { x: 0, y: 0, scale: 20 },
      })
      draw(ctx, { ...overlapping, snapshot: { ...overlapping.snapshot, hoverTarget: { kind: 'plant', id: 'a', state: 'hover' } } },
        { scratch: () => scratch as unknown as CanvasRenderingContext2D })
      const target = opacity < 1 ? scratch : ctx
      expect(target.fills.length).toBeGreaterThanOrEqual(2)
      expect(strokeStyles.slice(-2)).toEqual([ring.casingColor, ring.color])
      expect(target.order.lastIndexOf('fill')).toBeLessThan(target.order.length - 2)
      expect(target.order.slice(-2)).toEqual(['stroke', 'stroke'])
    }
  })

  it('rings the hovered lens plant with the shared hover visual', () => {
    const ctx = createMockCanvasContext()
    const hovered = createRendererSnapshot({
      plants: [createPlant({ id: 'a', position: { x: 10, y: 10 } }), createPlant({ id: 'b', position: { x: 30, y: 10 } })],
      viewport: { x: 0, y: 0, scale: 10 },
    })
    draw(ctx, { ...hovered, snapshot: { ...hovered.snapshot, hoverTarget: { kind: 'plant', id: 'a', state: 'hover' } } })
    const plainStrokes = createMockCanvasContext()
    draw(plainStrokes, createRendererSnapshot({
      plants: [createPlant({ id: 'a', position: { x: 10, y: 10 } }), createPlant({ id: 'b', position: { x: 30, y: 10 } })],
      viewport: { x: 0, y: 0, scale: 10 },
    }))
    // The hover ring is one casing stroke and one ring stroke.
    expect(ctx.stroke.mock.calls.length).toBe(plainStrokes.stroke.mock.calls.length + 2)
  })

  it('respects snapshot plantDisplay (outline off, symbolScale) and custom paintTokens', () => {
    const base = createRendererSnapshot({
      plants: [createPlant({ id: 'a', position: { x: 10, y: 10 } })],
      zones: [{ kind: 'zone', id: 'bed', name: 'bed', zoneType: 'rect', locked: false, rotationDeg: 0,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }], fillColor: null, notes: null }],
      viewport: { x: 0, y: 0, scale: 20 },
    })
    const customTokens = {
      ...readCanvasPaintTokens(),
      background: '#111111',
      'zone-stroke': '#abcdef',
      'hover-stroke': '#fedcba',
    }
    const scaled = createMockCanvasContext()
    const strokeStyles: string[] = []
    scaled.stroke.mockImplementation(() => { strokeStyles.push(scaled.strokeStyle) })
    draw(scaled, {
      ...base,
      snapshot: {
        ...base.snapshot,
        hoverTarget: { kind: 'plant', id: 'a', state: 'hover' },
        plantDisplay: { ...DEFAULT_PLANT_DISPLAY, outline: false, symbolScale: 1.5 },
        paintTokens: customTokens,
      },
    })

    const baseline = createMockCanvasContext()
    draw(baseline, base)

    // Zone stroke and hover ring read snapshot paintTokens, and outline: false skips the plant symbol stroke.
    expect(strokeStyles).toContain('#abcdef')
    expect(strokeStyles).toContain('#fedcba')
    // 2 strokes for zone (casing + stroke) + 2 strokes for hover ring (casing + stroke), 0 for the plant outline.
    expect(strokeStyles).toHaveLength(4)
    // symbolScale 1.5 draws a larger plant symbol radius than the default 1.0.
    const scaledRadius = scaled.arc.mock.calls[0]?.[2] ?? 0
    const baselineRadius = baseline.arc.mock.calls[0]?.[2] ?? 0
    expect(scaledRadius).toBeGreaterThan(baselineRadius)
  })
})

function createRendererSnapshot(overrides: {
  plants?: SceneRendererSnapshot['scene']['plants']
  zones?: SceneRendererSnapshot['scene']['zones']
  annotations?: SceneRendererSnapshot['scene']['annotations']
  measurementGuides?: SceneRendererSnapshot['scene']['measurementGuides']
  layers?: SceneRendererSnapshot['scene']['layers']
  plantSpeciesSymbols?: Record<string, string>
  viewport?: LensScene['viewport']
  selectedTargets?: SceneDesignObjectSelection
} = {}): LensScene {
  const snapshot = createTestSceneRendererSnapshot({
    scene: {
      plants: overrides.plants ?? [],
      zones: overrides.zones ?? [],
      annotations: overrides.annotations ?? [],
      groups: [],
      layers: overrides.layers ?? [],
      plantSpeciesColors: {},
      plantSpeciesSymbols: overrides.plantSpeciesSymbols ?? {},
      measurementGuides: overrides.measurementGuides ?? [],
    },
    selectedTargets: overrides.selectedTargets,
  })
  return { snapshot, viewport: overrides.viewport ?? { x: 10, y: 20, scale: 2 } }
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

function createMockCanvasContext() {
  return {
    setTransform: vi.fn(),
    transform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    ellipse: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    rotate: vi.fn(),
    getTransform: vi.fn(() => ({ a: 1 })),
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
  }
}

/** A mock context that records the alpha of every fill, stroke and drawImage, and the order of those calls. */
function createAlphaRecordingContext() {
  const order: string[] = []
  const fills: number[] = []
  const strokes: number[] = []
  const drawImageAlpha: number[] = []
  const context = {
    ...createMockCanvasContext(),
    canvas: { width: 0, height: 0 },
    order,
    fills,
    strokes,
    drawImageAlpha,
    fill: vi.fn(() => { order.push('fill'); fills.push(context.globalAlpha) }),
    stroke: vi.fn(() => { order.push('stroke'); strokes.push(context.globalAlpha) }),
    fillText: vi.fn(() => { order.push('fillText') }),
    drawImage: vi.fn((..._args: unknown[]) => { order.push('drawImage'); drawImageAlpha.push(context.globalAlpha) }),
  }
  return context
}

function createTransformTrackingCanvasContext(backingStoreScale: number) {
  type Transform = { a: number; b: number; c: number; d: number; e: number; f: number }
  let transform: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const stack: Transform[] = []
  const arcs: Array<{ centerCss: { x: number; y: number }; radiusCss: number }> = []
  const roundRects: Array<{ originCss: { x: number; y: number }; widthCss: number; heightCss: number }> = []
  const texts: Array<{ text: string; alpha: number; font: string; originCss: { x: number; y: number } }> = []
  const toCssPoint = (x: number, y: number) => ({
    x: (transform.a * x + transform.c * y + transform.e) / backingStoreScale,
    y: (transform.b * x + transform.d * y + transform.f) / backingStoreScale,
  })
  const context = {
    ...createMockCanvasContext(),
    setTransform: vi.fn((a: number, b: number, c: number, d: number, e: number, f: number) => {
      transform = { a, b, c, d, e, f }
    }),
    getTransform: vi.fn(() => ({ ...transform })),
    transform: vi.fn((a: number, b: number, c: number, d: number, e: number, f: number) => {
      transform = {
        a: transform.a * a + transform.c * b,
        b: transform.b * a + transform.d * b,
        c: transform.a * c + transform.c * d,
        d: transform.b * c + transform.d * d,
        e: transform.a * e + transform.c * f + transform.e,
        f: transform.b * e + transform.d * f + transform.f,
      }
    }),
    translate: vi.fn((x: number, y: number) => {
      transform = {
        ...transform,
        e: transform.e + transform.a * x + transform.c * y,
        f: transform.f + transform.b * x + transform.d * y,
      }
    }),
    scale: vi.fn((x: number, y: number) => {
      transform = {
        ...transform,
        a: transform.a * x,
        b: transform.b * x,
        c: transform.c * y,
        d: transform.d * y,
      }
    }),
    save: vi.fn(() => stack.push({ ...transform })),
    restore: vi.fn(() => {
      transform = stack.pop() ?? transform
    }),
    arc: vi.fn((x: number, y: number, radius: number) => {
      arcs.push({
        centerCss: toCssPoint(x, y),
        radiusCss: Math.hypot(transform.a, transform.b) * radius / backingStoreScale,
      })
    }),
    roundRect: vi.fn((x: number, y: number, width: number, height: number) => {
      const scale = Math.hypot(transform.a, transform.b) / backingStoreScale
      roundRects.push({ originCss: toCssPoint(x, y), widthCss: width * scale, heightCss: height * scale })
    }),
    fillText: vi.fn((text: string, x: number, y: number) => {
      texts.push({ text, alpha: context.globalAlpha, font: context.font, originCss: toCssPoint(x, y) })
    }),
  }

  return {
    context,
    arcs,
    roundRects,
    texts,
    clearDraws() {
      arcs.length = 0
      texts.length = 0
    },
  }
}
