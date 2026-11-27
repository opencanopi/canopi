import { capabilitiesForEdition } from '../../generated/edition-capabilities'
import { DEFAULT_SETTINGS } from '../../generated/settings'
import type { EditionPorts } from '../../platform/edition-ports'
import { createUnsupportedDataLibraryPort } from '../../platform/library'
import { createFakeFileDelivery } from './fakes/file-delivery.fake'

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
    fileDelivery: createFakeFileDelivery('downloaded'),
    dataLibrary: createUnsupportedDataLibraryPort(),
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
      version: async () => 'gallery',
      decode: async () => {
        throw new Error('Gallery edition does not decode Designs')
      },
      encode: async () => {
        throw new Error('Gallery edition does not encode Designs')
      },
      newDesign: async () => {
        throw new Error('Gallery edition does not construct Designs')
      },
      draftSummary: async () => {
        throw new Error('Gallery edition does not summarise Drafts')
      },
      decodeStamp: async () => {
        throw new Error('Gallery edition does not decode stamps')
      },
      encodeStamp: async () => {
        throw new Error('Gallery edition does not encode stamps')
      },
    },
  }
}
