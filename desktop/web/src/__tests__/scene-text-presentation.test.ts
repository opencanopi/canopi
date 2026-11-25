// @vitest-environment jsdom

// Production CSP rejects Pixi's generated functions; its shim avoids eval.
import 'pixi.js/unsafe-eval'
import { CanvasTextMetrics, Text } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'
import {
  getAnnotationPresentation,
  getAnnotationVisualWorldBounds,
  isPointInAnnotationPresentation,
  onAnnotationFontLoad,
} from '../canvas/runtime/annotation-layout'
import { getCanvasDetailLayout } from '../canvas/runtime/automatic-detail'
import {
  createDefaultScenePersistedState,
  SceneStore,
  type SceneAnnotationEntity,
  type SceneDesignObjectSelection,
  type ScenePersistedState,
} from '../canvas/runtime/scene'
import { SceneRuntimePresentationController } from '../canvas/runtime/scene-runtime/presentation'
import { createBillboardLayer } from '../canvas/runtime/renderers/billboard-layer'
import { getDesignObjectSelectionModel } from '../canvas/runtime/scene-runtime/selection'
import { projectScenePlantLabels } from '../canvas/runtime/selection-labels'
import { selectionScreenHull } from '../canvas/runtime/tools/select/selection-hull'
import { createTestView } from './support/test-view'
import type { ToolScene } from '../canvas/runtime/tools/tool'
import { createTestRendererView, createTestSceneRendererSnapshot } from './support/scene-renderer-snapshot'
import { createZoomCalibrationScene } from './support/zoom-calibration-scenes'

// jsdom has no 2D canvas and no font loading API, so this file measures through stubs: a context whose glyphs are half
// an em wide once their web-font face has loaded, 0.56 em wide before, and rise 0.7 em once the Latin face has loaded,
// 0.75 em before; and a font set of a Latin face and a Cyrillic face, each covering its script's characters as
// fonts.css's unicode ranges do, whose load resolves with the faces the text needs once they have loaded, and which the
// test finishes. A face the engine reports 'loading' (Chromium) or, under font-display: swap, as failed ('error',
// WebKit) has not loaded. Pixi measures its texts with the same context.
const face = { status: 'loaded' as FontFaceLoadStatus }
const cyrillicFace = { status: 'loaded' as FontFaceLoadStatus }
const faceOf = (glyph: string) => /\p{Script=Cyrillic}/u.test(glyph) ? cyrillicFace : face
const faceArrivals = new Map<typeof face, (() => void)[]>()
/** Ends the load of `which`. */
function finishLoad(which = face) {
  which.status = 'loaded'
  for (const arrive of faceArrivals.get(which) ?? []) arrive()
  faceArrivals.delete(which)
}
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: {
    forEach: (visit: (each: typeof face) => void) => [face, cyrillicFace].forEach((each) => visit(each)),
    load: (_font: string, text: string) => {
      const needed = [...new Set(Array.from(text, faceOf))]
      return Promise.all(needed.map((each) => each.status === 'loaded' ? undefined : new Promise<void>((resolve) => {
        faceArrivals.set(each, [...faceArrivals.get(each) ?? [], resolve])
      }))).then(() => needed)
    },
  },
})
vi.stubGlobal('OffscreenCanvas', class {
  getContext() {
    return {
      font: '',
      measureText(this: { font: string }, text: string) {
        const fontSize = Number(/([\d.]+)px/.exec(this.font)![1])
        const width = Array.from(text)
          .reduce((sum, glyph) => sum + fontSize * (faceOf(glyph).status === 'loaded' ? 0.5 : 0.56), 0)
        return { width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width - 1,
          actualBoundingBoxAscent: fontSize * (face.status === 'loaded' ? 0.7 : 0.75), actualBoundingBoxDescent: fontSize * 0.2 }
      },
    }
  }
})

// Pixi asks the context's class whether it spaces letters itself; this one does not.
vi.stubGlobal('CanvasRenderingContext2D', class {})

const SCALE = 20

function noteScene(text: string): ScenePersistedState {
  const note: SceneAnnotationEntity = { kind: 'annotation', id: 'note', annotationType: 'text', position: { x: 3, y: 4 },
    text, fontSize: 16, rotationDeg: 0, locked: false }
  return { ...createDefaultScenePersistedState(), annotations: [note] }
}

/** The note's frame width in CSS px as each reader sees it at SCALE, to a thousandth of a pixel. */
function widthsRead(scene: ScenePersistedState) {
  const note = scene.annotations[0]!
  const selection: SceneDesignObjectSelection = [{ kind: 'annotation', id: note.id }]
  const model = getDesignObjectSelectionModel(scene, selection, {
    annotationViewportScale: SCALE,
    revealedAnnotationId: note.id,
    plantContext: { pixelsPerMetre: SCALE, speciesCache: new Map(), localizedCommonNames: new Map() },
  })
  const testView = createTestView({ screen: { width: 800, height: 600 }, viewport: { x: 0, y: 0, scale: SCALE } })
  const view = testView.view()
  const hull = selectionScreenHull({ persisted: scene, selection: () => selection } as unknown as ToolScene, model, {
    metresPerPixelAt: (at) => view.metresPerPixelAt(at),
    screenAxesInWorld: () => view.screenAxesInWorld(),
    worldDeltaToScreen: (delta) => view.worldDeltaToScreen(delta),
    screenDeltaToWorld: (delta) => view.screenDeltaToWorld(delta),
  })!
  const px = (value: number) => Math.round(value * 1000) / 1000
  const result = {
    frame: px(getAnnotationPresentation(note, SCALE, true).textFrame.widthPx),
    detail: px(getCanvasDetailLayout(scene, SCALE).bounds[0]!.width - 4),
    selection: px((model.bounds!.maxX - model.bounds!.minX) * SCALE),
    hull: px((hull[1].x - hull[0].x) * SCALE),
  }
  testView.dispose()
  return result
}

describe('scene text presentation', () => {
  it('keeps marker geometry upright and switches to authored rotated text at half opacity', () => {
    const note = { ...createZoomCalibrationScene('garden').annotations[1]!, position: { x: 10, y: 20 }, rotationDeg: 90 }
    expect(getAnnotationVisualWorldBounds(note, 4)).toEqual({ x: 9, y: 19, width: 2, height: 2 })
    expect(getAnnotationPresentation(note, 13.99).markerOwnsGeometry).toBe(true)
    expect(getAnnotationPresentation(note, 14).markerOwnsGeometry).toBe(false)
    expect(getAnnotationPresentation(note, 4, true)).toMatchObject({ textOpacity: 1, markerOpacity: 0, markerOwnsGeometry: false })
  })

  it('projects a direct singleton Annotation reveal without revealing group or mixed selection', () => {
    const store = new SceneStore()
    store.updatePersisted((scene) => Object.assign(scene, createZoomCalibrationScene('garden')))
    const presentation = new SceneRuntimePresentationController({ sceneStore: store,
      readPixelsPerMetre: () => 4, getLocale: () => 'en',
      resolveHighlightedTargets: () => ({ plantIds: [], zoneIds: [] }), onPlantNamesChanged: () => {},
    })
    for (const selection of [
      [{ kind: 'annotation', id: 'note-0' }],
      [{ kind: 'annotation', id: 'note-0' }, { kind: 'plant', id: 'plant-0' }],
      [{ kind: 'group', id: 'guild' }],
    ] satisfies SceneDesignObjectSelection[]) {
      store.setSelection(selection)
      expect(presentation.buildRendererSnapshot().revealedAnnotationId).toBe(selection.length === 1 && selection[0]?.kind === 'annotation' ? 'note-0' : null)
    }
  })

  it('reveals a name only for direct singleton selection, without modifying the Design', () => {
    const store = new SceneStore()
    store.updatePersisted((scene) => Object.assign(scene, createZoomCalibrationScene('garden')))
    const before = store.persisted
    const presentation = new SceneRuntimePresentationController({
      sceneStore: store, readPixelsPerMetre: () => 4,
      getLocale: () => 'en', resolveHighlightedTargets: () => ({ plantIds: [], zoneIds: [] }),
      onPlantNamesChanged: () => {},
    })
    const selections: SceneDesignObjectSelection[] = [
      [{ kind: 'plant', id: 'plant-1' }],
      [{ kind: 'plant', id: 'plant-1' }, { kind: 'annotation', id: 'note-0' }],
      [{ kind: 'group', id: store.persisted.groups[0]!.id }],
      [{ kind: 'plant', id: 'plant-2' }],
      [{ kind: 'plant', id: 'plant-0' }],
    ]
    const snapshots = selections.map((selection) => {
      store.setSelection(selection)
      return presentation.buildRendererSnapshot()
    })
    const labels = snapshots.map((snapshot) => projectScenePlantLabels(snapshot, 4))
    expect(labels.map(({ pinnedPlantNameLabels }) => pinnedPlantNameLabels.map((label) => label.plantId)))
      .toEqual([['plant-1'], [], [], ['plant-2'], []])
    expect(labels.map(({ selectionLabels }) => selectionLabels.length)).toEqual([0, 0, 0, 0, 1])
    expect(store.persisted).toEqual(before)
  })

  it('a note\'s frame, click target, detail bounds and hull read its measured width', () => {
    const scene = noteScene('Hazelnut hedge, prune in February')
    const note = scene.annotations[0]!
    // 33 glyphs at 16 px, half an em each: the measured 264 px, not the 316.8 px of the 0.6 em estimate.
    expect(widthsRead(scene)).toEqual({ frame: 264, detail: 264, selection: 264, hull: 264 })

    // The click target is the drawn outline: the text plus 4 px each side, 2 px above and below (Q7).
    const at = (x: number, y: number) => isPointInAnnotationPresentation(
      note, { x: note.position.x + x / SCALE, y: note.position.y + y / SCALE }, SCALE)
    expect([at(-3.5, 10), at(267.5, 10), at(100, -1.5), at(100, 21.5)]).toEqual([true, true, true, true])
    expect([at(-4.5, 10), at(268.5, 10), at(100, -2.5), at(100, 22.5)]).toEqual([false, false, false, false])
    expect(at(284, 10), 'a click 20 px right of the text').toBe(false)
  })

  for (const { engine, status, text } of [
    { engine: 'Chromium', status: 'loading', text: 'Pond' },
    { engine: 'WebKit', status: 'error', text: 'Mere' },
  ] satisfies { engine: string, status: FontFaceLoadStatus, text: string }[]) {
    it(`a font load re-measures the note and every memo follows, as ${engine} reports the loading face`, async () => {
      const scene = noteScene(text)
      const loads = vi.fn()
      const stopListening = onAnnotationFontLoad(loads)
      try {
        face.status = status
        // 4 glyphs of the fallback font, 0.56 em each.
        expect(widthsRead(scene)).toEqual({ frame: 35.84, detail: 35.84, selection: 35.84, hull: 35.84 })

        finishLoad()
        await vi.waitFor(() => expect(loads).toHaveBeenCalledTimes(1))

        expect(widthsRead(scene)).toEqual({ frame: 32, detail: 32, selection: 32, hull: 32 })
      } finally {
        stopListening()
        face.status = 'loaded'
      }
    })
  }

  it('a font load re-measures the notes whose face was loading, measured after a same-font note whose face had loaded', async () => {
    // The notes ask for the same font and different faces: the Latin note's load brings back only its loaded face.
    const notes = ['Reed', 'Пруд', 'Вода'].map((text, index) => ({ ...noteScene(text).annotations[0]!, id: `note-${index}` }))
    const widths = () => notes.map((note) => getAnnotationPresentation(note, SCALE, true).textFrame.widthPx)
    const loads = vi.fn()
    const stopListening = onAnnotationFontLoad(loads)
    try {
      cyrillicFace.status = 'loading'
      // One scene sync: 0.5 em a glyph in the loaded Latin face, 0.56 em in the Cyrillic fallback.
      expect(widths()).toEqual([32, 35.84, 35.84])

      finishLoad(cyrillicFace)
      await vi.waitFor(() => expect(loads).toHaveBeenCalled())

      expect(widths()).toEqual([32, 32, 32])
    } finally {
      stopListening()
      cyrillicFace.status = 'loaded'
    }
  })

  it('a note measured in a font that has loaded is not measured again', async () => {
    const loads = vi.fn()
    const stopListening = onAnnotationFontLoad(loads)
    try {
      expect(widthsRead(noteScene('Medlar'))).toEqual({ frame: 48, detail: 48, selection: 48, hull: 48 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(loads).not.toHaveBeenCalled()
    } finally {
      stopListening()
    }
  })

  it('a font load draws the note\'s text anew, as its outline is measured anew', async () => {
    // Pixi keeps a text's raster while its text and style stay the same, and nothing in Pixi listens for fonts: a text
    // drawn in the fallback would keep the fallback's glyphs inside an outline measured in the web font.
    const scene = noteScene('Willow cuttings')
    const snapshot = () => createTestSceneRendererSnapshot({ scene, selectedTargets: [{ kind: 'annotation', id: 'note' }] })
    const view = createTestRendererView({ x: 0, y: 0, scale: SCALE })
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const noteText = () => layer.root.children.flatMap((layerRoot) => layerRoot.children)
      .find((node): node is Text => node instanceof Text && node.text === 'Willow cuttings')!
    const loads = vi.fn()
    const stopListening = onAnnotationFontLoad(loads)
    try {
      face.status = 'loading'
      layer.present(view, snapshot())
      const drawnInFallback = noteText()
      layer.present(view, snapshot())
      expect(noteText(), 'a scene sync keeps the drawn text').toBe(drawnInFallback)

      finishLoad()
      await vi.waitFor(() => expect(loads).toHaveBeenCalledTimes(1))
      // The runtime syncs the scene on the load (scene-runtime.ts).
      layer.present(view, snapshot())
      expect(drawnInFallback.destroyed, 'the fallback raster is let go').toBe(true)
      expect(noteText()).toBeDefined()
      expect(noteText()).not.toBe(drawnInFallback)
    } finally {
      stopListening()
      face.status = 'loaded'
      layer.dispose()
    }
  })

  it('a font load lays the note\'s text out anew, on the web font\'s widths and baseline', async () => {
    // Pixi memoises a font's ascent and descent by its CSS font string, which names the family and not whether it has
    // loaded: a text drawn anew would sit on the fallback's baseline inside its outline. (A text's widths are memoised
    // by its style instance, which a new text does not share.)
    const scene = noteScene('Comfrey under the apple')
    const note = scene.annotations[0]!
    const snapshot = () => createTestSceneRendererSnapshot({ scene, selectedTargets: [{ kind: 'annotation', id: 'note' }] })
    const view = createTestRendererView({ x: 0, y: 0, scale: SCALE })
    const layer = createBillboardLayer({ createText: () => new Text(), viewSize: { width: 400, height: 300 } })
    const noteText = () => layer.root.children.flatMap((layerRoot) => layerRoot.children)
      .find((node): node is Text => node instanceof Text && node.text === note.text)!
    // What Pixi's canvas text generator lays the raster out by.
    const rasterLayout = () => {
      const { maxLineWidth, fontProperties } = CanvasTextMetrics.measureText(note.text, noteText().style)
      return { widthPx: maxLineWidth, ascentPx: fontProperties.ascent }
    }
    const loads = vi.fn()
    const stopListening = onAnnotationFontLoad(loads)
    try {
      face.status = 'loading'
      layer.present(view, snapshot())
      const frameWidth = () => getAnnotationPresentation(note, SCALE, true).textFrame.widthPx
      expect(rasterLayout()).toEqual({ widthPx: frameWidth(), ascentPx: 12 })

      finishLoad()
      await vi.waitFor(() => expect(loads).toHaveBeenCalledTimes(1))
      layer.present(view, snapshot())
      expect(frameWidth()).toBe(23 * 16 * 0.5)
      expect(rasterLayout()).toEqual({ widthPx: frameWidth(), ascentPx: 16 * 0.7 })
    } finally {
      stopListening()
      face.status = 'loaded'
      layer.dispose()
    }
  })
})
