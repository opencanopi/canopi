import { describe, expect, it } from 'vitest'
import { getScaleBarDisplay } from '../canvas/map-scale'
import { SCALE_BAR_STEPS_M } from '../generated/quantity-table'
import {
  CONVERSION_CONSTANTS,
  currencyFractionDigits,
  currencySymbol,
  formatArea,
  formatByteSize,
  formatCatalogSize,
  formatCurrency,
  formatElevation,
  formatFixed,
  formatLength,
  formatNumber,
  formatPercent,
  formatPrecision,
  formatQuantity,
  formatRainfall,
  formatRasterResolution,
  formatScaleBarDistance,
  formatTemperature,
  formatVolume,
  niceDistanceAtMost,
  parseQuantity,
  pdfScalesForSystem,
  selectDisplayStyle,
} from './format'

describe('selectDisplayStyle', () => {
  it('applies wholeSourceRoundsToWholeUnit for catalog_size except km and mi (#394 N1)', () => {
    expect(selectDisplayStyle('catalog_size', 'metric', 3)).toEqual({ kind: 'single', unit: 'm', decimals: 0 })
    expect(selectDisplayStyle('catalog_size', 'us_customary', 3)).toEqual({ kind: 'single', unit: 'ft', decimals: 0 })
    expect(selectDisplayStyle('catalog_size', 'metric', 1.5)).toEqual({ kind: 'single', unit: 'm', decimals: 1 })
    expect(selectDisplayStyle('catalog_size', 'us_customary', 1.5)).toEqual({ kind: 'feet_and_inches', dropZeroInches: true })
    // #394 N1: km and mi keep their 2 decimals even for whole SI metre inputs.
    expect(selectDisplayStyle('catalog_size', 'metric', 1500)).toEqual({ kind: 'single', unit: 'km', decimals: 2 })
    expect(selectDisplayStyle('catalog_size', 'us_customary', 2000)).toEqual({ kind: 'single', unit: 'mi', decimals: 2 })
  })
})

describe('formatQuantity and convenience wrappers', () => {
  it('formats length bands in metric and US customary across locales', () => {
    expect(formatLength(0.9, 'metric', 'en-US')).toBe('90 cm')
    expect(formatLength(1.5, 'metric', 'en-US')).toBe('1.5 m')
    expect(formatLength(10, 'metric', 'en-US')).toBe('10 m')
    expect(formatLength(1500, 'metric', 'en-US')).toBe('1.50 km')
    expect(formatLength(1500, 'metric', 'de-DE')).toBe('1,50 km')

    expect(formatLength(0.1524, 'us_customary', 'en-US')).toBe('6 in')
    expect(formatLength(0.9144, 'us_customary', 'en-US')).toBe('3 ft')
    expect(formatLength(1.6764, 'us_customary', 'en-US')).toBe('5′ 6″')
    expect(formatLength(3.048, 'us_customary', 'en-US')).toBe('10 ft')
    expect(formatLength(1609.344, 'us_customary', 'en-US')).toBe('1.00 mi')
  })

  it('formats catalog_size with #394 N1 whole-unit rule', () => {
    expect(formatCatalogSize(3, 'metric', 'en-US')).toBe('3 m')
    expect(formatCatalogSize(3, 'us_customary', 'en-US')).toBe('10 ft')
    expect(formatCatalogSize(1500, 'metric', 'en-US')).toBe('1.50 km')
    expect(formatCatalogSize(1500, 'us_customary', 'en-US')).toBe('4,921 ft')
    expect(formatCatalogSize(2000, 'us_customary', 'en-US')).toBe('1.24 mi')
    expect(formatCatalogSize(1.5, 'metric', 'en-US')).toBe('1.5 m')
  })

  it('formats area, temperature, rainfall, volume, and raster resolution', () => {
    expect(formatArea(0.5, 'metric', 'en-US')).toBe('5,000 cm²')
    expect(formatArea(120, 'metric', 'en-US')).toBe('120 m²')
    expect(formatArea(15_000, 'metric', 'en-US')).toBe('1.50 ha')
    expect(formatArea(0.05, 'us_customary', 'en-US')).toBe('78 in²')
    expect(formatArea(100, 'us_customary', 'en-US')).toBe('1,076 ft²')
    expect(formatArea(4046.8564224, 'us_customary', 'en-US')).toBe('1.00 ac')

    expect(formatTemperature(0, 'metric', 'en-US')).toBe('0°C')
    expect(formatTemperature(0, 'us_customary', 'en-US')).toBe('32°F')
    expect(formatTemperature(-40, 'us_customary', 'en-US')).toBe('-40°F')

    expect(formatRainfall(25.4, 'metric', 'en-US')).toBe('25 mm')
    expect(formatRainfall(25.4, 'us_customary', 'en-US')).toBe('1.0 in')

    expect(formatVolume(3.785411784, 'metric', 'en-US')).toBe('3.8 L')
    expect(formatVolume(3.785411784, 'us_customary', 'en-US')).toBe('1.0 gal')

    expect(formatRasterResolution(0.5, 'metric', 'en-US')).toBe('50 cm')
    expect(formatRasterResolution(1, 'metric', 'en-US')).toBe('1.0 m')
  })

  it('formats elevations in m or ft without banding to km or mi (#932 B1)', () => {
    expect(formatElevation(1203, 'metric', 'en-US')).toBe('1,203 m')
    expect(formatElevation(1247, 'metric', 'en-US')).toBe('1,247 m')
    expect(formatElevation(1203, 'us_customary', 'en-US')).toBe('3,947 ft')
    expect(formatElevation(1247, 'us_customary', 'en-US')).toBe('4,091 ft')
    expect(formatElevation(1700, 'metric', 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe('1,700.00 m')
    expect(formatElevation(1700, 'us_customary', 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe('5,577.43 ft')
    expect(formatElevation(12.34, 'metric', 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' })).toBe('+12.3 m')
    expect(formatElevation(23.4, 'metric', 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })).toBe('23.4 m')
    expect(formatElevation(12.34, 'us_customary', 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' })).toBe('+40.5 ft')
    expect(formatElevation(0, 'metric', 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' })).toBe('0.0 m')
  })
})

describe('parseQuantity (#316 locale rules & cross-system input)', () => {
  it('parses de-DE comma decimals and dot group separators without treating dot as decimal', () => {
    expect(parseQuantity('length', '1,50 km', 'metric', 'de-DE')).toBeCloseTo(1500, 9)
    expect(parseQuantity('length', '1.500 m', 'metric', 'de-DE')).toBeCloseTo(1500, 9)
    expect(parseQuantity('length', '1.500,5 m', 'metric', 'de-DE')).toBeCloseTo(1500.5, 9)
    // Dot is the de-DE group separator, never a decimal fallback:
    expect(parseQuantity('length', '1.5 m', 'metric', 'de-DE')).toBeNull()
  })

  it('parses en-US comma group separators and dot decimals', () => {
    expect(parseQuantity('length', '1,500 ft', 'us_customary', 'en-US')).toBeCloseTo(457.2, 9)
    expect(parseQuantity('length', '1,500.5 m', 'metric', 'en-US')).toBeCloseTo(1500.5, 9)
  })

  it('parses fr-FR with NNBSP, NBSP, ASCII space grouping, and ASCII dot fallback', () => {
    expect(parseQuantity('length', '1\u202F500,5 m', 'metric', 'fr-FR')).toBeCloseTo(1500.5, 9)
    expect(parseQuantity('length', '1\u00A0500,5 m', 'metric', 'fr-FR')).toBeCloseTo(1500.5, 9)
    expect(parseQuantity('length', '1 500,5 m', 'metric', 'fr-FR')).toBeCloseTo(1500.5, 9)
    // ASCII `.` fallback is allowed in fr-FR because group separator is space, not `.`:
    expect(parseQuantity('length', '1.5 m', 'metric', 'fr-FR')).toBeCloseTo(1.5, 9)
  })

  it('parses es and it grouped numbers despite CLDR minimumGroupingDigits=2 (#921 B2)', () => {
    expect(parseQuantity('length', '1.500 m', 'metric', 'es')).toBeCloseTo(1500, 9)
    expect(parseQuantity('length', '10.000,5 m', 'metric', 'es')).toBeCloseTo(10000.5, 9)
    expect(parseQuantity('length', '1.5 m', 'metric', 'es')).toBeNull()
    expect(parseQuantity('length', '1.500 m', 'metric', 'it')).toBeCloseTo(1500, 9)
    expect(parseQuantity('length', '10.000,5 m', 'metric', 'it')).toBeCloseTo(10000.5, 9)
    expect(parseQuantity('length', '1.5 m', 'metric', 'it')).toBeNull()
    // Round trip: 1150 m² in US customary in Spanish formats with a dot thousands separator.
    const formatted = formatArea(1150, 'us_customary', 'es')
    const parsed = parseQuantity('area', formatted, 'us_customary', 'es')
    expect(parsed).not.toBeNull()
    expect(parsed!).toBeCloseTo(1150, 0)
  })

  it('parses compound feet and inches in any system mode', () => {
    expect(parseQuantity('length', `5' 6"`, 'us_customary', 'en-US')).toBeCloseTo(1.6764, 9)
    expect(parseQuantity('length', '5′ 6″', 'us_customary', 'en-US')).toBeCloseTo(1.6764, 9)
    expect(parseQuantity('length', `5'6"`, 'metric', 'en-US')).toBeCloseTo(1.6764, 9)
    expect(parseQuantity('length', '5′6″', 'metric', 'en-US')).toBeCloseTo(1.6764, 9)
    expect(parseQuantity('length', '5 ft 6 in', 'us_customary', 'en-US')).toBeCloseTo(1.6764, 9)
  })

  it('accepts cross-system aliases in any mode and uses bareInputUnit for bare numbers', () => {
    expect(parseQuantity('length', '10 ft', 'metric', 'en-US')).toBeCloseTo(3.048, 9)
    expect(parseQuantity('length', '10 m', 'us_customary', 'en-US')).toBeCloseTo(10, 9)
    expect(parseQuantity('length', '10', 'metric', 'en-US')).toBeCloseTo(10, 9)
    expect(parseQuantity('length', '10', 'us_customary', 'en-US')).toBeCloseTo(3.048, 9)
    expect(parseQuantity('temperature', '32 °F', 'metric', 'en-US')).toBeCloseTo(0, 9)
    expect(parseQuantity('temperature', '-40 F', 'us_customary', 'en-US')).toBeCloseTo(-40, 9)
    expect(parseQuantity('area', '1 acre', 'metric', 'en-US')).toBeCloseTo(CONVERSION_CONSTANTS.m2PerAcre, 6)
  })

  it('rejects negatives where disallowed, NaN, Infinity, empty strings, and unknown units', () => {
    expect(parseQuantity('length', '-5 m', 'metric', 'en-US')).toBeNull()
    expect(parseQuantity('length', `-5' 6"`, 'us_customary', 'en-US')).toBeNull()
    expect(parseQuantity('temperature', '-10 °C', 'metric', 'en-US')).toBe(-10)
    expect(parseQuantity('length', '', 'metric', 'en-US')).toBeNull()
    expect(parseQuantity('length', '   ', 'metric', 'en-US')).toBeNull()
    expect(parseQuantity('length', 'NaN', 'metric', 'en-US')).toBeNull()
    expect(parseQuantity('length', 'Infinity', 'metric', 'en-US')).toBeNull()
    expect(parseQuantity('length', '10 furlongs', 'metric', 'en-US')).toBeNull()
  })

  it('round-trips whole feet cleanly (3 ft never 2.99 ft, 4 ft -> 4 ft)', () => {
    for (const feet of [1, 2, 3, 4, 5, 8, 9, 10, 25, 100]) {
      const si = parseQuantity('length', `${feet} ft`, 'us_customary', 'en-US')!
      expect(si).toBeCloseTo(feet * CONVERSION_CONSTANTS.mPerFoot, 9)
      expect(formatLength(si, 'us_customary', 'en-US')).toBe(`${feet} ft`)
    }
    const si56 = parseQuantity('length', `5' 6"`, 'us_customary', 'en-US')!
    expect(formatLength(si56, 'us_customary', 'en-US')).toBe('5′ 6″')
  })

  it('round-trips Intl localized unit suffixes across non-Latin locales (ru, zh, ja, ko)', () => {
    for (const locale of ['ru', 'zh', 'ja', 'ko', 'de', 'fr']) {
      const formatted1m = formatLength(1, 'metric', locale, { trimTrailingZeros: true, maximumFractionDigits: 3 })
      expect(parseQuantity('length', formatted1m, 'metric', locale), `${locale}: ${formatted1m}`).toBeCloseTo(1, 6)
      const formatted50cm = formatLength(0.5, 'metric', locale, { trimTrailingZeros: true, maximumFractionDigits: 3 })
      expect(parseQuantity('length', formatted50cm, 'metric', locale), `${locale}: ${formatted50cm}`).toBeCloseTo(0.5, 6)
    }
  })
})

describe('scale bar steps and formatting', () => {
  it('picks nice steps in metric and US customary including below-floor and above-ceiling', () => {
    expect(niceDistanceAtMost(0, 'metric')).toBe(SCALE_BAR_STEPS_M.metric[0])
    expect(niceDistanceAtMost(0.3, 'metric')).toBeCloseTo(0.2, 9)
    expect(niceDistanceAtMost(0.08, 'metric')).toBeCloseTo(0.05, 9)
    expect(niceDistanceAtMost(35, 'metric')).toBe(20)
    expect(niceDistanceAtMost(1500, 'metric')).toBe(1000)
    expect(niceDistanceAtMost(12_500_000, 'metric')).toBe(10_000_000)

    expect(niceDistanceAtMost(0, 'us_customary')).toBe(SCALE_BAR_STEPS_M.us_customary[0])
    expect(niceDistanceAtMost(0.1, 'us_customary')).toBeLessThanOrEqual(0.1)
    expect(niceDistanceAtMost(0.1, 'us_customary')).toBeCloseTo(2 * CONVERSION_CONSTANTS.mPerInch, 9)
    expect(niceDistanceAtMost(1609.344, 'us_customary')).toBe(1609.344)
    expect(niceDistanceAtMost(20_000, 'us_customary')).toBeCloseTo(10 * CONVERSION_CONSTANTS.mPerMile, 6)
  })

  it('formats scale bar steps cleanly without spurious trailing decimals', () => {
    expect(formatScaleBarDistance(0.5, 'metric', 'en-US')).toBe('50 cm')
    expect(formatScaleBarDistance(1, 'metric', 'en-US')).toBe('1 m')
    expect(formatScaleBarDistance(500, 'metric', 'en-US')).toBe('500 m')
    expect(formatScaleBarDistance(1000, 'metric', 'en-US')).toBe('1 km')

    expect(formatScaleBarDistance(SCALE_BAR_STEPS_M.us_customary[0] ?? 0, 'us_customary', 'en-US')).toBe('6 in')
    expect(formatScaleBarDistance(CONVERSION_CONSTANTS.mPerFoot, 'us_customary', 'en-US')).toBe('1 ft')
    expect(formatScaleBarDistance(100 * CONVERSION_CONSTANTS.mPerFoot, 'us_customary', 'en-US')).toBe('100 ft')
    expect(formatScaleBarDistance(CONVERSION_CONSTANTS.mPerMile, 'us_customary', 'en-US')).toBe('1 mi')
  })

  it('preserves fractional digits for sub-floor deep-zoom scale-bar steps (#932 SF8)', () => {
    expect(formatScaleBarDistance(0.005, 'metric', 'en-US')).toBe('0.5 cm')
    expect(formatScaleBarDistance(0.002, 'metric', 'en-US')).toBe('0.2 cm')
    expect(formatScaleBarDistance(0.5 * CONVERSION_CONSTANTS.mPerInch, 'us_customary', 'en-US')).toBe('0.5 in')
    expect(formatScaleBarDistance(0.2 * CONVERSION_CONSTANTS.mPerInch, 'us_customary', 'en-US')).toBe('0.2 in')

    const metricHalfCm = getScaleBarDisplay(20_000, 'metric')
    expect(metricHalfCm.meters).toBeCloseTo(0.005, 9)
    expect(formatScaleBarDistance(metricHalfCm.meters, 'metric', 'en-US')).toBe('0.5 cm')

    const metricTwoMm = getScaleBarDisplay(50_000, 'metric')
    expect(metricTwoMm.meters).toBeCloseTo(0.002, 9)
    expect(formatScaleBarDistance(metricTwoMm.meters, 'metric', 'en-US')).toBe('0.2 cm')

    const usHalfIn = getScaleBarDisplay(8_000, 'us_customary')
    expect(usHalfIn.meters).toBeCloseTo(0.5 * CONVERSION_CONSTANTS.mPerInch, 9)
    expect(formatScaleBarDistance(usHalfIn.meters, 'us_customary', 'en-US')).toBe('0.5 in')

    const usTwoTenthsIn = getScaleBarDisplay(20_000, 'us_customary')
    expect(usTwoTenthsIn.meters).toBeCloseTo(0.2 * CONVERSION_CONSTANTS.mPerInch, 9)
    expect(formatScaleBarDistance(usTwoTenthsIn.meters, 'us_customary', 'en-US')).toBe('0.2 in')
  })
})

describe('pdfScalesForSystem', () => {
  it('offers ratio scales in metric and ratio + US architectural + US engineering in US customary', () => {
    const metric = pdfScalesForSystem('metric')
    expect(metric.every((s) => s.group === 'ratio')).toBe(true)
    expect(metric).toHaveLength(9)

    const us = pdfScalesForSystem('us_customary')
    expect(us.filter((s) => s.group === 'ratio')).toHaveLength(9)
    expect(us.filter((s) => s.group === 'us_architectural')).toHaveLength(9)
    expect(us.filter((s) => s.group === 'us_engineering')).toHaveLength(7)
    expect(us).toHaveLength(25)
  })
})

describe('formatByteSize (2.1-Q359)', () => {
  it('uses decimal SI (1000) across thresholds and locales', () => {
    expect(formatByteSize(0, 'en')).toBe('0 kB')
    expect(formatByteSize(999_000, 'en')).toBe('999 kB')
    expect(formatByteSize(1_000_000, 'en')).toBe('1 MB')
    expect(formatByteSize(1_500_000, 'en')).toBe('1.5 MB')
    expect(formatByteSize(512 * 1024 * 1024, 'en')).toBe('537 MB')
    expect(formatByteSize(1_000_000_000, 'en')).toBe('1 GB')
    expect(formatByteSize(2048 * 1024 * 1024, 'en')).toBe('2.1 GB')

    expect(formatByteSize(512 * 1024 * 1024, 'fr')).toMatch(/537\s?Mo/u)
    expect(formatByteSize(2048 * 1024 * 1024, 'fr')).toMatch(/2,1\s?Go/u)
  })
})

describe('general number, percent, fixed, precision, and currency helpers', () => {
  it('formats numbers, percentages, fixed, precision, and currencies', () => {
    expect(formatNumber(1234.5, 'en-US')).toBe('1,234.5')
    expect(formatNumber(1234.5, 'de-DE')).toBe('1.234,5')
    expect(formatPercent(0.75, 'en-US')).toBe('75%')
    expect(formatFixed(3.14159, 2)).toBe('3.14')
    expect(formatPrecision(123.456, 3)).toBe('123')
    expect(currencyFractionDigits('USD', 'en-US')).toBe(2)
    expect(currencyFractionDigits('JPY', 'en-US')).toBe(0)
    expect(formatCurrency(12.5, 'USD', 'en-US')).toBe('$12.50')
    expect(currencySymbol('EUR', 'en-US')).toBe('€')
    expect(formatQuantity('length', 10, 'metric', 'en-US')).toBe('10 m')
  })
})
