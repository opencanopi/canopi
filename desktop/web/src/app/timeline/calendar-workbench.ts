import { useCallback, useEffect, useRef } from 'preact/hooks'
import { useSignal } from '@preact/signals'
import type { PanelTarget, TimelineAction } from '../../types/design'
import { MANUAL_TARGET, targetIdentity } from '../../target'
import { createUuid } from '../../utils/ids'
import {
  addTimelineAction,
  calendarActionPatchFromFormData,
  createCalendarActionFromFormData,
  deleteTimelineAction,
  updateTimelineAction,
  type CalendarActionFormData,
} from '../design-edit'
import { designSessionStore } from '../document-session/store'
import { calendarAddRequest } from './calendar-request'
import { createPanelTargetPresentationController } from '../panel-targets/presentation'
import { usePlanningViewState, type CalendarCompletionFilter, type CalendarDisplay } from '../planning-view/state'
import {
  ACTION_TYPES,
  useCalendarPlanningSurface,
  type CalendarPlanningAction,
  type CalendarPlanningProjection,
  type PlanningZoneOption,
  type TimelineSpeciesOption,
} from '../planning-projection'
import {
  addCivilMonths,
  compareCivilDates,
  formatCivilDate,
  localToday,
  parseCivilDate,
  startOfCivilMonth,
} from '../../planning/civil-date'

const calendarTargetPresentation = createPanelTargetPresentationController('timeline')

export type CalendarTargetMode = 'preserve' | 'design' | 'species' | 'selection' | 'zone'
type CalendarEditorError = 'date-order' | 'empty-targets' | null

interface CalendarActionDraft extends CalendarActionFormData {
  readonly scheduled: boolean
  readonly range: boolean
  readonly targetMode: CalendarTargetMode
  readonly targetsChanged: boolean
}

interface CalendarEditorState {
  readonly mode: 'add' | 'edit'
  readonly actionId: string | null
  readonly sessionIdentity: object
  readonly draft: CalendarActionDraft
}

export interface CalendarWorkbench {
  readonly projection: CalendarPlanningProjection
  readonly actions: readonly TimelineAction[]
  readonly speciesList: readonly TimelineSpeciesOption[]
  readonly zones: readonly PlanningZoneOption[]
  readonly selectedPlantCount: number
  readonly activeLocale: string
  readonly month: string
  readonly search: string
  readonly actionType: string
  readonly completion: CalendarCompletionFilter
  /** Search, type or completion differs from the default open-actions view. */
  readonly filtersActive: boolean
  readonly selectedDate: string | null
  readonly display: CalendarDisplay
  readonly expanded: boolean
  readonly unscheduledExpanded: boolean
  readonly scrollTop: number
  readonly editor: CalendarEditorState | null
  readonly editorError: CalendarEditorError
  readonly clearFilters: () => void
  readonly setSearch: (value: string) => void
  readonly setActionType: (value: string) => void
  readonly setCompletion: (value: CalendarCompletionFilter) => void
  readonly setDisplay: (value: CalendarDisplay) => void
  readonly setExpanded: (value: boolean) => void
  readonly setUnscheduledExpanded: (value: boolean) => void
  readonly setScrollTop: (value: number) => void
  readonly previousMonth: () => void
  readonly nextMonth: () => void
  readonly showToday: () => void
  readonly selectDate: (date: string) => void
  readonly openAdd: (date?: string | null) => void
  readonly openEdit: (actionId: string) => void
  readonly updateDraft: (patch: Partial<CalendarActionDraft>) => void
  readonly setScheduled: (scheduled: boolean) => void
  readonly setRange: (range: boolean) => void
  readonly setTargetMode: (mode: Exclude<CalendarTargetMode, 'preserve'>) => void
  readonly toggleSpeciesTarget: (canonicalName: string) => void
  /** Adds every given species to the targets; ones already chosen stay once. */
  readonly addSpeciesTargets: (canonicalNames: readonly string[]) => void
  readonly setZoneTarget: (zoneId: string) => void
  readonly saveEditor: () => boolean
  readonly cancelEditor: () => void
  readonly deleteEditorAction: () => void
  readonly toggleCompleted: (actionId: string, completed: boolean) => void
  readonly hoverAction: (action: CalendarPlanningAction) => void
  readonly clearHover: () => void
}

export function useCalendarWorkbench(): CalendarWorkbench {
  const view = usePlanningViewState()
  const month = view.calendarMonth.value
  const search = view.calendarSearch.value
  const actionType = view.calendarActionType.value
  const completion = view.calendarCompletion.value
  const selectedDate = view.calendarSelectedDate.value
  const display = view.calendarDisplay.value
  const expanded = view.calendarExpanded.value
  const unscheduledExpanded = view.calendarUnscheduledExpanded.value
  const sessionIdentity = designSessionStore.sessionIdentity.value
  const surface = useCalendarPlanningSurface({ month, search, actionType, completion })
  const editor = useSignal<CalendarEditorState | null>(null)
  const editorError = useSignal<CalendarEditorError>(null)
  const actionsRef = useRef(surface.actions)
  const surfaceRef = useRef(surface)
  actionsRef.current = surface.actions
  surfaceRef.current = surface

  useEffect(() => () => calendarTargetPresentation.dispose(), [])
  useEffect(() => {
    const current = editor.value
    if (current && current.sessionIdentity !== sessionIdentity) {
      editor.value = null
      editorError.value = null
      calendarTargetPresentation.clearSelectedTargets()
    }
  }, [editor, editorError, sessionIdentity])

  const cancelEditor = useCallback(() => {
    editor.value = null
    editorError.value = null
    calendarTargetPresentation.clearSelectedTargets()
  }, [editor, editorError])

  const openAdd = useCallback((date?: string | null) => {
    const startDate = date ?? view.calendarSelectedDate.peek() ?? ''
    const identity = designSessionStore.sessionIdentity.peek()
    editorError.value = null
    editor.value = {
      mode: 'add',
      actionId: null,
      sessionIdentity: identity,
      draft: {
        action_type: ACTION_TYPES.includes(view.calendarActionType.peek() as (typeof ACTION_TYPES)[number])
          ? view.calendarActionType.peek()
          : 'other',
        description: '',
        start_date: startDate,
        end_date: '',
        completed: false,
        targets: [MANUAL_TARGET],
        scheduled: startDate !== '',
        range: false,
        targetMode: 'design',
        targetsChanged: true,
      },
    }
    calendarTargetPresentation.clearSelectedTargets()
  }, [editor, editorError, view])

  const openEdit = useCallback((actionId: string) => {
    const action = actionsRef.current.find((candidate) => candidate.id === actionId)
    if (!action) return
    const identity = designSessionStore.sessionIdentity.peek()
    editorError.value = null
    editor.value = {
      mode: 'edit',
      actionId,
      sessionIdentity: identity,
      draft: draftFromAction(action),
    }
    calendarTargetPresentation.setSelectedTargets(action.targets)
  }, [editor, editorError])

  const updateDraft = useCallback((patch: Partial<CalendarActionDraft>) => {
    if (!editor.value) return
    editor.value = {
      ...editor.value,
      draft: { ...editor.value.draft, ...patch },
    }
    editorError.value = null
  }, [editor, editorError])

  const setScheduled = useCallback((scheduled: boolean) => {
    const current = editor.value
    if (!current) return
    const today = formatCivilDate(localToday())
    const nextStart = scheduled
      ? current.draft.start_date || view.calendarSelectedDate.peek() || today
      : ''
    editor.value = {
      ...current,
      draft: {
        ...current.draft,
        scheduled,
        start_date: nextStart,
        end_date: scheduled && current.draft.range
          ? current.draft.end_date || nextStart
          : '',
      },
    }
    editorError.value = null
  }, [editor, editorError, view])

  const setRange = useCallback((range: boolean) => {
    const current = editor.value
    if (!current) return
    const today = formatCivilDate(localToday())
    const start = current.draft.start_date || view.calendarSelectedDate.peek() || today
    editor.value = {
      ...current,
      draft: {
        ...current.draft,
        scheduled: true,
        range,
        start_date: start,
        end_date: range ? current.draft.end_date || start : '',
      },
    }
    editorError.value = null
  }, [editor, editorError, view])

  const setTargetMode = useCallback((mode: Exclude<CalendarTargetMode, 'preserve'>) => {
    const current = editor.value
    if (!current) return
    let targets: readonly PanelTarget[] = []
    if (mode === 'design') targets = [MANUAL_TARGET]
    if (mode === 'species' && current.draft.targets.every((target) => target.kind === 'species')) {
      targets = current.draft.targets
    }
    if (mode === 'selection') {
      targets = surfaceRef.current.readSelectedPlantIds().map((plantId) => ({
        kind: 'placed_plant' as const,
        plant_id: plantId,
      }))
    }
    if (mode === 'zone' && current.draft.targets.length === 1 && current.draft.targets[0]?.kind === 'zone') {
      targets = current.draft.targets
    }
    editor.value = {
      ...current,
      draft: { ...current.draft, targetMode: mode, targets, targetsChanged: true },
    }
    editorError.value = null
    calendarTargetPresentation.setSelectedTargets(targets)
  }, [editor, editorError])

  const toggleSpeciesTarget = useCallback((canonicalName: string) => {
    const current = editor.value
    if (!current) return
    const existing = current.draft.targets.filter((target) => target.kind === 'species')
    const candidate = { kind: 'species' as const, canonical_name: canonicalName }
    const targets = existing.some((target) => target.canonical_name === canonicalName)
      ? existing.filter((target) => target.canonical_name !== canonicalName)
      : [...existing, candidate]
    editor.value = {
      ...current,
      draft: { ...current.draft, targetMode: 'species', targets, targetsChanged: true },
    }
    editorError.value = null
    calendarTargetPresentation.setSelectedTargets(targets)
  }, [editor, editorError])

  const addSpeciesTargets = useCallback((canonicalNames: readonly string[]) => {
    const current = editor.value
    if (!current) return
    const existing = current.draft.targets.filter((target) => target.kind === 'species')
    const chosen = new Set(existing.map((target) => target.canonical_name))
    const added = canonicalNames
      .filter((name) => !chosen.has(name))
      .map((name) => ({ kind: 'species' as const, canonical_name: name }))
    if (added.length === 0) return
    const targets = [...existing, ...added]
    editor.value = {
      ...current,
      draft: { ...current.draft, targetMode: 'species', targets, targetsChanged: true },
    }
    editorError.value = null
    calendarTargetPresentation.setSelectedTargets(targets)
  }, [editor, editorError])

  const setZoneTarget = useCallback((zoneId: string) => {
    const current = editor.value
    if (!current) return
    const targets: readonly PanelTarget[] = zoneId
      ? [{ kind: 'zone', zone_id: zoneId }]
      : []
    editor.value = {
      ...current,
      draft: { ...current.draft, targetMode: 'zone', targets, targetsChanged: true },
    }
    editorError.value = null
    calendarTargetPresentation.setSelectedTargets(targets)
  }, [editor, editorError])

  const saveEditor = useCallback((): boolean => {
    const current = editor.value
    if (!current || current.sessionIdentity !== designSessionStore.sessionIdentity.peek()) {
      cancelEditor()
      return false
    }
    if (
      current.mode === 'edit'
      && !actionsRef.current.some((action) => action.id === current.actionId)
    ) {
      cancelEditor()
      return false
    }
    const start = parseCivilDate(current.draft.start_date)
    const end = parseCivilDate(current.draft.end_date)
    if (start && end && compareCivilDates(start, end) > 0) {
      editorError.value = 'date-order'
      return false
    }
    if (
      (current.mode === 'add' || current.draft.targetsChanged)
      && current.draft.targets.length === 0
    ) {
      editorError.value = 'empty-targets'
      return false
    }

    if (current.mode === 'add') {
      addTimelineAction(createCalendarActionFromFormData(createUuid(), current.draft))
    } else if (current.actionId) {
      updateTimelineAction(
        current.actionId,
        calendarActionPatchFromFormData(current.draft, current.draft.targetsChanged),
      )
    }
    cancelEditor()
    return true
  }, [cancelEditor, editor, editorError])

  const deleteEditorAction = useCallback(() => {
    const current = editor.value
    if (
      !current
      || current.mode !== 'edit'
      || !current.actionId
      || current.sessionIdentity !== designSessionStore.sessionIdentity.peek()
    ) {
      cancelEditor()
      return
    }
    deleteTimelineAction(current.actionId)
    cancelEditor()
  }, [cancelEditor, editor])

  const toggleCompleted = useCallback((actionId: string, completed: boolean) => {
    if (!actionsRef.current.some((action) => action.id === actionId)) return
    updateTimelineAction(actionId, { completed })
  }, [])

  const hoverAction = useCallback((action: CalendarPlanningAction) => {
    calendarTargetPresentation.setHoveredTargets(action.targets)
  }, [])

  const clearHover = useCallback(() => {
    calendarTargetPresentation.clearHoveredTargets()
  }, [])

  const moveMonth = useCallback((amount: number) => {
    const current = parseCivilDate(view.calendarMonth.peek()) ?? localToday()
    view.calendarMonth.value = formatCivilDate(startOfCivilMonth(addCivilMonths(current, amount)))
  }, [view])

  // Add to calendar… from the map: a new action aimed at the selected plants or one zone.
  const addRequest = calendarAddRequest.value
  useEffect(() => {
    if (!addRequest) return
    calendarAddRequest.value = null
    if (addRequest.sessionIdentity !== designSessionStore.sessionIdentity.peek()) return
    openAdd()
    if (addRequest.target.kind === 'zone') setZoneTarget(addRequest.target.zoneId)
    else setTargetMode('selection')
  }, [addRequest, openAdd, setTargetMode, setZoneTarget])

  return {
    projection: surface.projection,
    actions: surface.actions,
    speciesList: surface.speciesList,
    zones: surface.zones,
    selectedPlantCount: surface.selectedPlantIds.length,
    activeLocale: surface.activeLocale,
    month,
    search,
    actionType,
    completion,
    selectedDate,
    display,
    expanded,
    unscheduledExpanded,
    scrollTop: view.calendarScrollTop,
    editor: editor.value,
    editorError: editorError.value,
    filtersActive: search !== '' || actionType !== 'all' || completion !== 'open',
    clearFilters: () => {
      view.calendarSearch.value = ''
      view.calendarActionType.value = 'all'
      view.calendarCompletion.value = 'open'
    },
    setSearch: (value) => { view.calendarSearch.value = value },
    setActionType: (value) => { view.calendarActionType.value = value },
    setCompletion: (value) => { view.calendarCompletion.value = value },
    setDisplay: (value) => { view.calendarDisplay.value = value },
    setExpanded: (value) => { view.calendarExpanded.value = value },
    setUnscheduledExpanded: (value) => { view.calendarUnscheduledExpanded.value = value },
    setScrollTop: (value) => { view.calendarScrollTop = value },
    previousMonth: () => moveMonth(-1),
    nextMonth: () => moveMonth(1),
    showToday: () => {
      const today = localToday()
      view.calendarMonth.value = formatCivilDate(startOfCivilMonth(today))
      view.calendarSelectedDate.value = formatCivilDate(today)
    },
    selectDate: (date) => { view.calendarSelectedDate.value = date },
    openAdd,
    openEdit,
    updateDraft,
    setScheduled,
    setRange,
    setTargetMode,
    toggleSpeciesTarget,
    addSpeciesTargets,
    setZoneTarget,
    saveEditor,
    cancelEditor,
    deleteEditorAction,
    toggleCompleted,
    hoverAction,
    clearHover,
  }
}

function draftFromAction(action: TimelineAction): CalendarActionDraft {
  return {
    action_type: action.action_type,
    description: action.description,
    start_date: action.start_date ?? '',
    end_date: action.end_date ?? '',
    completed: action.completed,
    targets: action.targets.map((target) => ({ ...target })),
    scheduled: action.start_date !== null || action.end_date !== null,
    range: action.end_date !== null,
    targetMode: inferTargetMode(action.targets),
    targetsChanged: false,
  }
}

function inferTargetMode(targets: readonly PanelTarget[]): CalendarTargetMode {
  if (targets.length === 1 && targetIdentity.equals(targets[0]!, MANUAL_TARGET)) return 'design'
  if (targets.length > 0 && targets.every((target) => target.kind === 'species')) return 'species'
  if (targets.length > 0 && targets.every((target) => target.kind === 'placed_plant')) return 'selection'
  if (targets.length === 1 && targets[0]?.kind === 'zone') return 'zone'
  return 'preserve'
}
