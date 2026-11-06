// A PR judged on its net change (`commit-gate pr`; 2.1-Q272, canopi-f47t.52.240): test deletions and loosening compare
// the merge base with the head and take a route from any commit message of the range or the PR body; the rules judged
// per commit (attribution, a created family's ledger id, added Python, new bead citations) never fail a commit made before the rule was added.
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

  it('canopi-f47t.52.240: a loosening is authorised by any commit message of the range', () => {
    repo.raiseSuppression('feat: an exception')
    repo.write({ 'notes.txt': 'x\n' })
    const { status, out } = verdict(repo.commit(`docs: the exception's authority (${OPEN_BEAD}, ${M_ROW})`))
    expect(out).not.toContain('gate-loosening-authority')
    expect(status, out).toBe(0)
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
