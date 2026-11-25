// Desktop's Design attachment (canopi-v4kj, 2.1-M479, Q337): a Design a newer Canopi saved is open as the format core's
// read view, never the user's file, so the attachment is never its re-encode; a storage-unchecked read-only Draft and an
// editing Design attach as today. The session is applied as the Design session's load result applies it.
import { afterEach, describe, expect, it } from 'vitest'
import { designSessionStore } from '../document-session/store'
import { clearCurrentDesignState, replaceCurrentDesignState } from '../../__tests__/support/design-session-state'
import type { CanopiFile } from '../../types/design'
import { buildCurrentDesignProblemReportAttachment } from './attachments'

function makeFile(name: string): CanopiFile {
  return {
    version: 9,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    measurement_guides: [],
    groups: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
  }
}

afterEach(() => clearCurrentDesignState())

describe('the Desktop Design attachment', () => {
  it('canopi-v4kj: a Design or Draft a newer Canopi saved, open read-only, is never attached re-encoded', () => {
    replaceCurrentDesignState(makeFile('Orchard 2.1'), '/designs/orchard.canopi', 'Orchard 2.1', {
      kind: 'read-only',
      origin: 'newer-version',
      savedByVersion: 10,
    })
    expect(designSessionStore.sessionKind.value).toEqual({ kind: 'read-only', origin: 'newer-version', savedByVersion: 10 })
    expect(buildCurrentDesignProblemReportAttachment()).toBeNull()

    replaceCurrentDesignState(makeFile('Hedge 2.1'), null, 'Hedge 2.1', {
      kind: 'read-only',
      origin: 'newer-version',
      savedByVersion: 10,
    })
    expect(buildCurrentDesignProblemReportAttachment()).toBeNull()
  })

  it('canopi-v4kj: an editing Design and a storage-unchecked read-only Draft still attach', () => {
    replaceCurrentDesignState(makeFile('Orchard'), '/designs/orchard.canopi', 'Orchard')
    expect(buildCurrentDesignProblemReportAttachment()).toContain('"name": "Orchard"')

    replaceCurrentDesignState(makeFile('Hedge as 2.0 left it'), null, 'Hedge as 2.0 left it', { kind: 'read-only', origin: 'storage-unchecked' })
    expect(buildCurrentDesignProblemReportAttachment()).toContain('"name": "Hedge as 2.0 left it"')
  })
})
