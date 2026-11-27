// Owner of locale number, quantity, scale-bar, PDF scale, currency and
// byte-size formatting and parsing (ADR 0027, contracts §14, `2.1-Q120`,
// `2.1-Q121`, `2.1-Q133`, `2.1-Q356`, `2.1-Q359`).
// Invariants: no direct `Intl.NumberFormat` or `toLocaleString` outside this
// module (`number-format-only-in-utils`, `no-currency-symbol-table`); all
// display bands and conversion constants derive from `generated/quantity-table`.

import {
  CONVERSION_CONSTANTS,
  PDF_SCALES,
  QUANTITY_TABLE,
  SCALE_BAR_STEPS_M,
  UNIT_META,
  type DisplayBand,
  type DisplayStyle,
  type PdfScaleSpec,
  type QuantityKind,
  type UnitId,
  type UnitInputSpec,
  type UnitSystem,
} from '../generated/quantity-table'

export { CONVERSION_CONSTANTS, type UnitSystem }

export interface FormatQuantityOptions {
  /** Omit trailing fractional zeros (used by scale-bar labels: `1 km`, `5 m`, `1 mi`). */
  readonly trimTrailingZeros?: boolean
  readonly minimumFractionDigits?: number
  readonly maximumFractionDigits?: number
}

const numberFormatterCache = new Map<string, Intl.NumberFormat>()
const separatorCache = new Map<string, { readonly decimal: string; readonly group: string }>()

function cachedNumberFormat(locale: string | undefined, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ''}|${options ? JSON.stringify(options) : ''}`
  let formatter = numberFormatterCache.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options)
    numberFormatterCache.set(key, formatter)
  }
  return formatter
}

/** Formats a number using a cached `Intl.NumberFormat`. */
export function formatNumber(value: number, locale: string, options?: Intl.NumberFormatOptions): string {
  return cachedNumberFormat(locale, options).format(value)
}

/** Formats a ratio (`0..1`) as a locale percentage. */
export function formatPercent(ratio: number, locale: string, options?: Intl.NumberFormatOptions): string {
  return cachedNumberFormat(locale, { style: 'percent', ...options }).format(ratio)
}

/** Formats a number to fixed decimal places without localization (for CSV, SVG paths, wire text). */
export function formatFixed(value: number, decimals: number): string {
  return value.toFixed(decimals)
}

/** Formats a number to `sigFigs` significant figures without localization. */
export function formatPrecision(value: number, sigFigs: number): string {
  return value.toPrecision(sigFigs)
}

/** Returns the default fraction digits for `currency` in `locale` (falls back to 2). */
export function currencyFractionDigits(currency: string, locale?: string): number {
  try {
    return cachedNumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    // reason: unknown or unsupported ISO 4217 currency code falls back to 2 decimals.
    return 2
  }
}

/** Formats a monetary value in `currency` and `locale`, with a safe fallback for unknown codes. */
export function formatCurrency(
  value: number,
  currency: string,
  locale?: string,
  options?: Intl.NumberFormatOptions,
): string {
  try {
    return cachedNumberFormat(locale, {
      style: 'currency',
      currency,
      ...options,
    }).format(value)
  } catch {
    // reason: unknown or unsupported ISO 4217 currency code falls back to code + fixed decimals.
    const digits = options?.maximumFractionDigits ?? 2
    return `${currency} ${value.toFixed(digits)}`
  }
}

/** Returns the currency's display symbol in `locale` (e.g. `"€"`, `"$"`, `"CHF"`). */
export function currencySymbol(currency: string, locale: string): string {
  try {
    return cachedNumberFormat(locale, { style: 'currency', currency })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value ?? currency
  } catch {
    // reason: unknown or unsupported ISO 4217 currency code falls back to the raw code.
    return currency
  }
}

/** Derives the decimal and group separators for `locale` from `Intl.NumberFormat.formatToParts`. */
export function localeNumberSeparators(locale: string): { readonly decimal: string; readonly group: string } {
  let cached = separatorCache.get(locale)
  if (!cached) {
    const parts = cachedNumberFormat(locale).formatToParts(1234.5)
    const decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.'
    const group = parts.find((part) => part.type === 'group')?.value ?? ''
    cached = Object.freeze({ decimal, group })
    separatorCache.set(locale, cached)
  }
  return cached
}

/** Converts degrees Fahrenheit to degrees Celsius using the quantity table's exact constants. */
export function fahrenheitToCelsius(fahrenheit: number): number {
  return (fahrenheit - CONVERSION_CONSTANTS.fahrenheitOffset) / CONVERSION_CONSTANTS.fahrenheitScale
}

/** Returns `true` when `absSi` is an exact whole SI unit (within `1e-9`). */
function isWholeSiUnit(absSi: number): boolean {
  return Number.isFinite(absSi) && Math.abs(absSi - Math.round(absSi)) <= 1e-9
}

/** Selects the display band for a non-negative SI magnitude `absSi`. */
function selectDisplayBand(kind: QuantityKind, system: UnitSystem, absSi: number): DisplayBand {
  const spec = QUANTITY_TABLE[kind]
  const bands = system === 'metric' ? spec.metric.bands : spec.usCustomary.bands
  for (const band of bands) {
    if (band.maxSiExclusive === null || absSi < band.maxSiExclusive) {
      return band
    }
  }
  return bands[bands.length - 1]!
}

/**
 * Selects the effective `DisplayStyle` for `absSi`, matching `canopi-types` plus `#394 N1`:
 * `wholeSourceRoundsToWholeUnit` applies when `absSi >= 1` and `isWholeSiUnit(absSi)` EXCEPT
 * when the band's unit is `'km'` or `'mi'`.
 */
export function selectDisplayStyle(kind: QuantityKind, system: UnitSystem, absSi: number): DisplayStyle {
  const spec = QUANTITY_TABLE[kind]
  const style = selectDisplayBand(kind, system, absSi).style
  if (!spec.wholeSourceRoundsToWholeUnit || absSi < 1 || !isWholeSiUnit(absSi)) {
    return style
  }
  if (style.kind === 'single') {
    if (style.unit === 'km' || style.unit === 'mi') {
      return style
    }
    return { kind: 'single', unit: style.unit, decimals: 0 }
  }
  return { kind: 'single', unit: 'ft', decimals: 0 }
}

function findInputUnit(kind: QuantityKind, unit: UnitId): UnitInputSpec {
  const found = QUANTITY_TABLE[kind].inputUnits.find((entry) => entry.unit === unit)
  if (!found) {
    throw new Error(`Unknown unit '${unit}' for quantity '${kind}'`)
  }
  return found
}

function convertFromSi(kind: QuantityKind, siValue: number, unit: UnitId): number {
  if (unit === 'fahrenheit') {
    return siValue * CONVERSION_CONSTANTS.fahrenheitScale + CONVERSION_CONSTANTS.fahrenheitOffset
  }
  const input = findInputUnit(kind, unit)
  return siValue / input.siPerUnit + input.offsetInUnit
}

function convertToSi(kind: QuantityKind, value: number, unit: UnitId): number {
  if (unit === 'fahrenheit') {
    return fahrenheitToCelsius(value)
  }
  const input = findInputUnit(kind, unit)
  return (value - input.offsetInUnit) * input.siPerUnit
}

function formatSingleUnit(
  value: number,
  unit: UnitId,
  decimals: number,
  locale: string,
  options?: FormatQuantityOptions,
): string {
  const maxDecimals = options?.maximumFractionDigits ?? decimals
  const minDecimals = options?.minimumFractionDigits ?? (options?.trimTrailingZeros ? 0 : maxDecimals)
  const normalized = Math.abs(value) < 0.5 * 10 ** -(maxDecimals + 2) ? 0 : value
  const meta = UNIT_META[unit]
  if (meta.intlUnit !== null) {
    return cachedNumberFormat(locale, {
      style: 'unit',
      unit: meta.intlUnit,
      unitDisplay: 'short',
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: maxDecimals,
    }).format(normalized)
  }
  const number = cachedNumberFormat(locale, {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
  }).format(normalized)
  return `${number} ${meta.symbol}`
}

/** Formats an SI quantity value in `system` and `locale` using the generated quantity table. */
export function formatQuantity(
  kind: QuantityKind,
  siValue: number,
  system: UnitSystem,
  locale: string,
  options?: FormatQuantityOptions,
): string {
  const absSi = Math.abs(siValue)
  const style = selectDisplayStyle(kind, system, absSi)
  if (style.kind === 'feet_and_inches') {
    const totalInches = Math.round(absSi / CONVERSION_CONSTANTS.mPerInch)
    const feet = Math.floor(totalInches / CONVERSION_CONSTANTS.inchesPerFoot)
    const inches = totalInches % CONVERSION_CONSTANTS.inchesPerFoot
    const signedFeet = siValue < 0 && totalInches > 0 ? -feet : feet
    if (inches === 0 && style.dropZeroInches) {
      return formatSingleUnit(signedFeet, 'ft', 0, locale, options)
    }
    const sign = siValue < 0 && totalInches > 0 ? '−' : ''
    const ftText = formatNumber(feet, locale, { maximumFractionDigits: 0 })
    const inText = formatNumber(inches, locale, { maximumFractionDigits: 0 })
    return `${sign}${ftText}′ ${inText}″`
  }
  const value = convertFromSi(kind, siValue, style.unit)
  return formatSingleUnit(value, style.unit, style.decimals, locale, options)
}

export function formatLength(meters: number, system: UnitSystem, locale: string, options?: FormatQuantityOptions): string {
  return formatQuantity('length', meters, system, locale, options)
}

export function formatArea(sqMeters: number, system: UnitSystem, locale: string, options?: FormatQuantityOptions): string {
  return formatQuantity('area', sqMeters, system, locale, options)
}

export function formatTemperature(celsius: number, system: UnitSystem, locale: string, options?: FormatQuantityOptions): string {
  return formatQuantity('temperature', celsius, system, locale, options)
}

export function formatRainfall(mm: number, system: UnitSystem, locale: string, options?: FormatQuantityOptions): string {
  return formatQuantity('rainfall', mm, system, locale, options)
}

export function formatVolume(liters: number, system: UnitSystem, locale: string, options?: FormatQuantityOptions): string {
  return formatQuantity('volume', liters, system, locale, options)
}

export function formatRasterResolution(meters: number, system: UnitSystem, locale: string, options?: FormatQuantityOptions): string {
  return formatQuantity('raster_resolution', meters, system, locale, options)
}

export function formatCatalogSize(meters: number, system: UnitSystem, locale: string, options?: FormatQuantityOptions): string {
  return formatQuantity('catalog_size', meters, system, locale, options)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isSpaceLike(separator: string): boolean {
  return separator === ' ' || separator === '\u00a0' || separator === '\u202f'
}

/**
 * Parses a localized number token without a unit suffix.
 *
 * Enforces `#316`: ASCII `.` is accepted as a decimal fallback ONLY when the
 * locale's group separator is not `.` and no locale decimal separator is present.
 */
function stripGroupSeparators(intPart: string, group: string): string | null {
  if (intPart === '') return ''
  if (isSpaceLike(group)) {
    // Space-grouped locales (e.g. fr-FR) accept U+202F, U+00A0, and ASCII space.
    if (!/^\d+(?:[\u202f\u00a0 ]\d{3})*$/.test(intPart) && !/^\d+$/.test(intPart)) return null
    return intPart.replace(/[\u202f\u00a0 ]/g, '')
  }
  if (group !== '' && intPart.includes(group)) {
    const groupedPattern = new RegExp(`^\\d{1,3}(?:${escapeRegExp(group)}\\d{3})+$`)
    return groupedPattern.test(intPart) ? intPart.split(group).join('') : null
  }
  return /^\d+$/.test(intPart) ? intPart : null
}

function splitDecimalParts(
  body: string,
  decimal: string,
  group: string,
): { rawInt: string; fracPart: string } | null {
  const activeDecimal = body.includes(decimal)
    ? decimal
    : (decimal !== '.' && group !== '.' && body.includes('.') ? '.' : null)
  if (activeDecimal === null) return { rawInt: body, fracPart: '' }
  const parts = body.split(activeDecimal)
  if (parts.length !== 2) return null
  const [rawInt, fracPart] = parts
  if (rawInt === undefined || fracPart === undefined || !/^\d+$/.test(fracPart)) return null
  return { rawInt, fracPart }
}

function parseLocalizedNumber(raw: string, locale: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const sign = trimmed.startsWith('-') || trimmed.startsWith('−') ? -1 : 1
  const body = (trimmed.startsWith('+') || sign < 0 ? trimmed.slice(1) : trimmed).trim()
  if (!body) return null

  const { decimal, group } = localeNumberSeparators(locale)
  const split = splitDecimalParts(body, decimal, group)
  if (split === null) return null

  const intPart = stripGroupSeparators(split.rawInt, group)
  if (intPart === null || (intPart === '' && split.fracPart === '')) return null

  const canonical = split.fracPart === '' ? intPart : `${intPart || '0'}.${split.fracPart}`
  const parsed = Number(canonical) * sign
  if (!Number.isFinite(parsed)) return null
  return parsed === 0 ? 0 : parsed
}

const FEET_AND_INCHES_PATTERN = /^([+−-]?)\s*([^'"′’″”a-zA-Z]+?)\s*(?:'|′|’|ft|feet|foot)\s*([^'"′’″”a-zA-Z]+?)\s*(?:"|″|”|in|inch|inches)$/i

function parseFeetAndInches(raw: string, locale: string): number | null {
  const match = FEET_AND_INCHES_PATTERN.exec(raw)
  if (!match) return null
  const sign = match[1] === '-' || match[1] === '−' ? -1 : 1
  const feet = parseLocalizedNumber(match[2]!, locale)
  const inches = parseLocalizedNumber(match[3]!, locale)
  if (feet === null || inches === null || feet < 0 || inches < 0) return null
  const meters = sign * (feet * CONVERSION_CONSTANTS.mPerFoot + inches * CONVERSION_CONSTANTS.mPerInch)
  return Number.isFinite(meters) ? (meters === 0 ? 0 : meters) : null
}

interface SortedAlias {
  readonly alias: string
  readonly unit: UnitId
}

const sortedAliasesByKind = new Map<QuantityKind, readonly SortedAlias[]>()

function aliasesForKind(kind: QuantityKind): readonly SortedAlias[] {
  let cached = sortedAliasesByKind.get(kind)
  if (!cached) {
    const list: SortedAlias[] = []
    for (const input of QUANTITY_TABLE[kind].inputUnits) {
      for (const alias of input.aliases) {
        list.push({ alias: alias.toLowerCase(), unit: input.unit })
      }
    }
    list.sort((a, b) => b.alias.length - a.alias.length)
    cached = list
    sortedAliasesByKind.set(kind, cached)
  }
  return cached
}

/**
 * Parses a user-entered quantity string into stored SI units, or `null` if invalid.
 *
 * Accepts any unit alias from `QUANTITY_TABLE[kind].inputUnits` regardless of the
 * active `system`; bare numbers use `system`'s `bareInputUnit`.
 */
export function parseQuantity(
  kind: QuantityKind,
  raw: string,
  system: UnitSystem,
  locale: string,
): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const spec = QUANTITY_TABLE[kind]
  const systemSpec = system === 'metric' ? spec.metric : spec.usCustomary

  if (spec.acceptsFeetAndInches) {
    const compound = parseFeetAndInches(trimmed, locale)
    if (compound !== null) {
      if (!spec.allowsNegative && compound < 0) return null
      return compound
    }
  }

  // Try matching a trailing unit alias (longest first).
  const lowered = trimmed.toLowerCase()
  for (const { alias, unit } of aliasesForKind(kind)) {
    if (!lowered.endsWith(alias)) continue
    const numRaw = trimmed.slice(0, trimmed.length - alias.length).trim()
    if (!numRaw) continue
    const value = parseLocalizedNumber(numRaw, locale)
    if (value === null) continue
    const si = convertToSi(kind, value, unit)
    if (!Number.isFinite(si)) return null
    if (!spec.allowsNegative && si < 0) return null
    return si === 0 ? 0 : si
  }

  // No unit alias matched: try bare number in the active system's bareInputUnit.
  const bare = parseLocalizedNumber(trimmed, locale)
  if (bare === null) return null
  const si = convertToSi(kind, bare, systemSpec.bareInputUnit)
  if (!Number.isFinite(si)) return null
  if (!spec.allowsNegative && si < 0) return null
  return si === 0 ? 0 : si
}

/** Largest 1, 2 or 5 times a power of ten that is at most `maximum`. */
function niceOneTwoFiveAtMost(maximum: number): number {
  const power = 10 ** Math.floor(Math.log10(maximum))
  const normalized = maximum / power
  return (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * power
}

/**
 * Picks the largest nice scale-bar step in metres `<= maxMeters` for `system`,
 * falling back to the smallest ladder step below the floor and clean 1-2-5 scaling
 * above the ladder ceiling (e.g. world zoom in `km` / `mi`).
 */
export function niceDistanceAtMost(maxMeters: number, system: UnitSystem): number {
  const steps = SCALE_BAR_STEPS_M[system]
  if (!Number.isFinite(maxMeters) || maxMeters <= steps[0]!) {
    return steps[0]!
  }
  const top = steps[steps.length - 1]!
  if (maxMeters > top) {
    if (system === 'us_customary') {
      const miles = niceOneTwoFiveAtMost(maxMeters / CONVERSION_CONSTANTS.mPerMile)
      return miles * CONVERSION_CONSTANTS.mPerMile
    }
    return niceOneTwoFiveAtMost(maxMeters)
  }
  let chosen = steps[0]!
  for (const step of steps) {
    if (step <= maxMeters) {
      chosen = step
    } else {
      break
    }
  }
  return chosen
}

/** Formats a scale-bar distance cleanly in `system` without spurious `.0` on whole steps. */
export function formatScaleBarDistance(meters: number, system: UnitSystem, locale: string): string {
  return formatQuantity('length', meters, system, locale, { trimTrailingZeros: true })
}

/** Returns the PDF scale picker entries offered for `system` (`2.1-Q133`, `2.1-Q356`). */
export function pdfScalesForSystem(system: UnitSystem): readonly PdfScaleSpec[] {
  return PDF_SCALES.filter((scale) => (system === 'metric' ? scale.metric : scale.usCustomary))
}

const BYTE_UNITS = ['kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

/**
 * Decimal SI byte size (`1000` base: `kB`, `MB`, `GB`, `TB`), formatted via `Intl.NumberFormat`
 * (`2.1-Q359`: `512 MiB` -> `537 MB`, `2048 MiB` -> `2.1 GB`, `999 kB`, `1 MB`, `1 GB`).
 */
export function formatByteSize(bytes: number, locale: string): string {
  let value = Math.max(0, Number.isFinite(bytes) ? bytes : 0) / 1000
  let unit = 0
  while (unit < BYTE_UNITS.length - 1 && (value >= 1000 || Math.round(value) >= 1000)) {
    value /= 1000
    unit += 1
  }
  return cachedNumberFormat(locale, {
    style: 'unit',
    unit: BYTE_UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value)
}
