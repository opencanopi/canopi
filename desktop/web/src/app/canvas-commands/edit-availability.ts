import type { CanvasEditAction } from './index'

/**
 * What the table reads of a selection: `SelectionCommandAvailability`
 * (`canvas/runtime/interaction/contextual-selection-actions.ts`) fits it. Declared here because this platform-neutral
 * module may not import the runtime's types, which reach the species IPC.
 */
export interface CanvasEditSelectionAvailability {
  /** Cut, Copy and Delete: on the unlocked part of the selection, nothing structurally blocked (U59). */
  readonly copy: boolean
  /** Duplicate, Bring to front, Send to back and Lock, on the same terms. */
  readonly edit: boolean
  readonly group: boolean
  readonly ungroup: boolean
  readonly rotate: boolean
  readonly unlock: boolean
  readonly selectSameSpecies: boolean
  readonly saveAsStamp: boolean
}

/** What the table reads; each reader builds it from its own live state. */
interface CanvasEditAvailabilityInput {
  /** A canvas runtime is mounted. */
  readonly canvasAvailable: boolean
  /** Overview hides Design objects, so nothing that changes one can run. */
  readonly overview: boolean
  /** A read-only Session (2.1-M478): nothing that changes a Design object can run, as in overview. Absent: editing. */
  readonly readOnly?: boolean
  /** What the selection's commands can do; null with nothing selected. */
  readonly selection: CanvasEditSelectionAvailability | null
  /** The re-origin hold: a press, a tool transient or a text entry is live, so Cut and Delete wait (U39). */
  readonly held: boolean
  /** Some Design Object is locked, so Unlock all has something to do. */
  readonly lockedObjectsPresent: boolean
  readonly canPaste: boolean
}

/** Edits that change Design objects; overview hides objects and a read-only Session keeps them, so they run in neither. */
const MUTATING: ReadonlySet<CanvasEditAction> = new Set([
  'cut', 'paste', 'duplicate', 'delete', 'group', 'ungroup', 'bring-to-front', 'send-to-back', 'rotate', 'lock', 'unlock',
  'unlock-all', 'save-as-stamp',
])

/**
 * When an Edit command can run (canopi-f47t.52.2, S3b): the one table the menu bar and the palette
 * (`isCanvasCommandDisabled`), the canvas menu (`app/canvas-context-menu/entries.ts`) and the run-time guard
 * (`runCanvasEditAction`) read, so none keeps a rule of its own (U39). Its readers differ only in what they pass for
 * Paste: the canvas menu passes the clipboard's state, the menu bar `true` (an enabled no-op, U54 Q5).
 */
export function canvasEditAvailable(action: CanvasEditAction, input: CanvasEditAvailabilityInput): boolean {
  if (!input.canvasAvailable) return false
  if ((input.overview || input.readOnly === true) && MUTATING.has(action)) return false
  const can = input.selection
  switch (action) {
    case 'select-all': return true
    case 'paste': return input.canPaste
    case 'unlock-all': return input.lockedObjectsPresent
    case 'deselect': return can !== null
    case 'cut':
    case 'delete': return (can?.copy ?? false) && !input.held
    case 'copy': return can?.copy ?? false
    case 'duplicate':
    case 'bring-to-front':
    case 'send-to-back':
    case 'lock': return can?.edit ?? false
    case 'group': return can?.group ?? false
    case 'ungroup': return can?.ungroup ?? false
    case 'rotate': return can?.rotate ?? false
    case 'unlock': return can?.unlock ?? false
    case 'select-same-species': return can?.selectSameSpecies ?? false
    case 'save-as-stamp': return can?.saveAsStamp ?? false
  }
}
