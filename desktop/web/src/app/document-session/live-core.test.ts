// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decode_design,
  encode_design,
  initSync,
} from '../../../../../canopi-format-wasm/dist/canopi_format_wasm.js'
import { CURRENT_CANOPI_FILE_VERSION } from '../../generated/canopi-design-format'
import type { CanopiFileV10, FormatDecodeAnswer } from '../../generated/contracts'
import type { DesignCore } from '../../platform/design-core'
import { EMPTY_SHA256, type DesignHomeStore, type HomeVersion } from '../../platform/design-home'
import type { CanopiFile } from '../../types/design'
import { saveAsCurrentDesign, saveCurrentDesign } from './actions'
import {
  createJsonSessionCodec,
  createSessionCore,
  getLiveSessionCore,
  installLiveSessionCore,
} from './live-core'
import { answerSaveProblem, saveProblem } from './save-problem'
import { designSessionStore } from './store'

let wasmReady = false
function ensureWasm(): void {
  if (wasmReady) return
  initSync({
    module: readFileSync(resolve(process.cwd(), '../../canopi-format-wasm/dist/canopi_format_wasm_bg.wasm')),
  })
  wasmReady = true
}

function makeRealWasmDesignCore(): DesignCore {
  ensureWasm()
  const dec = new TextDecoder('utf-8', { fatal: true })
  const enc = new TextEncoder()
  return {
    version: async () => '2.1.0',
    decode: async (bytes) => JSON.parse(decode_design(dec.decode(bytes))) as FormatDecodeAnswer,
    encode: async (design) => {
      const parsed = JSON.parse(encode_design(JSON.stringify(design))) as { ok?: string; err?: { kind: 'invalid_document'; message: string; field_path?: string | null } }
      return typeof parsed.ok === 'string' ? { ok: enc.encode(parsed.ok) } : { err: parsed.err! }
    },
    newDesign: vi.fn(async () => ({}) as CanopiFileV10),
    draftSummary: vi.fn(async () => ({ name: '', updated_at: '2026-11-26T00:00:00Z', readable: false })),
    decodeStamp: vi.fn(async () => ({ err: 'unused' })),
    encodeStamp: vi.fn(async () => ({ err: 'unused' })),
  }
}

function makeDesignCore(decodeImpl: (bytes: Uint8Array) => Promise<FormatDecodeAnswer>): DesignCore {
  return {
    version: vi.fn(async () => '2.1.0'),
    decode: vi.fn(decodeImpl),
    encode: vi.fn(async () => ({ ok: new Uint8Array() })),
    newDesign: vi.fn(async () => ({}) as CanopiFileV10),
    draftSummary: vi.fn(async () => ({ name: '', updated_at: '2026-11-26T00:00:00Z', readable: false })),
    decodeStamp: vi.fn(async () => ({ err: 'unused' })),
    encodeStamp: vi.fn(async () => ({ err: 'unused' })),
  }
}

describe('createJsonSessionCodec with DesignCore', () => {
  it('decodes v10 designs through DesignCore and maps v10 fields to session CanopiFile', async () => {
    const v10: CanopiFileV10 = {
      version: 10,
      name: 'Meadow',
      description: null,
      plant_species_colors: {},
      plant_species_symbols: {},
      plant_species_codes: {},
      layers: [],
      plants: [{
        id: 'p1',
        locked: false,
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        symbol: null,
        position: { lon: 1, lat: 2 },
        rotation: null,
        canopy_spread_m: 3.5,
        notes: null,
        planted_date: null,
        quantity: 1,
      }],
      zones: [{
        id: 'z1',
        name: 'Bed',
        locked: false,
        zone_type: 'polygon',
        points: [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }, { lon: 1, lat: 1 }],
        rotation: 0,
        fill_color: '#abc',
        notes: null,
      }],
      annotations: [{
        id: 'a1',
        locked: false,
        annotation_type: 'text',
        position: { lon: 0, lat: 0 },
        text: 'Hi',
        font_size: 12,
        rotation: null,
      }],
      measurement_guides: [],
      groups: [],
      consortiums: [],
      timeline: [],
      budget: [],
      budget_currency: 'EUR',
      views: [],
      stories: [],
      created_at: '2026-11-26T00:00:00Z',
      updated_at: '2026-11-26T00:00:00Z',
      custom_flag: true,
    } as CanopiFileV10
    const core = makeDesignCore(async () => ({
      ok: { design: v10, migrated_from: null },
    }))
    const codec = createJsonSessionCodec({ designCore: core })

    const decoded = await codec.decode(new TextEncoder().encode('{}'))
    expect(decoded.file.name).toBe('Meadow')
    expect(decoded.file.plants[0]?.scale).toBe(3.5)
    expect(decoded.file.extra).toEqual({ custom_flag: true })
  })

  it('maps newer_version, older_version, too_large, invalid_json, and invalid_document refusals with field paths (2.1-Q347)', async () => {
    const newerCore = makeDesignCore(async () => ({
      err: { kind: 'newer_version', message: 'too new' },
    }))
    await expect(createJsonSessionCodec({ designCore: newerCore }).decode(new TextEncoder().encode('{}')))
      .rejects.toMatchObject({ message: 'too new', loadFailureKind: 'newer_version' })

    const olderCore = makeDesignCore(async () => ({
      err: { kind: 'older_version', message: 'too old' },
    }))
    await expect(createJsonSessionCodec({ designCore: olderCore }).decode(new TextEncoder().encode('{}')))
      .rejects.toMatchObject({ message: 'too old', loadFailureKind: 'older_version' })

    const tooLargeCore = makeDesignCore(async () => ({
      err: { kind: 'too_large', message: 'over 64 MiB' },
    }))
    await expect(createJsonSessionCodec({ designCore: tooLargeCore }).decode(new TextEncoder().encode('{}')))
      .rejects.toMatchObject({ message: 'over 64 MiB', loadFailureKind: 'too_large' })

    const invalidCore = makeDesignCore(async () => ({
      err: { kind: 'invalid_document', message: 'bad doc', field_path: '$.plants[0].position' },
    }))
    await expect(createJsonSessionCodec({ designCore: invalidCore }).decode(new TextEncoder().encode('{}')))
      .rejects.toMatchObject({
        message: 'bad doc',
        loadFailureKind: 'invalid_document',
        fieldPath: '$.plants[0].position',
      })
  })

  it('canopi-f47t.52.49 (B1): opens v9 fixture with species budget and Site data, saves canonical v10 through real Wasm DesignCore, and reopens cleanly', async () => {
    const codec = createJsonSessionCodec({ designCore: makeRealWasmDesignCore() })
    const v9Bytes = readFileSync(resolve(process.cwd(), '../../canopi-format/spec/v9/fixture.canopi'))

    const opened = await codec.decode(new Uint8Array(v9Bytes))
    expect(opened.file.version).toBe(10)
    expect(opened.file.budget?.length).toBeGreaterThan(0)
    expect(opened.file.lidar?.entries.length).toBeGreaterThan(0)
    expect(codec.admitWrite?.(opened.file)).toBeNull()

    const saved = await codec.encode(opened.file)
    const savedJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes)) as Record<string, unknown>
    expect(savedJson.version).toBe(10)
    expect(savedJson.lidar).toBeUndefined()
    expect(savedJson.site_data).toBeDefined()

    const reopened = await codec.decode(saved.bytes)
    expect(reopened.file.version).toBe(10)
    expect(reopened.file.name).toBe(opened.file.name)
    expect(reopened.file.plants).toHaveLength(opened.file.plants.length)
    expect(reopened.file.budget).toEqual(opened.file.budget)
    expect(reopened.file.lidar).toEqual(opened.file.lidar)
  })

  it('canopi-f47t.52.49 (B2): admitWrite refuses out-of-range plant scale/rotation, annotation font_size, layer/Site-data opacity, Site-data name/range, and WGS84 coords before save', async () => {
    const codec = createJsonSessionCodec({ designCore: makeRealWasmDesignCore() })
    const v9Bytes = readFileSync(resolve(process.cwd(), '../../canopi-format/spec/v9/fixture.canopi'))
    const base = (await codec.decode(new Uint8Array(v9Bytes))).file

    expect(codec.admitWrite?.(base)).toBeNull()
    expect(codec.admitWrite?.({
      ...base,
      plants: [{ ...base.plants[0]!, scale: 0 }],
    })).toContain('$.plants[0].scale')
    expect(codec.admitWrite?.({
      ...base,
      plants: [{ ...base.plants[0]!, rotation: Number.NaN }],
    })).toContain('$.plants[0].rotation')
    expect(codec.admitWrite?.({
      ...base,
      annotations: [{
        id: 'ann-1',
        locked: false,
        annotation_type: 'text',
        position: { lon: 2, lat: 48 },
        text: 'Note',
        font_size: 0,
        rotation: null,
      }],
    })).toContain('$.annotations[0].font_size')
    expect(codec.admitWrite?.({
      ...base,
      layers: [{ ...base.layers[0]!, opacity: 1.5 }],
    })).toContain('$.layers[0].opacity')
    expect(codec.admitWrite?.({
      ...base,
      lidar: {
        ...base.lidar!,
        entries: [{ ...base.lidar!.entries[0]!, opacity: -0.1 }],
      },
    })).toContain('$.site_data.entries[0].opacity')
    expect(codec.admitWrite?.({
      ...base,
      lidar: {
        ...base.lidar!,
        entries: [{ ...base.lidar!.entries[0]!, name: '   ' }],
      },
    })).toContain('$.site_data.entries[0].name')
    expect(codec.admitWrite?.({
      ...base,
      lidar: {
        ...base.lidar!,
        entries: [{ ...base.lidar!.entries[0]!, range: { mode: 'Custom', min: 10, max: 5 } }],
      },
    })).toContain('$.site_data.entries[0].range')
    expect(codec.admitWrite?.({
      ...base,
      plants: [{ ...base.plants[0]!, position: { lon: 200, lat: 0 } }],
    })).toContain('$.plants[0].position')
    expect(codec.admitWrite?.({
      ...base,
      plants: [{ ...base.plants[0]!, id: '' }],
    })).toContain('$.plants[0].id')
    const sampleZone = {
      id: 'z-1',
      name: 'Bed',
      locked: false,
      zone_type: 'polygon' as const,
      points: [{ lon: 2, lat: 48 }, { lon: 2.001, lat: 48 }, { lon: 2.001, lat: 48.001 }],
      rotation: 0,
      fill_color: '#abc',
      notes: null,
    }
    expect(codec.admitWrite?.({
      ...base,
      zones: [{ ...sampleZone, rotation: Number.NaN }],
    })).toContain('$.zones[0].rotation')
    expect(codec.admitWrite?.({
      ...base,
      zones: [{ ...sampleZone, points: [{ lon: 200, lat: 0 }] }],
    })).toContain('$.zones[0].points[0]')
    expect(codec.admitWrite?.({
      ...base,
      annotations: [{
        id: 'ann-2',
        locked: false,
        annotation_type: 'text',
        position: { lon: 200, lat: 0 },
        text: 'Note',
        font_size: 12,
        rotation: null,
      }],
    })).toContain('$.annotations[0].position')
    expect(codec.admitWrite?.({
      ...base,
      annotations: [{
        id: 'ann-3',
        locked: false,
        annotation_type: 'text',
        position: { lon: 2, lat: 48 },
        text: 'Note',
        font_size: 12,
        rotation: Number.NaN,
      }],
    })).toContain('$.annotations[0].rotation')
    expect(codec.admitWrite?.({
      ...base,
      lidar: {
        ...base.lidar!,
        entries: [{ ...base.lidar!.entries[0]!, id: '' }],
      },
    })).toContain('$.site_data.entries[0].id')
    expect(codec.admitWrite?.({
      ...base,
      lidar: {
        ...base.lidar!,
        entries: [base.lidar!.entries[0]!, base.lidar!.entries[0]!],
      },
    })).toContain('$.site_data.entries[1].id')
  })
})

function sampleDesign(name = 'Orchard'): CanopiFile {
  return {
    version: CURRENT_CANOPI_FILE_VERSION,
    name,
    description: null,
    plant_species_colors: {},
    plant_species_symbols: {},
    plant_species_codes: {},
    plants: [],
    zones: [],
    annotations: [],
    groups: [],
    layers: [],
    measurement_guides: [],
    consortiums: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    views: [],
    stories: [],
    created_at: '2026-11-26T00:00:00Z',
    updated_at: '2026-11-26T00:00:00Z',
  }
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

    core.document('Rename', () => ({ name: 'Renamed' }))
    expect(await saveCurrentDesign()).toBe(true)
    expect(writes).toHaveLength(3)
  })
})
