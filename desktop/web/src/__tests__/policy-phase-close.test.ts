// Phase 0 closes on the repository's own policy tables (canopi-f47t.52.228): policy/check.mjs's --phase-close refuses
// a row whose owner_target phase has come while its owner is not in place, so a row a stream finished but never
// updated would stop every later phase close; and the check refuses an entry or a row citing a bead the tracker export
// records as closed, so each stream bead closing with the phase must leave no citation behind. The checker is loaded
// as `node policy/check.mjs` runs it, from the root. Tests run from desktop/web.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Refusal { readonly code: string, readonly where: string, readonly message: string }
interface Checker {
  loadRatchets(root?: string): { readonly families: unknown, readonly refusals: readonly Refusal[] }
  loadTableRules(root?: string): { readonly refusals: readonly Refusal[] }
  phaseCloseRefusals(tables: unknown, phase: string, families: unknown, pins: unknown): Refusal[]
  plannedPins(root?: string): unknown
  beadStatuses(root?: string): Map<string, unknown>
  closedBeadRefusals(families: unknown, tables: unknown, statuses: ReadonlyMap<string, unknown>): Refusal[]
  BEADS_FILE: string
}

const root = resolve(process.cwd(), '../..')
const checker = (await import(pathToFileURL(resolve(root, 'policy/check.mjs')).href)) as Checker
const lines = (refusals: readonly Refusal[]) => refusals.map((r) => `${r.code}: ${r.where}: ${r.message}`)

describe('policy tables at the Phase 0 close', () => {
  it('leave no row whose owner_target phase has come with its owner missing (canopi-f47t.52.228 seam 4)', () => {
    const tables = checker.loadTableRules(root)
    const { families } = checker.loadRatchets(root)
    expect(lines(tables.refusals)).toEqual([])
    expect(lines(checker.phaseCloseRefusals(tables, '0', families, checker.plannedPins(root)))).toEqual([])
  })

  it('cite no bead that closes with Phase 0, each 2.1-phase-0 bead read as closed (canopi-f47t.52.228 open item 1)', () => {
    const statuses = checker.beadStatuses(root)
    for (const line of readFileSync(resolve(root, checker.BEADS_FILE), 'utf8').split('\n').filter(Boolean)) {
      const bead = JSON.parse(line) as { id: string, labels?: string[] }
      if (bead.labels?.includes('2.1-phase-0')) statuses.set(bead.id, 'closed')
    }
    const { families, refusals } = checker.loadRatchets(root)
    const tables = checker.loadTableRules(root)
    expect(lines([...refusals, ...tables.refusals])).toEqual([])
    expect(lines(checker.closedBeadRefusals(families, tables, statuses))).toEqual([])
  })
})
