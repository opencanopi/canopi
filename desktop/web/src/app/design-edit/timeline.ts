import type { PanelTarget, TimelineAction } from '../../types/design'
import { editDesignArray } from './core'
import { applyTimelineActionPatch } from '../../planning/timeline-model'

export interface CalendarActionFormData {
  readonly action_type: string
  readonly start_date: string
  readonly end_date: string
  readonly description: string
  readonly completed: boolean
  readonly targets: readonly PanelTarget[]
}

export function addTimelineAction(action: Omit<TimelineAction, 'order'>): void {
  editDesignArray('timeline', (timeline) => {
    let maxOrder = -1
    for (const existing of timeline) {
      if (existing.order > maxOrder) maxOrder = existing.order
    }
    return [...timeline, { ...action, order: maxOrder + 1 }]
  }, 'timeline.add')
}

export function updateTimelineAction(
  actionId: string,
  patch: Partial<TimelineAction>,
): void {
  editDesignArray('timeline', (timeline) => applyTimelineActionPatch(timeline, actionId, patch), 'timeline.update')
}

export function deleteTimelineAction(actionId: string): void {
  editDesignArray('timeline', (timeline) => {
    if (!timeline.some((action) => action.id === actionId)) return timeline
    return timeline.filter((action) => action.id !== actionId)
  }, 'timeline.delete')
}

export function createCalendarActionFromFormData(
  id: string,
  data: CalendarActionFormData,
): Omit<TimelineAction, 'order'> {
  return {
    id,
    action_type: data.action_type,
    description: data.description,
    start_date: data.start_date || null,
    end_date: data.end_date || null,
    recurrence: null,
    targets: data.targets.map((target) => ({ ...target })),
    depends_on: null,
    completed: data.completed,
  }
}

export function calendarActionPatchFromFormData(
  data: CalendarActionFormData,
  includeTargets: boolean,
): Partial<TimelineAction> {
  return {
    action_type: data.action_type,
    description: data.description,
    start_date: data.start_date || null,
    end_date: data.end_date || null,
    completed: data.completed,
    ...(includeTargets
      ? { targets: data.targets.map((target) => ({ ...target })) }
      : {}),
  }
}
