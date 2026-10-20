import { getCanvasPlantNameLabels } from '../automatic-detail'
import { isPlantLayerShown } from '../scene-visuals'
import { projectScenePlantLabels, type PlantNameLabel, type SelectionLabel } from '../selection-labels'
import { zoomBandOf } from '../view/frame-source'
import type { SceneRendererSnapshot } from './scene-types'

/** The labels the scene draws: a single selection's name and the admitted plant names, each at an offset from its anchor. */
export interface AdmittedLabels {
  readonly selectionLabels: readonly SelectionLabel[]
  readonly plantNameLabels: readonly PlantNameLabel[]
}

/**
 * Admits the labels of `snapshot` at `pixelsPerMetre`; a translation never changes admission, so none is taken. A Plants
 * layer that shows nothing admits no label of either kind, a single selection's name included (canopi-knon).
 */
function admitLabels(snapshot: SceneRendererSnapshot, pixelsPerMetre: number): AdmittedLabels {
  if (!isPlantLayerShown(snapshot.scene)) return { selectionLabels: [], plantNameLabels: [] }
  const projected = projectScenePlantLabels(snapshot, pixelsPerMetre)
  return {
    selectionLabels: projected.selectionLabels,
    plantNameLabels: getCanvasPlantNameLabels(snapshot, pixelsPerMetre, projected),
  }
}

/**
 * Label admission (spec §1.5): a scene sync, the first view, a zoom-band change and a settled frame at a new scale admit
 * again. A pan and a zoom inside the band keep the admitted labels, which the billboards move with their anchors, so
 * mid-zoom names fade in band steps and are exact at rest (Q5).
 */
export class LabelAdmission {
  private snapshot: SceneRendererSnapshot | null = null
  private admitted: { readonly pixelsPerMetre: number; readonly labels: AdmittedLabels } | null = null

  /** `measure` wraps each admission that runs (the renderer's `labelAdmission` work name). */
  constructor(private readonly measure: <T>(admit: () => T) => T = (admit) => admit()) {}

  setScene(snapshot: SceneRendererSnapshot): void {
    this.snapshot = snapshot
    this.admitted = null
  }

  /**
   * The labels at `pixelsPerMetre`, admitted again on a new scene, a new zoom band, or a new scale on a `settled`
   * frame (the camera's settled frame, or any frame where there is none); null before a scene.
   */
  admit(pixelsPerMetre: number, settled: boolean): AdmittedLabels | null {
    if (!this.snapshot) return null
    const admitted = this.admitted
    const kept = admitted
      && zoomBandOf(admitted.pixelsPerMetre) === zoomBandOf(pixelsPerMetre)
      && (!settled || admitted.pixelsPerMetre === pixelsPerMetre)
    if (kept) return admitted.labels
    const snapshot = this.snapshot
    const labels = this.measure(() => admitLabels(snapshot, pixelsPerMetre))
    this.admitted = { pixelsPerMetre, labels }
    return labels
  }
}
