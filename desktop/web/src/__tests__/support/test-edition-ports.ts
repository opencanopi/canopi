import { capabilitiesForEdition } from '../../generated/edition-capabilities'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { EditionPorts } from '../../platform/edition-ports'
import { deliverBudgetCsv as deliverDesktopBudgetCsv } from '../../app/budget/platform.desktop'

export function createTestEditionPorts(overrides: Partial<EditionPorts> = {}): EditionPorts {
  return {
    capabilities: capabilitiesForEdition('desktop', 'linux'),
    settings: {
      load: () => ({ ...DEFAULT_SETTINGS }),
      save: async () => {},
    },
    problemReport: {
      sections: {
        build: 'not_on_this_edition',
        health: 'not_on_this_edition',
        queues: 'not_on_this_edition',
        native_settlements: 'not_on_this_edition',
        jobs: 'not_on_this_edition',
        library_disk: 'not_on_this_edition',
        log_tail: 'not_on_this_edition',
        settings_summary: 'not_on_this_edition',
      },
      currentDesign: () => null,
      write: async () => ({ file_name: 'test-report.zip' }),
    },
    geocoding: async () => [],
    canvasPdfDelivery: () => ({
      save: async () => 'saved',
      dispose: () => {},
    }),
    budgetExportDelivery: deliverDesktopBudgetCsv,
    ...overrides,
  }
}
