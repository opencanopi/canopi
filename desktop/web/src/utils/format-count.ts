// utils/format-count.ts
// Owner of number formatting (number-format-only-in-utils, ADR 0028; §18 F11) until 2a's
// utils/format.ts. Invariant: numbers are formatted only by the locale number owner.

const formatters = new Map<string, Intl.NumberFormat>()

/**
 * A count shown on its own ("175,473", "175 473" in French). Counts inside a
 * sentence use the message's `{{count, number}}` instead, which also picks the
 * plural form.
 */
export function formatCount(value: number, locale: string): string {
  let formatter = formatters.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    formatters.set(locale, formatter)
  }
  return formatter.format(value)
}
