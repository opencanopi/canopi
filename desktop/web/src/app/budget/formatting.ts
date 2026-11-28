import { currencySymbol, formatCurrency, formatNumber, localeNumberSeparators } from '../../utils/format'

export function formatBudgetCurrency(amount: number, currency: string, locale?: string): string {
  return formatCurrency(amount, currency, locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** A unit cost as the price field shows it: locale decimals, no symbol, no grouping. */
export function formatBudgetPriceInput(amount: number, locale: string): string {
  return formatNumber(amount, locale, {
    minimumFractionDigits: 2,
    // Enough places that a typed price like 0.125 reads back as itself.
    maximumFractionDigits: 6,
    useGrouping: false,
  })
}

/**
 * Reads a typed unit cost: locale decimals ("3,90") or a dot, spaces ignored.
 * Returns null for anything that is not a finite, nonnegative number.
 */
export function parseBudgetPriceInput(value: string, locale: string): number | null {
  const { decimal } = localeNumberSeparators(locale)
  let text = value.replace(/[\s\u00a0\u202f]/g, '')
  if (decimal !== '.') text = text.replace(decimal, '.')
  if (!/^\d*\.?\d*$/.test(text) || !/\d/.test(text)) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** The currency's symbol in this locale ("€", "$", "CHF"), shown inside price fields. */
export function budgetCurrencySymbol(currency: string, locale: string): string {
  return currencySymbol(currency, locale)
}

export function escapeBudgetCsvField(value: string): string {
  const sanitized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}
