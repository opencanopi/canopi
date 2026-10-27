// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/export', () => ({
  exportFile: vi.fn().mockResolvedValue(undefined),
}))

import { exportFile } from '../ipc/export'
import { exportBudgetCsv, exportCurrentBudgetCsv } from '../app/budget/export'
import { setCurrentCanvasSession } from '../canvas/session'
import { speciesBudgetTarget } from '../target'
import { designSessionFixture } from './support/design-session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { deliverBudgetCsv as deliverBrowserBudgetCsv } from '../app/budget/platform.browser'

afterEach(() => vi.restoreAllMocks())

describe('budget export', () => {
  it('exports the expected csv filename and row content through the app boundary', async () => {
    await exportBudgetCsv(
      [{ canonical: 'Malus domestica', commonName: 'Apple', count: 3 }],
      {
        currency: 'EUR',
        designName: 'orchard',
        lineItemPriceMap: new Map([['Malus domestica', { unit_cost: 12.5, currency: 'EUR' }]]),
        grandTotal: 37.5,
      },
    )

    expect(vi.mocked(exportFile)).toHaveBeenCalledWith(
      expect.stringContaining('Apple,3,12.50,37.50,EUR'),
      'orchard-budget.csv',
      'budget-csv-export',
    )
  })

  it('keeps unavailable prices distinct from explicit zero prices', async () => {
    await exportBudgetCsv(
      [
        { canonical: 'Malus domestica', commonName: 'Apple', count: 3 },
        { canonical: 'Pyrus communis', commonName: 'Pear', count: 2 },
      ],
      {
        currency: 'EUR',
        designName: 'orchard',
        lineItemPriceMap: new Map([['Malus domestica', { unit_cost: 0, currency: 'EUR' }]]),
        grandTotal: 0,
      },
    )

    const csv = vi.mocked(exportFile).mock.calls.at(-1)?.[0]
    expect(csv).toContain('Apple,3,0.00,0.00,EUR')
    expect(csv).toContain('Pear,2,,,EUR')
  })

  it('escapes a Design currency code that is not a plain ISO code', async () => {
    await exportBudgetCsv(
      [{ canonical: 'Malus domestica', commonName: 'Apple', count: 3 }],
      {
        currency: '=HYPERLINK("http://x","EUR")',
        designName: 'orchard',
        lineItemPriceMap: new Map([['Malus domestica', { unit_cost: 1, currency: 'EUR' }]]),
        grandTotal: 3,
      },
    )

    const csv = vi.mocked(exportFile).mock.calls.at(-1)?.[0] as string
    const appleLine = csv.split('\n').find((line) => line.startsWith('Apple,'))
    expect(appleLine).toBe('Apple,3,1.00,3.00,"\'=HYPERLINK(""http://x"",""EUR"")"')
  })

  it('downloads the shared CSV through the browser delivery adapter', async () => {
    let observed: HTMLAnchorElement | undefined
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      observed = this
    })
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:budget')
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    await deliverBrowserBudgetCsv('Species,Quantity\nApple,3', 'orchard-budget.csv')

    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(observed?.download).toBe('orchard-budget.csv')
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:budget')
    expect(document.querySelector('a[download="orchard-budget.csv"]')).toBeNull()
  })

  it('exports the open Design’s Budget from the File menu, as the panel would, and ignores a cancelled dialog', async () => {
    designSessionFixture.file = {
      version: 9,
      name: 'Orchard',
      description: null,
      plant_species_colors: {},
      layers: [],
      plants: [],
      zones: [],
      annotations: [],
      consortiums: [],
      groups: [],
      timeline: [],
      budget: [{
        target: speciesBudgetTarget('Malus domestica'),
        category: 'plants',
        description: 'Malus domestica',
        quantity: 0,
        unit_cost: 5,
        currency: 'EUR',
      }],
      budget_currency: 'EUR',
      extra: {},
      created_at: '2026-04-08T00:00:00.000Z',
      updated_at: '2026-04-08T00:00:00.000Z',
    }
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({
        plants: [0, 1].map((index) => ({
          id: `apple-${index}`,
          canonical_name: 'Malus domestica',
          common_name: 'Apple',
          color: null,
          position: { lon: 13, lat: 23 },
          rotation: null,
          scale: null,
          notes: null,
          planted_date: null,
          quantity: 1,
          locked: false,
        })),
      }),
    }))
    try {
      await exportCurrentBudgetCsv()
      expect(vi.mocked(exportFile)).toHaveBeenCalledWith(
        expect.stringContaining('Apple,2,5.00,10.00,EUR'),
        expect.stringMatching(/-budget\.csv$/),
        'budget-csv-export',
      )

      vi.mocked(exportFile).mockRejectedValueOnce(new Error('Dialog cancelled'))
      await expect(exportCurrentBudgetCsv()).resolves.toBeUndefined()
      vi.mocked(exportFile).mockRejectedValueOnce(new Error('disk full'))
      await expect(exportCurrentBudgetCsv()).rejects.toThrow('disk full')
    } finally {
      designSessionFixture.file = null
      setCurrentCanvasSession(null)
    }
  })
})
