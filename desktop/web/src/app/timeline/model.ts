import { targets } from '../../target'
import type { TimelineAction } from '../../generated/contracts'

export function applyTimelineActionPatch(
  timeline: readonly TimelineAction[],
  actionId: string,
  patch: Partial<TimelineAction>,
): TimelineAction[] {
  const index = timeline.findIndex((action) => action.id === actionId)
  if (index === -1) return timeline as TimelineAction[]
  const existing = timeline[index]!
  const next = { ...existing, ...patch }
  if (
    next.start_date === existing.start_date &&
    next.end_date === existing.end_date &&
    next.action_type === existing.action_type &&
    next.description === existing.description &&
    next.order === existing.order &&
    next.completed === existing.completed &&
    next.recurrence === existing.recurrence &&
    targets.listEquals(next.targets, existing.targets) &&
    next.depends_on === existing.depends_on
  ) {
    return timeline as TimelineAction[]
  }

  const updated = [...timeline]
  updated[index] = next
  return updated
}
