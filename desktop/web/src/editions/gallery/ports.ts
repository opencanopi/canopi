import { capabilitiesForEdition } from '../../generated/edition-capabilities'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { EditionPorts } from '../../platform/edition-ports'

const UNAVAILABLE = 'not_on_this_edition' as const

export function createGalleryEditionPorts(edition: 'desktop' | 'web'): EditionPorts {
  return {
    capabilities: capabilitiesForEdition(edition, 'linux'),
    settings: {
      load: () => ({ ...DEFAULT_SETTINGS }),
      save: async () => {},
    },
    problemReport: {
      sections: {
        build: UNAVAILABLE,
        health: UNAVAILABLE,
        queues: UNAVAILABLE,
        native_settlements: UNAVAILABLE,
        jobs: UNAVAILABLE,
        library_disk: UNAVAILABLE,
        log_tail: UNAVAILABLE,
        settings_summary: UNAVAILABLE,
      },
      currentDesign: () => null,
      write: async () => ({ file_name: 'gallery-report.zip' }),
    },
    geocoding: async () => [],
    canvasPdfDelivery: () => ({ save: async () => 'downloaded', dispose: () => {} }),
    budgetExportDelivery: async () => {},
    designHome: {
      read: async () => ({ kind: 'absent' }),
      write: async () => ({ kind: 'written', version: 'gallery-v1' }),
      listDrafts: async () => [],
      deleteDraft: async () => ({ ok: true }),
      onVersionChange: () => () => {},
    },
    fileAccess: {
      pickOpen: async () => ({ kind: 'cancelled' }),
      pickHomeTarget: async () => ({ kind: 'cancelled' }),
    },
    appLifecycle: {
      subscribe: () => () => {},
    },
    designCore: {
      readNewerDesign: async () => {
        throw new Error('Gallery edition does not decode newer Designs')
      },
    },
  }
}
