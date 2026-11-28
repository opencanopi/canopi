// app/keyboard/arming.ts
// Owner of tool arming for app code: armCanvasTool is the only app caller of the runtime's arm (tool-arming-only-in-arm-canvas-tool,
// ADR 0018; §18 F29). Invariants: every arm names its `from`; a read-only Session arms only Select and Pan (2.1-M478).
//
// The one way app code arms a canvas tool (spec §1.6, policy P9). Each caller passes its own `from`: the rail, menus,
// palette and both editions' keys reach here through the one canvas runner (runCanvasIntent in
// app/workspace-commands/canvas-actions.ts, behind runCatalogCommand and the projected action(from)); a catalog panel's
// Place, Favorites' Place stamp, the tool card's stamp chooser and the Start card call it directly. Arming records any
// chosen species in recentPlantStampSources, selects the canvas panel for the command and Start-card callers, arms the
// tool on the live canvas session (ToolHost owns the armed source) and focuses the map for every `from` but a
// shortcut, which leaves focus where it is. In overview a drawing tool first fits the Design as Return to Design does (an
// empty or too-large Design zooms in about the view centre), so every path that picks a tool leaves overview before the
// tool activates (canopi-n2cg); Select and Pan work in overview as they are. A drop arms in the runtime, with no `from`.
// Rail learning is not recorded here: it stays an effect on every tool change (app/tool-rail/learning.ts).

import { signal } from '@preact/signals'
import type { CanvasCommandFrom } from '../canvas-commands'
import {
  lackingCapabilities,
  TOOL_ROWS,
  type EditionCapabilityId,
  type ToolId,
} from '../command-table'
import type { MapInputHandle, MapInputRequest, ToolSource } from '../../canvas/runtime/interaction-types'
import { recordRecentPlantStampSource } from '../../canvas/stamp-drag-data'
import {
  currentCanvasQuerySurface,
  currentCanvasToolCommandSurface,
  currentCanvasViewportCommandSurface,
} from '../../canvas/session'
import { designShownReadOnly } from '../shell/state'
import { focusOwner } from './focus-owner'

/** Who armed the tool: a command surface (CanvasCommandFrom), a panel's Place, the tool card or the Start card. */
export type ArmFrom = CanvasCommandFrom | 'panel' | 'card' | 'start-card'

export interface ArmCanvasToolOptions<T = unknown> {
  readonly from: ArmFrom
  readonly source?: ToolSource
  readonly request?: MapInputRequest<T>
  readonly capabilities?: ReadonlySet<EditionCapabilityId>
}

const capabilityReader = signal<(() => ReadonlySet<EditionCapabilityId> | null) | null>(null)

/** Registers the edition's capability reader so arming enforces `TOOL_ROWS[tool].requires` without importing platform/. */
export function setToolCapabilityReader(read: (() => ReadonlySet<EditionCapabilityId> | null) | null): void {
  capabilityReader.value = read
}

function canArmTool(tool: ToolId, explicitCapabilities?: ReadonlySet<EditionCapabilityId>): boolean {
  const row = TOOL_ROWS[tool]
  if (!row.readOnly && designShownReadOnly()) return false
  const capabilities = explicitCapabilities ?? capabilityReader.peek()?.() ?? null
  return !(row.requires?.length && capabilities && lackingCapabilities(row.requires, capabilities).length > 0)
}

/** Arms a canvas tool through ToolHost and returns its single-settlement map input handle, or null when dropped/refused. */
function armCanvasToolRequest<T = unknown>(
  tool: ToolId,
  options: ArmCanvasToolOptions<T>,
): MapInputHandle<T> | null {
  const { from, source, request } = options
  if (!canArmTool(tool, options.capabilities)) {
    request?.onSettled?.({ kind: 'detached' })
    return null
  }
  const row = TOOL_ROWS[tool]
  const tools = currentCanvasToolCommandSurface.peek()
  if (source?.kind === 'species') {
    // Kept with no canvas too: Place plants' chooser offers it again in recents.
    recordRecentPlantStampSource(source.species)
  }
  // 2.1-Q41: a tool picked with no Design/canvas open is dropped, never queued.
  if (!tools) {
    request?.onSettled?.({ kind: 'detached' })
    return null
  }
  if (!row.worksInOverview && currentCanvasQuerySurface.peek()?.view.mode.peek() === 'overview') {
    // Fit first, so the tool's first configure sees site mode (the fit jumps; the mode is current on return).
    currentCanvasViewportCommandSurface.peek()?.returnToDesign({ around: 'view-centre' })
  }
  const handle = tools.arm(tool, source, request)
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
