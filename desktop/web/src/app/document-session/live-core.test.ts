import { describe, expect, it, vi } from 'vitest'
import type { CanopiFileV10, FormatDecodeAnswer } from '../../generated/contracts'
import type { DesignCore } from '../../platform/design-core'
import { createJsonSessionCodec } from './live-core'

function makeDesignCore(decodeImpl: (bytes: Uint8Array) => Promise<FormatDecodeAnswer>): DesignCore {
  return {
    version: vi.fn(async () => '2.1.0'),
    decode: vi.fn(decodeImpl),
    encode: vi.fn(async () => ({ ok: new Uint8Array() })),
    newDesign: vi.fn(async () => ({}) as CanopiFileV10),
    draftSummary: vi.fn(async () => ({ name: '', updated_at: '2026-11-26T00:00:00Z', readable: false })),
    decodeStamp: vi.fn(async () => ({ err: 'unused' })),
    encodeStamp: vi.fn(async () => ({ err: 'unused' })),
    readNewerDesign: vi.fn(async () => ({ saved_by_version: 11, view: {} as never })),
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

  it('routes newer_version through readNewerDesign and maps older/invalid refusals', async () => {
    const newerCore = makeDesignCore(async () => ({
      err: { kind: 'newer_version', message: 'too new' },
    }))
    const withReader = createJsonSessionCodec({
      designCore: newerCore,
      readNewerDesign: async () => ({ saved_by_version: 11, view: { name: 'Future' } as never }),
    })
    const ro = await withReader.decode(new TextEncoder().encode('{}'))
    expect(ro.readOnly).toBe(true)
    expect(ro.savedByVersion).toBe(11)

    const withoutReader = createJsonSessionCodec({ designCore: newerCore })
    await expect(withoutReader.decode(new TextEncoder().encode('{}'))).rejects.toThrow('too new')

    const olderCore = makeDesignCore(async () => ({
      err: { kind: 'older_version', message: 'too old' },
    }))
    await expect(createJsonSessionCodec({ designCore: olderCore }).decode(new TextEncoder().encode('{}')))
      .rejects.toThrow('too old')

    const invalidCore = makeDesignCore(async () => ({
      err: { kind: 'invalid_document', message: 'bad doc' },
    }))
    await expect(createJsonSessionCodec({ designCore: invalidCore }).decode(new TextEncoder().encode('{}')))
      .rejects.toThrow('bad doc')
  })
})
