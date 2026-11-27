// app/command-table/applicability.ts  (L2 rank 2, pure)
//
// Canvas & unified command ids, flat JSON-serialisable `CommandContext`,
// `Applicability`, and `commandApplicability` backed by
// `selectionCommandAvailability` semantics (contracts §21, 2.1-M163, 2.1-Q358).

import type {
  EditionCapabilityId,
  EditionCapabilitySet,
} from '../../generated/edition-capabilities'
import { SHELL_COMMAND_REQUIRES, type ShellCommandId } from './commands'
import { PANEL_DESCRIPTORS } from './panels'
import { isToolId, TOOL_ROWS, type ToolId } from './tools'

type CanvasCommandId =
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

type CommandId = ShellCommandId | CanvasCommandId

export type CommandOrToolId = CommandId | ToolId

/** Mirrors `SelectionCommandAvailability` (single runtime predicate for selection commands). */
interface SelectionAvailabilityContext {
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

/** Real canvas command rows with selection predicates, needs-flags, and capability gates (contracts §21). */
export const CANVAS_COMMAND_ROWS: Readonly<Record<CanvasCommandId, CommandOrToolRow>> = {
  'edit.undo': { id: 'edit.undo', needsDesign: true, needsUndo: true },
  'edit.redo': { id: 'edit.redo', needsDesign: true, needsRedo: true },
  'canvas.tool.select': { id: 'canvas.tool.select', needsCanvas: true },
  'canvas.tool.hand': { id: 'canvas.tool.hand', needsCanvas: true },
  'canvas.tool.plantStamp': { id: 'canvas.tool.plantStamp', needsSpatialEditing: true },
  'canvas.tool.plantSpacing': { id: 'canvas.tool.plantSpacing', needsSpatialEditing: true },
  'canvas.tool.objectStamp': { id: 'canvas.tool.objectStamp', needsSpatialEditing: true },
  'canvas.tool.polygon': { id: 'canvas.tool.polygon', needsSpatialEditing: true },
  'canvas.tool.rectangle': { id: 'canvas.tool.rectangle', needsSpatialEditing: true },
  'canvas.tool.ellipse': { id: 'canvas.tool.ellipse', needsSpatialEditing: true },
  'canvas.tool.line': { id: 'canvas.tool.line', needsSpatialEditing: true },
  'canvas.tool.text': { id: 'canvas.tool.text', needsSpatialEditing: true },
  'canvas.tool.measurementGuide': { id: 'canvas.tool.measurementGuide', needsSpatialEditing: true },
  'canvas.toggleGrid': { id: 'canvas.toggleGrid', needsCanvas: true },
  'canvas.toggleSnapToGrid': { id: 'canvas.toggleSnapToGrid', needsCanvas: true },
  'canvas.cut': { id: 'canvas.cut', needsSpatialEditing: true, selectionPredicate: 'copy', blockedByHold: true },
  'canvas.copy': { id: 'canvas.copy', needsCanvas: true, selectionPredicate: 'copy' },
  'canvas.paste': { id: 'canvas.paste', needsSpatialEditing: true, needsPaste: true },
  'canvas.duplicateSelected': { id: 'canvas.duplicateSelected', needsSpatialEditing: true, selectionPredicate: 'edit' },
  'canvas.deleteSelected': { id: 'canvas.deleteSelected', needsSpatialEditing: true, selectionPredicate: 'copy', blockedByHold: true },
  'canvas.selectAll': { id: 'canvas.selectAll', needsCanvas: true },
  'canvas.selectSameSpecies': { id: 'canvas.selectSameSpecies', needsCanvas: true, selectionPredicate: 'selectSameSpecies' },
  'canvas.clearSelection': { id: 'canvas.clearSelection', needsCanvas: true, selectionPredicate: 'non-empty' },
  'canvas.groupSelected': { id: 'canvas.groupSelected', needsSpatialEditing: true, selectionPredicate: 'group' },
  'canvas.ungroupSelected': { id: 'canvas.ungroupSelected', needsSpatialEditing: true, selectionPredicate: 'ungroup' },
  'canvas.bringToFront': { id: 'canvas.bringToFront', needsSpatialEditing: true, selectionPredicate: 'edit' },
  'canvas.sendToBack': { id: 'canvas.sendToBack', needsSpatialEditing: true, selectionPredicate: 'edit' },
  'canvas.rotateSelected': { id: 'canvas.rotateSelected', needsSpatialEditing: true, selectionPredicate: 'rotate' },
  'canvas.lockSelected': { id: 'canvas.lockSelected', needsSpatialEditing: true, selectionPredicate: 'edit' },
  'canvas.unlockSelected': { id: 'canvas.unlockSelected', needsSpatialEditing: true, selectionPredicate: 'unlock' },
  'canvas.unlockAll': { id: 'canvas.unlockAll', needsSpatialEditing: true, needsLockedObjects: true },
  'canvas.saveSelectionAsStamp': {
    id: 'canvas.saveSelectionAsStamp',
    requires: ['saved-stamps'],
    needsSpatialEditing: true,
    selectionPredicate: 'saveAsStamp',
  },
  'view.zoomIn': { id: 'view.zoomIn', needsCanvas: true },
  'view.zoomOut': { id: 'view.zoomOut', needsCanvas: true },
  'view.fitToDesign': { id: 'view.fitToDesign', needsCanvas: true },
  'view.zoomToSelection': { id: 'view.zoomToSelection', needsCanvas: true, selectionPredicate: 'non-empty' },
  'view.resetNorth': { id: 'view.resetNorth', needsCanvas: true },
  'view.turnViewLeft': { id: 'view.turnViewLeft', needsCanvas: true },
  'view.turnViewRight': { id: 'view.turnViewRight', needsCanvas: true },
  'view.searchPlace': { id: 'view.searchPlace', needsCanvas: true },
  'view.cycleLabels': { id: 'view.cycleLabels', needsCanvas: true },
}

const PANEL_REQUIRES_BY_ID = new Map<string, readonly EditionCapabilityId[]>(
  PANEL_DESCRIPTORS.flatMap((panel) => (panel.requires ? [[panel.commandId, panel.requires] as const] : [])),
)

/** Single source of truth resolving any command or tool id to its `CommandOrToolRow` (contracts §21, 2.1-M164). */
export function commandRowFor(id: CommandOrToolId): CommandOrToolRow {
  if (id in CANVAS_COMMAND_ROWS) return CANVAS_COMMAND_ROWS[id as CanvasCommandId]
  if (isToolId(id)) return TOOL_ROWS[id]
  const requires = PANEL_REQUIRES_BY_ID.get(id) ?? SHELL_COMMAND_REQUIRES[id as ShellCommandId]
  return requires ? { id, requires } : { id }
}
