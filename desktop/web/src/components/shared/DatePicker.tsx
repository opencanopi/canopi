import { useRef, useLayoutEffect } from 'preact/hooks'
import { useSignal, useSignalEffect } from '@preact/signals'
import { createPortal, type RefObject } from 'preact'
import { t } from '../../i18n'
import { locale } from '../../app/settings/state'
import {
  addCivilDays,
  addCivilMonths,
  buildCivilMonthGrid,
  civilWeekdayLabels,
  compareCivilDates,
  endOfCivilMonth,
  formatCivilDate,
  formatCivilDateLabel,
  formatCivilMonthLabel,
  localToday,
  parseCivilDate,
  type CivilDate,
} from '../../app/timeline/civil-date'
import { computeFloatingDirection, shouldAlignRight } from '../../utils/floating-position'
import styles from './DatePicker.module.css'

// Dates are civil dates (app/timeline/civil-date.ts): a stored value that is no real day (2026-02-30) is no date, and
// the grid starts on the locale's week start, like the Calendar panel's (canopi-f47t.52.82).

function isDayInRange(date: CivilDate, min: CivilDate | null, max: CivilDate | null): boolean {
  return (!min || compareCivilDates(date, min) >= 0) && (!max || compareCivilDates(date, max) <= 0)
}

/** Whether a month has no selectable day within min/max. */
function isMonthFullyDisabled(month: CivilDate, min: CivilDate | null, max: CivilDate | null): boolean {
  return (min !== null && compareCivilDates(endOfCivilMonth(month), min) < 0)
    || (max !== null && compareCivilDates({ ...month, day: 1 }, max) > 0)
}

function sameDay(a: CivilDate, b: CivilDate | null): boolean {
  return b !== null && compareCivilDates(a, b) === 0
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DatePickerProps {
  /** ISO YYYY-MM-DD string, or empty string for no selection */
  value: string
  onChange: (value: string) => void
  /** ISO YYYY-MM-DD min constraint */
  min?: string
  /** ISO YYYY-MM-DD max constraint */
  max?: string
  /** Shown when value is empty */
  placeholder?: string
  /** Applies --color-danger border (date validation error) */
  error?: boolean
  /** Extra class on the trigger button */
  className?: string
  /** Prevent parent overlays from closing on click */
  preserveOverlays?: boolean
  /** Accessible label for the trigger button */
  ariaLabel?: string
  /** Position the calendar against the viewport so a scroll region cannot clip it. */
  floating?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder,
  error,
  className,
  preserveOverlays = false,
  ariaLabel,
  floating = false,
}: DatePickerProps) {
  // Subscribe to locale for i18n reactivity
  const currentLocale = locale.value

  const open = useSignal(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const parsedValue = parseCivilDate(value)
  const minDate = parseCivilDate(min)
  const maxDate = parseCivilDate(max)

  // The month shown (day 1): the value's month, else today's
  const viewMonth = useSignal<CivilDate>({ ...(parsedValue ?? localToday()), day: 1 })

  // When value changes externally, sync view month
  const lastValue = useRef(value)
  if (value !== lastValue.current) {
    lastValue.current = value
    if (parsedValue) viewMonth.value = { ...parsedValue, day: 1 }
  }

  // Click-outside (pointerup) and focus leaving for another control, mirrors Dropdown.tsx
  useSignalEffect(() => {
    if (!open.value) return
    const handleOutside = (e: Event) => {
      if (!(e.target instanceof Node)) return
      if (ref.current?.contains(e.target) || popupRef.current?.contains(e.target)) return
      open.value = false
    }
    const dismissFloating = () => { if (floating) open.value = false }
    document.addEventListener('pointerup', handleOutside)
    document.addEventListener('focusin', handleOutside)
    window.addEventListener('resize', dismissFloating)
    window.addEventListener('scroll', dismissFloating, true)
    return () => {
      document.removeEventListener('pointerup', handleOutside)
      document.removeEventListener('focusin', handleOutside)
      window.removeEventListener('resize', dismissFloating)
      window.removeEventListener('scroll', dismissFloating, true)
    }
  })

  // Sync view to selected date when opening
  const handleToggle = () => {
    if (!open.value && parsedValue) viewMonth.value = { ...parsedValue, day: 1 }
    open.value = !open.value
  }

  const handleSelectDay = (date: CivilDate) => {
    open.value = false
    onChange(formatCivilDate(date))
    triggerRef.current?.focus()
  }

  const handlePrevMonth = () => { viewMonth.value = addCivilMonths(viewMonth.value, -1) }
  const handleNextMonth = () => { viewMonth.value = addCivilMonths(viewMonth.value, 1) }

  // Viewport-aware direction and horizontal alignment
  let resolvedDir: 'up' | 'down' = 'down'
  let alignRight = false
  if (open.value && triggerRef.current) {
    const rect = triggerRef.current.getBoundingClientRect()
    resolvedDir = computeFloatingDirection(rect, { gap: 4, minUsable: 240 }).direction
    alignRight = shouldAlignRight(rect, 220) // calendar is ~220px wide (fixed)
  }

  // Format trigger display
  const triggerText = parsedValue ? formatCivilDateLabel(parsedValue, currentLocale) : null

  const triggerClasses = [
    styles.trigger,
    error ? styles.triggerError : '',
    !triggerText ? styles.triggerPlaceholder : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  const calendar = open.value && (
    <CalendarPanel
      viewMonth={viewMonth.value}
      selectedDate={parsedValue}
      minDate={minDate}
      maxDate={maxDate}
      locale={currentLocale}
      direction={resolvedDir}
      alignRight={alignRight}
      popupRef={popupRef}
      floatingAnchor={floating ? triggerRef.current?.getBoundingClientRect() ?? null : null}
      onSelect={handleSelectDay}
      onPrevMonth={handlePrevMonth}
      onNextMonth={handleNextMonth}
      onClose={() => {
        open.value = false
        triggerRef.current?.focus()
      }}
    />
  )

  return (
    <div
      className={styles.datePicker}
      ref={ref}
      data-preserve-overlays={preserveOverlays ? 'true' : undefined}
    >
      <button
        ref={triggerRef}
        className={triggerClasses}
        type="button"
        onClick={handleToggle}
        role="combobox"
        aria-expanded={open.value}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
      >
        {triggerText ?? placeholder ?? ''}
      </button>
      {calendar && (floating ? createPortal(calendar, document.body) : calendar)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CalendarPanel (internal)
// ---------------------------------------------------------------------------

interface CalendarPanelProps {
  /** The month shown, day 1. */
  viewMonth: CivilDate
  selectedDate: CivilDate | null
  minDate: CivilDate | null
  maxDate: CivilDate | null
  locale: string
  direction: 'up' | 'down'
  alignRight?: boolean
  popupRef: RefObject<HTMLDivElement | null>
  floatingAnchor: DOMRect | null
  onSelect: (date: CivilDate) => void
  onPrevMonth: () => void
  onNextMonth: () => void
  onClose: () => void
}

function CalendarPanel({
  viewMonth,
  selectedDate,
  minDate,
  maxDate,
  locale: loc,
  direction,
  alignRight,
  popupRef,
  floatingAnchor,
  onSelect,
  onPrevMonth,
  onNextMonth,
  onClose,
}: CalendarPanelProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  // focusedDay is a ref (not signal) -- only read during render for tabIndex,
  // mutated in event handlers. Month-change re-renders supply correct value.
  const focusedDayRef = useRef<number | null>(null)
  const lastView = useRef<string>('')
  // Carries a keyboard-navigated day across the month-change re-render
  const pendingFocusDay = useRef<number | null>(null)

  const today = localToday()
  const totalDays = endOfCivilMonth(viewMonth).day
  const dayOfView = (day: number): CivilDate => ({ ...viewMonth, day })
  // The selected day in this month, else today, else the first selectable day
  const getInitialFocus = (): number => {
    if (selectedDate && selectedDate.year === viewMonth.year && selectedDate.month === viewMonth.month) {
      return selectedDate.day
    }
    if (today.year === viewMonth.year && today.month === viewMonth.month && isDayInRange(today, minDate, maxDate)) {
      return today.day
    }
    for (let d = 1; d <= totalDays; d++) {
      if (isDayInRange(dayOfView(d), minDate, maxDate)) return d
    }
    return 1
  }

  // Reset focused day when view month changes (no signal writes during render)
  const viewKey = formatCivilDate(viewMonth)
  if (lastView.current !== viewKey) {
    lastView.current = viewKey
    if (pendingFocusDay.current !== null) {
      focusedDayRef.current = pendingFocusDay.current
      pendingFocusDay.current = null
    } else {
      focusedDayRef.current = null
    }
  }

  // Compute effective focused day without signal writes
  const effectiveFocusedDay = focusedDayRef.current ?? getInitialFocus()
  // Keep ref in sync for keyboard handler reads
  focusedDayRef.current = effectiveFocusedDay

  // Auto-focus into calendar on mount and after month changes (ARIA dialog requirement), as it commits, so its Esc
  // handler hears the key from the first painted frame (canopi-f47t.52.228.20).
  useLayoutEffect(() => {
    const btn = gridRef.current?.querySelector(`[data-day="${focusedDayRef.current}"]`) as HTMLButtonElement | null
    btn?.focus()
  }, [viewKey])

  const monthYearLabel = formatCivilMonthLabel(viewMonth, loc)
  const weekdayHeaders = civilWeekdayLabels(loc)
  // The same weeks as the Calendar panel's grid; days outside the month are padding
  const cells = buildCivilMonthGrid(viewMonth, loc).flat().map((date) => {
    const current = date.month === viewMonth.month
    return { date, current, disabled: !current || !isDayInRange(date, minDate, maxDate) }
  })

  const prevDisabled = isMonthFullyDisabled(addCivilMonths(viewMonth, -1), minDate, maxDate)
  const nextDisabled = isMonthFullyDisabled(addCivilMonths(viewMonth, 1), minDate, maxDate)

  // Keyboard handler on the calendar dialog
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }

    const currentFocus = focusedDayRef.current ?? getInitialFocus()
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    const step = steps[e.key]

    if (step !== undefined) {
      e.preventDefault()
      let newDate = addCivilDays(dayOfView(currentFocus), step)
      if (minDate && compareCivilDates(newDate, minDate) < 0) newDate = minDate
      if (maxDate && compareCivilDates(newDate, maxDate) > 0) newDate = maxDate

      // If navigated to a different month, change view
      if (newDate.month !== viewMonth.month || newDate.year !== viewMonth.year) {
        pendingFocusDay.current = newDate.day
        if (compareCivilDates(newDate, viewMonth) < 0) onPrevMonth()
        else onNextMonth()
        // The layout effect on the view month focuses the day as the new month commits
      } else {
        focusedDayRef.current = newDate.day
        // Same-month navigation: focus the button directly
        const btn = gridRef.current?.querySelector(`[data-day="${newDate.day}"]`) as HTMLButtonElement | null
        btn?.focus()
      }
      return
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const date = dayOfView(currentFocus)
      if (isDayInRange(date, minDate, maxDate)) onSelect(date)
    }
  }

  const calendarClass = `${styles.calendar} ${direction === 'up' ? styles.calendarUp : styles.calendarDown}${floatingAnchor ? ` ${styles.calendarFloating}` : ''}`
  const calendarStyle = floatingAnchor
    ? direction === 'up'
      ? {
          left: alignRight ? 'auto' : `${Math.max(8, floatingAnchor.left)}px`,
          right: alignRight ? `${Math.max(8, window.innerWidth - floatingAnchor.right)}px` : 'auto',
          bottom: `${Math.max(8, window.innerHeight - floatingAnchor.top + 4)}px`,
        }
      : {
          left: alignRight ? 'auto' : `${Math.max(8, floatingAnchor.left)}px`,
          right: alignRight ? `${Math.max(8, window.innerWidth - floatingAnchor.right)}px` : 'auto',
          top: `${Math.max(8, floatingAnchor.bottom + 4)}px`,
        }
    : alignRight ? { left: 'auto', right: 0 } : undefined

  return (
    <div
      ref={popupRef}
      className={calendarClass}
      style={calendarStyle}
      data-floating-popup={floatingAnchor ? 'true' : undefined}
      role="dialog"
      aria-label={t('shared.datePicker.chooseDate')}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.header}>
        <button
          className={styles.navBtn}
          type="button"
          onClick={onPrevMonth}
          disabled={prevDisabled}
          aria-label={t('shared.datePicker.previousMonth')}
        >
          {'<'}
        </button>
        <span className={styles.monthLabel} aria-live="polite">
          {monthYearLabel}
        </span>
        <button
          className={styles.navBtn}
          type="button"
          onClick={onNextMonth}
          disabled={nextDisabled}
          aria-label={t('shared.datePicker.nextMonth')}
        >
          {'>'}
        </button>
      </div>

      <div className={styles.grid} role="grid" ref={gridRef}>
        {/* Weekday headers */}
        <div role="row" style={{ display: 'contents' }}>
          {weekdayHeaders.map((wh, i) => (
            <div key={i} className={styles.weekday} role="columnheader">
              {wh}
            </div>
          ))}
        </div>

        {/* Day cells in rows of 7 */}
        {Array.from({ length: Math.ceil(cells.length / 7) }, (_, rowIdx) => (
          <div key={rowIdx} role="row" style={{ display: 'contents' }}>
            {cells.slice(rowIdx * 7, rowIdx * 7 + 7).map((cell) => {
              const day = cell.date.day
              if (!cell.current) {
                return (
                  <div
                    key={`pad-${formatCivilDate(cell.date)}`}
                    className={`${styles.day} ${styles.dayPadding}`}
                    role="gridcell"
                    aria-disabled="true"
                  >
                    {day}
                  </div>
                )
              }

              const isToday = sameDay(cell.date, today)
              const isSelected = sameDay(cell.date, selectedDate)
              const isFocused = effectiveFocusedDay === day

              const dayClasses = [
                styles.day,
                isToday ? styles.dayToday : '',
                isSelected ? styles.daySelected : '',
                cell.disabled ? styles.dayDisabled : '',
              ].filter(Boolean).join(' ')

              return (
                <button
                  key={day}
                  className={dayClasses}
                  type="button"
                  role="gridcell"
                  data-day={day}
                  tabIndex={isFocused ? 0 : -1}
                  aria-selected={isSelected}
                  aria-disabled={cell.disabled}
                  disabled={cell.disabled}
                  onClick={() => {
                    if (!cell.disabled) onSelect(cell.date)
                  }}
                >
                  {day}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
