/**
 * platform/store-chain.ts: Thin synchronous store-chain step runner over the generated
 * `canopi-types::store_chain` floor table (Stage 2 Item 9; ADR 0023, ADR 0026, 2.1-M540).
 */
import { admitStoreVersion, STORE_FLOORS, type StoreFloor } from '../generated/store-chain'
import type { StoreId } from '../generated/contracts'

/** Rejects `PromiseLike` return values at compile time so an `async` step cannot compile (contracts §11). */
type SyncValue<T> = T extends PromiseLike<unknown> ? never : T

/** Runtime error thrown when a step returns a thenable (`step-returned-thenable`, contracts §11). */
class StepReturnedThenableError extends Error {
  readonly code = 'step-returned-thenable' as const
  readonly store: StoreId
  readonly from: number

  constructor(store: StoreId, from: number) {
    super(`store-chain: step-returned-thenable at v${from} for ${store}`)
    this.name = 'StepReturnedThenableError'
    this.store = store
    this.from = from
  }
}

/** One synchronous migration step from `from` to `to = from + 1`. */
export interface ChainStep<T> {
  readonly from: number
  readonly to: number
  run(value: T): SyncValue<T>
}

/** Result of running a synchronous store-chain upgrade over an initial value. */
export type StepDone<T> =
  | { readonly kind: 'current'; readonly version: number; readonly value: T; readonly stepsRun: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'newer_read_only'; readonly version: number; readonly value: T }
  | { readonly kind: 'refused_newer'; readonly version: number; readonly maxSupported: number }
  | { readonly kind: 'pre_floor'; readonly version: number; readonly minReadable: number }

function isThenable(value: unknown): boolean {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * Classifies `version` against `floor` and, when `upgradable`, applies each matching
 * step synchronously in ascending order until `floor.current` is reached.
 *
 * Rejects any runtime thenable with `StepReturnedThenableError` (`step-returned-thenable`)
 * so IndexedDB `onupgradeneeded` transactions can never auto-commit mid-migration.
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
    const nextValue = step.run(currentValue)
    if (isThenable(nextValue)) {
      throw new StepReturnedThenableError(floor.store, currentVersion)
    }
    currentValue = nextValue
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
