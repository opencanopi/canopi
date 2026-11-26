import { getLiveSessionCore } from '../document-session/live-core'
import { flattenDocumentForJson } from '../contracts/document'

/** The open Design as Desktop's report attaches it; null with none open or a newer Canopi's read view (canopi-v4kj). */
export function buildCurrentDesignProblemReportAttachment(): string | null {
  const core = getLiveSessionCore()
  const open = core?.currentDesign.peek()
  if (!core || !open || (open.readOnly && open.savedByVersion !== null)) return null
  const file = core.snapshot()
  return file ? `${JSON.stringify(flattenDocumentForJson(file), null, 2)}\n` : null
}
