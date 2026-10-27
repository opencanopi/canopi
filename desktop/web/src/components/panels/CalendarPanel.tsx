import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Fragment, type TargetedKeyboardEvent } from 'preact'
import { useCalendarWorkbench, type CalendarTargetMode } from '../../app/timeline/calendar-workbench'
import {
  addCivilDays,
  addCivilMonths,
  civilDateToLocalDate,
  endOfCivilMonth,
  formatCivilDate,
  localToday,
  parseCivilDate,
  civilWeekdayOffset,
  compareCivilDates,
  startOfCivilMonth,
  type CivilDate,
} from '../../app/timeline/civil-date'
import { ACTION_TYPES, missingZoneLabel, type CalendarDayProjection, type CalendarPlanningAction, type CalendarTargetLabel } from '../../app/planning-projection'
import type { CalendarCompletionFilter, CalendarDisplay } from '../../app/planning-view/state'
import { t } from '../../i18n'
import { locale } from '../../app/settings/state'
import { formatCount } from '../../utils/format-count'
import { DockPanelHeader, closeDockPanel } from '../shared/DockPanelHeader'
import { Dropdown, type DropdownItem } from '../shared/Dropdown'
import { SurfaceSearch } from '../shared/SurfaceSearch'
import { DatePicker } from '../shared/DatePicker'
import { EmptyState } from '../shared/EmptyState'
import { SegmentedControl, type SegmentedOption } from '../shared/SegmentedControl'
import { SpeciesCommonName } from '../shared/SpeciesIdentity'
import { SurfaceHeader } from '../shared/SurfaceHeader'
import { Switch } from '../shared/Switch'
import { CalendarSpeciesPicker } from './CalendarSpeciesPicker'
import styles from './CalendarPanel.module.css'

const FULL_MONTH_MIN_WIDTH = 640

export function CalendarPanel() {
  const workbench = useCalendarWorkbench()
  const panelRef = useRef<HTMLElement>(null)
  const agendaRef = useRef<HTMLDivElement>(null)
  const cancelledEditorFocus = useRef<string | null | undefined>(undefined)
  const [contentWidth, setContentWidth] = useState(0)
  const showFullMonth = workbench.expanded
    && contentWidth >= FULL_MONTH_MIN_WIDTH
    && workbench.display === 'month'

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const measure = () => setContentWidth(panel.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!workbench.selectedDate || showFullMonth) return
    const row = agendaRef.current?.querySelector<HTMLElement>(
      `[data-agenda-date="${workbench.selectedDate}"]`,
    )
    row?.scrollIntoView({ block: 'start' })
  }, [showFullMonth, workbench.selectedDate])

  useLayoutEffect(() => {
    if (!showFullMonth && agendaRef.current) {
      agendaRef.current.scrollTop = workbench.scrollTop
    }
  }, [showFullMonth])
  useLayoutEffect(() => {
    if (workbench.editor !== null || cancelledEditorFocus.current === undefined) return
    const actionId = cancelledEditorFocus.current
    const selector = actionId
      ? `button[data-calendar-action="${encodeURIComponent(actionId)}"]`
      : 'button[data-calendar-add]'
    const trigger = panelRef.current?.querySelector<HTMLButtonElement>(selector)
      ?? panelRef.current?.querySelector<HTMLButtonElement>('button[data-calendar-add]')
    trigger?.focus()
    cancelledEditorFocus.current = undefined
  }, [workbench.editor])

  useEffect(() => () => workbench.setExpanded(false), [])

  function cancelEditorAndRestoreFocus(): void {
    cancelledEditorFocus.current = workbench.editor?.actionId ?? null
    workbench.cancelEditor()
  }

  function closePanel(): void {
    workbench.cancelEditor()
    workbench.setExpanded(false)
    closeDockPanel()
  }

  function handleEscape(event: TargetedKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (workbench.editor) {
      cancelEditorAndRestoreFocus()
      return
    }
    if (workbench.expanded) {
      workbench.setExpanded(false)
      panelRef.current?.querySelector<HTMLButtonElement>('[data-calendar-expand]')?.focus()
      return
    }
    closePanel()
  }

  return (
    <section
      ref={panelRef}
      className={styles.panel}
      aria-label={t('canvas.calendar.title')}
      onKeyDown={handleEscape}
    >
      {workbench.editor ? (
        <CalendarEditor workbench={workbench} onCancel={cancelEditorAndRestoreFocus} onClose={closePanel} />
      ) : (
        <>
          <DockPanelHeader
            title={t('canvas.calendar.title')}
            actions={(
              <button
                type="button"
                className={styles.headerAction}
                data-calendar-expand
                onClick={() => workbench.setExpanded(!workbench.expanded)}
              >
                {t(workbench.expanded ? 'canvas.calendar.reduce' : 'canvas.calendar.expand')}
              </button>
            )}
          />
          <CalendarToolbar workbench={workbench} wide={contentWidth >= FULL_MONTH_MIN_WIDTH} />
          {showFullMonth ? (
            <CalendarMonthGrid workbench={workbench} />
          ) : (
            <div
              ref={agendaRef}
              className={styles.scrollRegion}
              onScroll={(event) => workbench.setScrollTop(event.currentTarget.scrollTop)}
            >
              <MiniMonth workbench={workbench} />
              <CalendarAgenda workbench={workbench} />
            </div>
          )}
        </>
      )}
    </section>
  )
}

type Workbench = ReturnType<typeof useCalendarWorkbench>

function CalendarToolbar({ workbench, wide }: { workbench: Workbench; wide: boolean }) {
  const actionTypeItems: DropdownItem<string>[] = [
    { value: 'all', label: t('canvas.calendar.allTypes') },
    ...ACTION_TYPES.map((type) => ({ value: type, label: actionTypeLabel(type) })),
  ]
  const completionItems: DropdownItem<CalendarCompletionFilter>[] = [
    { value: 'open', label: t('canvas.calendar.openActions') },
    { value: 'completed', label: t('canvas.calendar.completedActions') },
    { value: 'all', label: t('canvas.calendar.allActions') },
  ]
  const displayItems: DropdownItem<CalendarDisplay>[] = [
    { value: 'month', label: t('canvas.calendar.month') },
    { value: 'agenda', label: t('canvas.calendar.agenda') },
  ]
  const month = parseCivilDate(workbench.month) ?? localToday()
  const monthLabel = new Intl.DateTimeFormat(workbench.activeLocale, {
    month: 'long',
    year: 'numeric',
  }).format(civilDateToLocalDate(month))

  return (
    <div className={styles.toolbar}>
      <div className={styles.monthNavigation}>
        <button type="button" aria-label={t('canvas.calendar.previousMonth')} onClick={workbench.previousMonth}>‹</button>
        <strong>{monthLabel}</strong>
        <button type="button" aria-label={t('canvas.calendar.nextMonth')} onClick={workbench.nextMonth}>›</button>
        <button type="button" className={styles.todayButton} onClick={workbench.showToday}>
          {t('canvas.calendar.today')}
        </button>
        {workbench.expanded && wide && (
          <Dropdown
            trigger={displayItems.find((item) => item.value === workbench.display)?.label}
            items={displayItems}
            value={workbench.display}
            onChange={workbench.setDisplay}
            ariaLabel={t('canvas.calendar.displayLabel')}
          />
        )}
      </div>
      <div className={styles.searchRow}>
        <button type="button" data-calendar-add className={styles.primaryButton} onClick={() => workbench.openAdd()}>
          {t('canvas.calendar.addAction')}
        </button>
        <SurfaceSearch
          value={workbench.search}
          onChange={workbench.setSearch}
          label={t('canvas.calendar.search')}
        />
      </div>
      <div className={styles.filterRow}>
        <Dropdown
          trigger={completionItems.find((item) => item.value === workbench.completion)?.label}
          items={completionItems}
          value={workbench.completion}
          onChange={workbench.setCompletion}
          ariaLabel={t('canvas.calendar.completionFilter')}
        />
        <Dropdown
          trigger={actionTypeItems.find((item) => item.value === workbench.actionType)?.label}
          items={actionTypeItems}
          value={workbench.actionType}
          onChange={workbench.setActionType}
          ariaLabel={t('canvas.calendar.typeFilter')}
        />
      </div>
    </div>
  )
}

function MiniMonth({ workbench }: { workbench: Workbench }) {
  return (
    <CalendarDateGrid
      workbench={workbench}
      compact
      onSelect={(day) => workbench.selectDate(day.dateKey)}
    />
  )
}

function CalendarMonthGrid({ workbench }: { workbench: Workbench }) {
  return (
    <div className={styles.monthGridRegion}>
      <CalendarDateGrid
        workbench={workbench}
        compact={false}
        onSelect={(day) => {
          workbench.selectDate(day.dateKey)
          if (day.actions.length === 0) workbench.openAdd(day.dateKey)
        }}
      />
      {workbench.projection.unscheduled.length > 0 && (
        <button
          type="button"
          className={styles.unscheduledBar}
          onClick={() => workbench.setDisplay('agenda')}
        >
          {t('canvas.calendar.unscheduledCount', { count: workbench.projection.unscheduled.length })}
        </button>
      )}
    </div>
  )
}

function CalendarDateGrid({ workbench, compact, onSelect }: {
  workbench: Workbench
  compact: boolean
  onSelect(day: CalendarDayProjection): void
}) {
  const todayKey = formatCivilDate(localToday())
  const visibleDays = workbench.projection.weeks.flat()
  const initialFocus = workbench.selectedDate
    && visibleDays.some((day) => day.dateKey === workbench.selectedDate)
    ? workbench.selectedDate
    : (visibleDays.some((day) => day.dateKey === todayKey)
      ? todayKey
      : formatCivilDate(workbench.projection.month))
  const [focusedDate, setFocusedDate] = useState(initialFocus)
  const rovingDate = visibleDays.some((day) => day.dateKey === focusedDate)
    ? focusedDate
    : initialFocus
  const focusRequest = useRef<string | null>(null)
  const gridRef = useRef<HTMLTableElement>(null)

  useLayoutEffect(() => {
    if (focusedDate !== rovingDate) setFocusedDate(rovingDate)
    const date = focusRequest.current
    if (!date) return
    focusRequest.current = null
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-calendar-date="${date}"]`)?.focus()
  })

  const firstWeek = workbench.projection.weeks[0] ?? []
  const weekdays = firstWeek.map((day) => new Intl.DateTimeFormat(workbench.activeLocale, {
    weekday: compact ? 'narrow' : 'long',
  }).format(civilDateToLocalDate(day.date)))

  function moveFocus(date: CivilDate, days: number): void {
    const next = addCivilDays(date, days)
    const key = formatCivilDate(next)
    setFocusedDate(key)
    focusRequest.current = key
    if (next.month !== workbench.projection.month.month || next.year !== workbench.projection.month.year) {
      if (days < 0) workbench.previousMonth()
      else workbench.nextMonth()
    }
  }

  function handleDateKeyDown(event: TargetedKeyboardEvent<HTMLButtonElement>, day: CalendarDayProjection): void {
    let amount: number | null = null
    if (event.key === 'ArrowLeft') amount = -1
    if (event.key === 'ArrowRight') amount = 1
    if (event.key === 'ArrowUp') amount = -7
    if (event.key === 'ArrowDown') amount = 7
    const weekOffset = civilWeekdayOffset(day.date, workbench.activeLocale)
    if (event.key === 'Home') amount = -weekOffset
    if (event.key === 'End') amount = 6 - weekOffset
    if (amount !== null) {
      event.preventDefault()
      moveFocus(day.date, amount)
      return
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault()
      const next = addCivilMonths(day.date, event.key === 'PageUp' ? -1 : 1)
      const key = formatCivilDate(next)
      setFocusedDate(key)
      focusRequest.current = key
      if (event.key === 'PageUp') workbench.previousMonth()
      else workbench.nextMonth()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(day)
    }
  }

  return (
    <table ref={gridRef} className={compact ? styles.miniCalendar : styles.fullCalendar}>
      <thead>
        <tr>{weekdays.map((weekday, index) => <th key={index} scope="col">{weekday}</th>)}</tr>
      </thead>
      <tbody>
        {workbench.projection.weeks.map((week) => (
          <tr key={week[0]?.dateKey}>
            {week.map((day) => (
              <td key={day.dateKey} data-outside={day.inMonth ? undefined : 'true'}>
                <button
                  type="button"
                  className={styles.dateButton}
                  data-calendar-date={day.dateKey}
                  data-selected={workbench.selectedDate === day.dateKey ? 'true' : undefined}
                  data-today={todayKey === day.dateKey ? 'true' : undefined}
                  tabIndex={rovingDate === day.dateKey ? 0 : -1}
                  aria-label={new Intl.DateTimeFormat(workbench.activeLocale, { dateStyle: 'full' }).format(civilDateToLocalDate(day.date))}
                  onFocusIn={() => setFocusedDate(day.dateKey)}
                  onClick={() => onSelect(day)}
                  onKeyDown={(event) => handleDateKeyDown(event, day)}
                >
                  <span>{day.date.day}</span>
                  {compact && day.actions.length > 0 && <span className={styles.dots} aria-hidden="true">•</span>}
                </button>
                {!compact && (
                  <div className={styles.dayActions}>
                    {day.actions.slice(0, 3).map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        className={styles.actionChip}
                        data-calendar-action={encodeURIComponent(action.id)}
                        data-action-type={knownActionType(action.actionType) ? action.actionType : 'other'}
                        onMouseEnter={() => workbench.hoverAction(action)}
                        onMouseLeave={workbench.clearHover}
                        onClick={(event) => {
                          event.stopPropagation()
                          workbench.openEdit(action.id)
                        }}
                      >
                        {actionDescription(action)}
                      </button>
                    ))}
                    {day.actions.length > 3 && (
                      <button type="button" className={styles.moreButton} onClick={() => {
                        workbench.selectDate(day.dateKey)
                        workbench.setDisplay('agenda')
                      }}>
                        {t('canvas.calendar.moreActions', { count: day.actions.length - 3 })}
                      </button>
                    )}
                  </div>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CalendarAgenda({ workbench }: { workbench: Workbench }) {
  const selectedDay = workbench.selectedDate
    ? workbench.projection.weeks.flat().find((day) => day.dateKey === workbench.selectedDate)
    : undefined
  const selectedActions = selectedDay?.actions ?? []
  const selectedActionSet = new Set(selectedActions)
  const remainingGroups = workbench.projection.agenda
    .map((group) => ({
      ...group,
      actions: group.actions.filter((action) => !selectedActionSet.has(action)),
    }))
    .filter((group) => group.actions.length > 0)
  return (
    <div className={styles.agenda}>
      {workbench.selectedDate && selectedActions.length === 0 && (
        <section className={styles.emptyDate} data-agenda-date={workbench.selectedDate}>
          <strong>{formatDisplayDate(workbench.selectedDate, workbench.activeLocale)}</strong>
          <span>{t('canvas.calendar.noActionsForDate')}</span>
          <button type="button" onClick={() => workbench.openAdd(workbench.selectedDate)}>
            {t('canvas.calendar.addForDate')}
          </button>
        </section>
      )}
      {workbench.selectedDate && selectedActions.length > 0 && (
        <CalendarAgendaGroup
          dateKey={workbench.selectedDate}
          actions={selectedActions}
          workbench={workbench}
          selected
        />
      )}
      {remainingGroups.map((group) => (
        <CalendarAgendaGroup
          key={group.dateKey}
          dateKey={group.dateKey}
          actions={group.actions}
          workbench={workbench}
        />
      ))}
      <section className={styles.agendaGroup}>
        <button
          type="button"
          className={styles.unscheduledHeader}
          aria-expanded={workbench.unscheduledExpanded}
          onClick={() => workbench.setUnscheduledExpanded(!workbench.unscheduledExpanded)}
        >
          <span>{workbench.unscheduledExpanded ? '▾' : '▸'} {t('canvas.calendar.unscheduled')}</span>
          <small>{formatCount(workbench.projection.unscheduled.length, locale.value)}</small>
        </button>
        {workbench.unscheduledExpanded && workbench.projection.unscheduled.map((action) => (
          <CalendarActionRow key={action.id} action={action} workbench={workbench} />
        ))}
        {workbench.unscheduledExpanded && workbench.projection.unscheduled.length === 0 && (
          <p className={styles.quiet}>{t('canvas.calendar.noUnscheduled')}</p>
        )}
      </section>
      <CalendarAgendaEmpty workbench={workbench} />
    </div>
  )
}

/**
 * Why the agenda is empty: no actions at all, chosen filters hiding them, or
 * the default open-actions filter hiding only completed ones.
 */
function CalendarAgendaEmpty({ workbench }: { workbench: Workbench }) {
  if (workbench.projection.filteredCount > 0) return null
  if (workbench.actions.length === 0) {
    return (
      <div className={styles.emptyState} data-calendar-empty>
        <EmptyState action={{ label: t('canvas.calendar.addAction'), onClick: () => workbench.openAdd(workbench.selectedDate) }}>
          {t('canvas.calendar.noActionsYet')}
        </EmptyState>
      </div>
    )
  }
  if (workbench.filtersActive) {
    return (
      <div className={styles.emptyState} data-calendar-empty>
        <EmptyState status action={{ label: t('canvas.calendar.clearFilters'), onClick: workbench.clearFilters }}>
          {t('canvas.calendar.noResults')}
        </EmptyState>
      </div>
    )
  }
  return (
    <div className={styles.emptyState} data-calendar-empty>
      <EmptyState status action={{ label: t('canvas.calendar.showCompleted'), onClick: () => workbench.setCompletion('all') }}>
        {t('canvas.calendar.allDone')}
      </EmptyState>
    </div>
  )
}

function CalendarAgendaGroup({ dateKey, actions, workbench, selected = false }: {
  dateKey: string
  actions: readonly CalendarPlanningAction[]
  workbench: Workbench
  selected?: boolean
}) {
  return (
    <section
      className={styles.agendaGroup}
      data-agenda-date={dateKey}
      data-selected-date={selected ? 'true' : undefined}
    >
      <h3>
        <span>{formatDisplayDate(dateKey, workbench.activeLocale)}</span>
        <small>{t('canvas.calendar.actionCount', { count: actions.length })}</small>
      </h3>
      {actions.map((action) => (
        <CalendarActionRow key={action.id} action={action} workbench={workbench} />
      ))}
    </section>
  )
}

function CalendarActionRow({ action, workbench }: { action: CalendarPlanningAction; workbench: Workbench }) {
  return (
    <div
      className={styles.actionRow}
      data-calendar-agenda-action={encodeURIComponent(action.id)}
      onMouseEnter={() => workbench.hoverAction(action)}
      onMouseLeave={workbench.clearHover}
    >
      <input
        type="checkbox"
        checked={action.completed}
        aria-label={t('canvas.calendar.markCompleted', { action: actionDescription(action) })}
        onChange={(event) => workbench.toggleCompleted(action.id, event.currentTarget.checked)}
      />
      <button type="button" className={styles.actionBody} onClick={() => workbench.openEdit(action.id)}>
        <strong>{actionDescription(action)}</strong>
        <span>{actionTypeLabel(action.actionType)} · <TargetSummary action={action} /></span>
        <span>{actionDateSummary(action, workbench.activeLocale, workbench.projection.month)}</span>
      </button>
      <button
        type="button"
        className={styles.editChevron}
        data-calendar-action={encodeURIComponent(action.id)}
        aria-label={t('canvas.calendar.editAction', { action: actionDescription(action) })}
        onClick={() => workbench.openEdit(action.id)}
      >›</button>
    </div>
  )
}

function CalendarEditor({ workbench, onCancel, onClose }: {
  workbench: Workbench
  onCancel: () => void
  onClose: () => void
}) {
  const editor = workbench.editor!
  const draft = editor.draft
  const action = editor.actionId
    ? workbench.projection.weeks.flat().flatMap((day) => day.actions).find((candidate) => candidate.id === editor.actionId)
      ?? workbench.projection.unscheduled.find((candidate) => candidate.id === editor.actionId)
    : null
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const selectedSpecies = new Set(
    draft.targets.filter((target) => target.kind === 'species').map((target) => target.canonical_name),
  )
  const typeItems: DropdownItem<string>[] = [
    ...(knownActionType(draft.action_type)
      ? []
      : [{ value: draft.action_type, label: draft.action_type }]),
    ...ACTION_TYPES.map((type) => ({ value: type, label: actionTypeLabel(type) })),
  ]
  const selectedSpeciesTargets = draft.targets.filter((target) => target.kind === 'species')
  const selectedZone = draft.targets.find((target) => target.kind === 'zone')?.zone_id ?? ''
  const scheduleMode: ScheduleMode = !draft.scheduled ? 'unscheduled' : draft.range ? 'range' : 'single'
  const scheduleOptions: SegmentedOption<ScheduleMode>[] = [
    { value: 'range', label: t('canvas.calendar.range') },
    { value: 'single', label: t('canvas.calendar.oneDay') },
    { value: 'unscheduled', label: t('canvas.calendar.unscheduled') },
  ]
  const targetModeItems: DropdownItem<CalendarTargetMode>[] = (
    ['design', 'species', 'selection', 'zone'] as const
  ).map((mode) => ({
    value: mode,
    label: targetModeLabel(mode, workbench.selectedPlantCount),
    disabled: mode === 'selection' && workbench.selectedPlantCount === 0,
  }))
  const zoneItems: DropdownItem<string>[] = [
    { value: '', label: t('canvas.calendar.chooseZone') },
    ...(selectedZone && !workbench.zones.some((zone) => zone.id === selectedZone)
      ? [{ value: selectedZone, label: `${missingZoneLabel()} · ${t('canvas.calendar.unavailable')}` }]
      : []),
    ...workbench.zones.map((zone) => ({ value: zone.id, label: zone.label })),
  ]

  useLayoutEffect(() => {
    descriptionRef.current?.focus()
  }, [])

  function setScheduleMode(mode: ScheduleMode): void {
    if (mode === 'unscheduled') {
      workbench.setScheduled(false)
      return
    }
    workbench.setRange(mode === 'range')
  }

  function selectedSpeciesLabel(canonicalName: string): { label: string; unavailable: boolean } {
    const option = workbench.speciesList.find((species) => species.canonical_name === canonicalName)
    const saved = action?.targetLabels.find((target) =>
      target.kind === 'species'
      && target.target.kind === 'species'
      && target.target.canonical_name === canonicalName,
    )
    return {
      label: option?.display_name ?? saved?.label ?? canonicalName,
      unavailable: option === undefined,
    }
  }

  return (
    <div className={styles.editor} role="dialog" aria-label={t(editor.mode === 'add' ? 'canvas.timeline.addTitle' : 'canvas.timeline.editTitle')}>
      <SurfaceHeader
        title={t(editor.mode === 'add' ? 'canvas.timeline.addTitle' : 'canvas.timeline.editTitle')}
        back={{ label: t('sidebar.back'), onClick: onCancel }}
        closeLabel={t('sidebar.close')}
        onClose={onClose}
      />
      <div className={styles.editorFields}>
        <label>
          <span>{t('canvas.timeline.description')}</span>
          <textarea
            ref={descriptionRef}
            rows={3}
            className={styles.descriptionInput}
            data-calendar-description
            placeholder={t('canvas.calendar.descriptionPlaceholder')}
            value={draft.description}
            onInput={(event) => workbench.updateDraft({ description: event.currentTarget.value })}
          />
        </label>
        <div className={styles.field}>
          <span>{t('canvas.timeline.actionType')}</span>
          <Dropdown
            className={styles.editorDropdown}
            trigger={typeItems.find((item) => item.value === draft.action_type)?.label}
            items={typeItems}
            value={draft.action_type}
            onChange={(value) => workbench.updateDraft({ action_type: value })}
            ariaLabel={t('canvas.timeline.actionType')}
            floating
          />
        </div>
        <section className={styles.scheduleEditor} aria-label={t('canvas.calendar.schedule')}>
          <SegmentedControl
            label={t('canvas.calendar.schedule')}
            options={scheduleOptions}
            value={scheduleMode}
            onChange={setScheduleMode}
          />
          {draft.scheduled && (
            <div className={styles.dateFields} data-calendar-date-fields data-range={draft.range ? 'true' : undefined}>
              <div className={styles.field}>
                <span>{t('canvas.timeline.startDate')}</span>
                <DatePicker
                  value={draft.start_date}
                  onChange={(value) => workbench.updateDraft({ start_date: value })}
                  ariaLabel={t('canvas.timeline.startDate')}
                  error={workbench.editorError === 'date-order'}
                  floating
                />
                {draft.start_date && !parseCivilDate(draft.start_date) && (
                  <span className={styles.validation}>{t('canvas.calendar.savedInvalidDate', { value: draft.start_date })}</span>
                )}
              </div>
              {draft.range && (
                <div className={styles.field}>
                  <span>{t('canvas.calendar.endInclusive')}</span>
                  <DatePicker
                    value={draft.end_date}
                    onChange={(value) => workbench.updateDraft({ end_date: value })}
                    ariaLabel={t('canvas.calendar.endInclusive')}
                    error={workbench.editorError === 'date-order'}
                    floating
                  />
                  {draft.end_date && !parseCivilDate(draft.end_date) && (
                    <span className={styles.validation}>{t('canvas.calendar.savedInvalidDate', { value: draft.end_date })}</span>
                  )}
                </div>
              )}
            </div>
          )}
          {workbench.editorError === 'date-order' && (
            <p className={styles.validation} role="alert">{t('canvas.timeline.dateError')}</p>
          )}
        </section>
        <section className={styles.targetEditor} aria-label={t('canvas.calendar.targets')}>
          <span className={styles.fieldLabel}>{t('canvas.calendar.targets')}</span>
          <Dropdown
            className={styles.editorDropdown}
            trigger={targetModeLabel(draft.targetMode, workbench.selectedPlantCount, draft.targets.length)}
            items={targetModeItems}
            value={draft.targetMode}
            onChange={(mode) => workbench.setTargetMode(mode as Exclude<CalendarTargetMode, 'preserve'>)}
            ariaLabel={t('canvas.calendar.targets')}
            floating
          />
          {draft.targetMode === 'preserve' && (
            <p className={styles.savedTargets}>{t('canvas.calendar.mixedTargetsPreserved', { count: draft.targets.length })}</p>
          )}
          {action && !draft.targetsChanged && (
            draft.targetMode === 'preserve'
            || (draft.targetMode !== 'species' && action.targetLabels.some((target) => target.unavailable))
          ) && (
            <ul className={styles.savedTargetList}>
              {action.targetLabels.map((target, index) => (
                <li key={`${target.kind}:${target.label}:${index}`}><CalendarTargetName target={target} /></li>
              ))}
            </ul>
          )}
          {draft.targetMode === 'species' && (
            <CalendarSpeciesPicker
              species={workbench.speciesList}
              chosen={selectedSpecies}
              unavailable={selectedSpeciesTargets.flatMap((target) => {
                const selected = selectedSpeciesLabel(target.canonical_name)
                return selected.unavailable ? [{ canonicalName: target.canonical_name, label: selected.label }] : []
              })}
              onToggle={workbench.toggleSpeciesTarget}
              onAddAll={workbench.addSpeciesTargets}
            />
          )}
          {draft.targetMode === 'selection' && (
            <p className={styles.savedTargets}>{t('canvas.calendar.plantSelectionCount', { count: draft.targets.length })}</p>
          )}
          {draft.targetMode === 'zone' && (
            <Dropdown
              trigger={zoneItems.find((item) => item.value === selectedZone)?.label}
              items={zoneItems}
              value={selectedZone}
              onChange={workbench.setZoneTarget}
              ariaLabel={t('canvas.calendar.zone')}
              floating
            />
          )}
          {workbench.editorError === 'empty-targets' && (
            <p className={styles.validation} role="alert">{t('canvas.calendar.targetRequired')}</p>
          )}
        </section>
        <div data-calendar-completed>
          <Switch
            label={t('canvas.calendar.completed')}
            checked={draft.completed}
            onChange={(completed) => workbench.updateDraft({ completed })}
          />
        </div>
        {action?.recurrence && (
          <p className={styles.savedTargets}>
            {t('canvas.calendar.savedRecurrence', { value: action.recurrence })}
          </p>
        )}
      </div>
      <div className={styles.editorActions}>
        {editor.mode === 'edit' && (
          <button type="button" className={styles.deleteButton} onClick={workbench.deleteEditorAction}>
            {t('canvas.timeline.delete')}
          </button>
        )}
        <button type="button" onClick={onCancel}>{t('canvas.timeline.cancel')}</button>
        <button type="button" className={styles.primaryButton} onClick={workbench.saveEditor}>
          {t('canvas.timeline.save')}
        </button>
      </div>
    </div>
  )
}

type ScheduleMode = 'range' | 'single' | 'unscheduled'

function actionDescription(action: CalendarPlanningAction): string {
  return action.description.trim() || actionTypeLabel(action.actionType)
}

function actionTypeLabel(actionType: string): string {
  return knownActionType(actionType) ? t(`canvas.timeline.type_${actionType}`) : actionType
}

function knownActionType(actionType: string): boolean {
  return ACTION_TYPES.includes(actionType as (typeof ACTION_TYPES)[number])
}

function TargetSummary({ action }: { action: CalendarPlanningAction }) {
  if (action.targetLabels.length === 0) return <>{t('canvas.calendar.noTarget')}</>
  return <>{action.targetLabels.map((target, index) => (
    <Fragment key={index}>{index > 0 && ', '}<CalendarTargetName target={target} /></Fragment>
  ))}</>
}

/** A target's name; a species shown by its English catalog name carries the "(en)" mark. */
function CalendarTargetName({ target }: { target: CalendarTargetLabel }) {
  const label = target.kind === 'manual'
    ? t('canvas.calendar.wholeDesign')
    : target.kind === 'none'
      ? t('canvas.calendar.noTarget')
      : target.label
  return <>
    <SpeciesCommonName name={label} englishFallback={target.englishFallback} />
    {target.unavailable && ` · ${t('canvas.calendar.unavailable')}`}
  </>
}

function actionDateSummary(action: CalendarPlanningAction, locale: string, month: CivilDate): string {
  if (!action.parsedStart) {
    if (action.endDate) return t('canvas.calendar.unscheduledWithEnd', { value: action.endDate })
    if (action.startDate) return t('canvas.calendar.invalidStart', { value: action.startDate })
    return t('canvas.calendar.unscheduled')
  }
  const start = formatDisplayDate(formatCivilDate(action.parsedStart), locale)
  if (!action.endDate) return start
  if (!action.parsedEnd || action.invalidRange) {
    return t('canvas.calendar.savedDateRange', { start: action.startDate, end: action.endDate })
  }
  const continuation = [
    compareCivilDates(action.parsedStart, startOfCivilMonth(month)) < 0
      ? t('canvas.calendar.continuesBefore')
      : null,
    compareCivilDates(action.parsedEnd, endOfCivilMonth(month)) > 0
      ? t('canvas.calendar.continuesAfter')
      : null,
  ].filter((value): value is string => value !== null)
  const range = `${start} – ${formatDisplayDate(formatCivilDate(action.parsedEnd), locale)}`
  return continuation.length > 0 ? `${range} · ${continuation.join(' · ')}` : range
}

function formatDisplayDate(value: string, locale: string): string {
  const date = parseCivilDate(value)
  return date
    ? new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(civilDateToLocalDate(date))
    : value
}

function targetModeLabel(mode: CalendarTargetMode, selectedCount: number, targetCount?: number): string {
  if (mode === 'preserve') return t('canvas.calendar.mixedTargetsPreserved', { count: targetCount })
  if (mode === 'design') return t('canvas.calendar.wholeDesign')
  if (mode === 'species') return t('canvas.calendar.speciesTargets')
  if (mode === 'selection') return t('canvas.calendar.currentSelection', { count: targetCount ?? selectedCount })
  return t('canvas.calendar.zone')
}
