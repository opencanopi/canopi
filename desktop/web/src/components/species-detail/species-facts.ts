import { isLocaleKey, t } from '../../i18n'

/** One cell of the key facts grid; `null` reads "Not recorded", never an empty cell. */
export interface SpeciesFact {
  readonly id: string
  readonly label: string
  readonly value: string | null
}

interface ListFormatter {
  format(values: readonly string[]): string
}
type ListFormatConstructor = new (locale: string, options: { style: 'long'; type: 'conjunction' | 'unit' }) => ListFormatter

/** "Full sun, semi-shade": a list in the interface language's own separators. */
export function formatList(values: readonly string[], locale: string): string {
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatConstructor }).ListFormat
  return ListFormat ? new ListFormat(locale, { style: 'long', type: 'unit' }).format(values) : values.join(', ')
}

export function formatNumber(value: number, locale: string, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value)
}

/** "8 m" with the unit placed as the interface language places it. */
function formatMetres(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'meter', maximumFractionDigits: 1 }).format(value)
}

/** "4–10 m", "10 m" or null: a catalog min/max range in metres. */
export function formatMetreRange(min: number | null, max: number | null, locale: string): string | null {
  if (min !== null && max !== null && min !== max) return `${formatNumber(min, locale)}–${formatMetres(max, locale)}`
  const single = max ?? min
  return single === null ? null : formatMetres(single, locale)
}

export function formatYears(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'year', unitDisplay: 'long', maximumFractionDigits: 1 }).format(value)
}

/**
 * "USDA 3–8 · to −40 °C". The temperature is the lower bound of the coldest zone
 * (USDA zone n starts at 10·n − 70 °F), so the catalog's zone number stays the source.
 */
export function formatHardiness(min: number | null, max: number | null, locale: string): string | null {
  if (min === null && max === null) return null
  const zones = min !== null && max !== null && min !== max
    ? `${formatNumber(min, locale)}–${formatNumber(max, locale)}`
    : formatNumber((min ?? max)!, locale)
  if (min === null) return t('plantDetail.hardinessZones', { zones })
  const celsius = ((10 * min - 70) - 32) * 5 / 9
  const temperature = new Intl.NumberFormat(locale, { style: 'unit', unit: 'celsius', maximumFractionDigits: 0 }).format(celsius)
  return t('plantDetail.hardinessValue', { zones, temperature })
}

/** "5 of 5" for a 0–5 catalog rating. */
export function formatRating(rating: number | null, locale: string): string | null {
  return rating === null ? null : t('plantDetail.ratingValue', { rating: formatNumber(rating, locale, 0), max: formatNumber(5, locale, 0) })
}

/**
 * Catalog values arrive in the interface language, except English, where some fields
 * keep their catalog keys ("high", "secondary_ii"). Show those as words.
 */
export function presentCatalogValue(field: 'stratum' | 'succession', value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  if (field === 'stratum') {
    const key = `filters.stratum_${value}`
    return isLocaleKey(key) ? t(key) : value
  }
  if (!/^[a-z]+(_[a-z]+)*$/.test(value)) return value
  const words = value.split('_').map(word => (/^[ivx]+$/.test(word) ? word.toUpperCase() : word))
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Joins the recorded parts of one fact ("Medium · mature at 5 years"); null when none is recorded. */
export function joinRecorded(parts: readonly (string | null | undefined)[]): string | null {
  const recorded = parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '')
  return recorded.length > 0 ? recorded.join(' · ') : null
}
