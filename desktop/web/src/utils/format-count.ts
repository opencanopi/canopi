// utils/format-count.ts
// Count helper delegating to the locale number owner (utils/format.ts, §18 F11).

import { formatNumber } from './format'

/**
 * A count shown on its own ("175,473", "175 473" in French). Counts inside a
 * sentence use the message's `{{count, number}}` instead, which also picks the
 * plural form.
 */
export function formatCount(value: number, locale: string): string {
  return formatNumber(value, locale, { maximumFractionDigits: 0 })
}
