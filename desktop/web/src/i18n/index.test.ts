import { afterEach, describe, expect, it, vi } from 'vitest'

import { locale } from '../app/settings/state'
import { dynamicLocaleKey, isLocaleKey, t } from '.'

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

  it('dynamicLocaleKey throws under test and dev for a key absent from English', () => {
    expect(() => dynamicLocaleKey('no.such.key')).toThrow(/no\.such\.key/)
    expect(dynamicLocaleKey('about.title')).toBe('about.title')
    expect(dynamicLocaleKey('plantDb.speciesAtLeast')).toBe('plantDb.speciesAtLeast')
    expect(dynamicLocaleKey('plantDb.speciesAtLeast_other')).toBe('plantDb.speciesAtLeast_other')
  })

  it('dynamicLocaleKey returns a key absent from English unchanged in production', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('DEV', false)

    expect(dynamicLocaleKey('no.such.key')).toBe('no.such.key')
  })

  it('isLocaleKey narrows only a key English holds, in production too, for a value read from the catalog', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('DEV', false)
    const known: string = 'about.title'
    const unknown: string = 'filters.habit_Unheard of'

    expect(isLocaleKey(known) ? t(known) : 'fallback').toBe('About Canopi')
    expect(isLocaleKey('plantDb.speciesAtLeast')).toBe(true)
    expect(isLocaleKey(unknown) ? t(unknown) : 'fallback').toBe('fallback')
  })
})
