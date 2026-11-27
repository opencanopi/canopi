// app/command-table/index.ts  (L2 rank 2, pure)
export * from './commands'
export * from './panels'
export * from './reserved-chords'
export { TOOL_IDS, TOOL_ROWS, type ToolId } from './tools'
export {
  commandApplicability,
  commandRowFor,
  type Applicability,
  type CommandContext,
  type CommandOrToolRow,
} from './applicability'
export { EDITION_CAPABILITIES, type EditionCapabilityId } from '../../generated/edition-capabilities'
