import { describe, expect, it } from 'vitest'
import { createTestEditionPorts } from '../__tests__/support/test-edition-ports'
import { capabilitiesForEdition } from '../generated/edition-capabilities'
import {
  editionPorts,
  hasEditionPorts,
  installEditionPorts,
  type EditionPorts,
} from './edition-ports'

function stubPorts(edition: 'desktop' | 'web'): EditionPorts {
  return createTestEditionPorts({
    capabilities: capabilitiesForEdition(edition, 'linux'),
  })
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
