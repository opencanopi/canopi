import { describe, expect, it } from 'vitest'
import { formatByteSize } from './format'

describe('formatByteSize (2.1-Q359 decimal SI)', () => {
  it('formats 999 kB, 1 MB and 1 GB in two locales', () => {
    expect(formatByteSize(999_000, 'en')).toBe('999 kB')
    expect(formatByteSize(1_000_000, 'en')).toBe('1 MB')
    expect(formatByteSize(1_000_000_000, 'en')).toBe('1 GB')

    expect(formatByteSize(999_000, 'fr')).toMatch(/999\s?ko/u)
    expect(formatByteSize(1_000_000, 'fr')).toMatch(/1\s?Mo/u)
    expect(formatByteSize(1_000_000_000, 'fr')).toMatch(/1\s?Go/u)
  })

  it('formats binary MiB/GiB import limits in decimal SI (537 MB and 2.1 GB)', () => {
    expect(formatByteSize(512 * 1024 * 1024, 'en')).toBe('537 MB')
    expect(formatByteSize(2048 * 1024 * 1024, 'en')).toBe('2.1 GB')
    expect(formatByteSize(1_500_000, 'en')).toBe('1.5 MB')
  })
})
