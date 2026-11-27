// app/command-table/tools.ts  (L2 rank 2, pure)
// Owner of tool ids and tool descriptor rows (tool-id-literal-only-in-rows, ADR 0022 and 0024, contracts §18 F29, §21).
// Invariant: every ToolId, its read-only trait, capability gates, source requirement, Shift constraint flag,
// cursor, and Escape steps live here as data; no other module duplicates the tool-id list.

import type { EditionCapabilityId } from '../../generated/edition-capabilities'

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
  | 'siteData.pin'

type ToolEscapeStep = 'gesture' | 'nudge-series' | 'tool-transient' | 'tool' | 'selection'

type ToolCursor = 'default' | 'grab' | 'text' | 'crosshair'

type ToolSourceKind = 'species' | 'saved-stamp'

export interface ToolRow {
  readonly id: ToolId
  /** Read-only tools may arm in overview and on read-only Sessions (2.1-M478). */
  readonly readOnly: boolean
  readonly needsCanvas?: boolean
  readonly needsSpatialEditing?: boolean
  readonly requires?: readonly EditionCapabilityId[]
  readonly requiresSource?: ToolSourceKind
  /** Shift constrains points for this tool (spec §2.3). */
  readonly shiftConstrains?: boolean
  /** Drawing tool whose draft chips replace the selected zone's. */
  readonly zoneDraft?: boolean
  readonly cursor: ToolCursor
  /** Active Escape layers this tool participates in, highest priority first (S21). */
  readonly escSteps: readonly ToolEscapeStep[]
}

const DEFAULT_DRAW_ESC: readonly ToolEscapeStep[] = ['gesture', 'tool-transient', 'tool']

/** Single source of truth for tool descriptors, capability gates, read traits, and Esc steps (contracts §18 F29, §21, 2.1-M146, 2.1-M164). */
export const TOOL_ROWS: Readonly<Record<ToolId, ToolRow>> = {
  select: {
    id: 'select',
    readOnly: true,
    needsCanvas: true,
    cursor: 'default',
    escSteps: ['gesture', 'nudge-series', 'tool-transient', 'selection'],
  },
  hand: {
    id: 'hand',
    readOnly: true,
    needsCanvas: true,
    cursor: 'grab',
    escSteps: ['gesture', 'tool'],
  },
  'plant-stamp': {
    id: 'plant-stamp',
    readOnly: false,
    needsSpatialEditing: true,
    requiresSource: 'species',
    cursor: 'crosshair',
    escSteps: DEFAULT_DRAW_ESC,
  },
  text: {
    id: 'text',
    readOnly: false,
    needsSpatialEditing: true,
    cursor: 'text',
    escSteps: DEFAULT_DRAW_ESC,
  },
  line: {
    id: 'line',
    readOnly: false,
    needsSpatialEditing: true,
    shiftConstrains: true,
    zoneDraft: true,
    cursor: 'crosshair',
    escSteps: DEFAULT_DRAW_ESC,
  },
  'measurement-guide': {
    id: 'measurement-guide',
    readOnly: false,
    needsSpatialEditing: true,
    shiftConstrains: true,
    cursor: 'crosshair',
    escSteps: DEFAULT_DRAW_ESC,
  },
  rectangle: {
    id: 'rectangle',
    readOnly: false,
    needsSpatialEditing: true,
    shiftConstrains: true,
    zoneDraft: true,
    cursor: 'crosshair',
    escSteps: DEFAULT_DRAW_ESC,
  },
  ellipse: {
    id: 'ellipse',
    readOnly: false,
    needsSpatialEditing: true,
    shiftConstrains: true,
    zoneDraft: true,
    cursor: 'crosshair',
    escSteps: DEFAULT_DRAW_ESC,
  },
  polygon: {
    id: 'polygon',
    readOnly: false,
    needsSpatialEditing: true,
    shiftConstrains: true,
    zoneDraft: true,
    cursor: 'crosshair',
    escSteps: DEFAULT_DRAW_ESC,
  },
  'object-stamp': {
    id: 'object-stamp',
    readOnly: false,
    needsSpatialEditing: true,
    cursor: 'crosshair',
    escSteps: DEFAULT_DRAW_ESC,
  },
  'saved-object-stamp': {
    id: 'saved-object-stamp',
    readOnly: false,
    needsSpatialEditing: true,
    requires: ['saved-stamps'],
    requiresSource: 'saved-stamp',
    cursor: 'crosshair',
    escSteps: ['gesture', 'tool'],
  },
  'plant-spacing': {
    id: 'plant-spacing',
    readOnly: false,
    needsSpatialEditing: true,
    shiftConstrains: true,
    cursor: 'crosshair',
    escSteps: DEFAULT_DRAW_ESC,
  },
  profile: {
    id: 'profile',
    readOnly: true,
    needsCanvas: true,
    requires: ['site-data-below-limit'],
    shiftConstrains: true,
    cursor: 'crosshair',
    escSteps: DEFAULT_DRAW_ESC,
  },
  'siteData.pin': {
    id: 'siteData.pin',
    readOnly: true,
    needsCanvas: true,
    requires: ['site-data-below-limit'],
    cursor: 'crosshair',
    escSteps: ['gesture', 'tool'],
  },
}

export const TOOL_IDS: readonly ToolId[] = Object.keys(TOOL_ROWS) as ToolId[]

export function isToolId(value: string): value is ToolId {
  return Object.prototype.hasOwnProperty.call(TOOL_ROWS, value)
}
