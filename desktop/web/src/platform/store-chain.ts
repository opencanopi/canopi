/**
 * platform/store-chain.ts: Thin synchronous store-chain step runner over the generated
 * `canopi-types::store_chain` floor table (Stage 2 Item 9; contracts §11, ADR 0023,
 * ADR 0026, 2.1-M157, 2.1-M540).
 */
import { admitStoreVersion, STORE_FLOORS, type StoreFloor } from '../generated/store-chain'
import type { StoreId } from '../generated/contracts'

const STEP_DONE = Symbol('canopi.store-chain.step-done')

/**
 * Branded synchronous step output (contracts §11, 2.1-M157).
 *
 * Only the `done` callback provided by `runStoreChain` can mint a `StepDone<T>`.
 * Because `Promise<StepDone<T>>` never carries the brand, an `async` step fails
 * TypeScript compilation for every `T`, including `unknown` and `any`.
 */
interface StepDone<T> {
  readonly [STEP_DONE]: true
  readonly value: T
}

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

/** One synchronous migration step advancing a store from `from` to `from + 1`. */
export interface ChainStep<T> {
  readonly from: number
  run(value: T, done: (value: T) => StepDone<T>): StepDone<T>
}

/** Result of running a synchronous store-chain upgrade over an initial value (contracts §11). */
export type ChainResult<T> =
  | { readonly kind: 'absent' }
  | { readonly kind: 'before_floor'; readonly version: number; readonly minReadable: number }
  | { readonly kind: 'current'; readonly version: number; readonly value: T; readonly stepsRun: number }
  | { readonly kind: 'newer_readable'; readonly version: number; readonly value: T }
  | { readonly kind: 'refused_newer'; readonly version: number; readonly maxSupported: number }

function isThenable(value: unknown): boolean {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
}

function isBrandedStepDone<T>(value: unknown): value is StepDone<T> {
  return typeof value === 'object'
    && value !== null
    && (value as Record<PropertyKey, unknown>)[STEP_DONE] === true
}

function validateSteps<T>(floor: StoreFloor, steps: readonly ChainStep<T>[]): void {
  const expectedSteps = floor.current - floor.minReadable
  if (expectedSteps < 0 || floor.stepCount !== expectedSteps) {
    throw new Error(
      `store-chain: inconsistent floor for ${floor.store} (minReadable=${floor.minReadable}, current=${floor.current}, stepCount=${floor.stepCount})`,
    )
  }
  if (steps.length !== expectedSteps) {
    throw new Error(
      `store-chain: ${floor.store} requires ${expectedSteps} step(s) for v${floor.minReadable}..v${floor.current}, got ${steps.length}`,
    )
  }
  for (let i = 0; i < steps.length; i += 1) {
    const expectedFrom = floor.minReadable + i
    if (steps[i]!.from !== expectedFrom) {
      throw new Error(
        `store-chain: ${floor.store} step[${i}] must migrate from v${expectedFrom}, got v${steps[i]!.from}`,
      )
    }
  }
}

/**
 * Validates `steps` against `floor` (`current === minReadable + steps.length`, contiguous
 * `from -> from + 1`), classifies `version`, and when `migratable` applies each step
 * synchronously in order up to `floor.current`.
 *
 * Rejects any runtime thenable with `StepReturnedThenableError` (`step-returned-thenable`)
 * so IndexedDB `onupgradeneeded` transactions can never auto-commit mid-migration.
 */
export function runStoreChain<T>(
  floor: StoreFloor,
  version: number | null,
  value: T,
  steps: readonly ChainStep<T>[],
): ChainResult<T> {
  validateSteps(floor, steps)

  const admission = admitStoreVersion(floor, version)
  if (admission.kind === 'absent') return admission
  if (admission.kind === 'before_floor') return admission
  if (admission.kind === 'current') return { kind: 'current', version: floor.current, value, stepsRun: 0 }
  if (admission.kind === 'newer_readable') return { kind: 'newer_readable', version: admission.version, value }
  if (admission.kind === 'refused_newer') return admission

  let currentVersion = admission.from
  let currentValue = value
  let stepsRun = 0
  const startIndex = currentVersion - floor.minReadable
  for (let i = startIndex; i < steps.length; i += 1) {
    const step = steps[i]!
    const done = (nextValue: T): StepDone<T> => {
      if (isThenable(nextValue)) {
        throw new StepReturnedThenableError(floor.store, currentVersion)
      }
      return { [STEP_DONE]: true, value: nextValue }
    }
    const output = step.run(currentValue, done)
    if (isThenable(output)) {
      throw new StepReturnedThenableError(floor.store, currentVersion)
    }
    if (!isBrandedStepDone<T>(output)) {
      throw new Error(`store-chain: step at v${currentVersion} for ${floor.store} did not return done(value)`)
    }
    currentValue = output.value
    currentVersion += 1
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
