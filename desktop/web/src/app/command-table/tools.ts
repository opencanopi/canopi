// app/command-table/tools.ts  (L2 rank 2, pure)
//
// Declares `CommandOrToolId` (contracts §18 F29, §21) ready for 2c-1 to move
// runtime tool rows and literals from `canvas/runtime/tool-id.ts` here.

import type { EditionCapabilityId } from '../../generated/edition-capabilities'

/** Tool ids aligned with `canvas/runtime/tool-id.ts` until 2c-1 moves the runtime rows here. */
export type ToolId =
  | 'select'
  | 'hand'
  | 'plant-stamp'
  | 'text'
  | 'line'
  | 'measurement-guide'
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'object-stamp'
  | 'saved-object-stamp'
  | 'plant-spacing'
  | 'profile'

export interface ToolRow {
  readonly id: ToolId
  readonly needsCanvas?: boolean
  readonly needsSpatialEditing?: boolean
  readonly requires?: readonly EditionCapabilityId[]
}

/** Single source of truth for tool capability gates and canvas requirements (contracts §21, 2.1-M164). */
export const TOOL_ROWS: Readonly<Record<ToolId, ToolRow>> = {
  select: { id: 'select', needsCanvas: true },
  hand: { id: 'hand', needsCanvas: true },
  'plant-stamp': { id: 'plant-stamp', needsSpatialEditing: true },
  text: { id: 'text', needsSpatialEditing: true },
  line: { id: 'line', needsSpatialEditing: true },
  'measurement-guide': { id: 'measurement-guide', needsSpatialEditing: true },
  rectangle: { id: 'rectangle', needsSpatialEditing: true },
  ellipse: { id: 'ellipse', needsSpatialEditing: true },
  polygon: { id: 'polygon', needsSpatialEditing: true },
  'object-stamp': { id: 'object-stamp', needsSpatialEditing: true },
  'saved-object-stamp': { id: 'saved-object-stamp', needsSpatialEditing: true, requires: ['saved-stamps'] },
  'plant-spacing': { id: 'plant-spacing', needsSpatialEditing: true },
  profile: { id: 'profile', needsCanvas: true, requires: ['site-data-below-limit'] },
}
