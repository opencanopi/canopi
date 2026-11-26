// Desktop's Design attachment (canopi-v4kj, 2.1-M479, Q337): a Design a newer Canopi saved is open as the format core's
// read view, never the user's file, so the attachment is never its re-encode; a storage-unchecked read-only Draft and an
// editing Design attach through DesignCore.encode.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDesignCore } from '../../__tests__/support/design-wire'
import { createJsonSessionCodec, createSessionCore, installLiveSessionCore } from '../document-session/live-core'
import { createInMemoryDesignHomeStore } from '../../__tests__/support/session-core-fixture'
import type { CanopiFile } from '../../types/design'
import { buildCurrentDesignProblemReportAttachment } from './attachments'

function makeFile(name: string): CanopiFile {
  return {
    version: 10,
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

let disposeSession: (() => void) | null = null

afterEach(() => {
  disposeSession?.()
  disposeSession = null
})

function mountSession(file: CanopiFile, designCore: ReturnType<typeof createTestDesignCore>, readOnly = false): void {
  disposeSession?.()
  const core = createSessionCore({
    designHome: createInMemoryDesignHomeStore(),
    fileAccess: { pickOpen: async () => ({ kind: 'cancelled' }), pickHomeTarget: async () => ({ kind: 'cancelled' }) },
    lifecycle: { subscribe: () => () => {} },
    codec: createJsonSessionCodec({ designCore }),
    settings: { readLastOpenHome: async () => null, writeLastOpenHome: async () => {} },
    newDesignFactory: () => file,
    initialDesign: { home: { kind: 'draft', key: 'test' as never, version: null }, file, ...(readOnly ? { readOnly: true } : {}) },
  })
  disposeSession = installLiveSessionCore(core)
}

describe('the Desktop Design attachment', () => {
  it('returns null when no live session core is installed', async () => {
    expect(await buildCurrentDesignProblemReportAttachment()).toBeNull()
  })

  it('canopi-v4kj: an editing Design and a storage-unchecked read-only Draft still attach', async () => {
    const designCore = createTestDesignCore()
    const encodeSpy = vi.spyOn(designCore, 'encode')

    mountSession(makeFile('Orchard'), designCore, false)
    const orchard = await buildCurrentDesignProblemReportAttachment()
    expect(orchard).not.toBeNull()
    expect((JSON.parse(orchard!) as { name: string }).name).toBe('Orchard')

    mountSession(makeFile('Hedge as 2.0 left it'), designCore, true)
    const hedge = await buildCurrentDesignProblemReportAttachment()
    expect(hedge).not.toBeNull()
    expect((JSON.parse(hedge!) as { name: string }).name).toBe('Hedge as 2.0 left it')
    expect(encodeSpy).toHaveBeenCalledTimes(2)
  })
})
