// app/keyboard/arming.ts
// Owner of tool arming for app code: armCanvasTool is the only app caller of the runtime's arm (tool-arming-only-in-arm-canvas-tool,
// ADR 0018; §18 F29). Invariants: every arm names its `from`; a read-only Session arms only Select and Pan (2.1-M478).
//
// The one way app code arms a canvas tool (spec §1.6, policy P9). Each caller passes its own `from`: the rail, menus,
// palette and both editions' keys reach here through the one canvas runner (runCanvasIntent in
// app/workspace-commands/canvas-actions.ts, behind runCatalogCommand and the projected action(from)); a catalog panel's
// Place, Favorites' Place stamp, the tool card's stamp chooser and the Start card call it directly. Arming writes the source to the
// module read models first (canvas/plant-stamp-source.ts, canvas/saved-object-stamp-source.ts: what the tool card,
// recents and choosers show, and what the session reads when the tool activates), selects the canvas panel for the
// command and Start-card callers, sets the tool on the live canvas session and focuses the map for every `from` but a
// shortcut, which leaves focus where it is. In overview a drawing tool first fits the Design as Return to Design does (an
// empty or too-large Design zooms in about the view centre), so every path that picks a tool leaves overview before the
// tool activates (canopi-n2cg); Select and Pan work in overview as they are. A drop arms in the runtime, with no `from`.
// Rail learning is not recorded here: it stays an effect on every tool change (app/tool-rail/learning.ts).

import type { CanvasCommandFrom } from '../canvas-commands'
import { TOOL_ROWS, type ToolId } from '../command-table'
import type { MapInputHandle, MapInputRequest, ToolSource } from '../../canvas/runtime/interaction-types'
import { selectPlantStampSource } from '../../canvas/plant-stamp-source'
import { selectSavedObjectStampSource } from '../../canvas/saved-object-stamp-source'
import {
  currentCanvasQuerySurface,
  currentCanvasToolCommandSurface,
  currentCanvasViewportCommandSurface,
} from '../../canvas/session'
import { activePanel, designShownReadOnly, selectPanel } from '../shell/state'
import { focusOwner } from './focus-owner'

/** Who armed the tool: a command surface (CanvasCommandFrom), a panel's Place, the tool card or the Start card. */
export type ArmFrom = CanvasCommandFrom | 'panel' | 'card' | 'start-card'

export interface ArmCanvasToolOptions<T = unknown> {
  readonly from: ArmFrom
  readonly source?: ToolSource
  readonly request?: MapInputRequest<T>
}

/** Arms a canvas tool through ToolHost and returns its single-settlement map input handle, or null when dropped/refused. */
function armCanvasToolRequest<T = unknown>(
  tool: ToolId,
  options: ArmCanvasToolOptions<T>,
): MapInputHandle<T> | null {
  const { from, source, request } = options
  const row = TOOL_ROWS[tool]
  if (!row.readOnly && designShownReadOnly()) return null
  const command = from !== 'panel' && from !== 'card'
  if (command && activePanel.peek() !== 'canvas') selectPanel('canvas')
  const tools = currentCanvasToolCommandSurface.peek()
  if (source?.kind === 'species') {
    // Kept with no canvas too: Place plants' chooser offers it again.
    selectPlantStampSource(source.species)
  } else if (source?.kind === 'saved-stamp' && tools) {
    selectSavedObjectStampSource(source.stamp, source.name ?? null)
  }
  // 2.1-Q41: a tool picked with no Design/canvas open is dropped, never queued.
  if (!tools) return null
  if (!row.readOnly && currentCanvasQuerySurface.peek()?.view.mode.peek() === 'overview') {
    // Fit first, so the tool's first configure sees site mode (the fit jumps; the mode is current on return).
    currentCanvasViewportCommandSurface.peek()?.returnToDesign({ around: 'view-centre' })
  }
  const handle = tools.arm(tool, source ?? null, request)
  if (from !== 'shortcut') focusOwner.focusMap()
  return handle
}

/** True when a canvas session took the tool. */
export function armCanvasTool<T = unknown>(
  tool: ToolId,
  options: ArmCanvasToolOptions<T>,
): boolean {
  return armCanvasToolRequest(tool, options) !== null
}
