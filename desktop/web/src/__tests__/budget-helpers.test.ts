import { describe, it, expect } from 'vitest'
import { escapeBudgetCsvField, formatBudgetCurrency } from '../app/budget/formatting'
import { buildBudgetPlanningProjection } from '../app/planning-projection/budget'
import { speciesBudgetTarget } from '../target'

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

describe('buildBudgetPlanningProjection (2.1-Q96)', () => {
  it('projects every plant line in the single Design currency, ignoring stale item.ext.currency', () => {
    const projection = buildBudgetPlanningProjection({
      plants: [
        {
          id: 'p1',
          canonical_name: 'Malus domestica',
          common_name: 'Apple',
          color: null,
          position: { lon: 0, lat: 0 },
          rotation: null,
          canopy_spread_m: null,
          notes: null,
          planted_date: null,
          quantity: 2,
          locked: false,
        },
      ],
      budget: [
        {
          target: speciesBudgetTarget('Malus domestica'),
          unit_cost: 12,
          ext: { currency: 'USD' },
        },
      ],
      currency: 'EUR',
      locale: 'en',
    })
    expect(projection.rows).toHaveLength(1)
    expect(projection.rows[0]!.currency).toBe('EUR')
    expect(projection.lineItemPriceMap.get('Malus domestica')).toEqual({ unit_cost: 12, currency: 'EUR' })
  })
})
