// app/timeline/civil-date.ts
// Owner of civil dates (date-only-in-civil-date, ADR 0028; §18 F13). Invariant: dates are
// parsed and displayed only here; other modules hand it CivilDate values.

export interface CivilDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
/**
 * First weekday (0 Sunday … 6 Saturday) by tag or language, for engines
 * without Intl week info (older WebKit). Matches CLDR for the app locales:
 * `pt` is Brazilian Portuguese and `zh` Simplified Chinese (China).
 */
const WEEK_START_FALLBACK: Readonly<Record<string, number>> = {
  'en-US': 0, en: 0, pt: 0, ja: 0, ko: 0,
  'en-GB': 1, fr: 1, de: 1, es: 1, it: 1, nl: 1, ru: 1, zh: 1,
}

export function parseCivilDate(value: string | null | undefined): CivilDate | null {
  if (!value) return null
  const match = CIVIL_DATE_PATTERN.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const local = new Date(year, month - 1, day)
  if (
    local.getFullYear() !== year
    || local.getMonth() !== month - 1
    || local.getDate() !== day
  ) return null
  return { year, month, day }
}

export function formatCivilDate(date: CivilDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

export function civilDateToLocalDate(date: CivilDate): Date {
  return new Date(date.year, date.month - 1, date.day)
}

export function localToday(now = new Date()): CivilDate {
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  }
}

export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const local = new Date(date.year, date.month - 1, date.day + days)
  return {
    year: local.getFullYear(),
    month: local.getMonth() + 1,
    day: local.getDate(),
  }
}

export function addCivilMonths(date: CivilDate, months: number): CivilDate {
  const local = new Date(date.year, date.month - 1 + months, 1)
  const lastDay = new Date(local.getFullYear(), local.getMonth() + 1, 0).getDate()
  return {
    year: local.getFullYear(),
    month: local.getMonth() + 1,
    day: Math.min(date.day, lastDay),
  }
}

export function compareCivilDates(left: CivilDate, right: CivilDate): number {
  return formatCivilDate(left).localeCompare(formatCivilDate(right))
}

export function startOfCivilMonth(date: CivilDate): CivilDate {
  return { year: date.year, month: date.month, day: 1 }
}

export function endOfCivilMonth(date: CivilDate): CivilDate {
  return {
    year: date.year,
    month: date.month,
    day: new Date(date.year, date.month, 0).getDate(),
  }
}

type LocaleWeekInfo = { readonly firstDay?: number }

/** The locale's first weekday as a `Date.getDay()` number (0 Sunday … 6 Saturday). */
export function civilWeekStartDay(locale: string): number {
  try {
    const intlLocale = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => LocaleWeekInfo
      weekInfo?: LocaleWeekInfo
    }
    const firstDay = (typeof intlLocale.getWeekInfo === 'function' ? intlLocale.getWeekInfo() : intlLocale.weekInfo)?.firstDay
    // Intl numbers weekdays 1 Monday … 7 Sunday.
    if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) return firstDay % 7
  } catch {
    // An unknown tag falls through to the table.
  }
  return WEEK_START_FALLBACK[locale] ?? WEEK_START_FALLBACK[locale.split('-')[0] ?? locale] ?? 1
}

/** Days from the locale's week start to `date` (0 … 6). */
export function civilWeekdayOffset(date: CivilDate, locale: string): number {
  return (civilDateToLocalDate(date).getDay() - civilWeekStartDay(locale) + 7) % 7
}

export function startOfCivilWeek(date: CivilDate, locale: string): CivilDate {
  return addCivilDays(date, -civilWeekdayOffset(date, locale))
}

export function buildCivilMonthGrid(month: CivilDate, locale: string): CivilDate[][] {
  const start = startOfCivilWeek(startOfCivilMonth(month), locale)
  const end = endOfCivilMonth(month)
  const weeks: CivilDate[][] = []
  let cursor = start
  do {
    const week = Array.from({ length: 7 }, (_, index) => addCivilDays(cursor, index))
    weeks.push(week)
    cursor = addCivilDays(cursor, 7)
  } while (compareCivilDates(cursor, end) <= 0)
  return weeks
}

export function civilDateInRange(
  date: CivilDate,
  start: CivilDate,
  end: CivilDate,
): boolean {
  return compareCivilDates(date, start) >= 0 && compareCivilDates(date, end) <= 0
}
