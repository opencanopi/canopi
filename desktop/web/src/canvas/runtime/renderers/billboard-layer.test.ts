// @vitest-environment jsdom

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import type { Container} from 'pixi.js';
import { Graphics, GraphicsContext, Text } from 'pixi.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTestRendererView, createTestSceneRendererSnapshot } from '../../../__tests__/support/scene-renderer-snapshot'
import { refreshCanvasColorCache } from '../../theme-refresh'
import { getAnnotationPresentation } from '../annotation-layout'
import { getCanvasDetailLayout } from '../automatic-detail'
import { buildPlantPresentationEntries } from '../plant-presentation'
import { ROUND_PLANT_SYMBOL_RADIUS } from '../plant-symbol-recipes'
import type { SceneAnnotationEntity, ScenePlantEntity, ScenePoint } from '../scene'
import { setCanvasMapBackdrop } from '../scene-visuals'
import { createBillboardLayer } from './billboard-layer'

// A pass-through spy: the layer's detail-layout passes stay real and countable.
vi.mock('../automatic-detail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../automatic-detail')>()
  return { ...actual, getCanvasDetailLayout: vi.fn(actual.getCanvasDetailLayout) }
})

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__CANOPI_PIXI_SCENE_WORK__
  setCanvasMapBackdrop('basemap')
})

function createPlant(overrides: Partial<ScenePlantEntity> = {}): ScenePlantEntity {
  return {
    kind: 'plant', locked: false, id: 'plant', canonicalName: 'Malus domestica', commonName: 'Apple',
    color: null, canopySpreadM: null, position: { x: 4, y: 3 }, rotationDeg: null,
    notes: null, plantedDate: null, quantity: 1, ...overrides,
  }
}

/** Every node under `root`, depth first. */
function nodes(root: Container): Container[] {
  return root.children.flatMap((child) => [child, ...nodes(child)])
}

/** The shown Graphics under `root` that draw something. */
function shownGraphics(root: Container): Graphics[] {
  return nodes(root).filter((node): node is Graphics => node instanceof Graphics && node.visible
    && node.context.instructions.length > 0)
}

const NOTE: SceneAnnotationEntity = { kind: 'annotation', id: 'note', annotationType: 'text', locked: false,
  position: { x: 5, y: 5 }, text: 'Pond edge', fontSize: 16, rotationDeg: 30 }

/** A ringed plant, a stacked pair (a badge) and a note, all selected: rings, a badge, a note marker and its outline. */
function retainedScene() {
  return createTestSceneRendererSnapshot({
    scene: {
      plants: [
        createPlant({ id: 'apple', position: { x: 4, y: 3 } }),
        createPlant({ id: 'pear-a', canonicalName: 'Pyrus communis', commonName: 'Pear', position: { x: 8, y: 2 } }),
        createPlant({ id: 'pear-b', canonicalName: 'Pyrus communis', commonName: 'Pear', position: { x: 8, y: 2 } }),
      ],
      annotations: [NOTE],
    },
    selectedTargets: [{ kind: 'plant', id: 'apple' }, { kind: 'annotation', id: 'note' }],
  })
}

/** Records the dev work names the layer emits. */
function recordWork(): string[] {
  const names: string[] = []
  window.__CANOPI_PIXI_SCENE_WORK__ = (name) => { names.push(name) }
  return names
}

/** Spies on every GraphicsContext call that traces or paints geometry. */
function spyOnDrawing() {
  return (['clear', 'circle', 'roundRect', 'rect', 'moveTo', 'lineTo', 'bezierCurveTo', 'fill', 'stroke'] as const)
    .map((method) => vi.spyOn(GraphicsContext.prototype, method))
}

/** The stroke colours a context holds, in drawing order. */
function strokeColours(context: GraphicsContext): number[] {
  return context.instructions
    .filter((instruction) => instruction.action === 'stroke')
    .map((instruction) => (instruction.data as { style: { color: number } }).style.color)
}

/** The radius of the first circle a context fills. */
function filledCircleRadius(context: GraphicsContext): number {
  const fill = context.instructions.find((instruction) => instruction.action === 'fill')!
  const steps = (fill.data as unknown as { path: { instructions: Array<{ action: string; data: number[] }> } }).path.instructions
  return steps.find((step) => step.action === 'circle')!.data[2]!
}

/** The points of a context's first stroked path, in its own coordinates. */
function strokedPoints(context: GraphicsContext): ScenePoint[] {
  const stroke = context.instructions.find((instruction) => instruction.action === 'stroke')!
  const steps = (stroke.data as unknown as { path: { instructions: Array<{ action: string; data: number[] }> } }).path.instructions
  return steps.filter((step) => step.action === 'moveTo' || step.action === 'lineTo')
    .map((step) => ({ x: step.data[0]!, y: step.data[1]! }))
}

describe('billboard layer', () => {
  it('billboards stay upright at bearings 0, 30, 45, 60 and 200', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const plants = [
      createPlant({ id: 'apple', position: { x: 4, y: 3 }, pinnedName: true }),
      createPlant({ id: 'pear', canonicalName: 'Pyrus communis', commonName: 'Pear', position: { x: 6, y: 2 } }),
    ]
    const snapshot = createTestSceneRendererSnapshot({
      scene: {
        plants,
        annotations: [{ kind: 'annotation', id: 'note', annotationType: 'text', locked: false,
          position: { x: 5, y: 5 }, text: 'Pond edge', fontSize: 16, rotationDeg: 30 }],
      },
      selectedTargets: [{ kind: 'plant', id: 'pear' }],
    })

    for (const bearingDeg of [0, 30, 45, 60, 200]) {
      const view = createTestRendererView({ x: 200, y: 150, scale: 20 }, { bearingDeg })
      layer.present(view, bearingDeg === 0 ? snapshot : undefined)
      // The root carries no transform: billboards are CSS px, placed one by one.
      layer.root.updateLocalTransform()
      expect(layer.root.localTransform.a).toBe(1)
      expect(layer.root.localTransform.b).toBe(0)

      const symbols = nodes(layer.root).filter((node) => node instanceof Graphics && node.zIndex >= 0 && node.parent?.sortableChildren)
      expect(symbols).toHaveLength(2)
      for (const [index, plant] of plants.entries()) {
        const at = view.worldToScreen(plant.position)
        expect(symbols[index]!.position.x, `bearing ${bearingDeg}`).toBeCloseTo(at.x, 3)
        expect(symbols[index]!.position.y, `bearing ${bearingDeg}`).toBeCloseTo(at.y, 3)
        expect(symbols[index]!.rotation).toBe(0)
      }

      // The pinned name and the selection's name hang below their plants on screen, whatever the bearing.
      const texts = nodes(layer.root).filter((node): node is Text => node instanceof Text)
      for (const [name, plant] of [['Apple', plants[0]!], ['Pear', plants[1]!]] as const) {
        const label = texts.find((text) => text.text === name)!
        const at = view.worldToScreen(plant.position)
        expect(label.rotation).toBe(0)
        expect(label.position.x, `${name} at bearing ${bearingDeg}`).toBeCloseTo(at.x, 3)
        expect(label.position.y - at.y, `${name} at bearing ${bearingDeg}`).toBeGreaterThan(0)
      }

      // A note's text keeps its angle on the ground: its own 30°, less the bearing.
      const note = texts.find((text) => text.text === 'Pond edge')!
      const noteAt = view.worldToScreen({ x: 5, y: 5 })
      expect(note.position.x).toBeCloseTo(noteAt.x, 3)
      expect(note.position.y).toBeCloseTo(noteAt.y, 3)
      expect(note.rotation).toBeCloseTo(((30 - bearingDeg) * Math.PI) / 180, 6)
    }
    layer.dispose()
  })

  it('a single selected plant\'s name is drawn opaque below it at a zoom that hides names, follows a pan and goes with the selection', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const apple = createPlant({ id: 'apple', position: { x: 4, y: 3 } })
    const selected = createTestSceneRendererSnapshot({ scene: { plants: [apple] }, selectedTargets: [{ kind: 'plant', id: 'apple' }] })
    const named = () => nodes(layer.root).filter((node): node is Text => node instanceof Text && node.text === 'Apple')

    // 4 px/m fades every overview name to 0; the selection's name stays opaque.
    for (const [view, next] of [[createTestRendererView({ x: 200, y: 150, scale: 4 }), selected], [createTestRendererView({ x: 230, y: 110, scale: 4 }), undefined]] as const) {
      layer.present(view, next)
      const [label] = named()
      expect(named()).toHaveLength(1)
      expect(label!.style.fontStyle).toBe('normal')
      expect(label!.visible && label!.parent!.visible).toBe(true)
      expect(label!.alpha * label!.parent!.alpha).toBe(1)
      const at = view.worldToScreen(apple.position)
      expect(label!.position.x).toBeCloseTo(at.x, 3)
      // 2 px under the symbol: a lone plant at 4 px/m is 6.72 px in radius.
      expect(label!.position.y - at.y).toBeCloseTo(8.72, 3)
    }

    layer.present(createTestRendererView({ x: 230, y: 110, scale: 4 }), createTestSceneRendererSnapshot({ scene: { plants: [apple] } }))
    expect(named()).toHaveLength(0)
    layer.dispose()
  })

  it('canopi-knon: a selected plant shows no label while Plants is hidden', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const apple = createPlant({ id: 'apple', position: { x: 4, y: 3 } })
    const view = createTestRendererView({ x: 200, y: 150, scale: 20 })
    const withPlants = (visible: boolean) => createTestSceneRendererSnapshot({
      scene: { plants: [apple], layers: [{ kind: 'layer', name: 'plants', visible, locked: false, opacity: 1 }] },
      selectedTargets: [{ kind: 'plant', id: 'apple' }],
    })
    const named = () => nodes(layer.root).filter((node): node is Text => node instanceof Text && node.text === 'Apple')

    // Hidden: the selection stays in the snapshot, yet no name is drawn.
    const hidden = withPlants(false)
    layer.present(view, hidden)
    expect(hidden.selectionLabelPlantIds.has('apple')).toBe(true)
    expect(named()).toHaveLength(0)

    // Shown again: the selection's name returns, opaque.
    layer.present(view, withPlants(true))
    expect(named()).toHaveLength(1)
    expect(named()[0]!.alpha * named()[0]!.parent!.alpha).toBe(1)
    layer.dispose()
  })

  it('canopi-knon: the label follows the Plants layer\'s opacity', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const apple = createPlant({ id: 'apple', position: { x: 4, y: 3 } })
    const view = createTestRendererView({ x: 200, y: 150, scale: 20 })
    const atOpacity = (opacity: number) => createTestSceneRendererSnapshot({
      scene: { plants: [apple], layers: [{ kind: 'layer', name: 'plants', visible: true, locked: false, opacity }] },
      selectedTargets: [{ kind: 'plant', id: 'apple' }],
    })
    const named = () => nodes(layer.root).filter((node): node is Text => node instanceof Text && node.text === 'Apple')

    layer.present(view, atOpacity(0.4))
    expect(named()).toHaveLength(1)
    expect(named()[0]!.alpha * named()[0]!.parent!.alpha).toBeCloseTo(0.4, 6)

    layer.dispose()
  })

  it('a pan frame creates no glyph context and redraws no ring, badge or marker', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    // At 6 px/m the plants are dots and the note shows its marker under its selection outline.
    layer.present(createTestRendererView({ x: 0, y: 0, scale: 6 }), retainedScene())
    const shown = shownGraphics(layer.root)
    // Three glyphs, a ring, a badge, the note's marker and outline.
    expect(shown.length).toBeGreaterThanOrEqual(7)
    const before = shown.map((graphics) => ({ x: graphics.position.x, y: graphics.position.y }))
    const work = recordWork()
    const drawing = spyOnDrawing()

    layer.present(createTestRendererView({ x: 10, y: 20, scale: 6 }))

    expect(work).not.toContain('plantGlyph')
    expect(work).not.toContain('plantEntries')
    expect(work).not.toContain('plantLayout')
    expect(work).not.toContain('labelAdmission')
    for (const draw of drawing) expect(draw).not.toHaveBeenCalled()
    expect(shownGraphics(layer.root)).toEqual(shown)
    shown.forEach((graphics, index) => {
      expect(graphics.position.x).toBeCloseTo(before[index]!.x + 10, 6)
      expect(graphics.position.y).toBeCloseTo(before[index]!.y + 20, 6)
    })
    layer.dispose()
  })

  it('a zoom frame reuses its glyph, ring and badge contexts once warm', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const work = recordWork()
    layer.present(createTestRendererView({ x: 0, y: 0, scale: 20 }), retainedScene())
    layer.present(createTestRendererView({ x: 0, y: 0, scale: 30 }))
    expect(work).toContain('plantGlyph')
    work.length = 0
    const drawing = spyOnDrawing()

    // Back and forth across the same scales: every size is drawn already.
    layer.present(createTestRendererView({ x: 0, y: 0, scale: 20 }))
    layer.present(createTestRendererView({ x: 0, y: 0, scale: 30 }))

    expect(work).toContain('plantEntries')
    expect(work).not.toContain('plantGlyph')
    for (const draw of drawing) expect(draw).not.toHaveBeenCalled()
    layer.dispose()
  })

  it('a zoom frame with no notes and no measurement labels runs no detail layout', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [createPlant()] } })
    layer.present(createTestRendererView({ x: 0, y: 0, scale: 20 }), snapshot)
    vi.mocked(getCanvasDetailLayout).mockClear()

    for (const scale of [21, 22, 30]) layer.present(createTestRendererView({ x: 0, y: 0, scale }), undefined, false)

    expect(getCanvasDetailLayout).not.toHaveBeenCalled()
    layer.dispose()
  })

  it('each plant is drawn within 0.125 px of its exact radius, the badge at the exact radius', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const snapshot = createTestSceneRendererSnapshot({ scene: { plants: [
      createPlant({ id: 'a', position: { x: 1, y: 1 } }),
      createPlant({ id: 'b', position: { x: 1, y: 1 } }),
    ] } })
    for (const scale of [0.3, 3.3, 7.31, 13, 41.7, 133]) {
      const view = createTestRendererView({ x: 0, y: 0, scale })
      layer.present(view, snapshot)
      const [exact] = buildPlantPresentationEntries(snapshot.scene.plants, { pixelsPerMetre: scale, speciesCache: new Map() }, new Set())
      const at = view.worldToScreen({ x: 1, y: 1 })
      const glyph = shownGraphics(layer.root).find((graphics) => Math.hypot(graphics.position.x - at.x, graphics.position.y - at.y) < 1e-3
        && graphics.context.instructions.some((instruction) => instruction.action === 'fill'))!
      // The default symbol is a disc a little inside its radius; a dot fills the whole radius.
      const expected = exact!.radiusScreenPx * (exact!.dot ? 1 : ROUND_PLANT_SYMBOL_RADIUS)
      expect(Math.abs(filledCircleRadius(glyph.context) - expected), `scale ${scale}`).toBeLessThanOrEqual(0.125)
      const badge = nodes(layer.root).find((node): node is Text => node instanceof Text && node.text === '2')!
      const offset = exact!.radiusScreenPx + 2
      expect(badge.position.x, `scale ${scale}`).toBeCloseTo(at.x + offset, 3)
      expect(badge.position.y, `scale ${scale}`).toBeCloseTo(at.y - offset, 3)
    }
    layer.dispose()
  })

  it('a turned note\'s outline lies on its frame at every bearing', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const snapshot = createTestSceneRendererSnapshot({ scene: { annotations: [NOTE] }, selectedTargets: [{ kind: 'annotation', id: 'note' }] })
    for (const [bearingDeg, scale] of [[0, 20], [30, 20], [45, 6], [200, 20]] as const) {
      const view = createTestRendererView({ x: 200, y: 150, scale }, { bearingDeg })
      layer.present(view, bearingDeg === 0 ? snapshot : undefined)
      const outline = shownGraphics(layer.root).find((graphics) => strokeColours(graphics.context).length === 2)!
      outline.updateLocalTransform()
      const drawn = strokedPoints(outline.context).map((point) => outline.localTransform.apply(point))
      // The selected note shows its text at every scale; its frame is padded 4 px across and 2 px down, then turned by the
      // note's angle about the frame's origin.
      const { frame } = getAnnotationPresentation(NOTE, scale, true, true)
      const turn = (frame.rotationDeg * Math.PI) / 180
      const padded = [[-4, -2], [frame.widthPx + 4, -2], [frame.widthPx + 4, frame.heightPx + 2], [-4, frame.heightPx + 2]] as const
      const expected = padded.map(([x, y]) => view.worldToScreen({
        x: NOTE.position.x + (frame.origin.x + x * Math.cos(turn) - y * Math.sin(turn)) / scale,
        y: NOTE.position.y + (frame.origin.y + x * Math.sin(turn) + y * Math.cos(turn)) / scale,
      }))
      expected.forEach((point, index) => {
        expect(drawn[index]!.x, `bearing ${bearingDeg}`).toBeCloseTo(point.x, 6)
        expect(drawn[index]!.y, `bearing ${bearingDeg}`).toBeCloseTo(point.y, 6)
      })
    }
    layer.dispose()
  })

  it('a theme or backdrop change repaints shared rings, badges and markers in the new colours', () => {
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const view = createTestRendererView({ x: 0, y: 0, scale: 6 })
    layer.present(view, retainedScene())
    const coloursBefore = shownGraphics(layer.root).map((graphics) => strokeColours(graphics.context))
    const theme = document.createElement('div')
    theme.style.setProperty('--canvas-selection-stroke', '#123456')
    try {
      // A theme and a backdrop change each send the same scene again.
      refreshCanvasColorCache(theme)
      setCanvasMapBackdrop('satellite')
      layer.present(view, retainedScene())
      const colours = shownGraphics(layer.root).map((graphics) => strokeColours(graphics.context))
      // The ring and the outline take the new selection colour; the badge and the marker the satellite ink.
      expect(colours.flat()).toContain(0x123456)
      expect(colours.flat()).toContain(0x14100a)
      expect(colours).not.toEqual(coloursBefore)
      const badges = shownGraphics(layer.root).filter((graphics) => graphics.context.instructions.some((instruction) =>
        instruction.action === 'fill' && (instruction.data as { style: { color: number } }).style.color === 0xefe8da))
      expect(badges).toHaveLength(1)
    } finally {
      theme.style.setProperty('--canvas-selection-stroke', '#9C5A16')
      refreshCanvasColorCache(theme)
      layer.dispose()
    }
  })
})
