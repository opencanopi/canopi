// @vitest-environment jsdom

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import { AlphaFilter, Container, Graphics, Text, type GraphicsContext } from 'pixi.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../__tests__/support/camera-tolerance'

import { createTestRendererView, createTestSceneRendererSnapshot } from '../../../__tests__/support/scene-renderer-snapshot'
import { CANVAS_CHROME_FONT_FAMILY } from '../../chrome-fonts'
import { getCanvasColor } from '../../theme-refresh'
import { getAnnotationPresentation } from '../annotation-layout'
import { buildPlantPresentationEntries, resolvePlantDisplayColor } from '../plant-presentation'
import { getDraftLabelVisual, OVERLAY_CASING_EXTRA_PX } from '../scene-visuals'
import type { SceneAnnotationEntity, ScenePlantEntity, SceneZoneEntity } from '../scene'
import type { DraftPresentation, DraftShape } from '../tools/draft'
import { createDraftLayer, type DraftLayer } from './draft-layer'
import { createDraftScenePainters, createPixiScenePresentation } from './pixi-scene'
import type { SceneRendererSnapshot } from './scene-types'
import { createWorldLayers } from './world-layers'

/** jsdom has no canvas to measure glyphs, so chip text has a fixed size. */
class MeasuredText extends Text {
  override get width(): number { return 40 }
  override set width(_value: number) {}
  override get height(): number { return 16 }
  override set height(_value: number) {}
}

const layers: DraftLayer[] = []
const DOCUMENT_LANG = document.documentElement.lang

afterEach(() => {
  for (const layer of layers.splice(0)) layer.dispose()
  document.documentElement.lang = DOCUMENT_LANG
  vi.restoreAllMocks()
})

function mountLayer(snapshot: SceneRendererSnapshot | null = createTestSceneRendererSnapshot()): DraftLayer {
  const stage = new Container()
  const layer = createDraftLayer({
    createText: () => new MeasuredText(),
    viewSize: { width: 400, height: 300 },
    painters: createDraftScenePainters(() => snapshot),
  })
  // As pixi-scene.ts mounts it: the last two children of an untransformed stage.
  stage.addChild(layer.worldDraftRoot, layer.billboardDraftRoot)
  layers.push(layer)
  return layer
}

/** A fill or stroke a context holds: Pixi's instruction union without its texture member, so `data.path` is typed. */
type PaintInstruction = Exclude<GraphicsContext['instructions'][number], { action: 'texture' }>
interface PaintStyle { readonly color: number; readonly alpha: number; readonly width?: number; readonly cap?: string; readonly join?: string }
interface PathStep { readonly action: string; readonly data: readonly unknown[] }

function paintInstructions(graphics: Graphics, action: 'fill' | 'stroke'): PaintInstruction[] {
  return graphics.context.instructions.filter((instruction): instruction is PaintInstruction => instruction.action === action)
}

/** The fills or strokes of `graphics` in drawing order. */
function paints(graphics: Graphics, action: 'fill' | 'stroke'): PaintStyle[] {
  return paintInstructions(graphics, action).map((instruction) => instruction.data.style as unknown as PaintStyle)
}

function pathSteps(instruction: PaintInstruction): PathStep[] {
  return instruction.data.path.instructions
}

/** The shapes cut out of a fill, without the moveTo Pixi opens each path with; empty when it has none. */
function holeSteps(instruction: PaintInstruction): PathStep[] {
  const hole = instruction.data.hole
  return hole?.instructions.filter((step) => step.action !== 'moveTo') ?? []
}

/**
 * The points of an instruction's moveTo and lineTo steps, in order. Pixi opens the path after each paint with a
 * moveTo at the last point; a moveTo that starts nothing is left out.
 */
function tracedPoints(instruction: PaintInstruction): { x: number; y: number }[] {
  const steps = pathSteps(instruction)
  return steps
    .filter((step, index) => step.action === 'lineTo' || (step.action === 'moveTo' && steps[index + 1]?.action === 'lineTo'))
    .map((step) => ({ x: step.data[0] as number, y: step.data[1] as number }))
}

/** The length of each sub-path (a moveTo and the lineTo steps after it): the dashes of a dashed stroke. */
function subPathLengths(instruction: PaintInstruction): number[] {
  const lengths: number[] = []
  let last: { x: number; y: number } | null = null
  for (const step of pathSteps(instruction)) {
    const point = { x: step.data[0] as number, y: step.data[1] as number }
    if (step.action === 'moveTo') {
      lengths.push(0)
      last = point
    } else if (step.action === 'lineTo' && last) {
      lengths[lengths.length - 1]! += Math.hypot(point.x - last.x, point.y - last.y)
      last = point
    }
  }
  // Leaves out the moveTo Pixi opens after each paint.
  return lengths.filter((length) => length > 0)
}

function pixiColor(css: string): number {
  const rgba = css.match(/rgba?\(([^)]+)\)/i)?.[1]?.split(',').slice(0, 3).map((channel) => Number.parseInt(channel, 10))
  if (rgba) return (rgba[0]! << 16) + (rgba[1]! << 8) + rgba[2]!
  return Number.parseInt(css.replace('#', '').slice(0, 6), 16)
}

function cssAlpha(css: string): number {
  return Number.parseFloat(css.match(/rgba\([^)]*,\s*([\d.]+)\)/i)?.[1] ?? '1')
}

/** The view that places the plane origin at `origin` at `scale` px per metre, at bearing 0. */
function at(origin: { x: number; y: number }, scale: number) {
  return createTestRendererView({ ...origin, scale })
}

function global(node: Container): { x: number; y: number } {
  const point = node.getGlobalPosition()
  return { x: point.x, y: point.y }
}

function createPlant(overrides: Partial<ScenePlantEntity> = {}): ScenePlantEntity {
  return {
    kind: 'plant', locked: false, id: 'plant', canonicalName: 'Malus domestica', commonName: 'Apple',
    color: null, canopySpreadM: null, position: { x: 4, y: 3 }, rotationDeg: null,
    notes: null, plantedDate: null, quantity: 1, ...overrides,
  }
}

function createZone(): SceneZoneEntity {
  return {
    kind: 'zone', id: 'bed', name: 'Bed', zoneType: 'rect', locked: false, rotationDeg: 0, fillColor: null, notes: null,
    points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }],
  }
}

function createNote(): SceneAnnotationEntity {
  return {
    kind: 'annotation', id: 'note', annotationType: 'text', locked: false,
    position: { x: 1, y: 5 }, text: 'Pond edge', fontSize: 16, rotationDeg: 30,
  }
}

function objectsGhost(opacity: number): DraftShape {
  return {
    kind: 'ghost',
    opacity,
    entity: {
      kind: 'objects',
      template: {
        plants: [{ sourceId: 'stamp-plant', entity: createPlant({ id: 'stamp-plant', position: { x: 6, y: 1 } }) }],
        zones: [{ sourceId: 'bed', entity: createZone() }],
        annotations: [{ sourceId: 'note', entity: createNote() }],
        measurementGuides: [],
        groups: [],
      },
    },
  }
}

function everyShape(): DraftPresentation {
  return {
    shapes: [
      { kind: 'polyline', points: [{ x: 1, y: 2 }, { x: 3, y: 2 }], style: { token: 'draft', widthPx: 2 } },
      {
        kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }],
        style: { token: 'draft', widthPx: 2 }, fill: { token: 'draft-fill' },
      },
      {
        kind: 'quad', corners: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }],
        style: { token: 'selection', widthPx: 2 }, fill: { token: 'selection-fill' },
      },
      {
        kind: 'ellipse', center: { x: 10, y: 10 }, radiusX: 3, radiusY: 2, rotationDeg: 90,
        style: { token: 'draft', widthPx: 1.5, dash: [6, 5] }, fill: { token: 'draft-fill' },
      },
      { kind: 'circle-px', center: { x: 2, y: 2 }, radiusPx: 1.75, style: { token: 'draft', widthPx: 3.5 } },
      { kind: 'label', anchor: { x: 3, y: 1 }, offsetPx: { x: 0, y: 10 }, text: '12 m', tone: 'measure' },
      { kind: 'ghost', entity: { kind: 'plant', plant: createPlant(), mark: 'symbol' }, opacity: 0.85 },
      objectsGhost(0.62),
    ],
  }
}

describe('draft layer', () => {
  it('each draft shape renders in world units', () => {
    const layer = mountLayer()
    layer.setDraft(everyShape())
    layer.setView(at({ x: 100, y: 50 }, 10))

    // The world container carries the placement; world shapes keep their metres.
    expect(global(layer.worldDraftRoot)).toEqual({ x: 100, y: 50 })
    expect(layer.worldDraftRoot.scale.x).toBeCloseTo(10, 9)
    const [polyline, polygon, quad, ellipse, zoneGhost, ...extraWorld] = layer.worldDraftRoot.children as Graphics[]
    const zoneOutline = zoneGhost!.children[1] as Graphics
    expect(extraWorld).toEqual([])
    expect(tracedPoints(paintInstructions(polyline!, 'stroke')[1]!)).toEqual([{ x: 1, y: 2 }, { x: 3, y: 2 }])
    expect(tracedPoints(paintInstructions(polygon!, 'fill')[0]!)).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }])
    expect(tracedPoints(paintInstructions(quad!, 'fill')[0]!))
      .toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }])
    const ellipsePoints = tracedPoints(paintInstructions(ellipse!, 'fill')[0]!)
    expect(ellipsePoints.length).toBeGreaterThanOrEqual(48)
    // Turned 90°: radiusX runs along world y.
    for (const point of ellipsePoints) {
      expect(((point.x - 10) / 2) ** 2 + ((point.y - 10) / 3) ** 2).toBeCloseTo(1, 6)
    }
    expect(pathSteps(paintInstructions(zoneOutline, 'stroke')[0]!).find((step) => step.action === 'rect')?.data.slice(0, 4))
      .toEqual([0, 0, 2, 1])

    // Upright parts sit at the global point of their world anchor, in CSS px.
    const [marker, label, plantGhost, stampPlants, noteMarker, noteText, ...extraScreen] = layer.billboardDraftRoot.children
    expect(extraScreen).toEqual([])
    expect(global(marker!)).toEqual({ x: 120, y: 70 })
    expect(pathSteps(paintInstructions(marker as Graphics, 'stroke')[0]!).find((step) => step.action === 'circle')?.data.slice(0, 3))
      .toEqual([0, 0, 1.75])
    // A 40 × 16 text in a measure chip (2 × 5 padding, 1 px border) centred on the anchor plus its offset.
    expect(global(label!)).toEqual({ x: 130 - 26, y: 70 - 11 })
    expect(global((plantGhost as Container).children[0]!)).toEqual({ x: 140, y: 80 })
    expect(global((stampPlants as Container).children[0]!)).toEqual({ x: 160, y: 60 })
    expect(global(noteMarker!)).toEqual({ x: 110, y: 100 })
    expect(global(noteText!)).toEqual({ x: 110, y: 100 })
    expect((noteText as Text).text).toBe('Pond edge')
    expect(noteText!.rotation).toBeCloseTo(Math.PI / 6)
  })

  it('stroke widths and dashes stay in CSS px across a place at a new scale', () => {
    const layer = mountLayer()
    layer.setDraft({ shapes: [{
      kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      style: { token: 'draft', widthPx: 1.5, dash: [6, 5] },
    }] })

    for (const scale of [2, 8]) {
      layer.setView(at({ x: 0, y: 0 }, scale))
      const line = layer.worldDraftRoot.children[0] as Graphics
      const [casing, stroke] = paintInstructions(line, 'stroke')
      expect((stroke!.data.style as unknown as PaintStyle).width! * scale).toBeCloseTo(1.5)
      expect((casing!.data.style as unknown as PaintStyle).width! * scale).toBeCloseTo(3.5)
      // The casing follows the dash; the dash keeps its phase through the corner.
      expect(tracedPoints(casing!)).toEqual(tracedPoints(stroke!))
      const dashes = subPathLengths(stroke!).map((length) => length * scale)
      expect(dashes).toHaveLength(Math.ceil((20 * scale) / 11))
      for (const dash of dashes.slice(0, -1)) expect(dash).toBeCloseTo(6)
      expect(dashes.at(-1)!).toBeLessThanOrEqual(6 + 1e-9)
    }

    // A place that only moves re-positions and keeps the traced geometry.
    const line = layer.worldDraftRoot.children[0] as Graphics
    const instructions = [...line.context.instructions]
    layer.setView(at({ x: 30, y: 40 }, 8))
    expect(layer.worldDraftRoot.children[0]).toBe(line)
    expect(line.context.instructions).toEqual(instructions)
    expect(global(layer.worldDraftRoot)).toEqual({ x: 30, y: 40 })
  })

  it('a band, zone, line and polygon draft has a casing stroke of the same colour and width under it', () => {
    // Today's (a4c86d39) DOM previews: overlay-ui.ts drew the band in the selection stroke over the interaction casing and
    // the zone and measurement drafts in the guide line over the overlay casing; polygon-draft-overlay.ts drew the polygon's
    // draft line over the same dark casing, wider, along the same points. The shapes below carry the tools' styles
    // (tools/select/band.ts, and zone-drag.ts's DRAFT_STROKE and ZONE_DRAFT_FILL, which polygon.ts and measurement-guide.ts share).
    const draft = { token: 'draft', widthPx: 2 } as const
    const zoneFill = { token: 'draft-fill' } as const
    const cases: ReadonlyArray<{
      readonly name: string
      readonly shape: DraftShape
      readonly stroke: 'selection-stroke' | 'guide-line'
      readonly casing: 'interaction-casing' | 'overlay-casing'
    }> = [
      {
        name: 'band',
        shape: {
          kind: 'quad', corners: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }],
          style: { token: 'selection', widthPx: 2 }, fill: { token: 'selection-fill' },
        },
        stroke: 'selection-stroke',
        casing: 'interaction-casing',
      },
      {
        name: 'rectangle',
        shape: { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }], style: draft, fill: zoneFill },
        stroke: 'guide-line',
        casing: 'overlay-casing',
      },
      {
        name: 'ellipse',
        shape: { kind: 'ellipse', center: { x: 5, y: 5 }, radiusX: 3, radiusY: 2, rotationDeg: 0, style: draft, fill: zoneFill },
        stroke: 'guide-line',
        casing: 'overlay-casing',
      },
      {
        name: 'line and measurement guide',
        shape: { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 6, y: 0 }], style: draft },
        stroke: 'guide-line',
        casing: 'overlay-casing',
      },
      {
        name: 'polygon draft line',
        shape: { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }], style: draft },
        stroke: 'guide-line',
        casing: 'overlay-casing',
      },
    ]
    const scale = 4

    for (const { name, shape, stroke, casing } of cases) {
      const layer = mountLayer()
      layer.setDraft({ shapes: [shape] })
      layer.setView(at({ x: 0, y: 0 }, scale))
      const [casingPaint, strokePaint, ...more] = paintInstructions(layer.worldDraftRoot.children[0] as Graphics, 'stroke')
      expect(more, name).toEqual([])
      const casingStyle = casingPaint!.data.style as unknown as PaintStyle
      const strokeStyle = strokePaint!.data.style as unknown as PaintStyle
      // The casing first, in the dark contrast colour, then the light stroke; both in CSS px at any scale.
      expect(casingStyle.color, name).toBe(pixiColor(getCanvasColor(casing)))
      expect(strokeStyle.color, name).toBe(pixiColor(getCanvasColor(stroke)))
      expect(strokeStyle.width! * scale, name).toBeCloseTo(2)
      expect(casingStyle.width! * scale, name).toBeCloseTo(2 + OVERLAY_CASING_EXTRA_PX)
      // Along the same points.
      expect(tracedPoints(casingPaint!).length, name).toBeGreaterThan(1)
      expect(tracedPoints(casingPaint!), name).toEqual(tracedPoints(strokePaint!))
    }
  })

  it('a plant ghost and an objects ghost draw at the shape\'s opacity', () => {
    const layer = mountLayer()
    layer.setDraft({ shapes: [
      { kind: 'ghost', entity: { kind: 'plant', plant: createPlant(), mark: 'symbol' }, opacity: 0.85 },
      objectsGhost(0.62),
    ] })
    layer.setView(at({ x: 0, y: 0 }, 14))

    // A symbol composites once, as today's SVG group opacity does.
    const [plantGhost, stampPlants, noteMarker, noteText] = layer.billboardDraftRoot.children
    expect(plantGhost!.filters).toEqual([expect.any(AlphaFilter)])
    expect((plantGhost!.filters as AlphaFilter[])[0]!.alpha).toBe(0.85)
    expect((plantGhost as Container).children[0]!.alpha).toBe(1)
    expect((stampPlants!.filters as AlphaFilter[])[0]!.alpha).toBe(0.62)

    // The zones: the fill at the ghost's opacity over the zone's own, the outline the placed zone's cream stroke over its
    // dark casing at full opacity, so it previews what lands and reads on paper and imagery (Q10).
    const zoneGhost = layer.worldDraftRoot.children[0] as Container
    const [zoneFill, zoneOutline, ...moreZoneParts] = zoneGhost.children as Graphics[]
    expect(moreZoneParts).toEqual([])
    expect(zoneGhost.alpha).toBe(1)
    expect(zoneFill!.alpha).toBe(0.62)
    const fillColour = getCanvasColor('zone-fill')
    expect(paints(zoneFill!, 'fill')).toEqual([expect.objectContaining({ color: pixiColor(fillColour), alpha: 0.2 * cssAlpha(fillColour) })])
    expect(paints(zoneFill!, 'stroke')).toEqual([])
    expect(zoneOutline!.alpha).toBe(1)
    expect(paints(zoneOutline!, 'fill')).toEqual([])
    // The outline is the placed zone's at this scale (traced at the band's centre), casing then stroke, so the ghost and
    // the result match.
    const world = createWorldLayers()
    world.present(at({ x: 0, y: 0 }, 14), createTestSceneRendererSnapshot({ scene: { zones: [createZone()] } }))
    const placed = paints(world.root.children[1]!.children[0] as Graphics, 'stroke')
    expect(paints(zoneOutline!, 'stroke')).toEqual(placed)
    expect(placed.map((paint) => [paint.color, paint.alpha])).toEqual([
      [pixiColor(getCanvasColor('overlay-casing')), cssAlpha(getCanvasColor('overlay-casing'))],
      [pixiColor(getCanvasColor('zone-stroke')), cssAlpha(getCanvasColor('zone-stroke'))],
    ])

    const { textOpacity, markerOpacity } = getAnnotationPresentation(createNote(), 14)
    expect(textOpacity).toBeGreaterThan(0)
    expect(markerOpacity).toBeGreaterThan(0)
    expect(noteText!.alpha).toBeCloseTo(0.62 * textOpacity)
    expect(noteMarker!.alpha).toBeCloseTo(0.62 * markerOpacity)
  })

  it('a line zone\'s ghost is its outline only, at full opacity', () => {
    const layer = mountLayer()
    const line: SceneZoneEntity = { ...createZone(), id: 'hedge', zoneType: 'line', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }] }
    const template = { plants: [], zones: [{ sourceId: 'hedge', entity: line }], annotations: [], measurementGuides: [], groups: [] }
    layer.setDraft({ shapes: [{ kind: 'ghost', entity: { kind: 'objects', template }, opacity: 0.62 }] })
    layer.setView(at({ x: 0, y: 0 }, 14))

    const zoneGhost = layer.worldDraftRoot.children[0] as Container
    const [outline, ...more] = zoneGhost.children as Graphics[]
    expect(more).toEqual([])
    expect(outline!.alpha).toBe(1)
    expect(paints(outline!, 'fill')).toEqual([])
    expect(paints(outline!, 'stroke').map((paint) => paint.color))
      .toEqual([pixiColor(getCanvasColor('overlay-casing')), pixiColor(getCanvasColor('zone-stroke'))])
  })

  it('an objects ghost\'s note draws as its marker at an overview scale and as its turned text closer in', () => {
    const layer = mountLayer()
    layer.setDraft({ shapes: [objectsGhost(1)] })

    // Far out the scene shows a note as its marker only, as today's drop ghost did.
    layer.setView(at({ x: 0, y: 0 }, 0.5))
    expect(getAnnotationPresentation(createNote(), 0.5).textOpacity).toBe(0)
    const [, marker, ...noTextFar] = layer.billboardDraftRoot.children
    expect(marker).toBeInstanceOf(Graphics)
    expect(marker!.alpha).toBeCloseTo(1)
    expect(noTextFar).toEqual([])

    // Closer in it is the note's text, turned by its rotation, and no marker.
    layer.setView(at({ x: 0, y: 0 }, 40))
    expect(getAnnotationPresentation(createNote(), 40).textOpacity).toBe(1)
    const [, text, ...noMarkerNear] = layer.billboardDraftRoot.children
    expect(text).toBeInstanceOf(Text)
    expect((text as Text).text).toBe('Pond edge')
    expect(text!.rotation).toBeCloseTo(Math.PI / 6)
    expect(noMarkerNear).toEqual([])
  })

  it('a dot-mark plant ghost draws a disc in the plant\'s display colour', () => {
    const snapshot = createTestSceneRendererSnapshot()
    const layer = mountLayer(snapshot)
    const plant = createPlant({ color: '#AA3311' })
    layer.setDraft({ shapes: [{ kind: 'ghost', entity: { kind: 'plant', plant, mark: 'dot' }, opacity: 0.35 }] })
    layer.setView(at({ x: 10, y: 20 }, 30))

    const [dot, ...rest] = layer.billboardDraftRoot.children
    expect(rest).toEqual([])
    expect(dot).toBeInstanceOf(Graphics)
    expect(global(dot!)).toEqual({ x: 130, y: 110 })
    // One flat disc, so the shape's opacity needs no composite.
    expect(dot!.alpha).toBe(0.35)
    expect(dot!.filters ?? []).toEqual([])
    const entry = buildPlantPresentationEntries([plant], {
      plants: snapshot.scene.plants, pixelsPerMetre: 30, speciesCache: snapshot.speciesCache,
    }, new Set())[0]!
    const fills = paintInstructions(dot as Graphics, 'fill')
    expect(fills).toHaveLength(1)
    expect(fills[0]!.data.style).toMatchObject({ color: pixiColor(resolvePlantDisplayColor(plant, snapshot.speciesCache)), alpha: 1 })
    expect(pathSteps(fills[0]!).find((step) => step.action === 'circle')?.data.slice(0, 3)).toEqual([0, 0, entry.radiusScreenPx])
    expect(paints(dot as Graphics, 'stroke')).toEqual([])
  })

  it('a dot ghost with sizeFrom takes the radius at that point', () => {
    // Plant a row: the source sits close to a neighbour, so its presented radius is smaller than at an open row position.
    const source = createPlant({ id: 'source', position: { x: 0, y: 0 } })
    const neighbour = createPlant({ id: 'neighbour', position: { x: 0.2, y: 0 } })
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [source, neighbour] } })
    const layer = mountLayer(snapshot)
    const ghost = { ...source, id: 'row-ghost', position: { x: 10, y: 0 } }
    layer.setDraft({ shapes: [{ kind: 'ghost', entity: { kind: 'plant', plant: ghost, mark: 'dot', sizeFrom: source.position }, opacity: 0.35 }] })
    layer.setView(at({ x: 10, y: 20 }, 30))

    const radiusAt = (plant: ScenePlantEntity) => buildPlantPresentationEntries([plant], {
      plants: snapshot.scene.plants, pixelsPerMetre: 30, speciesCache: snapshot.speciesCache,
    }, new Set())[0]!.radiusScreenPx
    expect(radiusAt(source)).toBeLessThan(radiusAt(ghost))

    const [dot, ...rest] = layer.billboardDraftRoot.children
    expect(rest).toEqual([])
    // The disc stays at the ghost; only its size comes from sizeFrom.
    expect(global(dot!)).toEqual({ x: 310, y: 20 })
    const fills = paintInstructions(dot as Graphics, 'fill')
    expect(fills).toHaveLength(1)
    expect(pathSteps(fills[0]!).find((step) => step.action === 'circle')?.data.slice(0, 3)).toEqual([0, 0, radiusAt(source)])
  })

  it('a dot ghost is never smaller than its 2 px border', () => {
    // Today's disc is a border-box div with a 2 px border (today's (a4c86d39) plant-spacing-overlay.ts), which CSS never draws under
    // 4 px across.
    const source = createPlant({ id: 'source', position: { x: 0, y: 0 } })
    const neighbour = createPlant({ id: 'neighbour', position: { x: 0.1, y: 0 } })
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [source, neighbour] } })
    const layer = mountLayer(snapshot)
    const ghost = { ...source, id: 'row-ghost', position: { x: 10, y: 0 } }
    layer.setDraft({ shapes: [{ kind: 'ghost', entity: { kind: 'plant', plant: ghost, mark: 'dot', sizeFrom: source.position }, opacity: 0.35 }] })
    layer.setView(at({ x: 10, y: 20 }, 30))

    const presented = buildPlantPresentationEntries([source], {
      plants: snapshot.scene.plants, pixelsPerMetre: 30, speciesCache: snapshot.speciesCache,
    }, new Set())[0]!.radiusScreenPx
    expect(presented).toBeLessThan(2)

    const [dot, ...rest] = layer.billboardDraftRoot.children
    expect(rest).toEqual([])
    const fills = paintInstructions(dot as Graphics, 'fill')
    expect(fills).toHaveLength(1)
    expect(pathSteps(fills[0]!).find((step) => step.action === 'circle')?.data.slice(0, 3)).toEqual([0, 0, 2])
  })

  it('a chip whose font has not loaded asks the browser for it once per font, then redraws the draft and asks for a frame', async () => {
    // Canvas text drawn while its web font loads keeps the fallback and is never redrawn by itself.
    const face = { status: 'unloaded' as FontFaceLoadStatus }
    let finishLoad!: () => void
    const load = vi.fn(() => new Promise<FontFace[]>((resolve) => {
      finishLoad = () => {
        face.status = 'loaded'
        resolve([face as FontFace])
      }
    }))
    const fonts = { load, forEach: (callback: (each: FontFace) => void) => callback(face as FontFace) }
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
    try {
      const requestRepaint = vi.fn()
      const stage = new Container()
      const layer = createDraftLayer({
        createText: () => new MeasuredText(),
        viewSize: { width: 400, height: 300 },
        painters: createDraftScenePainters(() => createTestSceneRendererSnapshot()),
        requestRepaint,
      })
      stage.addChild(layer.worldDraftRoot, layer.billboardDraftRoot)
      layers.push(layer)
      layer.setView(at({ x: 0, y: 0 }, 1))
      const chip = (text: string, tone: 'measure' | 'measure-quiet') => ({ kind: 'label', anchor: { x: 0, y: 0 }, offsetPx: { x: 0, y: 0 }, text, tone }) as const
      layer.setDraft({ shapes: [chip('112 m²', 'measure'), chip('14 m', 'measure-quiet'), chip('8 m', 'measure-quiet')] })
      layer.setDraft({ shapes: [chip('113 m²', 'measure')] })

      const size = getDraftLabelVisual('measure').fontSizePx
      expect(load.mock.calls).toEqual([
        [`600 ${size}px ${CANVAS_CHROME_FONT_FAMILY}`],
        [`400 ${size}px ${CANVAS_CHROME_FONT_FAMILY}`],
      ])
      const before = layer.billboardDraftRoot.children[0]
      finishLoad()
      await Promise.resolve()
      await Promise.resolve()
      expect(requestRepaint).toHaveBeenCalledOnce()
      expect(layer.billboardDraftRoot.children, 'the live draft is drawn again').toHaveLength(1)
      expect(layer.billboardDraftRoot.children[0]).not.toBe(before)

      const loaded = mountLayer()
      loaded.setView(at({ x: 0, y: 0 }, 1))
      loaded.setDraft({ shapes: [chip('4 m', 'measure')] })
      expect(load, 'a loaded font is not asked for').toHaveBeenCalledTimes(2)
    } finally {
      Reflect.deleteProperty(document, 'fonts')
    }
  })

  it('a chip font WebKit reports as failed while it loads under font-display: swap is still asked for and redrawn once', async () => {
    // WebKit reports a face still loading under font-display: swap as 'error', so fonts.check() is true: only load() waits.
    const face = { status: 'error' as FontFaceLoadStatus }
    let finishLoad!: () => void
    const load = vi.fn(() => new Promise<FontFace[]>((resolve) => {
      finishLoad = () => {
        face.status = 'loaded'
        resolve([face as FontFace])
      }
    }))
    const fonts = { check: vi.fn(() => true), load, forEach: (callback: (each: FontFace) => void) => callback(face as FontFace) }
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
    try {
      const requestRepaint = vi.fn()
      const layer = createDraftLayer({
        createText: () => new MeasuredText(),
        viewSize: { width: 400, height: 300 },
        painters: createDraftScenePainters(() => createTestSceneRendererSnapshot()),
        requestRepaint,
      })
      layers.push(layer)
      layer.setView(at({ x: 0, y: 0 }, 1))
      layer.setDraft({ shapes: [{ kind: 'label', anchor: { x: 0, y: 0 }, offsetPx: { x: 0, y: 0 }, text: '112 m²', tone: 'measure' }] })

      expect(load).toHaveBeenCalledOnce()
      const before = layer.billboardDraftRoot.children[0]
      finishLoad()
      await Promise.resolve()
      await Promise.resolve()
      expect(requestRepaint).toHaveBeenCalledOnce()
      expect(layer.billboardDraftRoot.children[0], 'the live draft is drawn again').not.toBe(before)
    } finally {
      Reflect.deleteProperty(document, 'fonts')
    }
  })

  it('each label tone draws its chip style', () => {
    const cases = [
      { tone: 'measure', font: CANVAS_CHROME_FONT_FAMILY, weight: '600', lineHeight: 15, text: 'chip-text', background: 'chip-surface-muted', placement: 'centre', padding: { x: 5, y: 2 } },
      { tone: 'measure-quiet', font: CANVAS_CHROME_FONT_FAMILY, weight: '400', lineHeight: 15, text: 'chip-text', background: 'chip-surface-muted', placement: 'centre', padding: { x: 5, y: 2 } },
      { tone: 'hint', font: CANVAS_CHROME_FONT_FAMILY, weight: '600', lineHeight: 20, text: 'chip-text', background: 'chip-surface', placement: 'above', padding: { x: 6, y: 2 } },
      { tone: 'hint-primary', font: CANVAS_CHROME_FONT_FAMILY, weight: '600', lineHeight: 20, text: 'chip-primary', background: 'chip-surface', placement: 'above', padding: { x: 8, y: 4 } },
    ] as const
    for (const expected of cases) {
      const layer = mountLayer()
      layer.setDraft({ shapes: [{ kind: 'label', anchor: { x: 0, y: 0 }, offsetPx: { x: 0, y: 0 }, text: '4.2 m', tone: expected.tone }] })
      layer.setView(at({ x: 200, y: 100 }, 1))

      const chip = layer.billboardDraftRoot.children[0] as Container
      const [box, text] = chip.children as [Graphics, Text]
      expect(text.text, expected.tone).toBe('4.2 m')
      expect(text.style.fontFamily, expected.tone).toBe(expected.font)
      expect(text.style.fontWeight, expected.tone).toBe(expected.weight)
      expect(text.style.fontSize, expected.tone).toBe(12.5)
      // Measurements set line-height 1.2; hints inherit the map container's 20 px.
      expect(text.style.lineHeight, expected.tone).toBeCloseTo(expected.lineHeight)
      expect(text.style.fill, expected.tone).toMatchObject({ color: pixiColor(getCanvasColor(expected.text)) })

      // The 1 px border box around the padded text, centred on the point or bottom-centre 4 px above it.
      const width = 40 + 2 * expected.padding.x + 2
      const height = 16 + 2 * expected.padding.y + 2
      expect(global(text), expected.tone).toEqual({ x: global(chip).x + 1 + expected.padding.x, y: global(chip).y + 1 + expected.padding.y })
      expect(global(chip), expected.tone).toEqual(expected.placement === 'centre'
        ? { x: 200 - width / 2, y: Math.round(100 - height / 2) }
        : { x: 200 - width / 2, y: 100 - 4 - height })

      // --shadow-sm under the chip, then the background, then the border.
      const background = getCanvasColor(expected.background)
      const fills = paints(box, 'fill')
      expect(fills.at(-1), expected.tone).toMatchObject({ color: pixiColor(background), alpha: cssAlpha(background) })
      const shadow = getDraftLabelVisual(expected.tone).shadow!
      const rings = paintInstructions(box, 'fill').slice(0, -1).map((fill) => ({
        style: fill.data.style as unknown as PaintStyle,
        outer: pathSteps(fill).find((step) => step.action === 'roundRect')!.data as [number, number, number, number, number],
        hole: holeSteps(fill),
      }))
      expect(rings.length, expected.tone).toBeGreaterThan(0)
      for (const ring of rings) {
        expect(ring.style, expected.tone).toMatchObject({ color: pixiColor(shadow.color) })
        // A CSS outer shadow is clipped to outside the border box: each step is a ring with the chip cut out.
        expect(ring.hole.map(({ action, data }) => [action, ...data.slice(0, 5)]), expected.tone)
          .toEqual([['roundRect', 0, 0, width, height, 5]])
        const [x, y, ringWidth, ringHeight] = ring.outer
        expect(x < 0 && y < 0 && x + ringWidth > width && y + ringHeight > height, expected.tone).toBe(true)
      }
      // The shadow falls 2 px down: darker just under the chip than just over it, and no step darker than the shadow.
      const alphaAt = (pointY: number) => rings
        .filter(({ outer: [, y, , ringHeight] }) => pointY > y && pointY < y + ringHeight)
        .reduce((sum, ring) => sum + ring.style.alpha, 0)
      expect(alphaAt(-1), expected.tone).toBeGreaterThan(0)
      expect(alphaAt(height + 1), expected.tone).toBeGreaterThan(alphaAt(-1))
      expect(alphaAt(height + 1), expected.tone).toBeLessThanOrEqual(cssAlpha(shadow.color) + 1e-9)
      const border = getCanvasColor('chip-border')
      expect(paints(box, 'stroke'), expected.tone).toEqual([expect.objectContaining({ color: pixiColor(border), alpha: cssAlpha(border), width: 1 })])
    }

    // --text-xs: 13 px under zh, ja and ko (global.css keeps CJK text at 13 px or more), 12.5 px in every other language.
    for (const [lang, size] of [['zh', 13], ['ja', 13], ['ko', 13], ['fr', 12.5]] as const) {
      document.documentElement.lang = lang
      const layer = mountLayer()
      layer.setDraft({
        shapes: (['measure', 'hint'] as const).map((tone) => ({ kind: 'label', anchor: { x: 0, y: 0 }, offsetPx: { x: 0, y: 0 }, text: '4.2 m', tone })),
      })
      layer.setView(at({ x: 200, y: 100 }, 1))
      const [measure, hint] = layer.billboardDraftRoot.children.map((chip) => (chip as Container).children[1] as Text)
      expect([measure!.style.fontSize, hint!.style.fontSize], lang).toEqual([size, size])
      expect(measure!.style.lineHeight, lang).toBeCloseTo(size * 1.2)
      expect(hint!.style.lineHeight, lang).toBe(20)
    }
  })

  it('a chip beside a point moves along its normal until its nearest side is the gap past the point, whatever its size (U38)', () => {
    const layer = mountLayer()
    const beside = (normalPx: { x: number; y: number }): DraftShape => ({
      kind: 'label', anchor: { x: 3, y: 1 }, offsetPx: { x: 0, y: 0 }, text: '12 m', tone: 'measure-quiet', beside: { normalPx, gapPx: 6 },
    })
    layer.setDraft({ shapes: [beside({ x: 0, y: -1 }), beside({ x: 1, y: 0 }), beside({ x: 0.6, y: 0.8 })] })
    layer.setView(at({ x: 100, y: 50 }, 10))

    // The 52 × 22 chip (a 40 × 16 text, 2 × 5 padding, 1 px border) about the anchor's point (130, 60): above it, its
    // bottom 6 px over the point; right of it, its left side 6 px past; along (0.6, 0.8), its nearest corner 6 px along.
    const [above, right, diagonal] = layer.billboardDraftRoot.children
    expect(global(above!)).toEqual({ x: 130 - 26, y: 60 - 6 - 22 })
    expect(global(right!)).toEqual({ x: 130 + 6, y: 60 - 11 })
    // Chips snap to whole pixels.
    const reach = 0.6 * 26 + 0.8 * 11 + 6
    expect(global(diagonal!)).toEqual({ x: Math.round(130 + 0.6 * reach - 26), y: Math.round(60 + 0.8 * reach - 11) })

    // A pan carries the chip with its point.
    layer.setView(at({ x: 0, y: 0 }, 10))
    expect(global(layer.billboardDraftRoot.children[0]!)).toEqual({ x: 30 - 26, y: 10 - 6 - 22 })
  })

  it('clearing the draft removes its display objects', () => {
    const destroyFilter = vi.spyOn(AlphaFilter.prototype, 'destroy')
    const layer = mountLayer()
    layer.setDraft(everyShape())
    layer.setView(at({ x: 100, y: 50 }, 10))
    const drawn = [...layer.worldDraftRoot.children, ...layer.billboardDraftRoot.children]
    expect(drawn.length).toBeGreaterThan(0)

    layer.setDraft(null)
    expect(layer.worldDraftRoot.children).toEqual([])
    expect(layer.billboardDraftRoot.children).toEqual([])
    for (const node of drawn) expect(node.destroyed).toBe(true)
    // The two composites (the plant ghost and the stamp's plants) release their filters.
    expect(destroyFilter).toHaveBeenCalledTimes(2)

    // A later place draws nothing until the next draft.
    layer.setView(at({ x: 0, y: 0 }, 4))
    expect(layer.worldDraftRoot.children).toEqual([])
    expect(layer.billboardDraftRoot.children).toEqual([])
  })

  it('draws a draft set before the first place at that place', () => {
    const layer = mountLayer()
    layer.setDraft({ shapes: [{ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], style: { token: 'selection', widthPx: 2 } }] })
    expect(layer.worldDraftRoot.children).toEqual([])
    layer.setView(at({ x: 5, y: 5 }, 4))
    const [casing, stroke] = paints(layer.worldDraftRoot.children[0] as Graphics, 'stroke')
    expect(stroke).toMatchObject({ color: pixiColor(getCanvasColor('selection-stroke')), width: 0.5, cap: 'round', join: 'round' })
    expect(casing).toMatchObject({ color: pixiColor(getCanvasColor('interaction-casing')), width: 1 })
  })

  it('repositions upright parts on a move and redraws them on a zoom', () => {
    const layer = mountLayer()
    layer.setDraft({ shapes: [
      { kind: 'circle-px', center: { x: 1, y: 1 }, radiusPx: 4, style: { token: 'draft', widthPx: 1, dash: [2, 2] } },
      { kind: 'ghost', entity: { kind: 'plant', plant: createPlant({ position: { x: 2, y: 2 } }), mark: 'symbol' }, opacity: 0.5 },
    ] })
    layer.setView(at({ x: 0, y: 0 }, 10))
    const [marker, plantGhost] = layer.billboardDraftRoot.children
    const plant = (plantGhost as Container).children[0]!
    layer.setView(at({ x: 7, y: 9 }, 10))
    expect(layer.billboardDraftRoot.children[0]).toBe(marker)
    expect(global(marker!)).toEqual({ x: 17, y: 19 })
    expect(global(plant)).toEqual({ x: 27, y: 29 })

    // Pixel-sized dashes do not depend on the scale.
    const dashes = subPathLengths(paintInstructions(marker as Graphics, 'stroke')[1]!)
    for (const dash of dashes.slice(0, -1)) expect(dash).toBeCloseTo(2, 1)

    layer.setView(at({ x: 7, y: 9 }, 20))
    expect(layer.billboardDraftRoot.children[0]).not.toBe(marker)
    expect(marker!.destroyed).toBe(true)
    expect(global(layer.billboardDraftRoot.children[0]!)).toEqual({ x: 27, y: 29 })
  })

  it('draws a fill-only polygon, nothing for a one-point polyline, and a dashed quad', () => {
    const layer = mountLayer()
    layer.setDraft({ shapes: [
      { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], style: { token: 'draft', widthPx: 0 }, fill: { token: 'draft-fill' } },
      { kind: 'polyline', points: [{ x: 0, y: 0 }], style: { token: 'draft', widthPx: 2 } },
      { kind: 'quad', corners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], style: { token: 'draft', widthPx: 1, dash: [3, 3] }, fill: { token: 'draft-fill' } },
    ] })
    layer.setView(at({ x: 0, y: 0 }, 1))
    const [fillOnly, single, dashedQuad] = layer.worldDraftRoot.children as Graphics[]
    expect(paints(fillOnly!, 'stroke')).toEqual([])
    expect(paints(fillOnly!, 'fill')).toHaveLength(1)
    expect(single!.context.instructions).toEqual([])
    // [3, 3] is 3 on, 3 off around the closed quad, with butt ends and mitred corners.
    const quadStroke = paintInstructions(dashedQuad!, 'stroke')[1]!
    expect(subPathLengths(quadStroke)).toEqual([3])
    expect(quadStroke.data.style).toMatchObject({ cap: 'butt', join: 'miter' })
    expect(paints(dashedQuad!, 'fill')[0]).toMatchObject({ color: pixiColor(getCanvasColor('zone-fill')) })
  })

  it('draws no plant ghost before the scene has a snapshot, and keeps a ghost filter the size of the view', () => {
    const blind = mountLayer(null)
    blind.setDraft({ shapes: [{ kind: 'ghost', entity: { kind: 'plant', plant: createPlant(), mark: 'symbol' }, opacity: 0.5 }] })
    blind.setView(at({ x: 0, y: 0 }, 10))
    expect(blind.billboardDraftRoot.children).toEqual([])

    const layer = mountLayer()
    layer.setDraft({ shapes: [{ kind: 'ghost', entity: { kind: 'plant', plant: createPlant(), mark: 'symbol' }, opacity: 0.5 }] })
    layer.setView(at({ x: 0, y: 0 }, 10))
    const ghost = layer.billboardDraftRoot.children[0]!
    expect(ghost.filterArea).toMatchObject({ x: 0, y: 0, width: 400, height: 300 })
    layer.resize(640, 480)
    expect(ghost.filterArea).toMatchObject({ width: 640, height: 480 })
  })

  it('leaves out the parts of an objects ghost the scene cannot draw', () => {
    const layer = mountLayer()
    const template = {
      plants: [],
      zones: [{ sourceId: 'stub', entity: { ...createZone(), zoneType: 'polygon', points: [{ x: 0, y: 0 }] } }],
      annotations: [{ sourceId: 'arrow', entity: { ...createNote(), annotationType: 'arrow' } }],
      measurementGuides: [],
      groups: [],
    }
    layer.setDraft({ shapes: [{ kind: 'ghost', entity: { kind: 'objects', template }, opacity: 0.62 }] })
    layer.setView(at({ x: 0, y: 0 }, 20))
    expect(layer.worldDraftRoot.children).toEqual([])
    expect(layer.billboardDraftRoot.children).toEqual([])
  })

  it('dispose releases the draft but leaves the containers to the stage', () => {
    const layer = mountLayer()
    layer.setDraft(everyShape())
    layer.setView(at({ x: 0, y: 0 }, 10))
    layer.dispose()
    expect(layer.worldDraftRoot.children).toEqual([])
    expect(layer.billboardDraftRoot.children).toEqual([])
    expect(layer.worldDraftRoot.destroyed).toBe(false)
    expect(layer.billboardDraftRoot.destroyed).toBe(false)
  })

  it('the world drafts share the world root\'s affine and both draft roots sit above the billboards', () => {
    const stage = new Container()
    const presentation = createPixiScenePresentation({ stage, createText: () => new MeasuredText(), viewSize: { width: 400, height: 300 } })
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [createPlant()] } })
    presentation.setDraft({ shapes: [
      { kind: 'polyline', points: [{ x: 1, y: 2 }, { x: 3, y: 2 }], style: { token: 'draft', widthPx: 2 } },
      { kind: 'circle-px', center: { x: 2, y: 2 }, radiusPx: 1.75, style: { token: 'draft', widthPx: 3.5 } },
    ] })
    // The stage's order (spec §1.5): world root, billboard root, then the world and billboard draft roots on top.
    const [worldRoot, billboardRoot, worldDraftRoot, billboardDraftRoot, ...more] = stage.children
    expect(more).toEqual([])
    for (const bearingDeg of [0, 45]) {
      const view = createTestRendererView({ x: 100, y: 50, scale: 10 }, { bearingDeg })
      presentation.present(view, snapshot)
      for (const root of [worldRoot!, worldDraftRoot!]) {
        root.updateLocalTransform()
        const { a, b, c, d, tx, ty } = root.localTransform
        for (const [index, value] of [a, b, c, d, tx, ty].entries()) expect(value).toBeCloseTo(view.planar.affine[index]!, 9)
      }
      expect(billboardRoot!.children.length).toBeGreaterThan(0)
      expect(worldDraftRoot!.children).toHaveLength(1)
      const [marker] = billboardDraftRoot!.children
      const centre = view.worldToScreen({ x: 2, y: 2 })
      expect(marker!.position.x).toBeCloseTo(centre.x, 3)
      expect(marker!.position.y).toBeCloseTo(centre.y, 3)
    }
    presentation.dispose()
  })
})
