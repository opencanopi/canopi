import { deliverBudgetCsv as deliverDesktopBudgetCsv } from '../../app/budget/platform.desktop'
import { createGalleryEditionPorts } from '../../editions/gallery/ports'
import type { EditionPorts } from '../../platform/edition-ports'

export function createTestEditionPorts(overrides: Partial<EditionPorts> = {}): EditionPorts {
  const base = createGalleryEditionPorts('desktop')
  return {
    ...base,
    problemReport: {
      ...base.problemReport,
      write: async () => ({ file_name: 'test-report.zip' }),
    },
    canvasPdfDelivery: () => ({
      save: async () => 'saved',
      dispose: () => {},
    }),
    budgetExportDelivery: deliverDesktopBudgetCsv,
    ...overrides,
  }
}
