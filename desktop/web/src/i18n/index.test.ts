import { afterEach, describe, expect, it, vi } from 'vitest'

import { locale } from '../app/settings/state'
import { isLocaleKey, t } from '.'

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
})
