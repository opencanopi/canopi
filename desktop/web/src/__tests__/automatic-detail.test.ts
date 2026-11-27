import { describe, expect, it } from 'vitest'
import { getCanvasDetailLayout, getCanvasPlantNameLabels } from '../canvas/runtime/automatic-detail'
import { getAnnotationPresentation, isPointInAnnotationPresentation } from '../canvas/runtime/annotation-layout'
import { DEFAULT_PLANT_DISPLAY } from '../canvas/runtime/plant-display'
import { SceneStore, type ScenePlantEntity } from '../canvas/runtime/scene'
import { selectionExtentPoints } from '../canvas/runtime/scene-extent'
import { getCombinedTargetBounds } from '../canvas/runtime/scene-runtime/selection'
import { hitTestTopLevel, queryQuadTopLevel } from '../canvas/runtime/tools/hit-testing'
import { createTestRendererView, createTestSceneRendererSnapshot } from './support/scene-renderer-snapshot'

function plant(id: string, x: number, y: number): ScenePlantEntity {
  return { kind: 'plant', id, position: { x, y }, canonicalName: 'Mentha spicata', commonName: 'Menthe verte',
    color: null, canopySpreadM: null, rotationDeg: null, notes: null,
    plantedDate: null, quantity: null, locked: false, pinnedName: false }
}

describe('Automatic Detail', () => {
  it('does not let invisible plants suppress readable notes', () => {
    const { scene } = createTestSceneRendererSnapshot({ scene: {
      plants: [plant('a', 0, 0)],
      layers: [{ kind: 'layer', name: 'plants', visible: true, locked: false, opacity: 0 }],
      annotations: [{ kind: 'annotation', id: 'note', annotationType: 'text', position: { x: 0, y: 0 },
        text: 'Planting note', fontSize: 16, rotationDeg: 0, locked: false }],
    } })
    expect(getCanvasDetailLayout(scene, 20).annotationIds.has('note')).toBe(true)
  })

  it('editing a note\'s text recomputes the detail layout', () => {
    const note = (id: string, x: number, text: string) => ({ kind: 'annotation' as const, id, annotationType: 'text',
      position: { x, y: 0 }, text, fontSize: 16, rotationDeg: 0, locked: false })
    const store = new SceneStore()
    store.updatePersisted((draft) => { draft.annotations = [note('a', 0, 'Hi'), note('b', 10, 'Pond')] })
    const layout = getCanvasDetailLayout(store.persisted, 20)
    expect([...layout.annotationIds].sort()).toEqual(['a', 'b'])
    expect(getCanvasDetailLayout(store.persisted, 20)).toBe(layout)

    store.updatePersisted((draft) => { draft.annotations[0]!.text = 'Hi, this note now runs across the pond note' })
    expect([...getCanvasDetailLayout(store.persisted, 20).annotationIds]).toEqual(['b'])
  })

  it('keeps a crowded note discoverable with a compact marker and matching pointer allowance', () => {
    const note = { kind: 'annotation' as const, id: 'note', annotationType: 'text', position: { x: 0, y: 0 },
      text: 'Planting note', fontSize: 16, rotationDeg: 0, locked: false }
    const presentation = getAnnotationPresentation(note, 20, false, false)
    expect(presentation.frame.widthPx).toBe(4)
    expect(isPointInAnnotationPresentation(note, { x: 6 / 20, y: 0 }, 20, false, false)).toBe(true)
    expect(isPointInAnnotationPresentation(note, { x: 7 / 20, y: 0 }, 20, false, false)).toBe(false)
    expect(getAnnotationPresentation(note, 20, true, false).textOpacity).toBe(1)
  })

  it('identifies unpinned plants when local space allows without changing their saved name choices', () => {
    const snapshot = createTestSceneRendererSnapshot({
      scene: { plants: [plant('a', 0, 0), plant('b', .27, 0)] },
    })
    const before = JSON.stringify(snapshot.scene)
    const labels = getCanvasPlantNameLabels(snapshot, 400)
    expect(labels.map((label) => label.text)).toEqual(['Menthe verte', 'Menthe verte'])
    expect(JSON.stringify(snapshot.scene)).toBe(before)
    expect(getCanvasPlantNameLabels(snapshot, 10)).toEqual([])
  })

  it('draws the labels a snapshot asks for over the workspace choice (a saved view)', () => {
    const snapshot = createTestSceneRendererSnapshot({
      scene: { plants: [plant('a', 0, 0), plant('b', .27, 0)], plantSpeciesCodes: { 'Mentha spicata': 'MSP' } },
    })
    const pixelsPerMetre = 400
    expect(getCanvasPlantNameLabels({ ...snapshot, plantLabels: 'none' }, pixelsPerMetre)).toEqual([])
    expect(getCanvasPlantNameLabels({ ...snapshot, plantLabels: 'codes' }, pixelsPerMetre).map((label) => label.text)).toEqual(['MSP', 'MSP'])
    expect(getCanvasPlantNameLabels({ ...snapshot, plantLabels: 'names' }, pixelsPerMetre).map((label) => label.text))
      .toEqual(['Menthe verte', 'Menthe verte'])
  })

  it('includes the species code on pinned plants when codes mode is active', () => {
    const base = createTestSceneRendererSnapshot({
      scene: {
        plants: [{ ...plant('a', 0, 0), pinnedName: true }, plant('b', 1, 0)],
        plantSpeciesCodes: { 'Mentha spicata': 'MSP' },
      },
    })
    const snapshot = { ...base, plantLabels: 'codes' as const }
    expect(getCanvasPlantNameLabels(snapshot, 400).map((label) => ({ id: label.plantId, text: label.text }))).toEqual([
      { id: 'a', text: 'MSP · Menthe verte' },
      { id: 'b', text: 'MSP' },
    ])
  })

  it('keeps collision admission stable during panning and a round trip through overview zoom', () => {
    const snapshot = createTestSceneRendererSnapshot({
      scene: { plants: [plant('a', 0, 0), plant('b', .4, 0), plant('c', .8, 0)] },
    })
    const labels = getCanvasPlantNameLabels(snapshot, 100)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.length).toBeLessThan(3)
    // A pan moves where the admitted labels land in the frame, by the pan.
    const landing = (viewport: { x: number; y: number; scale: number }) => labels.map((label) => {
      const anchor = createTestRendererView(viewport).worldToScreen(label.anchor)
      return { x: anchor.x + label.offsetPx.x, y: anchor.y + label.offsetPx.y }
    })
    const panned = landing({ x: 113, y: -27, scale: 100 })
    for (const [index, point] of landing({ x: 0, y: 0, scale: 100 }).entries()) {
      expect(panned[index]!.x).toBeCloseTo(point.x + 113, 6)
      expect(panned[index]!.y).toBeCloseTo(point.y - 27, 6)
    }
    getCanvasPlantNameLabels(snapshot, 10)
    expect(getCanvasPlantNameLabels(snapshot, 100)).toEqual(labels)
  })

  it('a hover keeps the admitted names (Q4)', () => {
    const snapshot = createTestSceneRendererSnapshot({
      scene: { plants: [plant('a', 0, 0), plant('b', .4, 0), plant('c', .8, 0)] },
    })
    const admitted = getCanvasPlantNameLabels(snapshot, 100)
    const unnamed = ['a', 'b', 'c'].find((id) => !admitted.some((label) => label.plantId === id))!
    expect(unnamed).toBeDefined()

    const hovered = { ...snapshot, hoverTarget: { kind: 'plant' as const, id: unnamed, state: 'hover' as const } }
    expect(getCanvasPlantNameLabels(hovered, 100)).toEqual(admitted)
  })

  it('prioritizes an authored pin in a crowded label area and never reveals a hidden plant layer', () => {
    const snapshot = createTestSceneRendererSnapshot({
      scene: { plants: [plant('a', 0, 0), plant('b', 0, 0), { ...plant('z', 0, 0), pinnedName: true }] },
    })
    const pixelsPerMetre = 100
    expect(getCanvasPlantNameLabels(snapshot, pixelsPerMetre).map(label => label.plantId)).toEqual(['z', 'a'])
    const hidden = { ...snapshot, scene: { ...snapshot.scene,
      layers: [{ kind: 'layer' as const, name: 'plants', visible: false, locked: false, opacity: 1 }] } }
    expect(getCanvasPlantNameLabels(hidden, pixelsPerMetre)).toEqual([])
  })

  it('keeps hit-testing and selection bounds aligned with detail layout when symbolScale !== 1', () => {
    // At scale 20 px/m, a plant at (0,0) with default symbolScale=1 leaves a note at x=1.2m clear,
    // while symbolScale=2.5 expands the plant box so the note collapses to its compact marker.
    const { scene } = createTestSceneRendererSnapshot({
      scene: {
        plants: [plant('p1', 0, 0)],
        annotations: [{ kind: 'annotation', id: 'note', annotationType: 'text', position: { x: 1.2, y: 0 },
          text: 'Nearby planting note', fontSize: 16, rotationDeg: 0, locked: false }],
      },
    })
    const scale = 20
    expect(getCanvasDetailLayout(scene, scale, 1).annotationIds.has('note')).toBe(true)
    expect(getCanvasDetailLayout(scene, scale, 2.5).annotationIds.has('note')).toBe(false)

    const scaledContext = {
      plants: scene.plants,
      pixelsPerMetre: scale,
      speciesCache: new Map(),
      plantDisplay: { ...DEFAULT_PLANT_DISPLAY, symbolScale: 2.5 },
    }
    const defaultContext = {
      plants: scene.plants,
      pixelsPerMetre: scale,
      speciesCache: new Map(),
      plantDisplay: { ...DEFAULT_PLANT_DISPLAY, symbolScale: 1 },
    }

    // Far edge of the text box (x = 4m) hits the note when symbolScale=1, but misses when collapsed at symbolScale=2.5.
    const textFarEdge = { x: 4, y: 0 }
    expect(hitTestTopLevel(scene, textFarEdge, scale, 'mouse', new Map(), () => defaultContext)).toEqual({ kind: 'annotation', id: 'note' })
    expect(hitTestTopLevel(scene, textFarEdge, scale, 'mouse', new Map(), () => scaledContext)).toBeNull()

    const farQuad = [{ x: 3.5, y: -1 }, { x: 4.5, y: -1 }, { x: 4.5, y: 1 }, { x: 3.5, y: 1 }]
    expect(queryQuadTopLevel(scene, farQuad, scale, new Map(), () => defaultContext)).toEqual([{ kind: 'annotation', id: 'note' }])
    expect(queryQuadTopLevel(scene, farQuad, scale, new Map(), () => scaledContext)).toEqual([])

    const defaultBounds = getCombinedTargetBounds(scene, [{ kind: 'annotation', id: 'note' }], {
      annotationViewportScale: scale,
      plantContext: defaultContext,
      revealedAnnotationId: null,
    })!
    const scaledBounds = getCombinedTargetBounds(scene, [{ kind: 'annotation', id: 'note' }], {
      annotationViewportScale: scale,
      plantContext: scaledContext,
      revealedAnnotationId: null,
    })!
    expect(scaledBounds.maxX - scaledBounds.minX).toBeLessThan(defaultBounds.maxX - defaultBounds.minX)

    const defaultExtent = selectionExtentPoints(scene, [{ kind: 'annotation', id: 'note' }], { plantContext: defaultContext })(scale)
    const scaledExtent = selectionExtentPoints(scene, [{ kind: 'annotation', id: 'note' }], { plantContext: scaledContext })(scale)
    const widthOf = (pts: readonly { readonly x: number }[]) => Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))
    expect(widthOf(scaledExtent)).toBeLessThan(widthOf(defaultExtent))
  })
})
