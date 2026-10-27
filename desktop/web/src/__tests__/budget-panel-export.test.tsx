// @vitest-environment jsdom

import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exportBudgetCsv: vi.fn(),
}))

vi.mock('../app/budget/export', async (importOriginal) => {
  const actual = await importOriginal<typeof BudgetExportModule>()
  return {
    ...actual,
    exportBudgetCsv: mocks.exportBudgetCsv,
  }
})

import { BudgetPanel } from '../components/panels/BudgetPanel'
import { setCurrentCanvasSession } from '../canvas/session'
import { locale } from '../app/settings/state'
import { designSessionFixture } from './support/design-session-state'
import { speciesBudgetTarget } from '../target'
import type { CanopiFile, PlacedPlant } from '../types/design'
import { createTestCanvasQuerySurface } from './support/canvas-query-surface'
import { createTestCanvasRuntimeSurfaces } from './support/canvas-runtime-surfaces'
import type * as BudgetExportModule from '../app/budget/export'

function makeDesign(overrides: Partial<CanopiFile> = {}): CanopiFile {
  return {
    version: 9,
    name: 'Budget export test',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    extra: {},
    created_at: '2026-04-08T00:00:00.000Z',
    updated_at: '2026-04-08T00:00:00.000Z',
    ...overrides,
  }
}

function makePlant(canonicalName: string, commonName: string): PlacedPlant {
  return {
    id: `plant-${canonicalName}`,
    canonical_name: canonicalName,
    common_name: commonName,
    color: null,
    position: { lon: 13, lat: 23 },
    rotation: null,
    scale: null,
    notes: null,
    planted_date: null,
    quantity: 1,
    locked: false,
  }
}

describe('BudgetPanel export', () => {
  let container: HTMLDivElement
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.innerHTML = ''
    document.body.appendChild(container)
    locale.value = 'en'
    designSessionFixture.file = makeDesign({
      budget_currency: 'EUR',
      budget: [
        {
          target: speciesBudgetTarget('Malus domestica'),
          category: 'plants',
          description: 'Malus domestica',
          quantity: 0,
          unit_cost: 5,
          currency: 'EUR',
        },
      ],
    })
    setCurrentCanvasSession(createTestCanvasRuntimeSurfaces({
      queries: createTestCanvasQuerySurface({
        plants: [makePlant('Malus domestica', 'Apple')],
      }),
    }))
    mocks.exportBudgetCsv.mockReset()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
    render(null, container)
    container.remove()
    designSessionFixture.file = null
    setCurrentCanvasSession(null)
  })

  it('shows non-cancelled export failures and retries through the workbench', async () => {
    mocks.exportBudgetCsv.mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)

    await act(async () => {
      render(<BudgetPanel />, container)
    })

    const button = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.toLowerCase().includes('csv'),
    )

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(consoleError).toHaveBeenCalledWith('Budget export failed:', expect.any(Error))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be exported')

    const retry = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('Retry'),
    )
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(mocks.exportBudgetCsv).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('ignores dialog-cancelled export failures', async () => {
    mocks.exportBudgetCsv.mockRejectedValueOnce(new Error('Dialog cancelled'))

    await act(async () => {
      render(<BudgetPanel />, container)
    })

    const button = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.toLowerCase().includes('csv'),
    )

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(consoleError).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
