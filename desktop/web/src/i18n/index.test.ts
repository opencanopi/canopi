import { afterEach, describe, expect, it, vi } from 'vitest'

import { locale } from '../app/settings/state'
import { isLocaleKey, openSetText, t } from '.'

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

  it('isLocaleKey narrows only a key English holds, plural bases included, in production too', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('DEV', false)
    const known: string = 'about.title'
    const unknown: string = 'filters.habit_Unheard of'

    expect(isLocaleKey(known) ? t(known) : 'fallback').toBe('About Canopi')
    expect(isLocaleKey('plantDb.speciesAtLeast')).toBe(true)
    expect(isLocaleKey('plantDb.speciesAtLeast_other')).toBe(true)
    expect(isLocaleKey(unknown) ? t(unknown) : 'fallback').toBe('fallback')
  })

  it('isLocaleKey refuses a group of keys and an _other key with no plural siblings, as the LocaleKey union does', () => {
    const group: string = 'plantDb'

    expect(isLocaleKey(group) ? t(group) : 'fallback').toBe('fallback')
    expect(isLocaleKey('canvas.timeline.type')).toBe(false)
    expect(isLocaleKey('canvas.timeline.type_other')).toBe(true)
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
