// The commit gate's loosening authority over a planted repository, through the real entry (commit-gate-judge.ts;
// 2.1-Q267, 2.1-Q272): which header change loosens a ratchet, and which judge takes an engineering M row on the merge
// base and which, guarding a user decision, keeps a Q row.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANCH_M_ROW, GateRepo, KEPT, LEDGER, M_ROW, OPEN_BEAD, Q_ROW } from './commit-gate-repo.ts'
import { tiedRoutes } from './commit-gate-judge.ts'

let repo: GateRepo
beforeEach(() => { repo = new GateRepo() })
afterEach(() => repo.cleanup())

const verdict = (head: string, base?: string) => {
  const [status, out] = repo.pr(head, base)
  return { status, out }
}
const refused = (head: string, rule: string) => {
  const { status, out } = verdict(head)
  expect(status, out).toBe(1)
  expect(out).toContain(rule)
}
const passes = (head: string, base?: string) => {
  const { status, out } = verdict(head, base)
  expect(status, out).toBe(0)
}

/** Commits suppressions.json changed by `edit`; the new HEAD. */
const family = (edit: (doc: Record<string, unknown>) => void, message: string) => {
  const doc = repo.json('policy/ratchets/suppressions.json') as Record<string, unknown>
  edit(doc)
  repo.write({ 'policy/ratchets/suppressions.json': `${JSON.stringify(doc, null, 2)}\n` })
  return repo.commit(message)
}

describe('header authority (canopi-f47t.52.240)', () => {
  it('canopi-f47t.52.240: turning a family\'s ceilings on needs a bead and a Q row; turning them off passes', () => {
    // Ceilings keep a fixed site's headroom, so a new site can fill it unseen: a loosening, judged as one.
    const bare = verdict(family((doc) => { doc['ceilings'] = true }, 'chore: ceilings'))
    expect(bare.status, bare.out).toBe(1)
    expect(bare.out).toContain('gate-loosening-authority')
    repo.at(repo.base)
    const on = family((doc) => { doc['ceilings'] = true }, `chore: ceilings (${OPEN_BEAD}, ${Q_ROW})`)
    const wider = family((doc) => { doc['scope'] = [...doc['scope'] as string[], 'desktop/web/more/**'] }, 'chore: a wider scope')
    const kept = verdict(wider, on)
    expect(kept.status, `kept ceilings beside a wider scope: ${kept.out}`).toBe(0)
    const off = verdict(family((doc) => { delete doc['ceilings'] }, 'chore: ratchet again'), wider)
    expect(off.status, off.out).toBe(0)
  })
})

describe('engineering and product authority (2.1-Q272)', () => {
  it('canopi-f47t.52.240: an engineering loosening with an open bead and a merge-base M row passes; a branch-added M row authorises nothing', () => {
    // 2.1-Q272: an M row on the merge base authorises an engineering loosening; Q rows stay for product.
    passes(repo.raiseSuppression(`feat: add (${OPEN_BEAD}, ${M_ROW})`))
    repo.at(repo.base)
    repo.write({ 'docs/decisions/2-1.md': `${LEDGER}| ${BRANCH_M_ROW} | 2026-10-26 | Added on the branch. | | | plan |\n` })
    repo.commit('docs: a branch row')
    refused(repo.raiseSuppression(`feat: add (${OPEN_BEAD}, ${BRANCH_M_ROW})`), 'a Q or M row on the merge base')
  })

  it('canopi-f47t.52.240: a capability grant needs a Q row, the product judge; an engineering guarded file takes an M row', () => {
    // The capability grants are what Canopi may do on the user's machine: a user decision. A bundle budget is not (2.1-Q272).
    repo.write({ 'desktop/capabilities/main-window.json': `${JSON.stringify({ permissions: [] })}\n` })
    refused(repo.commit(`fix: drop the dialog grant (${OPEN_BEAD}, ${M_ROW})`), 'a Q row on the merge base')
    repo.at(repo.base)
    repo.write({ 'policy/ratchets/bundle-size.json': `${repo.read('policy/ratchets/bundle-size.json')}\n` })
    passes(repo.commit(`perf: a budget (${OPEN_BEAD}, ${M_ROW})`))
  })

  it('canopi-f47t.52.240: an inventory demotion takes a merge-base M row', () => {
    const inventory = { rules: [{ id: 'x-rule', doc: 'AGENTS.md', quote: 'x', state: { exists: { check: 'x' } } }] }
    repo.write({ 'policy/inventory.json': `${JSON.stringify(inventory)}\n` })
    const base = repo.commit('chore: inventory')
    repo.write({ 'policy/inventory.json': `${JSON.stringify({ rules: [{ ...inventory.rules[0], state: 'advice' }] })}\n` })
    passes(repo.commit(`chore: demote (${OPEN_BEAD}, ${M_ROW})`), base)
  })

  it('canopi-f47t.52.240: a deleted test citing only an M row is refused: a test guards behaviour a user decided', () => {
    repo.write({ 'desktop/web/src/a.test.ts': KEPT })
    repo.base = repo.commit('test(frontend): two behaviours')
    repo.write({ 'desktop/web/src/a.test.ts': KEPT.split("it('keeps the second")[0] ?? '' })
    refused(repo.commit(`test(frontend): drop one (${M_ROW})`), 'gate-test-deleted')
  })

  it('canopi-f47t.52.240: unreadable: a merge base whose ledger is not fetched is refused naming it, never read as holding no rows', () => {
    const blob = repo.git('rev-parse', `${repo.base}:docs/decisions/2-1.md`)
    const head = repo.raiseSuppression(`feat: add (${OPEN_BEAD}, ${M_ROW})`)
    rmSync(join(repo.path, '.git/objects', blob.slice(0, 2), blob.slice(2)))
    const { status, out } = verdict(head)
    expect(status, out).toBe(1)
    expect(out).toContain('docs/decisions/2-1.md is not readable')
    expect(out).toContain('fetch-depth: 0')
  })
})

describe('a PR body line tied to its file (2.1-Q274)', () => {
  it('canopi-f47t.52.240: a body line naming a path routes only that path, never one it is a prefix or suffix of', () => {
    const paths = ['desktop/web/src/a.test.ts', 'desktop/web/src/a.test.tsx', 'policy/rules.json', 'scripts/policy/rules.json']
    const route = tiedRoutes(() => paths.map((path) => ['M', path, path] as const), 'base', 'head',
      [{ rev: 'c1', parents: ['base'], message: 'chore: trivial' }],
      `desktop/web/src/a.test.tsx drops checks (${Q_ROW})\nscripts/policy/rules.json loosens (${M_ROW})\nedits policy/rules.json.`)
    expect(route('desktop/web/src/a.test.tsx')).toContain(Q_ROW)
    expect(route('desktop/web/src/a.test.ts')).not.toContain(Q_ROW)
    expect(route('scripts/policy/rules.json')).toContain(M_ROW)
    expect(route('policy/rules.json')).toBe('edits policy/rules.json.')
  })

  it('canopi-f47t.52.240: a base name that ends a different path names that path, never the one changed file sharing the name', () => {
    const only = (body: string) => tiedRoutes(() => [['M', 'policy/rules.json', 'policy/rules.json'] as const], 'base', 'head',
      [{ rev: 'c1', parents: ['base'], message: 'chore: trivial' }], body)('policy/rules.json')
    expect(only(`scripts/policy/rules.json loosens (${M_ROW})`)).toBe('')
    expect(only(`other/rules.json loosens (${M_ROW})`)).toBe('')
    for (const line of [`\`rules.json\` loosens (${M_ROW})`, `(rules.json) loosens (${M_ROW})`, `"rules.json" loosens (${M_ROW})`,
      `[rules.json](policy/rules.json#L3) loosens (${M_ROW})`, `rules.json: loosens (${M_ROW})`, `rules.json, loosens (${M_ROW})`,
      `rules.json#L3 loosens (${M_ROW})`, `loosens rules.json. (${M_ROW})`]) expect(only(line), line).toBe(line)
  })
})
