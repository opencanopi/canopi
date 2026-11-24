import type { ReadonlySignal } from '@preact/signals'
import type { WorldPoint } from '../geo/view/types'

export interface InspectionPoint { readonly x: number; readonly y: number }
export interface InspectionLabel extends InspectionPoint {
  readonly width: number
  readonly height: number
  readonly lines: readonly string[]
}
export interface InspectedPlant {
  readonly id: string
  readonly name: string
  readonly screenPosition: InspectionPoint
  readonly label: InspectionLabel | null
}
/** The lens footprint's four corners in main-map CSS pixels, in `worldQuadToScreen` order. */
export type InspectionSourceQuad = readonly [InspectionPoint, InspectionPoint, InspectionPoint, InspectionPoint]
export interface CanvasInspectionState {
  readonly point: InspectionPoint
  /** Preview pixels per world metre, for an accurate source footprint. */
  readonly scale: number
  readonly zoomPercent: number
  readonly previewAvailable: boolean
  readonly frame: { readonly width: number; readonly height: number }
  readonly plants: readonly InspectedPlant[]
}

/** A view-only Canvas resource. Its owner also releases it on runtime teardown. */
export interface CanvasInspectionHandle {
  readonly state: ReadonlySignal<CanvasInspectionState | null>
  /** Where the lens samples, drawn on the main map: follows the main camera's frames, not only the lens's own repaints. */
  readonly sourceQuad: ReadonlySignal<InspectionSourceQuad | null>
  /** Coordinates in CSS pixels relative to the main canvas host. */
  inspectAtScreenPoint(point: InspectionPoint): void
  /** Samples at the plane point ToolHost.subscribePointerWorld publishes (its `world`), with no screen conversion of its own. */
  inspectAtWorldPoint(point: WorldPoint): void
  centerOnCanvas(): void
  /** Moves the inspected point by a drag or arrow step on the lens, in lens CSS pixels (x right, y down) along the lens's
   *  screen, which turns with the main map, at the lens's painted scale; nothing before the lens has painted. */
  panByScreen(deltaPx: InspectionPoint): void
  zoomBy(factor: number): void
  highlightPlant(id: string | null): void
  focusPlant(id: string): void
  dispose(): void
}
