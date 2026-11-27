import type { GroundMeasure } from '../../../geo/session-plane'
import type { CanvasBackdropInk, CanvasMapBackdrop, CanvasPaintTokens } from '../../theme-refresh'
import type { UnitSystem } from '../../../utils/format'
import type { SpeciesFocus } from '../species-key'
import type { ScenePersistedState } from '../scene'
import type { DraftPresentation } from '../tools/draft'
import type { SpeciesCacheEntry } from '../presentation-data'
import type { PlantDisplay, PlantLabelMode } from '../plant-display'

export type SceneRendererHoverState =
  | 'hover'
  | 'locked-design-object'
  | 'locked-layer'

export type SceneRendererHoverTarget =
  | { kind: 'plant'; id: string; state: SceneRendererHoverState }
  | { kind: 'zone'; id: string; state: SceneRendererHoverState }
  | { kind: 'annotation'; id: string; state: SceneRendererHoverState }
  | { kind: 'measurement-guide'; id: string; state: SceneRendererHoverState }
  | { kind: 'group'; id: string; state: SceneRendererHoverState }

/**
 * The workspace map's editing aids (spec §1.5): the grid, drawn in the world root under every billboard. Its interval
 * follows the scale through `canvas/grid.ts`'s `gridInterval`, the lattice snapping uses; its ink follows the map backdrop.
 */
export interface SceneEditingAids {
  readonly grid: { readonly ink: string; readonly majorInk: string }
}

export interface SceneRendererSnapshot {
  readonly speciesFocus: SpeciesFocus
  readonly scene: ScenePersistedState
  readonly revealedAnnotationId: string | null
  readonly selectionLabelPlantIds: ReadonlySet<string>
  readonly selectedPlantIds: ReadonlySet<string>
  readonly selectedZoneIds: ReadonlySet<string>
  readonly selectedAnnotationIds: ReadonlySet<string>
  readonly selectedMeasurementGuideIds: ReadonlySet<string>
  readonly highlightedPlantIds: ReadonlySet<string>
  readonly highlightedZoneIds: ReadonlySet<string>
  readonly speciesCache: ReadonlyMap<string, SpeciesCacheEntry>
  readonly localizedCommonNames: ReadonlyMap<string, string | null>
  readonly hoveredCanonicalName: string | null
  readonly hoverTarget: SceneRendererHoverTarget | null
  /** Labels a saved view's snapshot draws; absent, the snapshot's plantDisplay decides. */
  readonly plantLabels?: PlantLabelMode
  /** Plant display rules captured for this surface (ADR 0024). */
  readonly plantDisplay: PlantDisplay
  /** Map backdrop captured for this surface (ADR 0024). */
  readonly mapBackdrop: CanvasMapBackdrop
  /** Backdrop ink resolved for `mapBackdrop` (ADR 0024). */
  readonly backdropInk: CanvasBackdropInk
  /** Immutable canvas paint tokens captured for this surface (ADR 0024). */
  readonly paintTokens: CanvasPaintTokens
  /** Annotation web-font epoch captured when this snapshot was built (ADR 0024). */
  readonly annotationFontEpoch: number
  /** Set only for the workspace map; absent, nothing is drawn (thumbnails, the overview, a presented story, the lens). */
  readonly editingAids?: SceneEditingAids
  /** True WGS84 ground measure for the session plane (contracts §20); used for measurement guide labels. */
  readonly groundMeasure?: GroundMeasure
  /** Active display unit system for measurement guide labels (defaults to `'metric'`). */
  readonly unitSystem?: UnitSystem
  /** Active interface locale for measurement guide labels (defaults to `'en'`). */
  readonly locale?: string
}

/**
 * The one scene render target (ADR 0019): the map-owned shared scene layer, which the render scheduler's one slot holds
 * (`SceneRuntimeRenderScheduler.connect`). MapLibre owns the drawing surface, its size and its frame loop; the layer reads
 * the camera frame in its own `render`, so nothing hands it a view.
 */
export interface SceneRenderTarget {
  /** Data, selection, hover or style changed. Never sent for a pan. No camera in the snapshot. */
  setSnapshot(snapshot: SceneRendererSnapshot): void
  setDraft(draft: DraftPresentation | null): void
  /** A camera frame: MapLibre draws the scene under the frame's view. */
  requestRender(): void
}
