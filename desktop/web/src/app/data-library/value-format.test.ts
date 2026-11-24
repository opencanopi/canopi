import { describe, expect, it } from 'vitest'
import { formatRowValue } from './value-format'

describe('formatRowValue (canopi-f47t.42, Q20 and Q22)', () => {
  it('writes metres to 2 decimals, degrees and percent to 1', () => {
    expect(formatRowValue(312.456, 'm', 'en')).toBe('312.46 m')
    expect(formatRowValue(-3.14159, 'm', 'en')).toBe('-3.14 m')
    expect(formatRowValue(23.44, '°', 'en')).toBe('23.4°')
    expect(formatRowValue(41.25, '%', 'en')).toBe('41.3%')
  })

  it('writes any other value to 4 significant digits, with its unit when known', () => {
    expect(formatRowValue(1234.567, 'unknown', 'en')).toBe('1,235')
    expect(formatRowValue(0.0123456, '', 'en')).toBe('0.01235')
    expect(formatRowValue(7.123456, 'mm', 'en')).toBe('7.123 mm')
  })

  it('uses the locale\'s digits and separators', () => {
    expect(formatRowValue(1234.5, 'm', 'fr')).toBe('1 234,50 m')
    expect(formatRowValue(23.44, '°', 'de')).toBe('23,4°')
  })

  it('writes an em dash where the raster has no value', () => {
    expect(formatRowValue(null, 'm', 'en')).toBe('—')
  })
})
