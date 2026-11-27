import { editionPorts } from '../../platform/edition-ports'
import { raiseNotice } from '../../failures/notices'
import { t } from '../../i18n'
import { currencyFractionDigits, formatFixed } from '../../utils/format'
import { escapeBudgetCsvField } from './formatting'
import { readBudgetPlanningSurface } from '../planning-projection'

export interface BudgetExportRow {
  canonical: string
  commonName: string
  count: number
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

  const decimals = currencyFractionDigits(options.currency)
  const csvRows = [header]
  for (const row of rows) {
    const entry = options.lineItemPriceMap.get(row.canonical)
    const displayName = row.commonName || row.canonical
    const priceColumns = entry
      ? `${formatFixed(entry.unit_cost, decimals)},${formatFixed(row.count * entry.unit_cost, decimals)}`
      : ','
    csvRows.push(`${escapeBudgetCsvField(displayName)},${row.count},${priceColumns},${escapeBudgetCsvField(options.currency)}`)
  }
  csvRows.push(`${escapeBudgetCsvField(t('canvas.budget.grandTotal'))},,,${formatFixed(options.grandTotal, decimals)},`)

  const outcome = await editionPorts().fileDelivery.deliverFile(
    'budget-csv',
    options.designName || 'budget',
    { text: csvRows.join('\n') },
  )
  if (outcome === 'refused') {
    raiseNotice({
      key: 'budget.export.refused',
      message: 'fileDelivery.refused',
      tone: 'error',
      kind: 'outcome',
    })
  }
}

/**
 * File › Export › Budget as CSV…: the open Design's Budget as the Budget panel
 * shows it. A cancelled save dialog is not a failure.
 */
export async function exportCurrentBudgetCsv(): Promise<void> {
  const { projection, currency, designName } = readBudgetPlanningSurface()
  await exportBudgetCsv(projection.rows, {
    currency,
    designName,
    lineItemPriceMap: projection.lineItemPriceMap,
    grandTotal: projection.grandTotal,
  })
}
