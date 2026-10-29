// Phase 0 closes on the repository's own policy tables (canopi-f47t.52.228): policy/check.mjs's --phase-close refuses
// a row whose owner_target phase has come while its owner is not in place, so a row a stream finished but never
// updated would stop every later phase close. The checker is loaded as `node policy/check.mjs` runs it, from the root.
// Tests run from desktop/web.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Refusal { readonly code: string, readonly where: string, readonly message: string }
interface Checker {
  loadTableRules(root?: string): { readonly refusals: readonly Refusal[] }
  phaseCloseRefusals(tables: unknown, phase: string): Refusal[]
}

const root = resolve(process.cwd(), '../..')
const checker = (await import(pathToFileURL(resolve(root, 'policy/check.mjs')).href)) as Checker
const lines = (refusals: readonly Refusal[]) => refusals.map((r) => `${r.code}: ${r.where}: ${r.message}`)

describe('policy tables at the Phase 0 close', () => {
  it('leave no row whose owner_target phase has come with its owner missing (canopi-f47t.52.228 seam 4)', () => {
    const tables = checker.loadTableRules(root)
    expect(lines(tables.refusals)).toEqual([])
    expect(lines(checker.phaseCloseRefusals(tables, '0'))).toEqual([])
  })
})
