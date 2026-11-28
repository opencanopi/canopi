// app/canvas-map-surface/host-view.ts  (L3 leaf)
//
// Thin, runtime-free leaf module holding the active CanvasHostView signal and its read/retry
// helpers (docs/plans/2-1-foundations-contracts.md §5). Sibling panels (LayersPanel, WebLayersPanel)
// import only this leaf so they never pull canvas-host.ts and the canvas runtime into the entry chunk.

import { signal, type ReadonlySignal } from '@preact/signals'
import type { LayerSlotId, LayerStatus, MapLifetimeState } from '../../maplibre/map-lifetime'

export type CanvasUnavailableCause = 'runtime-failed' | 'start-cancelled' | 'runtime-destroyed'

export type MapRetryAvailability = 'offered' | 'withheld' | 'never'

export type CanvasSurfaceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'unavailable', readonly cause: CanvasUnavailableCause }
  | { readonly kind: 'map', readonly map: MapLifetimeState, readonly retry: MapRetryAvailability }
  | { readonly kind: 'releasing' }

export interface CanvasHostView {
  readonly surface: ReadonlySignal<CanvasSurfaceState>
  readonly ready: ReadonlySignal<boolean>
  retryMap(): boolean
  retryLayer(slot: LayerSlotId): void
}

export const IDLE_CANVAS_SURFACE_STATE: CanvasSurfaceState = Object.freeze({ kind: 'idle' })

const activeCanvasHostView = signal<CanvasHostView | null>(null)

/** Publishes or clears the active CanvasHostView (written by canvas-host.ts on mount/dispose). */
export function setCurrentCanvasHostView(view: CanvasHostView | null): void {
  activeCanvasHostView.value = view
}

/** Clears the active CanvasHostView only if it is still `view`. */
export function clearCurrentCanvasHostView(view: CanvasHostView): void {
  if (activeCanvasHostView.peek() === view) activeCanvasHostView.value = null
}

/** Per-slot LayerStatus map of the active map when ready, else null. */
export function readCurrentCanvasLayerStatuses(): ReadonlyMap<LayerSlotId, LayerStatus> | null {
  const current = activeCanvasHostView.value?.surface.value
  return current?.kind === 'map' && current.map.kind === 'ready' ? current.map.layers : null
}

/** Routes a layer Retry click to the active canvas host view, if mounted. */
export function retryCurrentCanvasLayer(slot: LayerSlotId): void {
  activeCanvasHostView.value?.retryLayer(slot)
}
