import { captureCurrentDesignObservation } from '../document-session/transition'
import { encodeCanopiDesign } from '../contracts/canopi-design-wire'

/** The open Design as Desktop's report attaches it; null with none open or a newer Canopi's read view (canopi-v4kj). */
export function buildCurrentDesignProblemReportAttachment(): string | null {
  const file = captureCurrentDesignObservation()
  return file ? `${JSON.stringify(encodeCanopiDesign(file), null, 2)}\n` : null
}
