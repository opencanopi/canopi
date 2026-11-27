import type { PrintSetupV10 } from '../../generated/contracts'
import { editCurrentDesign, endDesignEditCoalesce, hasDesignEditAuthority, readCurrentDesign } from './core'

/** Reads the committed `print_setup` Document field for the open Design, or `null` if absent. */
export function readPrintSetup(): PrintSetupV10 | null {
  if (!hasDesignEditAuthority()) return null
  return readCurrentDesign()?.print_setup ?? null
}

/**
 * Writes the Document field `print_setup` through Design Edit under one coalescing key per PDF
 * workspace session (`2.1-M90`, `2.1-M160`, ADR 0008).
 */
export function writePrintSetup(setup: PrintSetupV10, coalesceKey: string): void {
  if (!hasDesignEditAuthority()) return
  editCurrentDesign(
    (design) => (design.print_setup === setup ? design : { ...design, print_setup: setup }),
    'print-setup',
    { coalesce: coalesceKey },
  )
}

/** Seals the open coalescing Undo entry for a PDF workspace session when the workspace closes. */
export function endPrintSetupCoalesce(coalesceKey: string): void {
  if (!hasDesignEditAuthority()) return
  endDesignEditCoalesce(coalesceKey)
}
