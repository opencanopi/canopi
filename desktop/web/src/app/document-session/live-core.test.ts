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
import { EMPTY_SHA256, type DesignHomeStore, type DraftId, type HomeVersion } from '../../platform/design-home'
import { createBrowserSessionHomeStore } from '../../editions/web/session-ports'
import { createBrowserAppDataStore, DRAFTS_STORAGE_KEY } from '../../web/browser-app-data'
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
    expect(decoded.file.plants[0]?.canopy_spread_m).toBe(3.5)
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
    expect(opened.file.site_data?.entries.length).toBeGreaterThan(0)
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
    expect(reopened.file.site_data).toEqual(opened.file.site_data)
  })

  it('canopi-f47t.52.49 (B2): admitWrite refuses out-of-range plant scale/rotation, annotation font_size, layer/Site-data opacity, Site-data name/range, and WGS84 coords before save', async () => {
    const codec = createJsonSessionCodec({ designCore: makeRealWasmDesignCore() })
    const v9Bytes = readFileSync(resolve(process.cwd(), '../../canopi-format/spec/v9/fixture.canopi'))
    const base = (await codec.decode(new Uint8Array(v9Bytes))).file

    expect(codec.admitWrite?.(base)).toBeNull()
    expect(codec.admitWrite?.({
      ...base,
      plants: [{ ...base.plants[0]!, canopy_spread_m: 0 }],
    })).toContain('$.plants[0].canopy_spread_m')
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
      site_data: {
        ...base.site_data!,
        entries: [{ ...base.site_data!.entries[0]!, opacity: -0.1 }],
      },
    })).toContain('$.site_data.entries[0].opacity')
    expect(codec.admitWrite?.({
      ...base,
      site_data: {
        ...base.site_data!,
        entries: [{ ...base.site_data!.entries[0]!, name: '   ' }],
      },
    })).toContain('$.site_data.entries[0].name')
    expect(codec.admitWrite?.({
      ...base,
      site_data: {
        ...base.site_data!,
        entries: [{ ...base.site_data!.entries[0]!, range: { mode: 'Custom', min: 10, max: 5 } }],
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
      site_data: {
        ...base.site_data!,
        entries: [{ ...base.site_data!.entries[0]!, id: '' }],
      },
    })).toContain('$.site_data.entries[0].id')
    expect(codec.admitWrite?.({
      ...base,
      site_data: {
        ...base.site_data!,
        entries: [base.site_data!.entries[0]!, base.site_data!.entries[0]!],
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
      codec: createJsonSessionCodec({ designCore: makeRealWasmDesignCore() }),
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
      codec: createJsonSessionCodec({ designCore: makeRealWasmDesignCore() }),
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

  it('canopi-f47t.52.49: full v10 spec fixture round-trips losslessly through SessionCore + real Wasm DesignCore', async () => {
    const designCore = makeRealWasmDesignCore()
    const rawV10 = readFileSync(resolve(process.cwd(), '../../canopi-format/spec/v10/fixture.canopi'), 'utf8')
    const decodedRef = JSON.parse(decode_design(rawV10)) as FormatDecodeAnswer
    if (!('ok' in decodedRef)) throw new Error('expected v10 fixture to decode')
    const rich = structuredClone(decodedRef.ok.design) as Record<string, unknown>
    ;(rich.plants as Record<string, unknown>[])[0]!.quantity = 4
    ;(rich.plants as Record<string, unknown>[])[0]!.ext = { nursery_tag: 'lot-7' }
    ;(rich.zones as Record<string, unknown>[])[0]!.stroke_color = '#1E3A5F'
    ;(rich.zones as Record<string, unknown>[])[0]!.opacity = 0.45
    ;(rich.zones as Record<string, unknown>[])[0]!.ext = { slope_band: 'gentle' }
    ;(rich.timeline as Record<string, unknown>[])[0]!.offset_days = 14
    ;(rich.timeline as Record<string, unknown>[])[0]!.ext = { crew: 'orchard' }
    ;(rich.layers as Record<string, unknown>[])[0]!.ext = { future_layer_tag: true }
    rich.groups = [{
      id: 'g-rich',
      members: [
        { kind: 'plant', id: (rich.plants as Record<string, unknown>[])[0]!.id, ext: { role: 'anchor' } },
        { kind: 'measurement_guide', id: (rich.measurement_guides as Record<string, unknown>[])[0]!.id },
      ],
      ext: { label: 'swale-pair' },
    }]
    rich.site_data = {
      visible: true,
      entries: [{
        id: 'derived-slope-1',
        name: 'Slope',
        visible: true,
        opacity: 0.8,
        order: 0,
        ramp: 'Aurora',
        reversed: false,
        range: null,
        ext: { unit: 'deg' },
      }],
      ext: { palette_version: 2 },
    }
    rich.budget_ext = {
      non_plant_lines: [{
        id: 'b-fence',
        category: 'Materials',
        description: 'Deer fence',
        quantity: 120,
        unit_cost: 4.5,
        currency: 'EUR',
        target: null,
      }],
      extra_note: 'keep-me',
    }
    const canonicalEnc = JSON.parse(encode_design(JSON.stringify(rich))) as { ok: string }
    const canonicalJson = JSON.parse(canonicalEnc.ok) as Record<string, unknown>
    const codec = createJsonSessionCodec({ designCore })

    const opened = await codec.decode(new TextEncoder().encode(canonicalEnc.ok))
    const saved = await codec.encode(opened.file)
    expect(JSON.parse(new TextDecoder().decode(saved.bytes))).toEqual(canonicalJson)

    const reopened = await codec.decode(saved.bytes)
    const resaved = await codec.encode(reopened.file)
    expect(JSON.parse(new TextDecoder().decode(resaved.bytes))).toEqual(canonicalJson)
  })

  it('canopi-f47t.52.49: frozen v9 fixture round-trips through SessionCore + real Wasm DesignCore matching chain.rs output', async () => {
    const designCore = makeRealWasmDesignCore()
    const rawV9 = readFileSync(resolve(process.cwd(), '../../canopi-format/spec/v9/fixture.canopi'), 'utf8')
    const coreDecoded = JSON.parse(decode_design(rawV9)) as FormatDecodeAnswer
    if (!('ok' in coreDecoded)) throw new Error('expected v9 fixture to decode')
    const codec = createJsonSessionCodec({ designCore })

    const opened = await codec.decode(new TextEncoder().encode(rawV9))
    expect(opened.migratedFrom).toBe(9)
    const saved = await codec.encode(opened.file)
    expect(JSON.parse(new TextDecoder().decode(saved.bytes))).toEqual(coreDecoded.ok.design)

    const reopened = await codec.decode(saved.bytes)
    const resaved = await codec.encode(reopened.file)
    expect(JSON.parse(new TextDecoder().decode(resaved.bytes))).toEqual(coreDecoded.ok.design)
  })

  it('canopi-f47t.52.49: stored 2.0 Web Draft (v9) with duplicate Site data ids migrates via DesignCore chain.rs and autosaves cleanly', async () => {
    const designCore = makeRealWasmDesignCore()
    const rawV9 = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../canopi-format/spec/v9/fixture.canopi'), 'utf8'),
    ) as Record<string, unknown>
    // Inject duplicate Site data id that only chain.rs v9->v10 deduplicates (2.1-M493, #669 B1-d).
    rawV9.lidar = {
      visible: true,
      entries: [
        { kind: 'Source', id: 'dup-site-1', name: 'First', visible: true, opacity: 1, order: 0, ramp: null, reversed: false, range: null },
        { kind: 'Derived', id: 'dup-site-1', name: 'Duplicate', visible: true, opacity: 0.5, order: 1, ramp: null, reversed: false, range: null },
      ],
    }

    const storageMap = new Map<string, string>()
    storageMap.set(DRAFTS_STORAGE_KEY, JSON.stringify({
      version: 3,
      drafts: [{ id: 'draft-v9', name: String(rawV9.name), updatedAt: '2026-10-01T00:00:00.000Z' }],
      draftFiles: { 'draft-v9': rawV9 },
    }))
    const appDataStore = createBrowserAppDataStore({
      storage: {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => { storageMap.set(k, v) },
        removeItem: (k: string) => { storageMap.delete(k) },
      },
    })
    const homeStore = createBrowserSessionHomeStore(appDataStore)
    const core = createSessionCore({
      designHome: homeStore,
      fileAccess: {
        pickOpen: async () => ({ kind: 'cancelled' }),
        pickHomeTarget: async () => ({ kind: 'cancelled' }),
      },
      lifecycle: { subscribe: () => () => {} },
      codec: createJsonSessionCodec({ designCore }),
      settings: {
        readLastOpenHome: async () => null,
        writeLastOpenHome: async () => {},
      },
      newDesignFactory: () => sampleDesign('Untitled'),
    })
    disposeCore = installLiveSessionCore(core)

    const opened = await core.openFrom({ kind: 'draft', id: 'draft-v9' as DraftId })
    expect(opened.status).toBe('opened')
    expect(core.currentDesign.peek()?.migratedFrom).toBe(9)
    expect(core.snapshot()?.site_data?.entries).toHaveLength(1)
    expect(core.snapshot()?.site_data?.entries[0]?.id).toBe('dup-site-1')

    core.document('Rename', () => ({ name: 'Migrated Orchard' }))
    await core.flushNow({ force: true })
    expect(core.dirty.peek()).toBe(false)
    expect(appDataStore.loadDraft('draft-v9')?.name).toBe('Migrated Orchard')
    expect(appDataStore.loadDraft('draft-v9')?.version).toBe(10)
  })

  it('#689 / 2b-5: zone-target and unknown open-set budget lines plus nested view/story/colour-range extras survive Web SessionCore round-trip', async () => {
    const designCore = makeRealWasmDesignCore()
    const raw = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../canopi-format/spec/v10/fixture.canopi'), 'utf8'),
    ) as Record<string, unknown>
    raw.budget = [
      { target: { kind: 'species', canonical_name: 'Malus domestica', target_tag: 'orchard' }, unit_cost: 18.5 },
      { target: { kind: 'zone', zone_id: 'zone-1', zone_note: 'south' }, unit_cost: 120.0, ext: { category: 'Earthworks' } },
      { target: { kind: 'seed_mix', mix_id: 'meadow-a' }, unit_cost: 42.25 },
    ]
    const canonicalEnc = JSON.parse(encode_design(JSON.stringify(raw))) as { ok: string }
    const canonicalJson = JSON.parse(canonicalEnc.ok) as Record<string, unknown>
    const codec = createJsonSessionCodec({ designCore })

    const opened = await codec.decode(new TextEncoder().encode(canonicalEnc.ok))
    expect(opened.file.budget).toHaveLength(3)
    expect(opened.file.budget[1]?.target.kind).toBe('zone')
    expect(opened.file.budget[2]?.target.kind).toBe('seed_mix')
    const saved = await codec.encode(opened.file)
    expect(JSON.parse(new TextDecoder().decode(saved.bytes))).toEqual(canonicalJson)
  })
})
