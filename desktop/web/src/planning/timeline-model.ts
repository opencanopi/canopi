import type { PanelTarget, TimelineAction } from '../types/design'

function panelTargetEquals(left: PanelTarget, right: PanelTarget): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'placed_plant':
      return left.plant_id === (right as Extract<PanelTarget, { kind: 'placed_plant' }>).plant_id
    case 'species':
      return left.canonical_name === (right as Extract<PanelTarget, { kind: 'species' }>).canonical_name
    case 'zone':
      return left.zone_id === (right as Extract<PanelTarget, { kind: 'zone' }>).zone_id
    case 'manual':
    case 'none':
      return true
  }
}

function panelTargetListEquals(left: readonly PanelTarget[], right: readonly PanelTarget[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (!panelTargetEquals(left[i]!, right[i]!)) return false
  }
  return true
}

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
    panelTargetListEquals(next.targets, existing.targets) &&
    next.depends_on === existing.depends_on
  ) {
    return timeline as TimelineAction[]
  }

  const updated = [...timeline]
  updated[index] = next
  return updated
}
