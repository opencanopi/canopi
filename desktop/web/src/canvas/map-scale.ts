import { CONVERSION_CONSTANTS, formatNumber, niceDistanceAtMost, type UnitSystem } from '../utils/format'

/** One CSS pixel on screen is 1/96 inch. */
const CSS_PIXEL_METERS = CONVERSION_CONSTANTS.mPerInch / 96

/** Common scales offered by the zoom group's scale menu. */
export const COMMON_MAP_SCALES: readonly number[] = [100, 200, 500, 1000, 2000, 5000, 10000, 25000]

/**
 * The N of "1:N", unrounded, from the ground metres one CSS pixel covers (`ViewReadSurface.groundMetresPerPixel`,
 * positive and finite on a validated camera).
 */
export function mapScaleDenominator(groundMetresPerPixel: number): number {
  return groundMetresPerPixel / CSS_PIXEL_METERS
}

/** Two significant figures: a readable ratio (1:190, 1:1,500, 1:50,000,000). */
export function roundScaleDenominator(denominator: number): number {
  const power = 10 ** Math.max(0, Math.floor(Math.log10(denominator)) - 1)
  return Math.max(1, Math.round(denominator / power) * power)
}

export function formatMapScale(denominator: number, locale: string): string {
  return `1:${formatNumber(roundScaleDenominator(denominator), locale, { maximumFractionDigits: 0 })}`
}

/** Zoom factor that turns the current scale into `1:target`. */
export function zoomFactorForScale(currentDenominator: number, targetDenominator: number): number {
  return currentDenominator / targetDenominator
}

/** The zoom group's scale bar: a round ground distance whose bar fits about 100 CSS px at the current scale. */
const SCALE_BAR_MAX_PX = 125

interface ScaleBarDisplay {
  readonly barScreenPx: number
  /** The ground distance the bar spans, in metres. */
  readonly meters: number
}

/** `scale` is CSS pixels per ground metre, positive and finite on a validated camera. */
export function getScaleBarDisplay(scale: number, system: UnitSystem = 'metric'): ScaleBarDisplay {
  const meters = niceDistanceAtMost(SCALE_BAR_MAX_PX / scale, system)
  return { barScreenPx: meters * scale, meters }
}
