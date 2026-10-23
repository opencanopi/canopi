import { useRef, useCallback, useEffect } from 'preact/hooks'
import { useSignal, useSignalEffect } from '@preact/signals'
import { createPortal, type RefObject } from 'preact'
import { t } from '../../i18n'
import { locale } from '../../app/settings/state'
import { computeFloatingDirection, shouldAlignRight } from '../../utils/floating-position'
import styles from './DatePicker.module.css'

/** Format a Date as ISO 8601 date string (YYYY-MM-DD). */
function toISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ---------------------------------------------------------------------------
// Intl.DateTimeFormat cache
// ---------------------------------------------------------------------------

const _dtfCache = new Map<string, Intl.DateTimeFormat>()

function cachedDTF(loc: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${loc}:${JSON.stringify(options)}`
  let fmt = _dtfCache.get(key)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(loc, options)
    _dtfCache.set(key, fmt)
  }
  return fmt
}

// ---------------------------------------------------------------------------
// Week start day by locale
// ---------------------------------------------------------------------------

const SUNDAY_START_LOCALES = new Set(['en', 'pt', 'zh', 'ja', 'ko'])

function weekStartsOnSunday(loc: string): boolean {
  return SUNDAY_START_LOCALES.has(loc)
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseISO(iso: string): Date | null {
  if (!iso) return null
  const d = new Date(iso + 'T00:00:00')
  return isNaN(d.getTime()) ? null : d
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

function isDayInRange(date: Date, min: Date | null, max: Date | null): boolean {
  if (min) {
    const minDay = new Date(min.getFullYear(), min.getMonth(), min.getDate())
    if (date < minDay) return false
  }
  if (max) {
    const maxDay = new Date(max.getFullYear(), max.getMonth(), max.getDate())
    if (date > maxDay) return false
  }
  return true
}

/** Check if an entire month has zero selectable days within min/max range. */
function isMonthFullyDisabled(year: number, month: number, min: Date | null, max: Date | null): boolean {
  if (!min && !max) return false
  const days = daysInMonth(year, month)
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month, days)
  if (min) {
    const minDay = new Date(min.getFullYear(), min.getMonth(), min.getDate())
    if (lastDay < minDay) return true
  }
  if (max) {
    const maxDay = new Date(max.getFullYear(), max.getMonth(), max.getDate())
    if (firstDay > maxDay) return true
  }
  return false
}

function prevMonth(year: number, month: number): [number, number] {
  return month === 0 ? [year - 1, 11] : [year, month - 1]
}

function nextMonth(year: number, month: number): [number, number] {
  return month === 11 ? [year + 1, 0] : [year, month + 1]
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

  const parsedValue = parseISO(value)
  const minDate = parseISO(min ?? '')
  const maxDate = parseISO(max ?? '')

  // View month state -- initialize to value's month or today
  const viewYear = useSignal(parsedValue?.getFullYear() ?? new Date().getFullYear())
  const viewMonth = useSignal(parsedValue?.getMonth() ?? new Date().getMonth())

  // When value changes externally, sync view month
  const lastValue = useRef(value)
  if (value !== lastValue.current) {
    lastValue.current = value
    const d = parseISO(value)
    if (d) {
      viewYear.value = d.getFullYear()
      viewMonth.value = d.getMonth()
    }
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
  const handleToggle = useCallback(() => {
    if (!open.value) {
      const d = parseISO(value)
      if (d) {
        viewYear.value = d.getFullYear()
        viewMonth.value = d.getMonth()
      }
    }
    open.value = !open.value
  }, [value]) // eslint-disable-line

  const handleSelectDay = useCallback((date: Date) => {
    open.value = false
    onChange(toISODate(date))
    triggerRef.current?.focus()
  }, [onChange]) // eslint-disable-line

  const handlePrevMonth = useCallback(() => {
    const [y, m] = prevMonth(viewYear.value, viewMonth.value)
    viewYear.value = y
    viewMonth.value = m
  }, []) // eslint-disable-line

  const handleNextMonth = useCallback(() => {
    const [y, m] = nextMonth(viewYear.value, viewMonth.value)
    viewYear.value = y
    viewMonth.value = m
  }, []) // eslint-disable-line

  // Viewport-aware direction and horizontal alignment
  let resolvedDir: 'up' | 'down' = 'down'
  let alignRight = false
  if (open.value && triggerRef.current) {
    const rect = triggerRef.current.getBoundingClientRect()
    resolvedDir = computeFloatingDirection(rect, { gap: 4, minUsable: 240 }).direction
    alignRight = shouldAlignRight(rect, 220) // calendar is ~220px wide (fixed)
  }

  // Format trigger display
  const triggerText = parsedValue
    ? cachedDTF(currentLocale, { day: 'numeric', month: 'short', year: 'numeric' }).format(parsedValue)
    : null

  const triggerClasses = [
    styles.trigger,
    error ? styles.triggerError : '',
    !triggerText ? styles.triggerPlaceholder : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  const calendar = open.value && (
    <CalendarPanel
      viewYear={viewYear.value}
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
  viewYear: number
  viewMonth: number
  selectedDate: Date | null
  minDate: Date | null
  maxDate: Date | null
  locale: string
  direction: 'up' | 'down'
  alignRight?: boolean
  popupRef: RefObject<HTMLDivElement | null>
  floatingAnchor: DOMRect | null
  onSelect: (date: Date) => void
  onPrevMonth: () => void
  onNextMonth: () => void
  onClose: () => void
}

function CalendarPanel({
  viewYear,
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

  // Determine initial focused day
  const today = new Date()
  const totalDays = daysInMonth(viewYear, viewMonth)
  const getInitialFocus = (): number => {
    if (selectedDate && selectedDate.getFullYear() === viewYear && selectedDate.getMonth() === viewMonth) {
      return selectedDate.getDate()
    }
    if (today.getFullYear() === viewYear && today.getMonth() === viewMonth) {
      const day = today.getDate()
      if (isDayInRange(new Date(viewYear, viewMonth, day), minDate, maxDate)) return day
    }
    for (let d = 1; d <= totalDays; d++) {
      if (isDayInRange(new Date(viewYear, viewMonth, d), minDate, maxDate)) return d
    }
    return 1
  }

  // Reset focused day when view month changes (no signal writes during render)
  const viewKey = `${viewYear}-${viewMonth}`
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

  // Auto-focus into calendar on mount and after month changes (ARIA dialog requirement)
  useEffect(() => {
    const btn = gridRef.current?.querySelector(`[data-day="${focusedDayRef.current}"]`) as HTMLButtonElement | null
    btn?.focus()
  }, [viewYear, viewMonth])

  // Month+year header label
  const monthYearLabel = cachedDTF(loc, { month: 'long', year: 'numeric' }).format(
    new Date(viewYear, viewMonth, 1)
  )

  // Day-of-week headers
  const sundayStart = weekStartsOnSunday(loc)
  const weekdayFmt = cachedDTF(loc, { weekday: 'short' })
  const weekdayHeaders: string[] = []
  // Generate day headers starting from the correct day
  const baseDate = new Date(2024, 0, 7) // A known Sunday (2024-01-07)
  const startOffset = sundayStart ? 0 : 1
  for (let i = 0; i < 7; i++) {
    const d = new Date(baseDate)
    d.setDate(baseDate.getDate() + startOffset + i)
    weekdayHeaders.push(weekdayFmt.format(d))
  }

  // Grid cells
  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay() // 0=Sun
  const offset = sundayStart ? firstDayOfMonth : ((firstDayOfMonth + 6) % 7)
  const prevDays = daysInMonth(...prevMonth(viewYear, viewMonth))

  type CellData = { day: number; type: 'padding' | 'current'; date: Date; disabled: boolean }
  const cells: CellData[] = []

  // Padding from previous month
  for (let i = offset - 1; i >= 0; i--) {
    const day = prevDays - i
    const [py, pm] = prevMonth(viewYear, viewMonth)
    cells.push({ day, type: 'padding', date: new Date(py, pm, day), disabled: true })
  }

  // Current month days
  for (let d = 1; d <= totalDays; d++) {
    const date = new Date(viewYear, viewMonth, d)
    const disabled = !isDayInRange(date, minDate, maxDate)
    cells.push({ day: d, type: 'current', date, disabled })
  }

  // Padding from next month
  const remaining = 7 - (cells.length % 7)
  if (remaining < 7) {
    const [ny, nm] = nextMonth(viewYear, viewMonth)
    for (let d = 1; d <= remaining; d++) {
      cells.push({ day: d, type: 'padding', date: new Date(ny, nm, d), disabled: true })
    }
  }

  // Nav button disabled state
  const [prevY, prevM] = prevMonth(viewYear, viewMonth)
  const [nextY, nextM] = nextMonth(viewYear, viewMonth)
  const prevDisabled = isMonthFullyDisabled(prevY, prevM, minDate, maxDate)
  const nextDisabled = isMonthFullyDisabled(nextY, nextM, minDate, maxDate)

  // Keyboard handler on the calendar dialog
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }

    const currentFocus = focusedDayRef.current ?? getInitialFocus()

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      let newDate = new Date(viewYear, viewMonth, currentFocus)

      if (e.key === 'ArrowLeft') newDate.setDate(newDate.getDate() - 1)
      else if (e.key === 'ArrowRight') newDate.setDate(newDate.getDate() + 1)
      else if (e.key === 'ArrowUp') newDate.setDate(newDate.getDate() - 7)
      else if (e.key === 'ArrowDown') newDate.setDate(newDate.getDate() + 7)

      // Clamp to min/max
      if (minDate && newDate < minDate) newDate = new Date(minDate)
      if (maxDate && newDate > maxDate) newDate = new Date(maxDate)

      // If navigated to a different month, change view
      if (newDate.getMonth() !== viewMonth || newDate.getFullYear() !== viewYear) {
        pendingFocusDay.current = newDate.getDate()
        if (newDate < new Date(viewYear, viewMonth, 1)) onPrevMonth()
        else onNextMonth()
        // useEffect on [viewYear, viewMonth] handles focus after re-render
      } else {
        focusedDayRef.current = newDate.getDate()
        // Same-month navigation: focus the button directly
        const btn = gridRef.current?.querySelector(`[data-day="${newDate.getDate()}"]`) as HTMLButtonElement | null
        btn?.focus()
      }
      return
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const date = new Date(viewYear, viewMonth, currentFocus)
      if (isDayInRange(date, minDate, maxDate)) {
        onSelect(date)
      }
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
              if (cell.type === 'padding') {
                return (
                  <div
                    key={`pad-${cell.date.getTime()}`}
                    className={`${styles.day} ${styles.dayPadding}`}
                    role="gridcell"
                    aria-disabled="true"
                  >
                    {cell.day}
                  </div>
                )
              }

              const isToday = isSameDay(cell.date, today)
              const isSelected = selectedDate !== null && isSameDay(cell.date, selectedDate)
              const isFocused = effectiveFocusedDay === cell.day

              const dayClasses = [
                styles.day,
                isToday ? styles.dayToday : '',
                isSelected ? styles.daySelected : '',
                cell.disabled ? styles.dayDisabled : '',
              ].filter(Boolean).join(' ')

              return (
                <button
                  key={cell.day}
                  className={dayClasses}
                  type="button"
                  role="gridcell"
                  data-day={cell.day}
                  tabIndex={isFocused ? 0 : -1}
                  aria-selected={isSelected}
                  aria-disabled={cell.disabled}
                  disabled={cell.disabled}
                  onClick={() => {
                    if (!cell.disabled) onSelect(cell.date)
                  }}
                >
                  {cell.day}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
