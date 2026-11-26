/**
 * app/design-edit/admission.ts: Edit-time value predicates shared by panels and Design Edit
 * (`canopi-f47t.52.49`, contracts §10).
 */
import type { LidarColourRange } from '../../generated/contracts'

/** Whether an opacity is admitted: a finite number in [0, 1]. */
export function isAdmittedOpacity(opacity: number): boolean {
  return Number.isFinite(opacity) && opacity >= 0 && opacity <= 1
}

/** Whether a Site data colour range is admitted: a Custom range is finite with min below max. */
export function isAdmittedColourRange(range: LidarColourRange | null): boolean {
  return range?.mode !== 'Custom' || (Number.isFinite(range.min) && Number.isFinite(range.max) && range.min < range.max)
}
