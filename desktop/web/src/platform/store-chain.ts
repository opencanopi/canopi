/**
 * platform/store-chain.ts: Thin synchronous store-chain step runner over the generated
 * `canopi-types::store_chain` floor table (Stage 2 Item 9; ADR 0023, ADR 0026).
 */
import { admitStoreVersion, STORE_FLOORS, type StoreFloor } from '../generated/store-chain'
import type { StoreId } from '../generated/contracts'

/** One synchronous migration step from `from` to `to = from + 1`. */
export interface ChainStep<T> {
  readonly from: number
  readonly to: number
  run(value: T): T
}

/** Result of running a synchronous store-chain upgrade over an initial value. */
export type StepDone<T> =
  | { readonly kind: 'current'; readonly version: number; readonly value: T; readonly stepsRun: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'newer_read_only'; readonly version: number; readonly value: T }
  | { readonly kind: 'refused_newer'; readonly version: number; readonly maxSupported: number }
  | { readonly kind: 'pre_floor'; readonly version: number; readonly minReadable: number }

/**
 * Classifies `version` against `floor` and, when `upgradable`, applies each matching
 * step synchronously in ascending order until `floor.current` is reached.
 */
export function runStoreChain<T>(
  floor: StoreFloor,
  version: number | null,
  value: T,
  steps: readonly ChainStep<T>[],
): StepDone<T> {
  const form = admitStoreVersion(floor, version)
  if (form.kind === 'missing') return form
  if (form.kind === 'current') return { kind: 'current', version: floor.current, value, stepsRun: 0 }
  if (form.kind === 'newer_read_only') return { kind: 'newer_read_only', version: form.version, value }
  if (form.kind === 'refused_newer') return form
  if (form.kind === 'pre_floor') return form

  let currentVersion = form.from
  let currentValue = value
  let stepsRun = 0
  while (currentVersion < floor.current) {
    const step = steps.find((candidate) => candidate.from === currentVersion)
    if (!step || step.to <= currentVersion || step.to > floor.current) {
      throw new Error(`store-chain: missing or invalid step from v${currentVersion} toward v${floor.current} for ${floor.store}`)
    }
    currentValue = step.run(currentValue)
    currentVersion = step.to
    stepsRun += 1
  }
  return { kind: 'current', version: currentVersion, value: currentValue, stepsRun }
}

/** Looks up the generated floor for `store`, throwing when the store has no version chain. */
export function requireStoreFloor(store: StoreId): StoreFloor {
  const floor = STORE_FLOORS[store]
  if (!floor) throw new Error(`store-chain: no version floor declared for ${store}`)
  return floor
}
