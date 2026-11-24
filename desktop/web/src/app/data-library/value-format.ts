// app/lidar/value-format.ts
//
// Writes the value a Site data row shows under the pointer or the pin (canopi-f47t.42, spec §1.10, Q20, Q22): metres to
// 2 decimals, degrees and percent to 1, any other value to 4 significant digits, in the interface locale's digits and
// separators, with the unit `unitSuffix` writes; an em dash where the raster has no value (the row names it "No data").
// The value is one native cell, so it is never written finer than that.

import { unitSuffix } from './item-types'

/** Fixed decimals per unit; any other unit gets 4 significant digits. */
const DECIMALS: Readonly<Record<string, number>> = { m: 2, '°': 1, '%': 1 }

const formatters = new Map<string, Intl.NumberFormat>()

function formatter(locale: string, decimals: number | undefined): Intl.NumberFormat {
  const key = `${locale}:${decimals ?? 'significant'}`
  let found = formatters.get(key)
  if (!found) {
    found = new Intl.NumberFormat(locale, decimals === undefined
      ? { maximumSignificantDigits: 4 }
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    formatters.set(key, found)
  }
  return found
}

export function formatRowValue(value: number | null, units: string, locale: string): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${formatter(locale, DECIMALS[units]).format(value)}${unitSuffix(units)}`
}
