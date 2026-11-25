// @vitest-environment jsdom
// Behavioral tests for live Session Core wiring (#481 B1/B2):
// proves production saveAsCurrentDesign() routes through SessionCore (FAT 0-byte EMPTY_SHA256
// probe + strict NotExists + Conflict 'Keep my version' retry) and mirrors open state into designSessionStore.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import { EMPTY_SHA256, type DesignHomeStore, type HomeVersion } from '../../platform/design-home'
import type { CanopiFile } from '../../types/design'
import {
  createJsonSessionCodec,
  createSessionCore,
  getLiveSessionCore,
  installLiveSessionCore,
} from './live-core'
import { answerSaveProblem, saveProblem } from './save-problem'
import { designSessionStore } from './store'
import { saveAsCurrentDesign, saveCurrentDesign } from './actions'

function sampleDesign(name = 'Orchard'): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    plants: [],
    zones: [],
    annotations: [],
    groups: [],
    layers: [],
    site: { origin: { lat: 48.85, lon: 2.35 }, units: 'metric' },
    timeline: [],
    budget: { currency: 'EUR', plantPrices: {} },
    consortium: { entries: [] },
    views: [],
    stories: [],
    measurementGuides: [],
  } as unknown as CanopiFile
}

describe('live Session Core wiring (#481 B1/B2)', () => {
  let disposeCore: (() => void) | null = null

  afterEach(() => {
    disposeCore?.()
    disposeCore = null
  })

  it('routes production saveAsCurrentDesign through SessionCore and handles a 0-byte FAT crash remnant via EMPTY_SHA256', async () => {
    const writes: Array<{ key: string; expected: HomeVersion | null }> = []
    const designHome: DesignHomeStore = {
      read: vi.fn(async (key: string) => {
        if (key === '/fat/remnant.canopi') {
          return { kind: 'present' as const, bytes: [], version: EMPTY_SHA256 }
        }
        return { kind: 'absent' as const }
      }),
      write: vi.fn(async (key: string, _bytes: Uint8Array, expected: HomeVersion | null) => {
        writes.push({ key, expected })
        return { kind: 'written' as const, version: 'sha-written-1' }
      }),
      listDrafts: async () => [],
      deleteDraft: async () => ({ ok: true as const }),
      onVersionChange: () => () => {},
    }

    const core = createSessionCore({
      designHome,
      fileAccess: {
        pickOpen: async () => ({ kind: 'cancelled' }),
        pickHomeTarget: async () => ({ kind: 'picked', grant: '/fat/remnant.canopi', displayName: 'remnant.canopi' }),
      },
      lifecycle: { subscribe: () => () => {} },
      codec: createJsonSessionCodec(),
      settings: {
        readLastOpenHome: async () => null,
        writeLastOpenHome: async () => {},
      },
      newDesignFactory: () => sampleDesign('FAT Save As'),
    })
    disposeCore = installLiveSessionCore(core)
    expect(getLiveSessionCore()).toBe(core)

    await core.createNew()
    expect(designSessionStore.currentDesign.peek()?.name).toBe('FAT Save As')

    const settlement = await saveAsCurrentDesign()
    expect(settlement?.status).toBe('applied')
    expect(settlement?.path).toBe('/fat/remnant.canopi')
    expect(writes).toEqual([{ key: '/fat/remnant.canopi', expected: EMPTY_SHA256 }])
    expect(designSessionStore.designPath.peek()).toBe('/fat/remnant.canopi')
  })

  it('routes production saveAsCurrentDesign Conflict through Keep my version retry and flushes via saveCurrentDesign', async () => {
    const writes: Array<{ key: string; expected: HomeVersion | null }> = []
    let attempt = 0
    const designHome: DesignHomeStore = {
      read: vi.fn(async () => ({ kind: 'absent' as const })),
      write: vi.fn(async (key: string, _bytes: Uint8Array, expected: HomeVersion | null) => {
        writes.push({ key, expected })
        attempt += 1
        if (attempt === 1) {
          return { kind: 'conflict' as const, current: 'sha-raced-on-disk' }
        }
        return { kind: 'written' as const, version: `sha-v${attempt}` }
      }),
      listDrafts: async () => [],
      deleteDraft: async () => ({ ok: true as const }),
      onVersionChange: () => () => {},
    }

    const core = createSessionCore({
      designHome,
      fileAccess: {
        pickOpen: async () => ({ kind: 'cancelled' }),
        pickHomeTarget: async () => ({ kind: 'picked', grant: '/designs/raced.canopi', displayName: 'raced.canopi' }),
      },
      lifecycle: { subscribe: () => () => {} },
      codec: createJsonSessionCodec(),
      settings: {
        readLastOpenHome: async () => null,
        writeLastOpenHome: async () => {},
      },
      newDesignFactory: () => sampleDesign('Raced Save As'),
    })
    disposeCore = installLiveSessionCore(core)
    await core.createNew()

    const saveAsPromise = saveAsCurrentDesign()
    await vi.waitFor(() => expect(saveProblem.value?.kind).toBe('conflict'))
    answerSaveProblem('keep-mine')

    const settlement = await saveAsPromise
    expect(settlement?.status).toBe('applied')
    expect(settlement?.path).toBe('/designs/raced.canopi')
    expect(writes).toEqual([
      { key: '/designs/raced.canopi', expected: null },
      { key: '/designs/raced.canopi', expected: 'sha-raced-on-disk' },
    ])

    // Subsequent edit + saveCurrentDesign flushes through SessionCore's write lane
    core.document('Rename', () => ({ name: 'Renamed' }))
    expect(await saveCurrentDesign()).toBe(true)
    expect(writes).toHaveLength(3)
  })
})
