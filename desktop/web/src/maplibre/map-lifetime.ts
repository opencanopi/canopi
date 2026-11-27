// maplibre/map-lifetime.ts  (L1)
//
// Owner of MapLibre map construction and style readiness (`map-constructor-only-in-factory`,
// `style-load-only-in-map-lifetime`, ADR 0024, contracts §5 & §6, §18 F4). Invariant: MapLifetimeHandle and
// MapLifetimeState are the single contract for map creation, style load, and disposal; imports nothing from app/ or canvas/.

import { signal, type ReadonlySignal } from '@preact/signals'

/** Fixed slots for the background band and terrain; library rasters and vectors are keyed by layer id. */
export type LayerSlotId = 'background' | 'terrain' | `library:${string}`

export type LayerStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly reason: string; readonly label?: string }
  | { readonly kind: 'skipped'; readonly reason: string }

export type MapFailureCause = 'no-webgl2' | 'engine-start' | 'style' | 'context-lost'

export type MapLifetimeState =
  | { readonly kind: 'creating', readonly attempt: number }
  | { readonly kind: 'admitted', readonly attempt: number }
  | { readonly kind: 'ready', readonly attempt: number, readonly layers: ReadonlyMap<LayerSlotId, LayerStatus> }
  | { readonly kind: 'failed', readonly attempt: number, readonly cause: MapFailureCause }
  | { readonly kind: 'released' }

/**
 * 2b-2's interface to a map slot's lifetime, backed in 2b by the workspace composition and replaced in 2d-2
 * by the standalone MapLibre lifetime owner. Holds no Retry policy (§5).
 */
export interface MapLifetimeHandle {
  readonly state: ReadonlySignal<MapLifetimeState>
  /** Moves a failed map to a new creating attempt; returns true when a restart started. */
  restart(): boolean
  /** Retries a single failed layer slot (e.g. 'background' for basemap/satellite) on a live map. */
  retryLayer(slot: LayerSlotId): void
  /** Releases contributions and the map. */
  release(): void
}

function layerStatusEquals(left: LayerStatus | undefined, right: LayerStatus | undefined): boolean {
  if (left === right) return true
  if (!left || !right || left.kind !== right.kind) return false
  if (left.kind === 'failed' && right.kind === 'failed') {
    return left.reason === right.reason && left.label === right.label
  }
  return left.kind !== 'skipped' || left.reason === (right as typeof left).reason
}

export function mapLifetimeStateEquals(left: MapLifetimeState, right: MapLifetimeState): boolean {
  if (left === right) return true
  if (left.kind !== right.kind) return false
  if (left.kind === 'released') return true
  if (left.attempt !== (right as typeof left).attempt) return false
  if (left.kind === 'failed') return left.cause === (right as typeof left).cause
  if (left.kind !== 'ready') return true
  const rightLayers = (right as typeof left).layers
  if (left.layers.size !== rightLayers.size) return false
  for (const [slot, status] of left.layers) {
    if (!layerStatusEquals(status, rightLayers.get(slot))) return false
  }
  return true
}

export interface MapLifetimeSlot {
  readonly handle: MapLifetimeHandle
  setState(next: MapLifetimeState): void
}

/**
 * Owns the single signal<MapLifetimeState> for a map slot so no other module holds map state in a signal (§5).
 * 2b-2 binds the workspace composition's restart/retryLayer/release actions here; 2d-2 replaces the backing owner.
 */
export function createMapLifetimeSlot(actions: {
  readonly restart: () => boolean
  readonly retryLayer: (slot: LayerSlotId) => void
  readonly release: () => void
}, initial: MapLifetimeState = { kind: 'creating', attempt: 0 }): MapLifetimeSlot {
  const state = signal<MapLifetimeState>(initial)
  return {
    handle: {
      state,
      restart: actions.restart,
      retryLayer: actions.retryLayer,
      release: () => {
        actions.release()
        if (state.peek().kind !== 'released') state.value = { kind: 'released' }
      },
    },
    setState(next) {
      if (!mapLifetimeStateEquals(state.peek(), next)) state.value = next
    },
  }
}
