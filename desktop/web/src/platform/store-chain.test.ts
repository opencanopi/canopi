import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { StoreId } from '../generated/contracts'
import {
  admitStoreVersion,
  FORM_SPECS,
  STORE_FLOORS,
  type Admission,
  type StoreFloor,
} from '../generated/store-chain'
import {
  requireStoreFloor,
  runStoreChain,
  type ChainStep,
} from './store-chain'

interface WireExpected {
  kind: Admission['kind']
  version?: number
  from?: number
  min_readable?: number
  max_supported?: number
}

function toTsAdmission(wire: WireExpected): Admission {
  switch (wire.kind) {
    case 'absent': return { kind: 'absent' }
    case 'before_floor': return { kind: 'before_floor', version: wire.version!, minReadable: wire.min_readable! }
    case 'current': return { kind: 'current' }
    case 'migratable': return { kind: 'migratable', from: wire.from! }
    case 'newer_readable': return { kind: 'newer_readable', version: wire.version! }
    case 'refused_newer': return { kind: 'refused_newer', version: wire.version!, maxSupported: wire.max_supported! }
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
  const floor: StoreFloor = { store: 'settings', minReadable: 1, current: 3, stepCount: 2, maxReadable: 4 }
  const steps: readonly ChainStep<{ v: number; log: string[] }>[] = [
    { from: 1, run: (s, done) => done({ v: 2, log: [...s.log, '1->2'] }) },
    { from: 2, run: (s, done) => done({ v: 3, log: [...s.log, '2->3'] }) },
  ]

  it('matches Rust STORE_FLOORS bounds (2.1-M480, 2.1-M486)', () => {
    expect(STORE_FLOORS.user_db).toEqual({ store: 'user_db', minReadable: 9, current: 9, stepCount: 0, maxReadable: null })
    expect(STORE_FLOORS.settings).toEqual({ store: 'settings', minReadable: 1, current: 1, stepCount: 0, maxReadable: null })
    expect(STORE_FLOORS.library_catalogue).toEqual({ store: 'library_catalogue', minReadable: 25, current: 25, stepCount: 0, maxReadable: null })
    expect(STORE_FLOORS.web_drafts).toEqual({ store: 'web_drafts', minReadable: 4, current: 4, stepCount: 0, maxReadable: null })
    expect(STORE_FLOORS.web_species_lists).toEqual({ store: 'web_species_lists', minReadable: 1, current: 1, stepCount: 0, maxReadable: null })
  })

  it('matches Rust admit_version across bounded and unbounded boundaries (Rust<->TS parity)', () => {
    const bounded: StoreFloor = {
      store: PARITY_FIXTURE.bounded.store,
      minReadable: PARITY_FIXTURE.bounded.min_readable,
      current: PARITY_FIXTURE.bounded.current,
      stepCount: PARITY_FIXTURE.bounded.current - PARITY_FIXTURE.bounded.min_readable,
      maxReadable: PARITY_FIXTURE.bounded.max_readable,
    }
    for (const c of PARITY_FIXTURE.bounded.cases) {
      expect(admitStoreVersion(bounded, c.found)).toEqual(toTsAdmission(c.expected))
    }
    for (const c of PARITY_FIXTURE.stores) {
      expect(admitStoreVersion(requireStoreFloor(c.store), c.found)).toEqual(toTsAdmission(c.expected))
    }
  })

  it('runs sequential upgrade steps synchronously up to current', () => {
    const result = runStoreChain(floor, 1, { v: 1, log: [] }, steps)
    expect(result).toEqual({ kind: 'current', version: 3, value: { v: 3, log: ['1->2', '2->3'] }, stepsRun: 2 })
  })

  it('classifies absent, current, newer_readable, refused_newer, and before_floor', () => {
    expect(runStoreChain(floor, null, { v: 0, log: [] }, steps)).toEqual({ kind: 'absent' })
    expect(runStoreChain(floor, 3, { v: 3, log: [] }, steps)).toEqual({
      kind: 'current',
      version: 3,
      value: { v: 3, log: [] },
      stepsRun: 0,
    })
    expect(runStoreChain(floor, 4, { v: 4, log: [] }, steps)).toEqual({
      kind: 'newer_readable',
      version: 4,
      value: { v: 4, log: [] },
    })
    expect(runStoreChain(floor, 5, { v: 5, log: [] }, steps)).toEqual({
      kind: 'refused_newer',
      version: 5,
      maxSupported: 4,
    })
    expect(runStoreChain({ ...floor, minReadable: 2, stepCount: 1 }, 1, { v: 1, log: [] }, [steps[1]!])).toEqual({
      kind: 'before_floor',
      version: 1,
      minReadable: 2,
    })
  })

  it('enforces CURRENT = FLOOR + steps.length and contiguous from versions up front (2.1-M157)', () => {
    // Even when version is already current, a missing step is rejected immediately.
    expect(() => runStoreChain(floor, 3, { v: 3, log: [] }, [steps[0]!])).toThrow(/requires 2 step\(s\).*got 1/)
    // Non-contiguous step `from` is rejected immediately.
    expect(() => runStoreChain(floor, 3, { v: 3, log: [] }, [steps[1]!, steps[1]!])).toThrow(/step\[0\] must migrate from v1, got v2/)
    expect(requireStoreFloor('settings').store).toBe('settings')
    expect(() => requireStoreFloor('plant_catalog')).toThrow(/no version floor declared/)
  })

  it('exposes the closed StoredForm FORM_SPECS table aligned with STORE_FLOORS (2.1-M485, 2.1-M540)', () => {
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

  it('rejects async steps at compile time (concrete, unknown, and any) and thenables at runtime (contracts §11)', () => {
    const oneStepFloor: StoreFloor = { store: 'settings', minReadable: 1, current: 2, stepCount: 1, maxReadable: null }

    const asyncConcrete: ChainStep<{ v: number }> = {
      from: 1,
      // @ts-expect-error async steps return Promise<StepDone<T>> and must not compile
      run: async (s, done) => done({ v: s.v + 1 }),
    }
    const asyncUnknown: ChainStep<unknown> = {
      from: 1,
      // @ts-expect-error async steps must not compile even when T is unknown
      run: async (s, done) => done(s),
    }
    const asyncRawUnknown: ChainStep<unknown> = {
      from: 1,
      // @ts-expect-error returning unbranded async unknown must not compile
      run: async (s) => s,
    }
    expect(() => runStoreChain(oneStepFloor, 1, { v: 1 }, [asyncConcrete])).toThrow(/step-returned-thenable/)
    expect(() => runStoreChain(oneStepFloor, 1, { v: 1 }, [asyncUnknown])).toThrow(/step-returned-thenable/)
    expect(() => runStoreChain(oneStepFloor, 1, { v: 1 }, [asyncRawUnknown])).toThrow(/step-returned-thenable/)

    const thenableStep: ChainStep<{ v: number }> = {
      from: 1,
      run: (() => ({ then: () => undefined })) as unknown as ChainStep<{ v: number }>['run'],
    }
    try {
      runStoreChain(oneStepFloor, 1, { v: 1 }, [thenableStep])
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
