// canvas/runtime/tools/registry.ts
//
// Owns which tools the ToolHost runs: one factory for every tool id, so an armed id is always a tool.

import type { ToolId } from '../interaction-types'
import { createMeasurementGuideTool } from './measurement-guide'
import { createObjectStampTool } from './object-stamp'
import { createPanTool } from './pan'
import { createPlantRowTool } from './plant-row'
import { createPlantStampTool } from './plant-stamp'
import { createPolygonTool } from './polygon'
import { createProfileLineTool } from './profile-line'
import { createSavedObjectStampTool } from './saved-object-stamp'
import { createSelectTool } from './select/select-tool'
import { createTextNoteTool } from './text-note'
import type { CanvasTool } from './tool'
import { createZoneDragTool } from './zone-drag'

export type ToolFactory = () => CanvasTool

export const TOOL_REGISTRY: Readonly<Record<ToolId, ToolFactory>> = Object.freeze({
  select: createSelectTool,
  hand: createPanTool,
  text: createTextNoteTool,
  'plant-stamp': createPlantStampTool,
  'plant-spacing': createPlantRowTool,
  'object-stamp': createObjectStampTool,
  'saved-object-stamp': createSavedObjectStampTool,
  line: () => createZoneDragTool('line'),
  rectangle: () => createZoneDragTool('rectangle'),
  ellipse: () => createZoneDragTool('ellipse'),
  polygon: createPolygonTool,
  'measurement-guide': createMeasurementGuideTool,
  profile: createProfileLineTool,
})
