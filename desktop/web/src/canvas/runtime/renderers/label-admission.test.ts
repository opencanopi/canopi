import { describe, expect, it } from 'vitest'
import { createTestRendererView, createTestSceneRendererSnapshot } from '../../../__tests__/support/scene-renderer-snapshot'
import type { ScenePlantEntity } from '../scene'
import type { PlantNameLabel, SelectionLabel } from '../selection-labels'
import { getCanvasTextOpacity } from '../text-visibility'
import { LabelAdmission } from './label-admission'
import '../../../__tests__/support/camera-tolerance'

const plant: ScenePlantEntity = {
  kind: 'plant', id: 'mint', position: { x: 2, y: 3 }, canonicalName: 'Mentha spicata',
  commonName: 'Mint', color: null, canopySpreadM: 1, rotationDeg: null,
  notes: null, plantedDate: null, quantity: null, locked: false, pinnedName: true,
}

function snapshot(pinnedName = true, localizedCommonNames: [string, string][] = []) {
  return createTestSceneRendererSnapshot({
    scene: { plants: [{ ...plant, pinnedName }] },
    selectedTargets: [{ kind: 'plant', id: 'mint' }],
    localizedCommonNames: new Map(localizedCommonNames),
  })
}

/** Where a label lands under the view: its anchor projected, plus its offset. */
function onScreen(label: PlantNameLabel | SelectionLabel, viewport: { x: number; y: number; scale: number }) {
  const at = createTestRendererView(viewport).worldToScreen(label.anchor)
  return { x: at.x + label.offsetPx.x, y: at.y + label.offsetPx.y }
}

/** What a fresh admission of the pinned-name scene shows at `pixelsPerMetre`. */
function fresh(pixelsPerMetre: number) {
  const admission = new LabelAdmission()
  admission.setScene(snapshot())
  return admission.admit(pixelsPerMetre, true)!
}

describe('label admission', () => {
  it('a pan keeps the admitted labels without reading scene geometry, and they move with their anchors', () => {
    const admission = new LabelAdmission()
    const initial = snapshot()
    admission.setScene(initial)
    const admitted = admission.admit(20, true)!
    const [name] = admitted.plantNameLabels
    expect(name?.anchor).toEqual({ x: 2, y: 3 })
    for (const [viewport, offset] of [
      [{ x: 10, y: 20, scale: 20 }, { x: 0, y: 18 }],
      [{ x: 17, y: 13, scale: 20 }, { x: 0, y: 18 }],
      [{ x: -2, y: 40, scale: 20 }, { x: 0, y: 18 }],
    ] as const) {
      const anchor = createTestRendererView(viewport).worldToScreen({ x: 2, y: 3 })
      expect(onScreen(name!, viewport).x).toBeCloseTo(anchor.x + offset.x, 6)
      expect(onScreen(name!, viewport).y).toBeCloseTo(anchor.y + offset.y, 6)
    }
    // A pan admits nothing again: the scene's geometry is not read.
    Object.defineProperty(initial.scene, 'plants', { get: () => { throw new Error('pan read geometry') } })
    expect(admission.admit(20, true)).toBe(admitted)
  })

  it('admits on the settled frame and on a band change, not on each zoom frame', () => {
    const runs: number[] = []
    const admission = new LabelAdmission((admit) => { runs.push(runs.length); return admit() })
    admission.setScene(snapshot())
    // 20 and 22 px/m share a band (1.25^13 to 1.25^14); 14 px/m is two bands down.
    const first = admission.admit(20, false)!
    expect(runs).toHaveLength(1)
    expect(admission.admit(21, false)).toBe(first)
    expect(admission.admit(22, false)).toBe(first)
    expect(runs).toHaveLength(1)

    const settled = admission.admit(22, true)!
    expect(runs).toHaveLength(2)
    const [name] = settled.plantNameLabels
    expect(onScreen(name!, { x: 0, y: 0, scale: 22 })).toEqual(onScreen(fresh(22).plantNameLabels[0]!, { x: 0, y: 0, scale: 22 }))
    // The settled frame again (a repaint at rest) admits nothing.
    expect(admission.admit(22, true)).toBe(settled)

    const crossed = admission.admit(14, false)!
    expect(runs).toHaveLength(3)
    expect(crossed).not.toBe(settled)
    expect(crossed.plantNameLabels).toEqual(fresh(14).plantNameLabels)
    expect(admission.admit(13, false)).toBe(crossed)
    expect(runs).toHaveLength(3)
  })

  it('a scene sync admits at the exact scale, mid-zoom too', () => {
    // Unselected, so the pinned name fades: 14 and 13 px/m share a band, and its opacity differs between them.
    const unselected = (localizedCommonNames: [string, string][] = []) => createTestSceneRendererSnapshot({
      scene: { plants: [plant] }, localizedCommonNames: new Map(localizedCommonNames),
    })
    const admission = new LabelAdmission()
    admission.setScene(unselected())
    const before = admission.admit(14, false)!
    expect(admission.admit(13, false)).toBe(before)
    admission.setScene(unselected([['Mentha spicata', 'Menthe']]))
    const synced = admission.admit(13, false)!
    expect(synced).not.toBe(before)
    expect(synced.plantNameLabels[0]?.text).toBe('Menthe')
    expect(synced.plantNameLabels[0]?.opacity).toBe(getCanvasTextOpacity(13))
    expect(before.plantNameLabels[0]?.opacity).toBe(getCanvasTextOpacity(14))
  })

  it('a settled scale change admits again, and a new scene replaces selection, pins and localized names', () => {
    const admission = new LabelAdmission()
    admission.setScene(snapshot(false))
    const [selection] = admission.admit(20, true)!.selectionLabels
    const selAnchor = createTestRendererView({ x: 10, y: 20, scale: 20 }).worldToScreen({ x: 2, y: 3 })
    expect(onScreen(selection!, { x: 10, y: 20, scale: 20 }).y).toBeCloseTo(selAnchor.y + 16, 6)
    const [zoomed] = admission.admit(2, true)!.selectionLabels
    const zoomAnchor = createTestRendererView({ x: 1, y: 2, scale: 2 }).worldToScreen({ x: 2, y: 3 })
    expect(onScreen(zoomed!, { x: 1, y: 2, scale: 2 }).x).toBeCloseTo(zoomAnchor.x, 6)
    expect(onScreen(zoomed!, { x: 1, y: 2, scale: 2 }).y).toBeCloseTo(zoomAnchor.y + 5.36, 6)
    admission.setScene(snapshot(true, [['Mentha spicata', 'Menthe']]))
    expect(admission.admit(2, true)!.selectionLabels).toEqual([])
    const [name] = admission.admit(40, true)!.plantNameLabels
    expect(name?.text).toBe('Menthe')
    const nameAnchor = createTestRendererView({ x: 0, y: 0, scale: 40 }).worldToScreen({ x: 2, y: 3 })
    expect(onScreen(name!, { x: 0, y: 0, scale: 40 }).y).toBeCloseTo(nameAnchor.y + 18, 6)
    admission.setScene(createTestSceneRendererSnapshot())
    expect(admission.admit(40, true)!.plantNameLabels).toEqual([])
  })

  it('admits nothing before a scene', () => {
    const admission = new LabelAdmission()
    expect(admission.admit(20, true)).toBeNull()
    admission.setScene(snapshot())
    expect(admission.admit(20, true)).not.toBeNull()
  })
})
