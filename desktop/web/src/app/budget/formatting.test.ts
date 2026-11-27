import { describe, it, expect } from 'vitest'
import { escapeBudgetCsvField, formatBudgetCurrency } from './formatting'

describe('formatBudgetCurrency', () => {
  it('formats a number as currency', () => {
    const result = formatBudgetCurrency(5.5, 'USD')
    expect(result).toContain('5.50')
  })

  it('handles invalid currency gracefully', () => {
    const result = formatBudgetCurrency(10, 'INVALID')
    expect(result).toContain('10.00')
  })
})

describe('escapeBudgetCsvField', () => {
  it('wraps fields containing commas in quotes', () => {
    expect(escapeBudgetCsvField('hello, world')).toBe('"hello, world"')
  })

  it('returns plain fields unchanged', () => {
    expect(escapeBudgetCsvField('hello')).toBe('hello')
  })

  it('doubles embedded double-quotes and wraps', () => {
    expect(escapeBudgetCsvField('say "hello"')).toBe('"say ""hello"""')
  })

  it('wraps fields containing newlines', () => {
    expect(escapeBudgetCsvField('line1\nline2')).toBe('"line1\nline2"')
  })

  it('sanitizes formula injection prefixes', () => {
    expect(escapeBudgetCsvField('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(escapeBudgetCsvField('+CMD')).toBe("'+CMD")
    expect(escapeBudgetCsvField('-HYPERLINK')).toBe("'-HYPERLINK")
    expect(escapeBudgetCsvField('@import')).toBe("'@import")
  })
})
