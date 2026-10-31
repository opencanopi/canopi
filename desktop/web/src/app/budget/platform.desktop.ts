import { exportFile } from '../../ipc/export'

export async function deliverBudgetCsv(data: string, defaultName: string): Promise<void> {
  await exportFile(data, defaultName, 'budget-csv-export')
}
