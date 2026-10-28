// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import { Graphics, type Container, type GraphicsContext } from 'pixi.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTestRendererView, createTestSceneRendererSnapshot } from '../../../__tests__/support/scene-renderer-snapshot'
import { gridInterval } from '../../grid'
import { getMapBackdropInk } from '../scene-visuals'
import { snapWorldPoint } from '../tools/snapping'
import { bandCentreScale, zoomBandOf } from '../view/frame-source'
import type { ViewTransform, WorldPoint } from '../view/types'
import type { SceneEditingAids } from './scene-types'
import { createWorldLayers } from './world-layers'

afterEach(() => {
  vi.restoreAllMocks()
})

function bedAndGuide() {
  return createTestSceneRendererSnapshot({ scene: {
    zones: [{ kind: 'zone', id: 'bed', name: 'bed', zoneType: 'rect', locked: false, rotationDeg: 0, fillColor: '#eeeeee', notes: null,
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }],
    measurementGuides: [{ kind: 'measurement-guide', id: 'guide', locked: false, start: { x: 0, y: 0 }, end: { x: 2, y: 0 } }],
  } })
}

function withAids(aids: SceneEditingAids, snapshot = createTestSceneRendererSnapshot()) {
  return { ...snapshot, editingAids: aids }
}

function gridAid(): SceneEditingAids['grid'] {
  const ink = getMapBackdropInk()
  return { ink: ink.grid, majorInk: ink.gridMajor }
}

function aid(layers: ReturnType<typeof createWorldLayers>, label: 'grid'): Graphics {
  const graphics = layers.root.getChildByLabel(label, true)
  if (!(graphics instanceof Graphics)) throw new Error(`no ${label} graphics`)
  return graphics
}

/** A fill or stroke a context holds: Pixi's instruction union without its texture member, so `data.path` is typed. */
type PaintInstruction = Exclude<GraphicsContext['instructions'][number], { action: 'texture' }>

/** Each stroke's straight segments in world metres, in drawing order. */
function strokedSegments(graphics: Graphics): Array<Array<readonly [WorldPoint, WorldPoint]>> {
  return graphics.context.instructions
    .filter((instruction): instruction is PaintInstruction => instruction.action === 'stroke')
    .map((instruction) => {
      const steps = instruction.data.path.instructions
      const segments: Array<readonly [WorldPoint, WorldPoint]> = []
      let from: WorldPoint | null = null
      for (const step of steps) {
        const to = { x: step.data[0]!, y: step.data[1]! }
        if (step.action === 'lineTo' && from) segments.push([from, to])
        from = to
      }
      return segments
    })
}

/** Each stroke's width in a Graphics, in drawing order. */
function strokeWidths(graphics: Graphics): number[] {
  return graphics.context.instructions
    .filter((instruction) => instruction.action === 'stroke')
    .map((instruction) => (instruction.data as { style: { width: number } }).style.width)
}

/** A world point on screen through the root's transform, as the GPU draws it. */
function onScreen(root: Container, point: WorldPoint): WorldPoint {
  root.updateLocalTransform()
  const { a, b, c, d, tx, ty } = root.localTransform
  return { x: a * point.x + c * point.y + tx, y: b * point.x + d * point.y + ty }
}

function visibleBox(view: ViewTransform) {
  const quad = view.visibleWorldQuad()
  const xs = quad.map((point) => point.x)
  const ys = quad.map((point) => point.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

describe('world layers', () => {
  it('a pan re-tessellates no zone', () => {
    const layers = createWorldLayers()
    layers.present(createTestRendererView({ x: 0, y: 0, scale: 30 }), bedAndGuide())
    const traced = layers.root.children.flatMap((layer) => layer.children) as Graphics[]
    expect(traced).toHaveLength(2)
    const instructions = traced.map((graphics) => graphics.context.instructions.length)
    const clear = vi.spyOn(Graphics.prototype, 'clear')

    // A pan writes the world root's affine, one write, and traces nothing.
    const panned = createTestRendererView({ x: 10, y: 20, scale: 30 })
    layers.present(panned)
    expect(clear).not.toHaveBeenCalled()
    expect(traced.map((graphics) => graphics.context.instructions.length)).toEqual(instructions)
    layers.root.updateLocalTransform()
    const { a, b, c, d, tx, ty } = layers.root.localTransform
    expect([a, b, c, d, tx, ty]).toEqual([...panned.planar.affine])

    // A zoom traces the CSS-px strokes again at the new scale.
    layers.present(createTestRendererView({ x: 10, y: 20, scale: 60 }))
    expect(clear).toHaveBeenCalledTimes(2)
  })

  it('a zoom inside a band re-traces no zone, guide or grid; a band edge traces them at the band\'s centre scale', () => {
    const layers = createWorldLayers()
    // 30 and 33 px/m share a band (1.25^15 to 1.25^16) and a grid interval (1 m).
    layers.present(createTestRendererView({ x: 0, y: 0, scale: 30 }), withAids({ grid: gridAid() }, bedAndGuide()))
    const clear = vi.spyOn(Graphics.prototype, 'clear')
    layers.present(createTestRendererView({ x: 0, y: 0, scale: 33 }))
    expect(clear).not.toHaveBeenCalled()

    layers.present(createTestRendererView({ x: 0, y: 0, scale: 60 }))
    expect(clear).toHaveBeenCalledTimes(3)
    const centre = bandCentreScale(zoomBandOf(60))
    const [zone, guide] = layers.root.children.slice(1).flatMap((layer) => layer.children) as Graphics[]
    // The 2 px zone over its 4 px casing, the 1.5 px guide over its 3.5 px casing, the 1 px grid: traced at the band's
    // centre, so on screen within 12 % of their CSS px.
    for (const [graphics, widthsPx] of [[zone!, [4, 2]], [guide!, [3.5, 1.5]], [aid(layers, 'grid'), [1, 1]]] as const) {
      const widths = strokeWidths(graphics)
      expect(widths).toHaveLength(widthsPx.length)
      widths.forEach((width, index) => {
        expect(width).toBeCloseTo(widthsPx[index]! / centre, 9)
        expect(Math.abs(width * 60 - widthsPx[index]!) / widthsPx[index]!).toBeLessThanOrEqual(0.12)
      })
    }
  })

  it('the grid lines are the snap lattice', () => {
    const layers = createWorldLayers()
    const view = createTestRendererView({ x: 12, y: 34, scale: 8 })
    layers.present(view, withAids({ grid: gridAid() }))

    const interval = gridInterval(view.pixelsPerMetre).interval
    const [minor] = strokedSegments(aid(layers, 'grid'))
    const columns = minor!.filter(([start, end]) => start.x === end.x).map(([start]) => start.x)
    const rows = minor!.filter(([start, end]) => start.y === end.y).map(([start]) => start.y)
    for (const x of columns) expect(x / interval).toBeCloseTo(Math.round(x / interval), 9)
    for (const y of rows) expect(y / interval).toBeCloseTo(Math.round(y / interval), 9)

    // A point snapped to the grid lands on a drawn line, where the screen shows it.
    for (const pointer of [{ x: 37, y: 61 }, { x: 250.4, y: 190.2 }, { x: 399, y: 1 }]) {
      const snapped = snapWorldPoint(view.screenToWorld(pointer), { grid: true }, view.pixelsPerMetre)
      const column = columns.find((x) => Math.abs(x - snapped.x) < 1e-9)
      const row = rows.find((y) => Math.abs(y - snapped.y) < 1e-9)
      expect(column, `column for ${pointer.x}`).toBeDefined()
      expect(row, `row for ${pointer.y}`).toBeDefined()
      expect(onScreen(layers.root, snapped).x).toBeCloseTo(view.worldToScreen(snapped).x, 6)
      expect(onScreen(layers.root, snapped).y).toBeCloseTo(view.worldToScreen(snapped).y, 6)
    }
  })

  it('the grid turns with the world root', () => {
    const layers = createWorldLayers()
    const view = createTestRendererView({ x: 120, y: 80, scale: 8 }, { bearingDeg: 30 })
    layers.present(view, withAids({ grid: gridAid() }))

    // One affine for the zones and the grid: lines on world axes, turned on screen by the view.
    layers.root.updateLocalTransform()
    const { a, b, c, d, tx, ty } = layers.root.localTransform
    ;[a, b, c, d, tx, ty].forEach((value, index) => expect(value).toBeCloseTo(view.planar.affine[index]!, 6))
    const [minor] = strokedSegments(aid(layers, 'grid'))
    expect(minor!.every(([start, end]) => start.x === end.x || start.y === end.y)).toBe(true)
    // The traced lattice covers the turned screen's corners.
    const box = visibleBox(view)
    const xs = minor!.flatMap(([start, end]) => [start.x, end.x])
    const ys = minor!.flatMap(([start, end]) => [start.y, end.y])
    expect(Math.min(...xs)).toBeLessThanOrEqual(box.minX)
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(box.maxX)
    expect(Math.min(...ys)).toBeLessThanOrEqual(box.minY)
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(box.maxY)
  })

  it('a pan inside the margin traces nothing; leaving it retraces only the grid', () => {
    const layers = createWorldLayers()
    layers.present(createTestRendererView({ x: 0, y: 0, scale: 30 }), withAids({ grid: gridAid() }, bedAndGuide()))
    const clear = vi.spyOn(Graphics.prototype, 'clear')

    // A 40 px pan stays inside the traced margin.
    layers.present(createTestRendererView({ x: 40, y: -40, scale: 30 }))
    expect(clear).not.toHaveBeenCalled()

    // A screen-wide pan leaves it: the grid retraces, the zones keep their geometry.
    layers.present(createTestRendererView({ x: -1200, y: 900, scale: 30 }))
    expect(clear.mock.contexts).toEqual([aid(layers, 'grid')])

    // A scene sync with the same aids traces nothing either.
    clear.mockClear()
    layers.present(createTestRendererView({ x: -1200, y: 900, scale: 30 }), withAids({ grid: gridAid() }, bedAndGuide()))
    expect(clear).not.toHaveBeenCalled()
  })

  it('draws no grid without editing aids, as in a thumbnail', () => {
    const layers = createWorldLayers()
    layers.present(createTestRendererView({ x: 0, y: 0, scale: 30 }), withAids({ grid: gridAid() }))
    expect(strokedSegments(aid(layers, 'grid'))).not.toEqual([])

    layers.present(createTestRendererView({ x: 0, y: 0, scale: 30 }), createTestSceneRendererSnapshot())
    expect(layers.root.getChildByLabel('grid', true)).toBeNull()
  })

  it('draws the grid under the zones', () => {
    const layers = createWorldLayers()
    layers.present(createTestRendererView({ x: 0, y: 0, scale: 30 }), withAids({ grid: gridAid() }, bedAndGuide()))
    const aidsLayer = aid(layers, 'grid').parent!
    expect(layers.root.children[0]).toBe(aidsLayer)
    expect(aidsLayer.children).toEqual([aid(layers, 'grid')])
  })
})
