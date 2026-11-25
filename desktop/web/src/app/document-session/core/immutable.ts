/**
 * app/document-session/core/immutable.ts: Hand structural sharing helpers (`2.1-M547`).
 *
 * Keeps `DeepReadonly<T>` end-to-end under TypeScript 7 without `mutative` draft-casting
 * friction, and short-circuits `deepFreezeDev` on `Object.isFrozen(value)` so unchanged
 * subtrees cost O(1) in dev/test while tree-shaking to a no-op in production builds.
 */

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

const FREEZE_IN_THIS_BUILD = Boolean(import.meta.env?.DEV || import.meta.env?.MODE === 'test')

/**
 * Recursively freezes `value` in development and test builds, skipping any object already
 * frozen (`Object.isFrozen` short-circuit, 2.1-M547). Production builds return `value` directly.
 */
export function deepFreezeDev<T>(value: T): DeepReadonly<T> {
  if (!FREEZE_IN_THIS_BUILD || value === null || typeof value !== 'object') {
    return value as DeepReadonly<T>
  }
  if (Object.isFrozen(value)) {
    return value as DeepReadonly<T>
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      deepFreezeDev(value[i])
    }
  } else {
    for (const key of Object.keys(value)) {
      deepFreezeDev((value as Record<string, unknown>)[key])
    }
  }
  return Object.freeze(value) as DeepReadonly<T>
}
