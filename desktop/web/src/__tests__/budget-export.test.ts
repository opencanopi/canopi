// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pickCancelled } from '../ipc/dialogs'
import { exportBudgetCsv, exportCurrentBudgetCsv } from '../app/budget/export'
import { setCurrentCanvasSession } from '../canvas/session'
import { speciesBudgetTarget } from '../target'
import { designSessionFixture } from './support/design-session-state'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import { buildDeliveryFileName, createBrowserFileDelivery } from '../platform/file-delivery'

import { installEditionPorts } from '../platform/edition-ports'
import { createTestEditionPorts } from './support/test-edition-ports'

const deliverFile = vi.fn().mockResolvedValue('saved' as const)
let disposePorts: (() => void) | null = null
beforeEach(() => {
  deliverFile.mockReset().mockResolvedValue('saved')
  disposePorts = installEditionPorts(createTestEditionPorts({
    fileDelivery: { deliverFile, dispose: vi.fn() },
  }))
})
afterEach(() => { disposePorts?.(); disposePorts = null; vi.restoreAllMocks() })

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

    expect(deliverFile).toHaveBeenCalledWith(
      'budget-csv',
      'orchard',
      { text: expect.stringContaining('Apple,3,12.50,37.50,EUR') },
    )
    expect(buildDeliveryFileName('budget-csv', deliverFile.mock.calls[0]![1] as string)).toBe('orchard-budget.csv')
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

    const csv = (deliverFile.mock.calls.at(-1)?.[2] as { text: string }).text
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

    const csv = (deliverFile.mock.calls.at(-1)?.[2] as { text: string }).text
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

    const browserDelivery = createBrowserFileDelivery()
    await browserDelivery.deliverFile('budget-csv', 'orchard-budget.csv', { text: 'Species,Quantity\nApple,3' })
    browserDelivery.dispose?.()

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
        unit_cost: 5,
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
          canopy_spread_m: null,
          notes: null,
          planted_date: null,
          quantity: 1,
          locked: false,
        })),
      }),
    }))
    try {
      await exportCurrentBudgetCsv()
      expect(deliverFile).toHaveBeenCalledWith(
        'budget-csv',
        'Orchard',
        { text: expect.stringContaining('Apple,2,5.00,10.00,EUR') },
      )
      expect(buildDeliveryFileName('budget-csv', deliverFile.mock.calls[0]![1] as string)).toMatch(/-budget\.csv$/)

      deliverFile.mockRejectedValueOnce(pickCancelled('dialog.pick_save'))
      await expect(exportCurrentBudgetCsv()).resolves.toBeUndefined()
      deliverFile.mockRejectedValueOnce(new Error('disk full'))
      await expect(exportCurrentBudgetCsv()).rejects.toThrow('disk full')
      // canopi-f47t.52.172: only the typed cancel is quiet; a failure whose text says "cancelled" still reaches the user.
      deliverFile.mockRejectedValueOnce(new Error('Dialog cancelled'))
      await expect(exportCurrentBudgetCsv()).rejects.toThrow('Dialog cancelled')
    } finally {
      designSessionFixture.file = null
      setCurrentCanvasSession(null)
    }
  })
})
