import { computed, signal } from '@preact/signals'
import type { PlantSymbolId } from '../generated/known-canopi-keys'
import type { ToolId } from './runtime/interaction-types'

// UI mirror state only, one name per signal (canvas/session.ts re-exports them). SceneCanvasRuntime owns the authoritative
// canvas selection.
export const currentCanvasTool = signal<ToolId>('select')
export const currentCanvasSelection = signal<Set<string>>(new Set())

export function setCanvasTool(id: ToolId): void {
  currentCanvasTool.value = id
}

export function setCanvasSelection(
  ids: Iterable<string>,
  options: { readonly publishIfUnchanged?: boolean } = {},
): void {
  const next = new Set(ids)
  const current = currentCanvasSelection.value
  const unchanged = next.size === current.size && [...next].every((id) => current.has(id))
  if (unchanged && !options.publishIfUnchanged) return
  currentCanvasSelection.value = next
}

export const currentCanvasHasSelection = computed(() => currentCanvasSelection.value.size > 0)

/** A mouse or pen rests on the overview's Design pin, as the map's hover finds it: the pin shows its tooltip (canopi-n2cg). */
export const currentCanvasDesignPinHovered = signal(false)

export function setCanvasDesignPinHovered(hovered: boolean): void {
  currentCanvasDesignPinHovered.value = hovered
}

/** A drag refused by a lock (2.1-Q177): a fresh notice per refused drag, which the lock toast shows until dismissed. */
interface CanvasLockedMoveNotice {
  readonly id: number
}

export const currentCanvasLockedMoveNotice = signal<CanvasLockedMoveNotice | null>(null)
let lockedMoveNoticeIds = 0

export function noteCanvasLockedMoveRefused(): void {
  lockedMoveNoticeIds += 1
  currentCanvasLockedMoveNotice.value = { id: lockedMoveNoticeIds }
}

/** Dismisses `notice`, only while it is still the one shown. */
export function dismissCanvasLockedMoveNotice(notice: CanvasLockedMoveNotice): void {
  if (currentCanvasLockedMoveNotice.peek() === notice) currentCanvasLockedMoveNotice.value = null
}

/** What a stamp pick places: the tool card names it and counts its plants and species. */
export interface CanvasStampGuidance {
  readonly kind: 'plant' | 'zone' | 'annotation' | 'group'
  /** The plant's name or the group's name; null when the object has none to show. */
  readonly name: string | null
  readonly plants: number
  readonly species: number
}

/**
 * Plant a row, as the tool card shows it: which step it is on, the picked
 * plant, the spacing field and how many plants the row would add.
 */
export interface CanvasPlantRowGuidance {
  /** `pick`: click a plant; `missed`: that click found no usable plant; `row`: a plant is picked. */
  readonly phase: 'pick' | 'missed' | 'row'
  /** The picked plant's shown name. */
  readonly plantName: string | null
  /** The picked plant's symbol and colour, for the card's glyph. */
  readonly glyph: { readonly symbol: PlantSymbolId; readonly color: string } | null
  /** The spacing field's text, as typed. */
  readonly interval: string
  readonly intervalValid: boolean
  /** Plants the drawn row would add; null before a row is drawn. */
  readonly count: number | null
  /** `dense` above 100 plants; `blocked` above the most one row may add. */
  readonly density: 'normal' | 'dense' | 'blocked'
  /** Moves each time the spacing field should take focus (a plant picked, an invalid spacing kept). */
  readonly focusRequest: number
  // The path (U58): absent fields read as a row of the picked plant alone, whose card is the straight row's.
  /** The row's points, the picked plant counted; from 2 the card offers the finish, the mode and the length. */
  readonly points?: number
  /** The points close into a loop. */
  readonly closed?: boolean
  /** "Every N m" (`interval`) or "N plants" (`count`, the picked plant counted). */
  readonly mode?: 'interval' | 'count'
  /** The count field's text, as typed, and whether it is a count of 2 to 5001 (Plant a row's own limit). */
  readonly countText?: string
  readonly countValid?: boolean
  /** The drawn row's length, formatted as the map's length chip. */
  readonly length?: string | null
  /** On a loop in "every N m": the equal gap the interval rounds to, formatted. */
  readonly loopSpacing?: string | null
  /** The pointer that last pressed or hovered the map was a finger: the card's targets grow to 44 px. */
  readonly touch?: boolean
}

/** The active tool's state as the tool card explains it. UI mirror state only. */
export interface CanvasToolGuidance {
  /** A gesture is in progress, so Esc cancels it rather than leaving the tool. */
  readonly gesture: boolean
  /** Place a stamp: the object picked to copy, once there is one. */
  readonly stamp: CanvasStampGuidance | null
  /** Place a stamp: the held stamp's angle in degrees (clockwise, `[` and `]` turn it), or null without one. */
  readonly stampRotationDeg: number | null
  /**
   * Place plants: the clicks on the map that found no species chosen, since one was (0: none). While above 0 the card
   * points to its chooser, and each new one points to it again.
   */
  readonly speciesPrompts: number
  /** Plant a row's step and spacing field. */
  readonly plantRow: CanvasPlantRowGuidance | null
}

export const IDLE_CANVAS_TOOL_GUIDANCE: CanvasToolGuidance = Object.freeze({ gesture: false, stamp: null, stampRotationDeg: null, speciesPrompts: 0, plantRow: null })

/** The active tool's gesture and stamp state, for the tool card. */
export const currentCanvasToolGuidance = signal<CanvasToolGuidance>(IDLE_CANVAS_TOOL_GUIDANCE)

export function setCanvasToolGuidance(next: CanvasToolGuidance): void {
  const current = currentCanvasToolGuidance.peek()
  if (
    current.gesture === next.gesture
    && current.speciesPrompts === next.speciesPrompts
    && current.stampRotationDeg === next.stampRotationDeg
    && stampGuidanceEqual(current.stamp, next.stamp)
    && plantRowGuidanceEqual(current.plantRow, next.plantRow)
  ) return
  currentCanvasToolGuidance.value = next
}

function stampGuidanceEqual(a: CanvasStampGuidance | null, b: CanvasStampGuidance | null): boolean {
  if (a === null || b === null) return a === b
  return a.kind === b.kind && a.name === b.name && a.plants === b.plants && a.species === b.species
}

function plantRowGuidanceEqual(a: CanvasPlantRowGuidance | null, b: CanvasPlantRowGuidance | null): boolean {
  if (a === null || b === null) return a === b
  return a.phase === b.phase && a.plantName === b.plantName && a.interval === b.interval
    && a.glyph?.symbol === b.glyph?.symbol && a.glyph?.color === b.glyph?.color
    && a.intervalValid === b.intervalValid && a.count === b.count && a.density === b.density
    && a.focusRequest === b.focusRequest
    && a.points === b.points && a.closed === b.closed && a.mode === b.mode
    && a.countText === b.countText && a.countValid === b.countValid
    && a.length === b.length && a.loopSpacing === b.loopSpacing
    && a.touch === b.touch
}
