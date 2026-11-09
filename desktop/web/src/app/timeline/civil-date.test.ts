import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  addCivilDays,
  addCivilMonths,
  buildCivilMonthGrid,
  civilDateToLocalDate,
  formatCivilDate,
  formatInstantInDetail,
  formatInstantInList,
  civilWeekStartDay,
  parseCivilDate,
  startOfCivilWeek,
} from './civil-date'

describe('calendar civil dates', () => {
  it('parses strict dates and crosses leap-day and year boundaries', () => {
    expect(parseCivilDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 })
    expect(parseCivilDate('2023-02-29')).toBeNull()
    expect(parseCivilDate('2026-2-01')).toBeNull()
    expect(formatCivilDate(addCivilDays({ year: 2024, month: 2, day: 28 }, 1))).toBe('2024-02-29')
    expect(formatCivilDate(addCivilDays({ year: 2026, month: 12, day: 31 }, 1))).toBe('2027-01-01')
    expect(formatCivilDate(addCivilMonths({ year: 2026, month: 1, day: 31 }, 1))).toBe('2026-02-28')
  })

  it('uses locale week starts and emits actual five or six week months', () => {
    const date = { year: 2026, month: 9, day: 9 }
    expect(formatCivilDate(startOfCivilWeek(date, 'en'))).toBe('2026-09-06')
    expect(formatCivilDate(startOfCivilWeek(date, 'fr'))).toBe('2026-09-07')
    expect(buildCivilMonthGrid({ year: 2026, month: 2, day: 1 }, 'en')).toHaveLength(4)
    expect(buildCivilMonthGrid({ year: 2026, month: 8, day: 1 }, 'fr')).toHaveLength(6)
  })

  it('follows the locale week start from Intl week info', () => {
    // 2026-09-09 is a Wednesday: Monday is the 7th, Sunday the 6th.
    const date = { year: 2026, month: 9, day: 9 }
    for (const tag of ['fr', 'de', 'es', 'it', 'nl', 'ru', 'zh', 'en-GB']) {
      expect(formatCivilDate(startOfCivilWeek(date, tag)), tag).toBe('2026-09-07')
    }
    for (const tag of ['en', 'en-US', 'pt', 'ja', 'ko']) {
      expect(formatCivilDate(startOfCivilWeek(date, tag)), tag).toBe('2026-09-06')
    }
  })

  describe('without Intl week info (older WebKit)', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('falls back to a table for the app locales', () => {
      class LocaleWithoutWeekInfo { constructor(readonly baseName: string) {} }
      vi.stubGlobal('Intl', { ...Intl, Locale: LocaleWithoutWeekInfo })
      for (const tag of ['fr', 'de', 'es', 'it', 'nl', 'ru', 'zh']) {
        expect(civilWeekStartDay(tag), tag).toBe(1)
      }
      for (const tag of ['en', 'en-US', 'pt', 'ja', 'ko']) expect(civilWeekStartDay(tag), tag).toBe(0)
      expect(civilWeekStartDay('en-GB')).toBe(1)
      expect(civilWeekStartDay('xx')).toBe(1)
    })
  })

  it('uses calendar constructors through both DST transitions without shifting the day', () => {
    for (const [date, expected] of [
      [{ year: 2026, month: 3, day: 28 }, '2026-03-29'],
      [{ year: 2026, month: 10, day: 24 }, '2026-10-25'],
    ] as const) {
      const next = addCivilDays(date, 1)
      expect(formatCivilDate(next)).toBe(expected)
      expect(civilDateToLocalDate(next).getHours()).toBe(0)
    }
  })
})

// Instants (2.1-Q103): relative in lists, the full date and time in detail panes. The zone east of UTC
// (canopi-f47t.61): Recent Designs and Drafts carry UTC instants with their zone (`…Z`), and the row shows the local
// day and time.
describe('formatInstantInList in Europe/Paris', () => {
  let zone: string | undefined
  beforeAll(() => {
    zone = process.env.TZ
    process.env.TZ = 'Europe/Paris'
  })
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('pins the zone it runs in', () => {
    expect(new Date('2026-10-13T23:11:59Z').getHours()).toBe(1)
  })

  it('shows a Design saved at 01:11 CEST, 23:11 UTC the day before, as today at 1:11 AM', () => {
    const now = new Date('2026-10-14T08:00:00Z')
    expect(formatInstantInList('2026-10-13T23:11:59Z', 'en', now)).toBe('Today, 1:11 AM')
  })

  it('shows a Draft stamped with milliseconds in local time too', () => {
    const now = new Date('2026-10-14T08:00:00Z')
    expect(formatInstantInList('2026-10-12T22:30:00.000Z', 'en', now)).toBe('Yesterday, 12:30 AM')
  })

  it('shows an older instant by its local day', () => {
    const now = new Date('2026-10-14T08:00:00Z')
    expect(formatInstantInList('2026-09-11T22:30:00Z', 'en', now)).toBe('Sep 12')
  })

  it('canopi-f47t.52.137: last changed reads one way on Start screen, Drafts and Data library', () => {
    // One instant, stamped as ISO text (Recent Designs, Drafts, the notebook) or unix milliseconds (the Data library),
    // reads the same in a list and, in full, in a detail pane.
    const now = new Date('2026-10-14T08:00:00Z')
    const iso = '2025-09-11T22:30:00.000Z'
    const unixMs = String(Date.UTC(2025, 8, 11, 22, 30))
    expect(formatInstantInList(iso, 'en', now)).toBe('Sep 12, 2025')
    expect(formatInstantInList(unixMs, 'en', now)).toBe('Sep 12, 2025')
    expect(formatInstantInDetail(iso, 'en')).toBe('Sep 12, 2025, 12:30 AM')
    expect(formatInstantInDetail(unixMs, 'en')).toBe(formatInstantInDetail(iso, 'en'))
    for (const unreadable of ['', 'yesterday', '2026-02-30T00:00:00Z', 'NaN']) {
      expect(formatInstantInList(unreadable, 'en', now), unreadable).toBe('')
      expect(formatInstantInDetail(unreadable, 'en'), unreadable).toBe('')
    }
  })
})
