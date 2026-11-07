import { deliverBudgetCsv } from '#budget-export-platform'
import { isCancelledFailure } from '../../failures/ipc-failure'
import { t } from '../../i18n'
import { escapeBudgetCsvField } from './formatting'
import { readBudgetPlanningSurface } from '../planning-projection'

export interface BudgetExportRow {
  canonical: string
  commonName: string
  count: number
}

/** A dismissed Save dialog: the typed cancel, never a failure whose text says "cancelled" (canopi-f47t.52.172). */
export function isBudgetExportCancelled(error: unknown): boolean {
  return isCancelledFailure(error)
}

export async function exportBudgetCsv(
  rows: readonly BudgetExportRow[],
  options: {
    currency: string
    designName: string
    lineItemPriceMap: ReadonlyMap<string, { unit_cost: number; currency: string }>
    grandTotal: number
  },
): Promise<void> {
  const header = [
    t('canvas.budget.species'),
    t('canvas.budget.quantity'),
    t('canvas.budget.unitCost'),
    t('canvas.budget.lineTotal'),
    t('canvas.budget.currency'),
  ].map(escapeBudgetCsvField).join(',')

  const csvRows = [header]
  for (const row of rows) {
    const entry = options.lineItemPriceMap.get(row.canonical)
    const displayName = row.commonName || row.canonical
    const priceColumns = entry
      ? `${entry.unit_cost.toFixed(2)},${(row.count * entry.unit_cost).toFixed(2)}`
      : ','
    csvRows.push(`${escapeBudgetCsvField(displayName)},${row.count},${priceColumns},${escapeBudgetCsvField(options.currency)}`)
  }
  csvRows.push(`${escapeBudgetCsvField(t('canvas.budget.grandTotal'))},,,${options.grandTotal.toFixed(2)},`)

  await deliverBudgetCsv(
    csvRows.join('\n'),
    `${options.designName || 'budget'}-budget.csv`,
  )
}

/**
 * File › Export › Budget as CSV…: the open Design's Budget as the Budget panel
 * shows it. A cancelled save dialog is not a failure.
 */
export async function exportCurrentBudgetCsv(): Promise<void> {
  const { projection, currency, designName } = readBudgetPlanningSurface()
  try {
    await exportBudgetCsv(projection.rows, {
      currency,
      designName,
      lineItemPriceMap: projection.lineItemPriceMap,
      grandTotal: projection.grandTotal,
    })
  } catch (error) {
    if (isBudgetExportCancelled(error)) return
    throw error
  }
}
