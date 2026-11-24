import { describe, expect, it } from 'vitest'
import { capabilitiesForEdition } from '../generated/edition-capabilities'
import { DEFAULT_SETTINGS } from '../generated/settings'
import {
  editionPorts,
  hasEditionPorts,
  installEditionPorts,
  type EditionPorts,
} from './edition-ports'

function stubPorts(edition: 'desktop' | 'web'): EditionPorts {
  return {
    capabilities: capabilitiesForEdition(edition, 'linux'),
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
      write: async () => ({ file_name: 'report.zip' }),
    },
    geocoding: async () => [],
    canvasPdfDelivery: () => ({
      save: async () => 'downloaded',
      dispose: () => {},
    }),
    budgetExportDelivery: async () => {},
  }
}

describe('platform/edition-ports (Stage 2 A1)', () => {
  it('throws when editionPorts() is read before installation', () => {
    expect(hasEditionPorts()).toBe(false)
    expect(() => editionPorts()).toThrow(/EditionPorts are not installed/)
  })

  it('installs and disposes ports cleanly', () => {
    const desktop = stubPorts('desktop')
    const dispose = installEditionPorts(desktop)
    expect(hasEditionPorts()).toBe(true)
    expect(editionPorts()).toBe(desktop)
    expect(editionPorts().capabilities.has('file-home')).toBe(true)
    dispose()
    expect(hasEditionPorts()).toBe(false)
  })

  it('restores prior ports when a nested installEditionPorts disposer runs', () => {
    const desktop = stubPorts('desktop')
    const web = stubPorts('web')
    const disposeOuter = installEditionPorts(desktop)
    try {
      const disposeInner = installEditionPorts(web)
      expect(editionPorts()).toBe(web)
      disposeInner()
      expect(editionPorts()).toBe(desktop)
    } finally {
      disposeOuter()
    }
    expect(hasEditionPorts()).toBe(false)
  })
})
