import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { StoreId } from '../generated/contracts'
import { admitStoreVersion, FORM_SPECS, STORE_FLOORS, type StoreFloor, type StoredForm } from '../generated/store-chain'
import {
  requireStoreFloor,
  runStoreChain,
  type ChainStep,
} from './store-chain'

interface WireExpected {
  kind: StoredForm['kind']
  version?: number
  from?: number
  min_readable?: number
  max_supported?: number
}

function toTsStoredForm(wire: WireExpected): StoredForm {
  switch (wire.kind) {
    case 'missing': return { kind: 'missing' }
    case 'current': return { kind: 'current' }
    case 'upgradable': return { kind: 'upgradable', from: wire.from! }
    case 'newer_read_only': return { kind: 'newer_read_only', version: wire.version! }
    case 'refused_newer': return { kind: 'refused_newer', version: wire.version!, maxSupported: wire.max_supported! }
    case 'pre_floor': return { kind: 'pre_floor', version: wire.version!, minReadable: wire.min_readable! }
  }
}

interface ParityFixture {
  bounded: {
    store: StoreId
    min_readable: number
    current: number
    max_readable: number | null
    cases: Array<{ found: number | null; expected: WireExpected }>
  }
  stores: Array<{ store: StoreId; found: number | null; expected: WireExpected }>
}

const PARITY_FIXTURE: ParityFixture = JSON.parse(
  readFileSync(new URL('../../../../canopi-types/fixtures/store-chain-parity.json', import.meta.url), 'utf8'),
) as ParityFixture

describe('platform/store-chain (Stage 2 Item 9)', () => {
  const floor: StoreFloor = { store: 'settings', minReadable: 1, current: 3, maxReadable: 4 }
  const steps: readonly ChainStep<{ v: number; log: string[] }>[] = [
    { from: 1, to: 2, run: (s) => ({ v: 2, log: [...s.log, '1->2'] }) },
    { from: 2, to: 3, run: (s) => ({ v: 3, log: [...s.log, '2->3'] }) },
  ]

  it('matches Rust STORE_FLOORS bounds (2.1-M480, 2.1-M486)', () => {
    expect(STORE_FLOORS.user_db).toEqual({ store: 'user_db', minReadable: 9, current: 9, maxReadable: null })
    expect(STORE_FLOORS.settings).toEqual({ store: 'settings', minReadable: 1, current: 1, maxReadable: null })
    expect(STORE_FLOORS.library_catalogue).toEqual({ store: 'library_catalogue', minReadable: 25, current: 25, maxReadable: null })
    expect(STORE_FLOORS.web_drafts).toEqual({ store: 'web_drafts', minReadable: 4, current: 4, maxReadable: null })
    expect(STORE_FLOORS.web_species_lists).toEqual({ store: 'web_species_lists', minReadable: 1, current: 1, maxReadable: null })
  })

  it('matches Rust admit_version across bounded and unbounded boundaries (Rust<->TS parity)', () => {
    const bounded: StoreFloor = {
      store: PARITY_FIXTURE.bounded.store,
      minReadable: PARITY_FIXTURE.bounded.min_readable,
      current: PARITY_FIXTURE.bounded.current,
      maxReadable: PARITY_FIXTURE.bounded.max_readable,
    }
    for (const c of PARITY_FIXTURE.bounded.cases) {
      expect(admitStoreVersion(bounded, c.found)).toEqual(toTsStoredForm(c.expected))
    }
    for (const c of PARITY_FIXTURE.stores) {
      expect(admitStoreVersion(requireStoreFloor(c.store), c.found)).toEqual(toTsStoredForm(c.expected))
    }
  })

  it('runs sequential upgrade steps synchronously up to current', () => {
    const done = runStoreChain(floor, 1, { v: 1, log: [] }, steps)
    expect(done).toEqual({ kind: 'current', version: 3, value: { v: 3, log: ['1->2', '2->3'] }, stepsRun: 2 })
  })

  it('classifies missing, current, newer_read_only, refused_newer, and pre_floor', () => {
    expect(runStoreChain(floor, null, { v: 0, log: [] }, steps)).toEqual({ kind: 'missing' })
    expect(runStoreChain(floor, 3, { v: 3, log: [] }, steps)).toEqual({
      kind: 'current',
      version: 3,
      value: { v: 3, log: [] },
      stepsRun: 0,
    })
    expect(runStoreChain(floor, 4, { v: 4, log: [] }, steps)).toEqual({
      kind: 'newer_read_only',
      version: 4,
      value: { v: 4, log: [] },
    })
    expect(runStoreChain(floor, 5, { v: 5, log: [] }, steps)).toEqual({
      kind: 'refused_newer',
      version: 5,
      maxSupported: 4,
    })
    expect(runStoreChain({ ...floor, minReadable: 2 }, 1, { v: 1, log: [] }, steps)).toEqual({
      kind: 'pre_floor',
      version: 1,
      minReadable: 2,
    })
  })

  it('throws when an upgradable store is missing a step or a store has no floor', () => {
    expect(() => runStoreChain(floor, 1, { v: 1, log: [] }, [steps[0]!])).toThrow(/missing or invalid step from v2/)
    expect(requireStoreFloor('settings').store).toBe('settings')
    expect(() => requireStoreFloor('plant_catalog')).toThrow(/no version floor declared/)
  })

  it('exposes the closed FORM_SPECS table aligned with STORE_FLOORS (2.1-M485, 2.1-M540)', () => {
    expect(Object.keys(FORM_SPECS)).toHaveLength(9)
    expect(FORM_SPECS.canopi_file).toEqual({ form: 'canopi_file', store: null, floor: 9 })
    expect(FORM_SPECS.saved_stamp_payload).toEqual({ form: 'saved_stamp_payload', store: null, floor: 2 })
    expect(FORM_SPECS.source_meta).toEqual({ form: 'source_meta', store: null, floor: 1 })
    expect(FORM_SPECS.web_legacy_container).toEqual({ form: 'web_legacy_container', store: null, floor: 3 })
    for (const spec of Object.values(FORM_SPECS)) {
      if (spec.store !== null) {
        expect(spec.floor).toBe(requireStoreFloor(spec.store).minReadable)
      }
    }
  })

  it('rejects async steps at compile time and thenables at runtime with step-returned-thenable (contracts §11)', () => {
    const asyncStep: ChainStep<{ v: number }> = {
      from: 1,
      to: 2,
      // @ts-expect-error async steps return Promise and must not compile
      run: async (s) => ({ v: s.v + 1 }),
    }
    expect(() => runStoreChain({ store: 'settings', minReadable: 1, current: 2, maxReadable: null }, 1, { v: 1 }, [asyncStep]))
      .toThrow(/step-returned-thenable/)

    const thenableStep: ChainStep<{ v: number }> = {
      from: 1,
      to: 2,
      run: (() => ({ then: () => undefined })) as unknown as ChainStep<{ v: number }>['run'],
    }
    try {
      runStoreChain({ store: 'settings', minReadable: 1, current: 2, maxReadable: null }, 1, { v: 1 }, [thenableStep])
      expect.unreachable('expected StepReturnedThenableError')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      const typed = error as Error & { code?: unknown; from?: unknown; store?: unknown }
      expect(typed.name).toBe('StepReturnedThenableError')
      expect(typed.code).toBe('step-returned-thenable')
      expect(typed.from).toBe(1)
      expect(typed.store).toBe('settings')
    }
  })
})
