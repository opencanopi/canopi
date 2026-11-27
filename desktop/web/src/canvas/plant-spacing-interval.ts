import { formatFixed } from '../utils/format'

const FALLBACK_PLANT_SPACING_INTERVAL_M = 0.5

export type PlantSpacingIntervalParseResult =
  | { valid: true; meters: number }
  | { valid: false }

const METRIC_INTERVAL_PATTERN = /^([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))\s*(cm|m)?$/i

export function parsePlantSpacingIntervalInput(input: string): PlantSpacingIntervalParseResult {
  const trimmed = input.trim()
  if (!trimmed) return { valid: false }

  const match = trimmed.match(METRIC_INTERVAL_PATTERN)
  if (!match) return { valid: false }

  const rawValue = match[1]?.replace(',', '.')
  if (!rawValue) return { valid: false }

  const value = Number(rawValue)
  if (!Number.isFinite(value) || value <= 0) return { valid: false }

  const unit = match[2]?.toLowerCase() ?? 'm'
  return {
    valid: true,
    meters: unit === 'cm' ? value / 100 : value,
  }
}

export function formatPlantSpacingIntervalInput(meters: number): string {
  const normalized = Number.isFinite(meters) && meters > 0
    ? meters
    : FALLBACK_PLANT_SPACING_INTERVAL_M

  return formatMetricLength(normalized)
}

function formatMetricLength(meters: number): string {
  if (meters < 1) {
    return `${formatDecimal(meters * 100)} cm`
  }

  return `${formatDecimal(meters)} m`
}

function formatDecimal(value: number): string {
  return Number(formatFixed(value, 3)).toString()
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
