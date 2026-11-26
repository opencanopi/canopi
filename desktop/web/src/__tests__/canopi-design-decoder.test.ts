import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pickCancelled } from '../ipc/dialogs'
import {
  designLoadFailureMessageKey,
  designLoadFailureOf,
} from '../app/contracts/canopi-design-errors'
import { readPlantDisplayOptions } from '../app/design-edit/plant-display'
import { recentFrontendDiagnostics } from '../app/problem-report/diagnostics'
import { resetFrontendDiagnosticsForTests } from '../failures/ring'
import {
  CanopiDesignIngestionError,
  decodeCanopiDesign,
  isSavedByNewerCanopi,
  parseCanopiText,
} from './support/design-wire'

describe('Canopi Design decoder', () => {
  it.each([
    { version: undefined, displayed: 1 },
    { version: 1, displayed: 1 },
    { version: 6, displayed: 6 },
    { version: 7, displayed: 7 },
    { version: 8, displayed: 8 },
    { version: 10, displayed: 10 },
  ])('refuses any version but the current one: $displayed', ({ version, displayed }) => {
    const input = currentDesign()
    if (version === undefined) delete input.version
    else input.version = version

    expect(() => decodeCanopiDesign(input)).toThrow(
      `$.version: unsupported Canopi Design version ${displayed}; Canopi 2.0 and later open only version 9`,
    )
    expectKind(() => decodeCanopiDesign(input), 'unsupported_version')
  })

  it.each([
    { version: 7, kind: 'older_version' },
    { version: 8, kind: 'older_version' },
    { version: 10, kind: 'newer_version' },
  ])('tells a Design from before Canopi 2.0 apart from a newer one: v$version', ({ version, kind }) => {
    try {
      decodeCanopiDesign(currentDesign({ version }))
      expect.fail('expected the version to be refused')
    } catch (error) {
      expect(designLoadFailureOf(error)?.kind).toBe(kind)
    }
    expect(designLoadFailureMessageKey('older_version')).toBe('start.cantReadOlderVersion')
  })

  it('refuses a Canopi 1.2 Design (v6 with a spatial frame) as an older version, never as damaged', () => {
    const canopi12 = currentDesign({
      version: 6,
      spatial_frame: { origin: { lon: 2, lat: 48 } },
    })
    try {
      decodeCanopiDesign(canopi12)
      expect.fail('expected v6 to be refused')
    } catch (error) {
      expect(designLoadFailureOf(error)?.kind).toBe('older_version')
    }
  })

  it('admits a current-version Design with lon/lat positions', () => {
    const decoded = decodeCanopiDesign(currentDesign({
      plants: [{
        id: 'plant-1',
        locked: false,
        canonical_name: 'Malus domestica',
        common_name: 'Apple',
        color: null,
        symbol: null,
        pinned_name: false,
        position: { lon: 2.29448, lat: 48.85837 },
        rotation: null,
        scale: null,
        notes: null,
        planted_date: null,
        quantity: 1,
      }],
    }))
    expect(decoded.plants[0]?.position).toEqual({ lon: 2.29448, lat: 48.85837 })
  })

  it('refuses a root extra key: unknown fields are carried at the root, never nested', () => {
    const input = currentDesign({ extra: { custom: true } })
    expect(() => decodeCanopiDesign(input)).toThrow('$.extra')
    expectKind(() => decodeCanopiDesign(input), 'invalid_document')
  })

  it('preserves unsafe-looking root keys as data without changing prototypes', () => {
    const raw = JSON.parse('{"version":9,"name":"Safe","description":null,"plant_species_colors":{},"layers":[],"plants":[],"zones":[],"annotations":[],"consortiums":[],"groups":[],"timeline":[],"budget":[],"created_at":"2026-04-02T00:00:00.000Z","updated_at":"2026-04-02T00:00:00.000Z","__proto__":{"polluted":true}}') as unknown
    const decoded = decodeCanopiDesign(raw)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(decoded.extra, '__proto__')).toBe(true)
  })

  it('rejects missing required root fields', () => {
    const input = currentDesign()
    delete input.plants
    expectKind(() => decodeCanopiDesign(input), 'invalid_document')
  })

  it('maps every load error to a kind and a Start-screen string, never "invalid" for an older file', () => {
    resetFrontendDiagnosticsForTests()
    expect(designLoadFailureOf(pickCancelled('dialog.pick_open'))).toBeNull()
    expect(designLoadFailureOf(new Error('plain'))).toBeNull()
    expect(designLoadFailureOf({ kind: 'older_version', message: 'old' })).toEqual({
      kind: 'older_version',
      message: 'old',
    })
    expect(designLoadFailureOf({ kind: 'invalid_document', message: 'bad', field_path: '$.plants[0].id' })).toEqual({
      kind: 'invalid_document',
      message: 'bad',
      field_path: '$.plants[0].id',
    })
    expect(designLoadFailureMessageKey('missing')).toBe('start.cantReadMissing')
    expect(designLoadFailureMessageKey('older_version')).toBe('start.cantReadOlderVersion')
    expect(designLoadFailureMessageKey('newer_version')).toBe('start.cantReadNewerVersion')
    expect(designLoadFailureMessageKey('invalid_json')).toBe('start.cantReadDamaged')
    expect(designLoadFailureMessageKey('invalid_document')).toBe('start.cantReadDamaged')
    expect(designLoadFailureMessageKey('unreadable')).toBe('start.cantRead')
    expect(designLoadFailureMessageKey('too_large')).toBe('start.cantRead')
    expect(designLoadFailureMessageKey('internal')).toBe('start.cantRead')
    expect(recentFrontendDiagnostics()).toEqual([])
  })

  it('canopi-f47t.52.270: Open sends a Design whose version is an integer above 9 to the read view, as saved_by_newer does', () => {
    expect(isSavedByNewerCanopi({ version: 10 })).toBe(true)
    expect(isSavedByNewerCanopi({ version: 11 })).toBe(true)
    expect(isSavedByNewerCanopi({ version: 9 })).toBe(false)
    expect(isSavedByNewerCanopi({ version: 10.5 })).toBe(false)
    expect(isSavedByNewerCanopi(null)).toBe(false)
  })

  it('canopi-f47t.52.270: text that is no JSON is a damaged Design before any version is read', () => {
    expectKind(() => parseCanopiText('{not json'), 'invalid_document')
  })

  it("canopi-f47t.52.270: the v10 read fixture's view decodes as a 2.0 Design and shows its display options with no repair", () => {
    const expected = JSON.parse(readFileSync(
      '../../canopi-format/spec/v10/read-expected.json',
      'utf8',
    )) as { view: unknown }
    resetFrontendDiagnosticsForTests()
    const decoded = decodeCanopiDesign(expected.view)
    expect(readPlantDisplayOptions(decoded)).toMatchObject({
      colorBy: 'species',
      labels: 'codes',
      symbolScale: 1.25,
      outline: false,
    })
    expect(recentFrontendDiagnostics()).toEqual([])
  })
})

function expectKind(fn: () => unknown, kind: CanopiDesignIngestionError['kind']) {
  try {
    fn()
    expect.fail(`expected ${kind}`)
  } catch (error) {
    expect(error).toBeInstanceOf(CanopiDesignIngestionError)
    expect((error as CanopiDesignIngestionError).kind).toBe(kind)
  }
}

function currentDesign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 9,
    name: 'Garden',
    description: null,
    plant_species_colors: {},
    layers: [],
    plants: [],
    zones: [],
    annotations: [],
    consortiums: [],
    groups: [],
    timeline: [],
    budget: [],
    budget_currency: 'EUR',
    created_at: '2026-04-02T00:00:00.000Z',
    updated_at: '2026-04-02T00:00:00.000Z',
    ...overrides,
  }
}
