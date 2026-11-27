// canvas/runtime/interaction-types.ts  (types)

import type { PlantStampSourceInput } from '../stamp-drag-data'
import type { SavedObjectStampPayload } from '../saved-object-stamp-payload'

export type PointerKind = 'mouse' | 'pen' | 'touch'
export interface Modifiers { readonly shift: boolean; readonly ctrl: boolean; readonly alt: boolean; readonly meta: boolean }
export type CancelReason = 'pointercancel' | 'lost-capture' | 'blur' | 'hidden' | 'escape' | 'multitouch' | 'tool-change'
  | 'navigate'                                                  // a Pan-tool press whose drag panned: after its pan end (spec §2.2)
export type { ToolId } from '../../app/command-table'
/** Arming payloads that arrive with a tool arm (species or saved stamp). */
export type ToolSource =
  | { readonly kind: 'species'; readonly species: PlantStampSourceInput }
  | { readonly kind: 'saved-stamp'; readonly stamp: SavedObjectStampPayload; readonly name?: string | null }
/** Why a map input request settled without a pick (contracts §5, 2c-1). */
export type MapInputCancelReason = 'escape' | 'tool-change' | 'design-closed' | 'superseded'
/** Single-settlement outcome of a map input request armed via `tools.arm(id, source, request)`. */
export type MapInputOutcome<T = unknown> =
  | { readonly kind: 'picked'; readonly value: T }
  | { readonly kind: 'cancelled'; readonly reason: MapInputCancelReason }
  | { readonly kind: 'detached' }
/** Request options passed to `tools.arm(id, source, request)`. */
export interface MapInputRequest<T = unknown> {
  /** Called at most once when the request settles. */
  readonly onSettled?: (outcome: MapInputOutcome<T>) => void
}
/** Handle returned by `tools.arm(id, source, request)`; `settled` resolves once. */
export interface MapInputHandle<T = unknown> {
  readonly settled: Promise<MapInputOutcome<T>>
  cancel(reason?: MapInputCancelReason): void
}
/** 'rotate', 'vertex:<zone id>:<index>', 'rect-corner:<id>:ne', 'guide-end:<id>:a', 'edge-mid:<zone id>:<index>'. */
export type ToolHandleId = string & { readonly __toolHandleId: true }
/** What a panel drag carries, read from dataTransfer by the DOM source (today plant-stamp-source.ts and saved-object-stamp-source.ts). */
export type CanvasDropPayload =
  | { readonly kind: 'species'; readonly species: PlantStampSourceInput | null }   // null on dragover: the browser hides the data until the drop; the MIME type says species
  | { readonly kind: 'saved-stamp'; readonly stamp: SavedObjectStampPayload }
  | { readonly kind: 'unknown' }                                // over the map but not ours: no drop cue
/** A plant or saved stamp dropped on the overview: it fits the Design and stays picked, placing nothing (canopi-n2cg). */
export type OverviewDropPayload =
  | { readonly kind: 'species'; readonly species: PlantStampSourceInput }
  | { readonly kind: 'saved-stamp'; readonly stamp: SavedObjectStampPayload }
// PlantStampSourceInput (canvas/plant-stamp-source.ts) and SavedObjectStampPayload are type-only imports.
