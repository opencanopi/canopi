import { formatLength, parseQuantity, type UnitSystem } from '../utils/format'

const FALLBACK_PLANT_SPACING_INTERVAL_M = 0.5

export type PlantSpacingIntervalParseResult =
  | { valid: true; meters: number }
  | { valid: false }

export function parsePlantSpacingIntervalInput(
  input: string,
  system: UnitSystem = 'metric',
  locale: string = 'en',
): PlantSpacingIntervalParseResult {
  const meters = parseQuantity('length', input, system, locale)
  if (meters === null || !Number.isFinite(meters) || meters <= 0) return { valid: false }
  return { valid: true, meters }
}

export function formatPlantSpacingIntervalInput(
  meters: number,
  system: UnitSystem = 'metric',
  locale: string = 'en',
): string {
  const normalized = Number.isFinite(meters) && meters > 0
    ? meters
    : FALLBACK_PLANT_SPACING_INTERVAL_M

  return formatLength(normalized, system, locale, { trimTrailingZeros: true, maximumFractionDigits: 3 })
}

type PlantRowCountParseResult =
  | { valid: true; count: number }
  | { valid: false }

/** Plant a row's "N plants" field: a whole number of plants from 2, the picked plant counted (the tool bounds it). */
export function parsePlantRowCountInput(input: string): PlantRowCountParseResult {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) return { valid: false }
  const count = Number(trimmed)
  return count >= 2 && Number.isSafeInteger(count) ? { valid: true, count } : { valid: false }
}
