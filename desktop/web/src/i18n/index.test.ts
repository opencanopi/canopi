import { afterEach, describe, expect, it, vi } from 'vitest'

import { locale } from '../app/settings/state'
import { openSetText, t } from '.'

describe('typed translation keys', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    locale.value = 'en'
  })

  it('refuses at typecheck a key English lacks', () => {
    // @ts-expect-error 'no.such.key' is no LocaleKey; this directive fails typecheck if t stops refusing it
    expect(t('no.such.key')).toBe('no.such.key')
  })

  it('returns the English text of a known key', () => {
    locale.value = 'en'

    expect(t('about.title')).toBe('About Canopi')
    expect(t('plantDb.speciesAtLeast', { count: 3 })).toBe('3+ species')
  })

  it('openSetText reads a value whose key English holds as a string, in production too', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('DEV', false)
    locale.value = 'en'
    const tree: string = 'Tree'
    const other: string = 'other'

    expect(openSetText('filters.habit_', tree)).toBe(t('filters.habit_Tree'))
    expect(openSetText('canvas.timeline.type_', other)).toBe(t('canvas.timeline.type_other'))
  })

  it('openSetText falls back for a key English lacks, in production too, never reading a missing key', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('DEV', false)
    const unheardOf: string = 'Unheard of'
    const none: string = ''

    expect(openSetText('filters.habit_', unheardOf, '-')).toBe('-')
    expect(openSetText('canvas.timeline.type_', none, '-')).toBe('-')
  })

  it('openSetText names an open-set value in its key family, or its fallback, and refuses a family English lacks', () => {
    locale.value = 'en'
    const tree: string = 'Tree'
    const mediterranean: string = 'Mediterranean'
    const unheardOf: string = 'Unheard of'

    expect(openSetText('filters.habit_', tree)).toBe('Tree')
    expect(openSetText('filters.climateZone_', mediterranean)).toBe(t('filters.climateZone_Mediterranean'))
    expect(openSetText('filters.habit_', unheardOf)).toBe('Unheard of')
    expect(openSetText('filters.habit_', unheardOf, '-')).toBe('-')
    // @ts-expect-error 'filters.habbit_' starts no LocaleKey; this directive fails typecheck if openSetText stops refusing it
    expect(openSetText('filters.habbit_', tree)).toBe('Tree')
  })

  it('openSetText refuses at typecheck a literal value, whose fallback would hide a misspelled key: a known text is t(key)', () => {
    locale.value = 'en'
    const closed = 'Tree' as 'Tree' | 'Shrub'

    // @ts-expect-error a literal value is a known key, written t('filters.habit_Tree'); this directive fails typecheck if openSetText takes it
    expect(openSetText('filters.habit_', 'Tre')).toBe('Tre')
    // @ts-expect-error a closed union is a typed table lookup (Record<Union, LocaleKey>); this directive fails typecheck if openSetText takes it
    expect(openSetText('filters.habit_', closed)).toBe('Tree')
  })
})
