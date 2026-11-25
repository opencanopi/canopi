// app/command-table/tools.ts  (L2 rank 2, pure)
//
// Declares `CommandOrToolId` (contracts §18 F29, §21) ready for 2c-1 to move
// runtime tool rows and literals from `canvas/runtime/tool-id.ts` here.

import type { CommandId } from './applicability'

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

export type CommandOrToolId = CommandId | ToolId
