/**
 * utils/format.ts: Owner of decimal SI byte-size formatting across the app (number-format-only-in-utils, ADR 0027, 2.1-Q359, contracts §18 F11).
 * Invariant: every displayed file or limit size uses `Intl.NumberFormat` in decimal SI (1000-based) units in the active
 * locale.
 */

const SI_UNITS = ['kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

/**
 * Formats a byte count in decimal SI units (`1000` base: kB, MB, GB, TB) in the given locale.
 * Values below 100 use at most 1 decimal digit; values >= 100 round to whole units.
 *
 * Examples (`en`): 999_000 -> "999 kB", 1_000_000 -> "1 MB", 1_500_000 -> "1.5 MB",
 * 512 MiB (536_870_912) -> "537 MB", 2 GiB (2_147_483_648) -> "2.1 GB".
 */
export function formatByteSize(bytes: number, locale: string): string {
  const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  let value = safe / 1000
  let unitIndex = 0
  while (value >= 1000 && unitIndex < SI_UNITS.length - 1) {
    value /= 1000
    unitIndex += 1
  }
  const decimals = value >= 100 ? 0 : 1
  const rounded = decimals === 0 ? Math.round(value) : Math.round(value * 10) / 10
  if (rounded >= 1000 && unitIndex < SI_UNITS.length - 1) {
    value = rounded / 1000
    unitIndex += 1
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: SI_UNITS[unitIndex],
    unitDisplay: 'short',
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value)
}
