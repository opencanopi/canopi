import type { CanopiFile } from '../../types/design'
import { reportFailure } from '../../failures/report'

/**
 * The root `extra` keys Design Edit owns. The format keeps them as unknown
 * `extra` (ADR 0011), so their names live here and nowhere else: readers go
 * through `readExtra`, writers through `withExtra`, and a stored value that
 * reads back repaired is reported once. The scene owns no `extra` key: the
 * file composer in app/contracts/document.ts writes the document's `extra`
 * as it is, other keys included (canopi-skhg: derive the new-Design key list
 * from this registry).
 */
export const DESIGN_EDIT_EXTRA_KEYS = Object.freeze({
  /** Display on the map; a new Design carries it from Settings › New Designs. */
  plantDisplay: 'plant_display',
} as const)

export type DesignEditExtraKey = (typeof DESIGN_EDIT_EXTRA_KEYS)[keyof typeof DESIGN_EDIT_EXTRA_KEYS]

type ExtraOwner = Pick<CanopiFile, 'extra'>

/**
 * The object stored under `key`, or null when absent. A stored value that is
 * not an object is a repair: reported, then read as absent.
 */
export function readExtra(design: ExtraOwner | null, key: DesignEditExtraKey): Readonly<Record<string, unknown>> | null {
  const stored = design?.extra?.[key]
  if (stored === undefined) return null
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    reportExtraRepair(design, key, 'the stored value is not an object')
    return null
  }
  return stored as Record<string, unknown>
}

/** The Design with `key` set to `value`, or removed with null; a write that changes nothing returns it untouched. */
export function withExtra<T extends ExtraOwner>(design: T, key: DesignEditExtraKey, value: Record<string, unknown> | null): T {
  const current = design.extra?.[key]
  if (value === null ? current === undefined : JSON.stringify(current) === JSON.stringify(value)) return design
  const extra: Record<string, unknown> = { ...design.extra }
  if (value === null) delete extra[key]
  else extra[key] = value
  return { ...design, extra }
}

const reportedRepairs = new WeakMap<object, Set<string>>()

/**
 * A stored value read back repaired (defaulted, dropped or pruned) goes into
 * the problem report once per stored `extra` object and key, so a Design
 * that keeps being read does not flood it.
 */
export function reportExtraRepair(design: ExtraOwner | null, key: DesignEditExtraKey, what: string): void {
  const extra = design?.extra
  if (!extra || typeof extra !== 'object') return
  let keys = reportedRepairs.get(extra)
  if (!keys) reportedRepairs.set(extra, keys = new Set())
  if (keys.has(key)) return
  keys.add(key)
  reportFailure(`Repaired extra.${key} on read: ${what}.`, { shown: 'none', source: 'design-edit:extra', level: 'warning' })
}
