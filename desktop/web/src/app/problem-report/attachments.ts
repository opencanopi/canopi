import { captureCurrentDesignObservation } from '../document-session/transition'
import { encodeCanopiDesign } from '../contracts/canopi-design-wire'
import { currentDesignAttachable } from './design-consent'

/** The open Design as Desktop's report attaches it; null with none open or a newer Canopi's read view (canopi-v4kj). */
export function buildCurrentDesignProblemReportAttachment(): string | null {
  if (!currentDesignAttachable()) return null
  const file = captureCurrentDesignObservation()
  return file ? `${JSON.stringify(encodeCanopiDesign(file), null, 2)}\n` : null
}
