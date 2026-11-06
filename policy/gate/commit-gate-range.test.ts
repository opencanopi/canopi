// A PR judged on its net change (`commit-gate pr`; 2.1-Q272, canopi-f47t.52.240): test deletions and loosening compare
// the merge base with the head and take a route only from a commit that touched the file or a PR body line naming it
// (2.1-Q274); the rules judged per commit (attribution, a created family's ledger id, added Python, new bead citations)
// never fail a commit made before the rule was added.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GateRepo, KEPT, M_ROW, OPEN_BEAD, Q_ROW } from './commit-gate-repo.ts'

const FILE = 'desktop/web/src/a.test.ts'
const FIRST_ONLY = KEPT.split("it('keeps the second")[0] ?? ''
const SECOND = "import { expect, it } from 'vitest'\n\nit('holds the second behaviour', () => {\n  expect(3).toBe(3)\n})\n"

let repo: GateRepo
beforeEach(() => {
  repo = new GateRepo()
  repo.write({ [FILE]: KEPT })
  repo.base = repo.commit('test(frontend): two behaviours')
})
afterEach(() => repo.cleanup())

const verdict = (head: string, ...extra: string[]) => {
  const [status, out] = repo.pr(head, repo.base, ...extra)
  return { status, out }
}

/** A branch whose one commit makes `change`, merged into main past a notes commit with `message`; the merge. */
const mergeBranch = (change: () => void, message: string) => {
  repo.git('checkout', '-q', '-b', 'stream')
  change()
  repo.commit('chore: the branch change')
  repo.git('checkout', '-q', 'main')
  repo.write({ 'notes.txt': 'x\n' })
  repo.commit('docs: notes')
  repo.git('-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-ff', '-m', message, 'stream')
  return repo.git('rev-parse', 'HEAD')
}

/** Two branches of notes merged with `message`, the merge's own resolution making `change`, so it differs from both. */
const mergeResolving = (change: () => void, message: string) => {
  repo.at(repo.base)
  repo.git('checkout', '-q', '-B', 'side')
  repo.write({ 'notes.txt': 'y\n' })
  repo.commit('docs: other notes')
  repo.git('checkout', '-q', '-B', 'trunk', repo.base)
  repo.write({ 'other.txt': 'z\n' })
  repo.commit('docs: more notes')
  repo.git('-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-ff', '--no-commit', 'side')
  change()
  return repo.commit(message)
}

describe('a PR judged on its net change (2.1-Q272)', () => {
  it('canopi-f47t.52.240: a test deleted in one commit is routed by a quote in a later commit of the range', () => {
    repo.write({ [FILE]: FIRST_ONLY })
    repo.commit('test(frontend): drop the second behaviour')
    repo.write({ 'desktop/web/src/b.test.ts': SECOND })
    const { status, out } = verdict(repo.commit("test(frontend): 'holds the second behaviour' replaces it"))
    expect(out).not.toContain('gate-test-deleted')
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.240: a test deleted and restored within the range is no loss', () => {
    repo.write({ [FILE]: FIRST_ONLY })
    repo.commit('test(frontend): drop the second behaviour')
    repo.write({ [FILE]: KEPT })
    const { status, out } = verdict(repo.commit('test(frontend): restore it'))
    expect(out).not.toContain('gate-test-deleted')
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.240: a loosening is authorised by the commit that raised it or a PR body line naming its family file', () => {
    repo.raiseSuppression(`feat: an exception (${OPEN_BEAD}, ${M_ROW})`)
    repo.write({ 'notes.txt': 'x\n' })
    const own = verdict(repo.commit('docs: notes'))
    expect(own.out).not.toContain('gate-loosening-authority')
    expect(own.status, own.out).toBe(0)
    repo.at(repo.base)
    repo.raiseSuppression('feat: an exception')
    const head = repo.commit('docs: notes')
    const body = (line: string) => repo.gate(['pr', repo.base, head, '--body-env', 'PR_BODY'], { PR_BODY: `${line}\n` })
    const named = body(`suppressions.json takes one exception (${OPEN_BEAD}, ${M_ROW}).`)
    expect(named.stdout).not.toContain('gate-loosening-authority')
    expect(named.status, named.stdout).toBe(0)
    const unnamed = body(`One exception (${OPEN_BEAD}, ${M_ROW}).`)
    expect(unnamed.stdout).toContain('gate-loosening-authority: suppressions: added')
    expect(unnamed.status, unnamed.stdout).toBe(1)
  })

  it("canopi-f47t.52.240: a bead and M row cited only in an unrelated commit authorise no family's loosening", () => {
    repo.write({ 'notes.txt': 'x\n' })
    repo.commit(`docs: settle the exception (${OPEN_BEAD}, ${M_ROW})`)
    const { status, out } = verdict(repo.raiseSuppression('feat: an exception'))
    expect(out).toContain('gate-loosening-authority: suppressions: added')
    expect(out).toContain('2.1-Q274')
    expect(status, out).toBe(1)
  })

  it('canopi-f47t.52.240: an M row cited only in an unrelated commit authorises no guarded-file change', () => {
    repo.write({ 'notes.txt': 'x\n' })
    repo.commit(`docs: settle the budget (${M_ROW})`)
    const lower = () => {
      const doc = repo.json('policy/ratchets/bundle-size.json') as { budgets: Record<string, { ceiling: number }> }
      const entry = doc.budgets['desktop chunk: Notice']
      if (entry) entry.ceiling -= 6
      repo.write({ 'policy/ratchets/bundle-size.json': `${JSON.stringify(doc, null, 2)}\n` })
    }
    lower()
    const unrelated = verdict(repo.commit('perf: a tighter budget'))
    expect(unrelated.out).toContain('gate-guarded-file: policy/ratchets/bundle-size.json (changed)')
    expect(unrelated.status, unrelated.out).toBe(1)
    repo.at(repo.base)
    lower()
    const own = verdict(repo.commit(`perf: a tighter budget (${M_ROW})`))
    expect(own.out).not.toContain('gate-guarded-file')
    expect(own.status, own.out).toBe(0)
  })

  it("canopi-f47t.52.240: a bead and M row cited by a merge authorise only what the merge itself changed, never its branch's loosening", () => {
    const branch = verdict(mergeBranch(() => repo.stageSuppression(), `merge: stream S (${OPEN_BEAD}, ${M_ROW})`))
    expect(branch.out).toContain('gate-loosening-authority: suppressions: added')
    expect(branch.status, branch.out).toBe(1)
    // A raise the merge's own resolution makes differs from every parent: the merge's route authorises it.
    const resolved = verdict(mergeResolving(() => repo.stageSuppression(), `merge: side, with an exception (${OPEN_BEAD}, ${M_ROW})`))
    expect(resolved.out).not.toContain('gate-loosening-authority')
    expect(resolved.status, resolved.out).toBe(0)
  })

  it('canopi-f47t.52.240: an M row cited only in an unrelated commit authorises no advice demotion', () => {
    const row = { id: 'x-rule', doc: 'AGENTS.md', quote: 'x', state: { exists: { check: 'x' } } as unknown }
    repo.write({ 'policy/inventory.json': `${JSON.stringify({ rules: [row] })}\n` })
    repo.base = repo.commit('chore: inventory')
    repo.write({ 'notes.txt': 'x\n' })
    repo.commit(`docs: settle the demotion (${M_ROW})`)
    repo.write({ 'policy/inventory.json': `${JSON.stringify({ rules: [{ ...row, state: 'advice' }] })}\n` })
    const { status, out } = verdict(repo.commit('chore: a rule becomes advice'))
    expect(out).toContain('gate-inventory-demotion: policy/inventory.json')
    expect(status, out).toBe(1)
  })

  it('canopi-f47t.52.240: a Rewords-test chain across commits routes the net reword', () => {
    repo.write({ [FILE]: KEPT.replace('keeps the second behaviour', 'keeps behaviour two') })
    repo.commit('test(frontend): a new name')
    repo.write({ [FILE]: KEPT.replace('keeps the second behaviour', 'holds behaviour two') })
    const { status, out } = verdict(repo.commit('test(frontend): a better name\n\nRewords-test: keeps the second behaviour -> '
      + 'keeps behaviour two\nRewords-test: keeps behaviour two -> holds behaviour two'))
    expect(out).not.toContain('gate-test-')
    expect(status, out).toBe(0)
  })

  it('canopi-f47t.52.240: a rule added in the range never fails a commit made before it', () => {
    const rules = repo.json('policy/rules.json') as { rules: { id: string }[] }
    repo.write({ 'policy/rules.json': `${JSON.stringify({ ...rules, rules: rules.rules.filter((row) => row.id !== 'gate-python-added') }, null, 2)}\n` })
    repo.base = repo.commit('chore: a gate without the Python rule')
    repo.write({ 'scripts/early.py': 'x = 1\n' })
    repo.commit('chore: a script before the rule')
    repo.write({ 'policy/rules.json': `${JSON.stringify(rules, null, 2)}\n` })
    repo.commit('chore: the Python rule')
    repo.write({ 'scripts/late.py': 'x = 1\n' })
    const { status, out } = verdict(repo.commit('chore: a script after the rule'))
    expect(out).not.toContain('early.py')
    expect(out).toContain('gate-python-added: scripts/late.py')
    expect(status, out).toBe(1)
  })

  it('canopi-f47t.52.240: a family is judged for its ledger id in the commit that creates it, so a later re-point to another row passes', () => {
    const family = (ledger: string) => `${JSON.stringify({ version: 1, family: 'planted-family', ledger, tool: 'suppressions',
      scope: ['src/**'], lane: 'commit', keys: 'path', entries: { 'src/a.ts': { count: 1 } } }, null, 2)}\n`
    repo.write({ 'policy/ratchets/planted-family.json': family(Q_ROW) })
    repo.commit(`feat: a new family under ${Q_ROW}`)
    repo.write({ 'policy/ratchets/planted-family.json': family(M_ROW) })
    const repointed = verdict(repo.commit('chore: re-point the family to its M row'))
    expect(repointed.out).not.toContain('gate-first-baseline')
    expect(repointed.status, repointed.out).toBe(0)
    repo.git('reset', '-q', '--hard', repo.base)
    repo.write({ 'policy/ratchets/planted-family.json': family(M_ROW) })
    repo.commit('feat: a new family')
    const late = verdict(repo.commit(`docs: the family's row is ${M_ROW}`))
    expect(late.out).toContain('gate-first-baseline: planted-family: created')
    expect(late.status, late.out).toBe(1)
  })

  it('canopi-f47t.52.240: a Q row routes a test loss only from a commit that touched its file, never from an unrelated commit', () => {
    repo.write({ 'notes.txt': 'x\n' })
    repo.commit(`docs: record a settlement (${Q_ROW})`)
    repo.write({ [FILE]: FIRST_ONLY })
    const unrelated = verdict(repo.commit('refactor(frontend): tidy'))
    expect(unrelated.out).toContain("gate-test-deleted: desktop/web/src/a.test.ts: 'keeps the second behaviour'")
    expect(unrelated.status, unrelated.out).toBe(1)
    repo.write({ [FILE]: KEPT })
    repo.commit('test(frontend): restore it')
    repo.write({ [FILE]: FIRST_ONLY })
    const touching = verdict(repo.commit(`test(frontend): the second behaviour goes (${Q_ROW})`))
    expect(touching.out).not.toContain('gate-test-deleted')
    expect(touching.status, touching.out).toBe(0)
  })

  it("canopi-f47t.52.240: a Q row cited by a merge routes only what the merge itself changed, never its branch's test losses", () => {
    const branch = verdict(mergeBranch(() => repo.write({ [FILE]: FIRST_ONLY }), `merge: stream S (${Q_ROW})`))
    expect(branch.out).toContain("gate-test-deleted: desktop/web/src/a.test.ts: 'keeps the second behaviour'")
    expect(branch.status, branch.out).toBe(1)
    // A loss the merge's own resolution makes differs from every parent: the merge's Q row routes it.
    const resolved = verdict(mergeResolving(() => repo.write({ [FILE]: FIRST_ONLY }),
      `merge: side, the second behaviour goes (${Q_ROW})`))
    expect(resolved.out).not.toContain('gate-test-deleted')
    expect(resolved.status, resolved.out).toBe(0)
  })

  it('canopi-f47t.52.240: a PR body line routes by base name only when one changed file of the range has it', () => {
    const other = 'desktop/web/src/other/a.test.ts'
    const otherKept = KEPT.replace('keeps the second behaviour', 'keeps the other behaviour')
    repo.write({ [other]: otherKept })
    repo.base = repo.commit('test(frontend): the same base name elsewhere')
    repo.write({ [FILE]: FIRST_ONLY, [other]: otherKept.split("it('keeps the other")[0] ?? '' })
    const head = repo.commit('test(frontend): drop the second behaviours')
    const shared = repo.gate(['pr', repo.base, head, '--body-env', 'PR_BODY'],
      { PR_BODY: `a.test.ts loses its second behaviour (${Q_ROW}).\n` })
    expect(shared.stdout).toContain(`gate-test-deleted: ${FILE}: 'keeps the second behaviour'`)
    expect(shared.stdout).toContain(`gate-test-deleted: ${other}: 'keeps the other behaviour'`)
    expect(shared.status, shared.stdout).toBe(1)
    const byPath = repo.gate(['pr', repo.base, head, '--body-env', 'PR_BODY'],
      { PR_BODY: `${FILE} loses its second behaviour (${Q_ROW}).\n` })
    expect(byPath.stdout).not.toContain(`gate-test-deleted: ${FILE}:`)
    expect(byPath.stdout).toContain(`gate-test-deleted: ${other}: 'keeps the other behaviour'`)
    repo.write({ [other]: otherKept })
    const alone = repo.commit('test(frontend): keep the other file')
    const unique = repo.gate(['pr', repo.base, alone, '--body-env', 'PR_BODY'],
      { PR_BODY: `a.test.ts loses its second behaviour (${Q_ROW}).\n` })
    expect(unique.stdout).not.toContain('gate-test-deleted')
    expect(unique.status, unique.stdout).toBe(0)
  })

  it('canopi-f47t.52.240: retried: a route only in the PR body passes with --body-env and is reported red without it', () => {
    repo.write({ [FILE]: FIRST_ONLY, 'desktop/web/src/b.test.ts': SECOND })
    const head = repo.commit('test(frontend): move the second behaviour')
    const body = { PR_BODY: "The new test 'holds the second behaviour' replaces 'keeps the second behaviour'.\n" }
    const ci = repo.gate(['pr', repo.base, head, '--body-env', 'PR_BODY'], body)
    expect(ci.status, ci.stdout).toBe(0)
    const local = verdict(head)
    expect(local.status, local.out).toBe(1)
    expect(local.out).toContain("gate-test-deleted: desktop/web/src/a.test.ts: 'keeps the second behaviour'")
    expect(local.out).toContain('no PR body was read (--body-env)')
  })
})

describe('a Retires-test line and a kept test (2.1-Q274, M388)', () => {
  const LOOSENED = KEPT.replace('  expect(2).toBe(2)\n', '')

  it('canopi-f47t.52.240: a false Retires-test line naming a kept, loosened test does not authorise its loosening', () => {
    repo.write({ [FILE]: LOOSENED })
    const fromMessage = verdict(repo.commit('test(frontend): loosen\n\nRetires-test: keeps the first behaviour — not really'))
    expect(fromMessage.out).toContain("gate-test-loosened: desktop/web/src/a.test.ts: 'keeps the first behaviour'")
    expect(fromMessage.status, fromMessage.out).toBe(1)
    repo.at(repo.base)
    repo.write({ [FILE]: LOOSENED })
    const head = repo.commit('test(frontend): loosen')
    const fromBody = repo.gate(['pr', repo.base, head, '--body-env', 'PR_BODY'],
      { PR_BODY: 'Retires-test: keeps the first behaviour — not really\n' })
    expect(fromBody.stdout).toContain("gate-test-loosened: desktop/web/src/a.test.ts: 'keeps the first behaviour'")
    expect(fromBody.status, fromBody.stdout).toBe(1)
  })

  it('canopi-f47t.52.240: retiring one of two same-titled tests passes, and its kept twin is still judged for loosening', () => {
    const code = 'export const c = 1\nexport const d = 2\n'
    const twin = (first: string) => "import { expect, it } from 'vitest'\nimport { c, d } from './c'\n\n"
      + `it('reads', () => {\n${first}})\n\nit('reads', () => {\n  expect(d).toBe(2)\n})\n`
    const strong = '  expect(c).toBe(1)\n  expect(c + 1).toBe(2)\n'
    repo.write({ 'desktop/web/src/c.ts': code, 'desktop/web/src/c.test.ts': twin(strong) })
    repo.base = repo.commit('feat(frontend): c and d')
    const retire = (first: string) => {
      repo.write({ 'desktop/web/src/c.ts': 'export const c = 1\n',
        'desktop/web/src/c.test.ts': (twin(first).split("\n\nit('reads', () => {\n  expect(d)")[0] ?? '').replace(', d', '') + '\n' })
      return verdict(repo.commit('refactor(frontend): drop d\n\nRetires-test: reads — d is gone'))
    }
    const kept = retire(strong)
    expect(kept.out).not.toContain('gate-test-')
    expect(kept.status, kept.out).toBe(0)
    repo.at(repo.base)
    const loosened = retire('  expect(c).toBe(1)\n')
    expect(loosened.out).toContain("gate-test-loosened: desktop/web/src/c.test.ts: 'reads'")
    expect(loosened.status, loosened.out).toBe(1)
  })
})
