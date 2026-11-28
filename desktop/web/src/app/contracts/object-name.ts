// app/contracts/object-name.ts  (pure)
//
// Single rename normalisation rule shared by Desktop and Web for Designs,
// saved views, stories and stamps (contracts §4, 2.1-Q87, 2.1-Q360).

export type NormalisedObjectName =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: 'empty' }

/**
 * Trims surrounding whitespace and collapses internal control/line-break runs
 * to a single space. Empty results are rejected so callers keep the previous
 * name or show a validation error.
 */
export function normaliseObjectName(raw: string): NormalisedObjectName {
  const name = raw.replace(/[\r\n\t]+/g, ' ').trim()
  if (name.length === 0) return { ok: false, reason: 'empty' }
  return { ok: true, name }
}
