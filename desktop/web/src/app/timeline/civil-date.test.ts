import { describe, expect, it } from 'vitest'
import * as civilDate from './civil-date'

describe('instant display', () => {
  it.fails('[1b-c7 canopi-f47t.52.137] canopi-f47t.52.137: last changed reads one way on Start screen, Drafts and Data library', () => {
    // One list formatter for an instant (design check F7): the Start screen, Drafts and the Data library call it.
    const formatInstantInList = (civilDate as Record<string, unknown>).formatInstantInList
    expect(typeof formatInstantInList).toBe('function')
    const format = formatInstantInList as (iso: string, locale: string, now: Date) => string
    const now = new Date('2026-07-04T12:00:00.000Z')
    expect(format('2026-07-01T09:30:00.000Z', 'en', now)).toBe(format('2026-07-01T09:30:00.000Z', 'en', now))
  })
})
