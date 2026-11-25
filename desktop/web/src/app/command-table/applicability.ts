// app/command-table/applicability.ts  (L2 rank 2, pure)
//
// Canvas & unified command ids, flat JSON-serialisable `CommandContext`,
// `Applicability`, and `commandApplicability` backed by
// `selectionCommandAvailability` semantics (contracts §21, 2.1-M163, 2.1-Q358).

import type {
  EditionCapabilityId,
  EditionCapabilitySet,
} from '../../generated/edition-capabilities'
import type { ShellCommandId } from './commands'

export type CanvasCommandId =
  | 'edit.undo'
  | 'edit.redo'
  | 'canvas.tool.select'
  | 'canvas.tool.hand'
  | 'canvas.tool.plantStamp'
  | 'canvas.tool.plantSpacing'
  | 'canvas.tool.objectStamp'
  | 'canvas.tool.polygon'
  | 'canvas.tool.rectangle'
  | 'canvas.tool.ellipse'
  | 'canvas.tool.line'
  | 'canvas.tool.text'
  | 'canvas.tool.measurementGuide'
  | 'canvas.toggleGrid'
  | 'canvas.toggleSnapToGrid'
  | 'canvas.cut'
  | 'canvas.copy'
  | 'canvas.paste'
  | 'canvas.duplicateSelected'
  | 'canvas.deleteSelected'
  | 'canvas.selectAll'
  | 'canvas.selectSameSpecies'
  | 'canvas.clearSelection'
  | 'canvas.groupSelected'
  | 'canvas.ungroupSelected'
  | 'canvas.bringToFront'
  | 'canvas.sendToBack'
  | 'canvas.rotateSelected'
  | 'canvas.lockSelected'
  | 'canvas.unlockSelected'
  | 'canvas.unlockAll'
  | 'canvas.saveSelectionAsStamp'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.fitToDesign'
  | 'view.zoomToSelection'
  | 'view.resetNorth'
  | 'view.turnViewLeft'
  | 'view.turnViewRight'
  | 'view.searchPlace'
  | 'view.cycleLabels'

export type CommandId = ShellCommandId | CanvasCommandId

/** Mirrors `SelectionCommandAvailability` (single runtime predicate for selection commands). */
export interface SelectionAvailabilityContext {
  readonly copy: boolean
  readonly edit: boolean
  readonly group: boolean
  readonly ungroup: boolean
  readonly rotate: boolean
  readonly unlock: boolean
  readonly selectSameSpecies: boolean
  readonly saveAsStamp: boolean
}

/** Flat, JSON-serialisable command evaluation context (contracts §21). */
export interface CommandContext {
  readonly capabilities: readonly EditionCapabilityId[]
  readonly hasDesign: boolean
  readonly revertAvailable: boolean
  readonly canvasAvailable: boolean
  readonly spatialEditingAvailable: boolean
  readonly readOnly: boolean
  readonly selection: SelectionAvailabilityContext | null
  readonly held: boolean
  readonly lockedObjectsPresent: boolean
  readonly canPaste: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
}

export type Applicability =
  | 'enabled'
  | 'disabled'
  | 'hidden'
  | { readonly lacking: readonly EditionCapabilityId[] }

export interface CommandOrToolRow {
  readonly id: string
  readonly requires?: readonly EditionCapabilityId[]
  readonly needsDesign?: boolean
  readonly needsWritableDesign?: boolean
  readonly needsCanvas?: boolean
  readonly needsSpatialEditing?: boolean
  readonly selectionPredicate?: keyof SelectionAvailabilityContext | 'non-empty'
  readonly blockedByHold?: boolean
  readonly needsLockedObjects?: boolean
  readonly needsPaste?: boolean
  readonly needsUndo?: boolean
  readonly needsRedo?: boolean
  readonly hidden?: boolean
}

/** Capabilities from `requires` that `present` lacks. */
export function lackingCapabilities(
  requires: readonly EditionCapabilityId[] | undefined,
  present: EditionCapabilitySet | readonly EditionCapabilityId[],
): readonly EditionCapabilityId[] {
  if (!requires || requires.length === 0) return []
  const set = present instanceof Set ? present : new Set(present)
  return requires.filter((cap) => !set.has(cap))
}

function isSessionOrCanvasDisabled(row: CommandOrToolRow, ctx: CommandContext): boolean {
  if (row.needsDesign && !ctx.hasDesign) return true
  if (row.needsWritableDesign && (!ctx.hasDesign || ctx.readOnly)) return true
  if (row.needsCanvas && !ctx.canvasAvailable) return true
  if (row.needsSpatialEditing && (!ctx.canvasAvailable || !ctx.spatialEditingAvailable || ctx.readOnly)) return true
  return false
}

function isSelectionOrEditDisabled(row: CommandOrToolRow, ctx: CommandContext): boolean {
  if (row.needsUndo && (!ctx.canUndo || ctx.readOnly)) return true
  if (row.needsRedo && (!ctx.canRedo || ctx.readOnly)) return true
  if (row.needsPaste && !ctx.canPaste) return true
  if (row.needsLockedObjects && !ctx.lockedObjectsPresent) return true
  if (row.blockedByHold && ctx.held) return true
  if (!row.selectionPredicate) return false
  if (!ctx.selection) return true
  return row.selectionPredicate !== 'non-empty' && !ctx.selection[row.selectionPredicate]
}

/**
 * Single runtime applicability predicate (contracts §21): evaluates capability
 * gates first (`lacking`), then `hidden`, then session/canvas/selection rules
 * backed by `selectionCommandAvailability`.
 */
export function commandApplicability(row: CommandOrToolRow, ctx: CommandContext): Applicability {
  const lacking = lackingCapabilities(row.requires, ctx.capabilities)
  if (lacking.length > 0) return { lacking }
  if (row.hidden) return 'hidden'
  if (isSessionOrCanvasDisabled(row, ctx) || isSelectionOrEditDisabled(row, ctx)) return 'disabled'
  return 'enabled'
}
